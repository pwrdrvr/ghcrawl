import { spawn } from 'node:child_process';

import blessed from 'neo-blessed';

import type {
  GHCrawlService,
  TuiClusterDetail,
  TuiClusterSortMode,
  TuiSnapshot,
  TuiThreadDetail,
  TuiWideLayoutPreference,
} from '@ghcrawl/api-core';
import { getTuiRepositoryPreference, writeTuiRepositoryPreference } from '@ghcrawl/api-core';
import {
  buildMemberRows,
  cycleFocusPane,
  cycleMinSizeFilter,
  cycleSortMode,
  findSelectableIndex,
  moveSelectableIndex,
  preserveSelectedId,
  selectedThreadIdFromRow,
  type MemberListRow,
  type TuiFocusPane,
  type TuiMinSizeFilter,
} from './state.js';
import { computeTuiLayout } from './layout.js';

type StartTuiParams = {
  service: GHCrawlService;
  owner?: string;
  repo?: string;
};

type RepositoryTarget = {
  owner: string;
  repo: string;
};

type RepositoryChoice =
  | {
      kind: 'existing';
      target: RepositoryTarget;
      label: string;
    }
  | {
      kind: 'new';
      label: string;
    };

type Widgets = {
  screen: blessed.Widgets.Screen;
  header: blessed.Widgets.BoxElement;
  clusters: blessed.Widgets.ListElement;
  members: blessed.Widgets.ListElement;
  detail: blessed.Widgets.BoxElement;
  footer: blessed.Widgets.BoxElement;
};

type ThreadDetailCacheEntry = {
  detail: TuiThreadDetail;
  hasNeighbors: boolean;
};

export function resolveBlessedTerminal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const term = env.TERM;
  if (!term) {
    return undefined;
  }
  if (term === 'xterm-ghostty') {
    return 'xterm-256color';
  }
  return term;
}

function createScreen(options: Parameters<typeof blessed.screen>[0]): blessed.Widgets.Screen {
  return blessed.screen({
    ...options,
    terminal: resolveBlessedTerminal(),
  });
}

const ACTIVITY_LOG_LIMIT = 200;
const FOOTER_LOG_LINES = 3;

export async function startTui(params: StartTuiParams): Promise<void> {
  const selectedRepository = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : null;
  let currentRepository = selectedRepository ?? { owner: '', repo: '' };
  const widgets = createWidgets(currentRepository.owner, currentRepository.repo);

  let focusPane: TuiFocusPane = 'clusters';
  const initialPreference = selectedRepository
    ? getTuiRepositoryPreference(params.service.config, currentRepository.owner, currentRepository.repo)
    : { sortMode: 'recent' as TuiClusterSortMode, minClusterSize: 1 as TuiMinSizeFilter, wideLayout: 'columns' as TuiWideLayoutPreference };
  let sortMode: TuiClusterSortMode = initialPreference.sortMode;
  let minSize: TuiMinSizeFilter = initialPreference.minClusterSize;
  let wideLayout: TuiWideLayoutPreference = initialPreference.wideLayout;
  let showClosed = true;
  let search = '';
  let snapshot: TuiSnapshot | null = null;
  let clusterItems: string[] = ['Pick a repository with p'];
  let clusterIndexById = new Map<number, number>();
  let clusterDetail: TuiClusterDetail | null = null;
  let threadDetail: TuiThreadDetail | null = null;
  let selectedClusterId: number | null = null;
  let selectedMemberThreadId: number | null = null;
  let memberRows: MemberListRow[] = [];
  let memberIndex = -1;
  let status = 'Ready';
  const activityLines: string[] = [];
  const clusterDetailCache = new Map<number, TuiClusterDetail>();
  const threadDetailCache = new Map<number, ThreadDetailCacheEntry>();
  let modalOpen = false;

  const clearCaches = (): void => {
    clusterDetailCache.clear();
    threadDetailCache.clear();
  };

  const formatTuiError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const rebuildClusterItems = (): void => {
    if (!snapshot) {
      clusterItems = ['Pick a repository with p'];
      clusterIndexById = new Map();
      widgets.clusters.setItems(clusterItems);
      return;
    }

    clusterIndexById = new Map();
    clusterItems = snapshot.clusters.map((cluster, index) => {
      clusterIndexById.set(cluster.clusterId, index);
      const updated = formatClusterDateColumn(cluster.latestUpdatedAt);
      const meta = `${cluster.totalCount} items  C${cluster.clusterId}  ${cluster.pullRequestCount}P/${cluster.issueCount}I  ${updated}`;
      const label = `${cluster.displayTitle}  ${meta}`;
      return cluster.isClosed ? `{gray-fg}${escapeBlessedText(label)}{/gray-fg}` : escapeBlessedText(label);
    });
    widgets.clusters.setItems(clusterItems);
  };

  const pushActivity = (message: string, options?: { raw?: boolean }): void => {
    activityLines.push(options?.raw === true ? message : `${formatActivityTimestamp()} ${message}`);
    if (activityLines.length > ACTIVITY_LOG_LIMIT) {
      activityLines.splice(0, activityLines.length - ACTIVITY_LOG_LIMIT);
    }
    render();
  };

  const loadClusterDetail = (clusterId: number): TuiClusterDetail => {
    const cached = clusterDetailCache.get(clusterId);
    if (cached) return cached;
    const detail = params.service.getTuiClusterDetail({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      clusterId,
      clusterRunId: snapshot?.clusterRunId ?? undefined,
    });
    clusterDetailCache.set(clusterId, detail);
    return detail;
  };

  const loadThreadDetail = (threadId: number, includeNeighbors: boolean): TuiThreadDetail => {
    const cached = threadDetailCache.get(threadId);
    if (cached && (cached.hasNeighbors || !includeNeighbors)) {
      return cached.detail;
    }

    const detail = params.service.getTuiThreadDetail({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      threadId,
      includeNeighbors,
    });
    threadDetailCache.set(threadId, { detail, hasNeighbors: includeNeighbors });
    return detail;
  };

  const loadSelectedThreadDetail = (includeNeighbors: boolean): void => {
    threadDetail = selectedMemberThreadId !== null ? loadThreadDetail(selectedMemberThreadId, includeNeighbors) : null;
  };

  const jumpToThread = (threadId: number, clusterId: number | null | undefined): boolean => {
    if (clusterId == null) {
      status = 'Selected thread is not assigned to a cluster';
      render();
      return false;
    }

    const selectFromSnapshot = (): boolean => {
      const cluster = snapshot?.clusters.find((item) => item.clusterId === clusterId) ?? null;
      if (!cluster) {
        return false;
      }
      selectedClusterId = cluster.clusterId;
      try {
        clusterDetail = loadClusterDetail(cluster.clusterId);
      } catch (error) {
        status = `Cluster ${cluster.clusterId} changed; refreshing view`;
        refreshAll(true);
        return false;
      }
      memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed });
      selectedMemberThreadId = threadId;
      memberIndex = findSelectableIndex(memberRows, selectedMemberThreadId);
      loadSelectedThreadDetail(false);
      resetDetailScroll();
      status = `Cluster ${cluster.clusterId} / #${threadDetail?.thread.number ?? '?'}`;
      render();
      return true;
    };

    if (selectFromSnapshot()) {
      return true;
    }

    if (minSize !== 0 || search) {
      minSize = 0;
      search = '';
      refreshAll(false);
      return selectFromSnapshot();
    }

    status = `Cluster ${clusterId} is not available in the current view`;
    render();
    return false;
  };

  const refreshAll = (preserveSelection: boolean): void => {
    const previousClusterId = preserveSelection ? selectedClusterId : null;
    const previousMemberId = preserveSelection ? selectedMemberThreadId : null;
    clearCaches();
    snapshot = params.service.getTuiSnapshot({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      minSize,
      sort: sortMode,
      search,
      includeClosedClusters: showClosed,
    });
    selectedClusterId = preserveSelectedId(snapshot.clusters.map((cluster) => cluster.clusterId), previousClusterId);
    rebuildClusterItems();

    if (selectedClusterId !== null) {
      try {
        clusterDetail = loadClusterDetail(selectedClusterId);
      } catch {
        snapshot = params.service.getTuiSnapshot({
          owner: currentRepository.owner,
          repo: currentRepository.repo,
          minSize,
          sort: sortMode,
          search,
          includeClosedClusters: showClosed,
        });
        rebuildClusterItems();
        selectedClusterId = preserveSelectedId(snapshot.clusters.map((cluster) => cluster.clusterId), null);
        clusterDetail = selectedClusterId !== null ? loadClusterDetail(selectedClusterId) : null;
      }
    }

    if (selectedClusterId !== null && clusterDetail) {
      memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed });
      selectedMemberThreadId = preserveSelectedId(
        memberRows.filter((row) => row.selectable).map((row) => row.threadId),
        previousMemberId,
      );
      memberIndex = findSelectableIndex(memberRows, selectedMemberThreadId);
      loadSelectedThreadDetail(false);
    } else {
      clusterDetail = null;
      memberRows = [];
      selectedMemberThreadId = null;
      memberIndex = -1;
      threadDetail = null;
    }

    status = `Loaded ${snapshot.clusters.length} cluster(s)`;
    render();
  };

  const updateFocus = (nextFocus: TuiFocusPane): void => {
    focusPane = nextFocus;
    if (focusPane === 'detail' && selectedMemberThreadId !== null) {
      loadSelectedThreadDetail(true);
    }
    if (focusPane === 'clusters') widgets.clusters.focus();
    if (focusPane === 'members') widgets.members.focus();
    if (focusPane === 'detail') widgets.detail.focus();
    render();
  };

  const render = (): void => {
    const width = widgets.screen.width as number;
    const height = widgets.screen.height as number;
    const layout = computeTuiLayout(width, height, wideLayout);
    applyRect(widgets.header, layout.header);
    applyRect(widgets.clusters, layout.clusters);
    applyRect(widgets.members, layout.members);
    applyRect(widgets.detail, layout.detail);
    applyRect(widgets.footer, layout.footer);

    widgets.screen.title = currentRepository.owner && currentRepository.repo ? `ghcrawl ${currentRepository.owner}/${currentRepository.repo}` : 'ghcrawl';
    const repoLabel = snapshot?.repository.fullName ?? (currentRepository.owner && currentRepository.repo ? `${currentRepository.owner}/${currentRepository.repo}` : 'ghcrawl');
    const ghStatus = formatRelativeTime(snapshot?.stats.lastGithubReconciliationAt ?? null);
    const embedAge = formatRelativeTime(snapshot?.stats.lastEmbedRefreshAt ?? null);
    const embedStatus =
      snapshot && snapshot.stats.staleEmbedThreadCount > 0
        ? `${snapshot.stats.staleEmbedThreadCount} stale / ${embedAge}`
        : embedAge;
    const clusterStatus =
      snapshot?.stats.latestClusterRunId != null
        ? `#${snapshot.stats.latestClusterRunId} ${formatRelativeTime(snapshot.stats.latestClusterRunFinishedAt ?? null)}`
        : 'never';
    widgets.header.setContent(
      `{bold}${repoLabel}{/bold}  {cyan-fg}${snapshot?.stats.openPullRequestCount ?? 0} PR{/cyan-fg}  {green-fg}${snapshot?.stats.openIssueCount ?? 0} issues{/green-fg}  GH:${ghStatus}  Emb:${embedStatus}  Cl:${clusterStatus}  sort:${sortMode}  min:${minSize === 0 ? 'all' : `${minSize}+`}  layout:${wideLayout === 'columns' ? 'cols' : 'stack'}  closed:${showClosed ? 'shown' : 'hidden'}  filter:${search || 'none'}`,
    );

    const clusterIndex = snapshot && selectedClusterId !== null ? Math.max(0, clusterIndexById.get(selectedClusterId) ?? -1) : 0;
    widgets.clusters.select(clusterIndex);

    widgets.members.setItems(memberRows.length > 0 ? memberRows.map((row) => row.label) : ['No members']);
    if (memberIndex >= 0) {
      widgets.members.select(memberIndex);
    }

    widgets.detail.setContent(renderDetailPane(threadDetail, clusterDetail, focusPane));
    updatePaneStyles(widgets, focusPane);
    const logLines = activityLines.slice(-FOOTER_LOG_LINES);
    const footerLines = [...logLines];
    while (footerLines.length < FOOTER_LOG_LINES) {
      footerLines.unshift('');
    }
    footerLines.push(
      `${status}  |  h/? help  # jump  p repos  / filter  s sort  f min  l layout  x closed`,
    );
    footerLines.push(
      `Tab focus  arrows move-or-scroll  PgUp/PgDn page  r refresh  o open  q quit`,
    );
    widgets.footer.setContent(footerLines.join('\n'));
    widgets.screen.render();
  };

  const resetDetailScroll = (): void => {
    widgets.detail.setScroll(0);
  };

  const scrollDetail = (offset: number): void => {
    if (focusPane !== 'detail') return;
    widgets.detail.scroll(offset);
    widgets.screen.render();
  };

  const moveSelection = (delta: -1 | 1, options?: { steps?: number; wrap?: boolean }): void => {
    if (!snapshot) return;
    const steps = Math.max(1, options?.steps ?? 1);
    const wrap = options?.wrap ?? true;
    if (focusPane === 'clusters') {
      if (snapshot.clusters.length === 0) return;
      const currentIndex = Math.max(0, selectedClusterId === null ? -1 : (clusterIndexById.get(selectedClusterId) ?? -1));
      let nextIndex = currentIndex + delta * steps;
      if (wrap) {
        nextIndex = ((nextIndex % snapshot.clusters.length) + snapshot.clusters.length) % snapshot.clusters.length;
      } else {
        nextIndex = Math.max(0, Math.min(snapshot.clusters.length - 1, nextIndex));
      }
      selectedClusterId = snapshot.clusters[nextIndex]?.clusterId ?? null;
      if (selectedClusterId !== null) {
        try {
          clusterDetail = loadClusterDetail(selectedClusterId);
        } catch {
          status = 'Cluster data changed; refreshing view';
          refreshAll(true);
          return;
        }
        memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed });
        selectedMemberThreadId = preserveSelectedId(
          memberRows.filter((row) => row.selectable).map((row) => row.threadId),
          null,
        );
        memberIndex = findSelectableIndex(memberRows, selectedMemberThreadId);
        loadSelectedThreadDetail(false);
        resetDetailScroll();
      }
      status = selectedClusterId !== null ? `Cluster ${selectedClusterId} (${nextIndex + 1}/${snapshot.clusters.length})` : `Cluster ${nextIndex + 1}/${snapshot.clusters.length}`;
      render();
      return;
    }

    if (focusPane === 'members') {
      if (memberRows.length === 0) return;
      let nextIndex = memberIndex < 0 ? 0 : memberIndex;
      for (let index = 0; index < steps; index += 1) {
        const candidateIndex = moveSelectableIndex(memberRows, nextIndex, delta);
        if (!wrap && candidateIndex === nextIndex) {
          break;
        }
        nextIndex = candidateIndex;
      }
      memberIndex = nextIndex;
      selectedMemberThreadId = selectedThreadIdFromRow(memberRows, memberIndex);
      loadSelectedThreadDetail(false);
      resetDetailScroll();
      status = selectedMemberThreadId !== null ? `Selected #${threadDetail?.thread.number ?? '?'}` : 'No selectable member';
      render();
    }
  };

  const getFocusedListPageSize = (): number => {
    const listHeight = focusPane === 'clusters' ? Number(widgets.clusters.height) : Number(widgets.members.height);
    return Math.max(1, listHeight - 4);
  };

  const pageFocusedPane = (delta: -1 | 1): void => {
    if (focusPane === 'detail') {
      scrollDetail(delta * 12);
      return;
    }
    moveSelection(delta, { steps: getFocusedListPageSize(), wrap: false });
  };

  const promptFilter = (): void => {
    modalOpen = true;
    const prompt = blessed.prompt({
      parent: widgets.screen,
      border: 'line',
      height: 7,
      width: '60%',
      top: 'center',
      left: 'center',
      label: ' Cluster Filter ',
      tags: true,
      keys: true,
      vi: true,
      style: {
        border: { fg: 'cyan' },
        bg: '#101522',
      },
    });
    prompt.input('Filter clusters', search, (_error, value) => {
      search = (value ?? '').trim();
      status = search ? `Filter: ${search}` : 'Filter cleared';
      refreshAll(false);
      prompt.destroy();
      modalOpen = false;
      updateFocus('clusters');
    });
  };

  const promptThreadJump = (): void => {
    if (modalOpen) return;
    modalOpen = true;
    const prompt = blessed.prompt({
      parent: widgets.screen,
      border: 'line',
      height: 7,
      width: '60%',
      top: 'center',
      left: 'center',
      label: ' Jump To Issue/PR ',
      tags: true,
      keys: true,
      vi: true,
      style: {
        border: { fg: '#fde74c' },
        bg: '#101522',
      },
    });
    prompt.input('Issue or PR number', '', (_error, value) => {
      prompt.destroy();
      modalOpen = false;
      const parsed = Number((value ?? '').trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        status = 'Enter a positive issue or PR number';
        render();
        return;
      }
      try {
        const detail = params.service.getTuiThreadDetail({
          owner: currentRepository.owner,
          repo: currentRepository.repo,
          threadNumber: parsed,
          includeNeighbors: false,
        });
        const jumped = jumpToThread(detail.thread.id, detail.thread.clusterId ?? null);
        if (jumped) {
          status = `Jumped to #${detail.thread.number} in cluster ${detail.thread.clusterId ?? '?'}`;
          updateFocus('members');
          return;
        }
        render();
      } catch (error) {
        status = error instanceof Error ? error.message : `Thread #${parsed} was not found`;
        render();
      }
    });
  };

  const openSelectedThread = (): void => {
    const url = threadDetail?.thread.htmlUrl;
    if (!url) {
      status = 'No thread selected to open';
      render();
      return;
    }
    openUrl(url);
    status = `Opened ${url}`;
    render();
  };

  const openHelp = (): void => {
    if (modalOpen) return;
    void (async () => {
      modalOpen = true;
      try {
        await promptHelp(widgets.screen);
        render();
      } finally {
        modalOpen = false;
      }
    })();
  };

  const requestQuit = (): void => {
    if (modalOpen) return;
    widgets.screen.destroy();
  };

  const persistRepositoryPreference = (): void => {
    writeTuiRepositoryPreference(params.service.config, {
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      minClusterSize: minSize,
      sortMode,
      wideLayout,
    });
  };

  const withLoadingOverlay = async <T>(message: string, task: () => T | Promise<T>): Promise<T> => {
    const box = blessed.box({
      parent: widgets.screen,
      border: 'line',
      label: ' Loading ',
      width: '56%',
      height: 7,
      top: 'center',
      left: 'center',
      tags: true,
      content: `${message}\n\nThis can take a few seconds on large repos.`,
      style: {
        border: { fg: '#5bc0eb' },
        fg: 'white',
        bg: '#101522',
      },
    });
    widgets.screen.render();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      return await task();
    } finally {
      box.destroy();
      widgets.screen.render();
    }
  };

  const setRepositoryPending = (
    target: RepositoryTarget,
    overrides?: Partial<{
      minClusterSize: TuiMinSizeFilter;
      sortMode: TuiClusterSortMode;
      status: string;
    }>,
  ): void => {
    currentRepository = target;
    const preference = getTuiRepositoryPreference(params.service.config, target.owner, target.repo);
    minSize = overrides?.minClusterSize ?? preference.minClusterSize;
    sortMode = overrides?.sortMode ?? preference.sortMode;
    wideLayout = preference.wideLayout;
    persistRepositoryPreference();
    clearCaches();
    search = '';
    snapshot = null;
    clusterItems = ['Pick a repository with p'];
    clusterIndexById = new Map();
    widgets.clusters.setItems(clusterItems);
    clusterDetail = null;
    threadDetail = null;
    selectedClusterId = null;
    selectedMemberThreadId = null;
    memberRows = [];
    memberIndex = -1;
    status = overrides?.status ?? `Switched to ${target.owner}/${target.repo}`;
    render();
  };

  const switchRepository = (
    target: RepositoryTarget,
    overrides?: Partial<{
      minClusterSize: TuiMinSizeFilter;
      sortMode: TuiClusterSortMode;
    }>,
  ): void => {
    setRepositoryPending(target, overrides);
    refreshAll(false);
  };

  const browseRepositories = (): void => {
    if (modalOpen) return;

    void (async () => {
      modalOpen = true;
      try {
        const choice = await promptRepositoryChoice(widgets.screen, params.service);
        if (!choice) {
          render();
          return;
        }

        if (choice.kind === 'existing') {
          await withLoadingOverlay(`Opening ${choice.target.owner}/${choice.target.repo}...`, async () => {
            switchRepository(choice.target);
          });
          pushActivity(`[repo] switched to ${choice.target.owner}/${choice.target.repo}`);
          updateFocus('clusters');
          return;
        }

        const target = await promptRepositoryInput(widgets.screen);
        if (!target) {
          render();
          return;
        }
        setRepositoryPending(target, {
          minClusterSize: 1,
          status: `No local data for ${target.owner}/${target.repo}; run sync/embed/cluster in the CLI, then press r`,
        });
        pushActivity(`[repo] selected ${target.owner}/${target.repo}; run ghcrawl sync/embed/cluster from the shell`);
        updateFocus('clusters');
      } catch (error) {
        status = 'Repository action failed';
        pushActivity(`[repo] action failed: ${formatTuiError(error)}`);
      } finally {
        modalOpen = false;
      }
    })();
  };

  const initializeRepositorySelection = async (): Promise<boolean> => {
    if (selectedRepository) {
      return true;
    }

    modalOpen = true;
    try {
      const choice = await promptRepositoryChoice(widgets.screen, params.service);
      if (!choice) {
        return false;
      }

      if (choice.kind === 'existing') {
        await withLoadingOverlay(`Opening ${choice.target.owner}/${choice.target.repo}...`, async () => {
          switchRepository(choice.target);
        });
        pushActivity(`[repo] opened ${choice.target.owner}/${choice.target.repo}`);
        updateFocus('clusters');
        return true;
      }

      const target = await promptRepositoryInput(widgets.screen);
      if (!target) {
        return false;
      }
      setRepositoryPending(target, {
        minClusterSize: 1,
        status: `No local data for ${target.owner}/${target.repo}; run sync/embed/cluster in the CLI, then press r`,
      });
      pushActivity(`[repo] selected ${target.owner}/${target.repo}; run ghcrawl sync/embed/cluster from the shell`);
      updateFocus('clusters');
      return true;
    } catch (error) {
      status = 'Repository selection failed';
      pushActivity(`[repo] selection failed: ${formatTuiError(error)}`);
      return false;
    } finally {
      modalOpen = false;
    }
  };

  widgets.screen.key(['q'], () => {
    requestQuit();
  });
  widgets.screen.key(['C-c'], () => {
    requestQuit();
  });
  widgets.screen.key(['tab', 'right'], () => {
    if (modalOpen) return;
    updateFocus(cycleFocusPane(focusPane, 1));
  });
  widgets.screen.key(['S-tab', 'left'], () => {
    if (modalOpen) return;
    updateFocus(cycleFocusPane(focusPane, -1));
  });
  widgets.screen.key(['down'], () => {
    if (modalOpen) return;
    if (focusPane === 'detail') {
      scrollDetail(3);
      return;
    }
    moveSelection(1);
  });
  widgets.screen.key(['up'], () => {
    if (modalOpen) return;
    if (focusPane === 'detail') {
      scrollDetail(-3);
      return;
    }
    moveSelection(-1);
  });
  widgets.screen.key(['pageup'], () => {
    if (modalOpen) return;
    pageFocusedPane(-1);
  });
  widgets.screen.key(['pagedown'], () => {
    if (modalOpen) return;
    pageFocusedPane(1);
  });
  widgets.screen.key(['home'], () => {
    if (modalOpen) return;
    if (focusPane !== 'detail') return;
    widgets.detail.setScroll(0);
    widgets.screen.render();
  });
  widgets.screen.key(['end'], () => {
    if (modalOpen) return;
    if (focusPane !== 'detail') return;
    widgets.detail.setScrollPerc(100);
    widgets.screen.render();
  });
  widgets.screen.key(['enter'], () => {
    if (modalOpen) return;
    if (focusPane === 'clusters') {
      updateFocus('members');
      return;
    }
    if (focusPane === 'members') {
      loadSelectedThreadDetail(true);
      status = selectedMemberThreadId !== null ? `Loaded neighbors for #${threadDetail?.thread.number ?? '?'}` : status;
      updateFocus('detail');
    }
  });
  widgets.screen.key(['s'], () => {
    if (modalOpen) return;
    sortMode = cycleSortMode(sortMode);
    persistRepositoryPreference();
    status = `Sort: ${sortMode}`;
    refreshAll(false);
  });
  widgets.screen.key(['f'], () => {
    if (modalOpen) return;
    minSize = cycleMinSizeFilter(minSize);
    persistRepositoryPreference();
    status = `Min size: ${minSize === 0 ? 'all' : `${minSize}+`}`;
    refreshAll(false);
  });
  widgets.screen.key(['l'], () => {
    if (modalOpen) return;
    wideLayout = wideLayout === 'columns' ? 'right-stack' : 'columns';
    persistRepositoryPreference();
    status = `Layout: ${wideLayout === 'columns' ? 'three columns' : 'wide left + stacked right'}`;
    render();
  });
  widgets.screen.key(['x'], () => {
    if (modalOpen) return;
    showClosed = !showClosed;
    status = showClosed ? 'Showing closed clusters and members' : 'Hiding closed clusters and members';
    refreshAll(true);
  });
  widgets.screen.key(['/'], () => {
    if (modalOpen) return;
    promptFilter();
  });
  widgets.screen.key(['#'], () => {
    if (modalOpen) return;
    promptThreadJump();
  });
  widgets.screen.key(['h', '?'], () => {
    if (modalOpen) return;
    openHelp();
  });
  widgets.screen.key(['p'], () => browseRepositories());
  widgets.screen.key(['r'], () => {
    if (modalOpen) return;
    status = 'Refreshing';
    refreshAll(true);
  });
  widgets.screen.key(['o'], () => {
    if (modalOpen) return;
    openSelectedThread();
  });
  widgets.screen.on('resize', () => render());

  widgets.screen.on('destroy', () => {
    widgets.screen.program.showCursor();
  });

  widgets.screen.program.hideCursor();
  if (selectedRepository) {
    refreshAll(false);
  } else {
    status = 'Pick a repository';
    render();
    const ready = await initializeRepositorySelection();
    if (!ready) {
      widgets.screen.destroy();
      return;
    }
  }
  updateFocus('clusters');

  await new Promise<void>((resolve) => widgets.screen.once('destroy', () => resolve()));
}

function createWidgets(owner: string, repo: string): Widgets {
  const screen = createScreen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false,
    title: owner && repo ? `ghcrawl ${owner}/${repo}` : 'ghcrawl',
  });
  const header = blessed.box({
    parent: screen,
    tags: true,
    style: { fg: 'white', bg: '#0d1321' },
  });
  const clusters = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Clusters ',
    tags: true,
    keys: false,
    style: {
      border: { fg: '#5bc0eb' },
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    scrollbar: { ch: ' ' },
  });
  const members = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Members ',
    tags: true,
    keys: false,
    style: {
      border: { fg: '#9bc53d' },
      item: { fg: 'white' },
      selected: { bg: '#9bc53d', fg: 'black', bold: true },
    },
    scrollbar: { ch: ' ' },
  });
  const detail = blessed.box({
    parent: screen,
    border: 'line',
    label: ' Detail ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: false,
    scrollbar: { ch: ' ' },
    style: {
      border: { fg: '#fde74c' },
      fg: 'white',
    },
  });
  const footer = blessed.box({
    parent: screen,
    tags: false,
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  return { screen, header, clusters, members, detail, footer };
}

function updatePaneStyles(widgets: Widgets, focus: TuiFocusPane): void {
  widgets.clusters.style.border = { fg: focus === 'clusters' ? 'white' : '#5bc0eb' };
  widgets.members.style.border = { fg: focus === 'members' ? 'white' : '#9bc53d' };
  widgets.detail.style.border = { fg: focus === 'detail' ? 'white' : '#fde74c' };
}

export function renderDetailPane(
  threadDetail: TuiThreadDetail | null,
  clusterDetail: TuiClusterDetail | null,
  focusPane: TuiFocusPane,
): string {
  if (!clusterDetail) {
    return 'No cluster selected.\n\nRun `ghcrawl cluster owner/repo` if you have not clustered this repository yet.';
  }
  if (!threadDetail) {
    const representativeLabel =
      clusterDetail.representativeNumber !== null && clusterDetail.representativeKind !== null
        ? ` (#${clusterDetail.representativeNumber} representative ${clusterDetail.representativeKind === 'pull_request' ? 'pr' : 'issue'})`
        : '';
    return `{bold}Cluster ${clusterDetail.clusterId}${escapeBlessedText(representativeLabel)}{/bold}\n${escapeBlessedText(clusterDetail.displayTitle)}\n\nSelect a member to inspect thread details.`;
  }

  const thread = threadDetail.thread;
  const representativeLabel =
    clusterDetail.representativeNumber !== null && clusterDetail.representativeKind !== null
      ? ` (#${clusterDetail.representativeNumber} representative ${clusterDetail.representativeKind === 'pull_request' ? 'pr' : 'issue'})`
      : '';
  const labels = thread.labels.length > 0 ? escapeBlessedText(thread.labels.join(', ')) : 'none';
  const closedLabel = thread.isClosed
    ? `{bold}Closed:{/bold} ${escapeBlessedText(thread.closedAtLocal ?? thread.closedAtGh ?? 'yes')} ${thread.closeReasonLocal ? `(${escapeBlessedText(thread.closeReasonLocal)})` : ''}`.trimEnd()
    : '{bold}Closed:{/bold} no';
  const summaries = Object.entries(threadDetail.summaries)
    .map(([key, value]) => {
      const label = key === 'dedupe_summary' ? 'LLM Summary' : key;
      return `{bold}${escapeBlessedText(label)}:{/bold}\n${escapeBlessedText(value)}`;
    })
    .join('\n\n');
  const neighbors =
    threadDetail.neighbors.length > 0
      ? threadDetail.neighbors
          .map((neighbor) => `#${neighbor.number} ${neighbor.kind} ${(neighbor.score * 100).toFixed(1)}%  ${escapeBlessedText(neighbor.title)}`)
          .join('\n')
      : focusPane === 'detail'
        ? 'No neighbors available.'
        : 'Neighbors load when the detail pane is focused.';
  return [
    `{bold}Cluster ${clusterDetail.clusterId}${escapeBlessedText(representativeLabel)}{/bold}`,
    '',
    `{bold}${thread.kind} #${thread.number}{/bold}  ${escapeBlessedText(thread.title)}`,
    '',
    `{bold}Author:{/bold} ${escapeBlessedText(thread.authorLogin ?? 'unknown')}`,
    closedLabel,
    `{bold}Updated:{/bold} ${thread.updatedAtGh ?? 'unknown'}`,
    `{bold}Labels:{/bold} ${labels}`,
    `{bold}URL:{/bold} ${escapeBlessedText(thread.htmlUrl)}`,
    summaries ? `\n\n${summaries}` : '',
    '',
    `{bold}Body{/bold}`,
    escapeBlessedText(thread.body ?? '(no body)'),
    `\n\n{bold}Neighbors{/bold}\n${neighbors}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function escapeBlessedText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function applyRect(element: blessed.Widgets.BoxElement | blessed.Widgets.ListElement, rect: { top: number; left: number; width: number; height: number }): void {
  element.top = rect.top;
  element.left = rect.left;
  element.width = rect.width;
  element.height = rect.height;
}

function openUrl(url: string): void {
  const launch =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] };
  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: process.platform === 'win32',
  });
  child.unref();
}

export function buildHelpContent(): string {
  return [
    '{bold}ghcrawl TUI Help{/bold}',
    '',
    '{bold}Navigation{/bold}',
    'Tab / Shift-Tab  cycle focus across clusters, members, and detail',
    'Left / Right      cycle focus backward or forward across panes',
    'Up / Down         move selection, or scroll detail when detail is focused',
    'Enter             clusters -> members, members -> detail',
    'PgUp / PgDn       page through the focused pane or this help popup faster',
    'Home / End        jump to the top or bottom of detail or help',
    '',
    '{bold}Views And Filters{/bold}',
    '#                 jump directly to an issue or PR number',
    's                 cycle cluster sort mode',
    'f                 cycle minimum cluster size filter',
    'l                 toggle wide layout: columns vs. wide-left stacked-right',
    'x                 show or hide locally closed clusters and members',
    '/                 filter clusters by title/member text',
    'r                 refresh the current local view from SQLite',
    '',
    '{bold}Actions{/bold}',
    'p                 open the repository browser / select another local repository',
    'o                 open the selected thread URL in your browser',
    '',
    '{bold}Help And Exit{/bold}',
    'h or ?            open this help popup',
    'q                 quit the TUI or close this popup',
    'Esc               close this popup',
    '',
    '{bold}Notes{/bold}',
    'The TUI only reads local SQLite. Run ghcrawl sync, ghcrawl embed, and ghcrawl cluster from the shell to update data.',
    'The default cluster filter is 1+, so solo clusters are visible unless you raise it with f.',
    'Clusters show C<clusterId> so the cluster id is easy to copy into CLI or skill flows.',
    'The footer only shows the short command list. Open help to see the full list.',
    'This popup scrolls. Use arrows, PgUp/PgDn, Home, and End if it does not fit.',
  ].join('\n');
}

async function promptHelp(screen: blessed.Widgets.Screen): Promise<void> {
  const modalWidth = '86%';
  const box = blessed.box({
    parent: screen,
    border: 'line',
    label: ' Help ',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: false,
    top: 'center',
    left: 'center',
    width: modalWidth,
    height: '80%',
    padding: {
      left: 1,
      right: 1,
    },
    scrollbar: {
      ch: ' ',
    },
    style: {
      border: { fg: '#5bc0eb' },
      fg: 'white',
      bg: '#101522',
      scrollbar: { bg: '#5bc0eb' },
    },
    content: buildHelpContent(),
  });
  const help = blessed.box({
    parent: screen,
    width: modalWidth,
    height: 1,
    bottom: 1,
    left: 'center',
    tags: false,
    content: 'Scroll with arrows, PgUp/PgDn, Home, End. Press Esc, q, h, ?, or Enter to close.',
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  box.focus();
  box.setScroll(0);
  screen.render();

  return await new Promise<void>((resolve) => {
    const finish = (): void => {
      screen.off('keypress', handleKeypress);
      box.destroy();
      help.destroy();
      screen.render();
      resolve();
    };
    const handleKeypress = (char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape' || key.name === 'enter' || key.name === 'q' || key.name === 'h' || char === '?') {
        finish();
        return;
      }
      if (key.name === 'pageup') {
        box.scroll(-12);
        screen.render();
        return;
      }
      if (key.name === 'pagedown') {
        box.scroll(12);
        screen.render();
        return;
      }
      if (key.name === 'home') {
        box.setScroll(0);
        screen.render();
        return;
      }
      if (key.name === 'end') {
        box.setScrollPerc(100);
        screen.render();
      }
    };

    screen.on('keypress', handleKeypress);
  });
}

export function getRepositoryChoices(service: Pick<GHCrawlService, 'listRepositories'>, now: Date = new Date()): RepositoryChoice[] {
  const repositories = service.listRepositories().repositories
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.fullName.localeCompare(right.fullName));

  return [
    ...repositories.map((repository) => ({
      kind: 'existing' as const,
      target: { owner: repository.owner, repo: repository.name },
      label: `${repository.fullName}  ${formatRelativeTime(repository.updatedAt, now)}`,
    })),
    { kind: 'new' as const, label: '+ Select another repository path' },
  ];
}

async function promptRepositoryChoice(
  screen: blessed.Widgets.Screen,
  service: GHCrawlService,
): Promise<RepositoryChoice | null> {
  const choices = getRepositoryChoices(service);
  const box = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Repositories ',
    keys: true,
    vi: true,
    mouse: false,
    top: 'center',
    left: 'center',
    width: '70%',
    height: '70%',
    style: {
      border: { fg: '#5bc0eb' },
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    items: choices.map((choice) => choice.label),
  });
  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Select a repository with Enter. Press n for a new repo. Esc cancels.',
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  box.focus();
  box.select(0);
  screen.render();

  return await new Promise<RepositoryChoice | null>((resolve) => {
    const teardown = (): void => {
      screen.off('keypress', handleKeypress);
      box.destroy();
      help.destroy();
      screen.render();
    };
    const finish = (value: RepositoryChoice | null): void => {
      teardown();
      resolve(value);
    };
    const handleKeypress = (_char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape' || key.name === 'q') {
        finish(null);
        return;
      }
      if (key.name === 'n') {
        const newIndex = choices.findIndex((choice) => choice.kind === 'new');
        if (newIndex >= 0) {
          box.select(newIndex);
          screen.render();
        }
      }
    };

    screen.on('keypress', handleKeypress);
    box.on('select', (_item, index) => finish(choices[index] ?? null));
  });
}

async function promptRepositoryInput(screen: blessed.Widgets.Screen): Promise<RepositoryTarget | null> {
  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    height: 7,
    width: '60%',
    top: 'center',
    left: 'center',
    label: ' Repository ',
    tags: true,
    keys: true,
    vi: true,
    style: {
      border: { fg: 'cyan' },
      bg: '#101522',
    },
  });

  return await new Promise<RepositoryTarget | null>((resolve) => {
    prompt.input('Repository to open (owner/repo)', '', (_error, value) => {
      prompt.destroy();
      const parsed = parseOwnerRepoValue((value ?? '').trim());
      resolve(parsed);
    });
  });
}

export function parseOwnerRepoValue(value: string): { owner: string; repo: string } | null {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function formatActivityTimestamp(now: Date = new Date()): string {
  return now.toISOString().slice(11, 19);
}

export function formatClusterDateColumn(value: string | null, locales?: Intl.LocalesArgument): string {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hour = String(parsed.getHours()).padStart(2, '0');
  const minute = String(parsed.getMinutes()).padStart(2, '0');
  const ordering = new Intl.DateTimeFormat(locales, {
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(parsed)
    .filter((part) => part.type === 'month' || part.type === 'day')
    .map((part) => part.type);
  const date = ordering[0] === 'day' ? `${day}-${month}` : `${month}-${day}`;

  return `${date} ${hour}:${minute}`;
}

function formatRelativeTime(value: string | null, now: Date = new Date()): string {
  if (!value) return 'never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const diffMs = Math.max(0, now.getTime() - parsed.getTime());
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${minutes}m ago`;
  }
  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}h ago`;
  }
  if (diffMs < 14 * dayMs) {
    return `${Math.floor(diffMs / dayMs)}d ago`;
  }
  return parsed.toISOString().slice(0, 10);
}
