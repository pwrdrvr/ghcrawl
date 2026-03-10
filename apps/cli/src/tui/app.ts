import { spawn } from 'node:child_process';

import blessed from 'neo-blessed';

import type {
  GHCrawlService,
  TuiClusterDetail,
  TuiClusterSortMode,
  TuiRepoStats,
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

type AuthorThreadChoice = {
  threadId: number;
  clusterId: number | null | undefined;
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

type UpdateTaskSelection = {
  sync: boolean;
  embed: boolean;
  cluster: boolean;
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
const UPDATE_TASK_ORDER: Array<keyof UpdateTaskSelection> = ['sync', 'embed', 'cluster'];

export async function startTui(params: StartTuiParams): Promise<void> {
  const selectedRepository = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : null;
  let currentRepository = selectedRepository ?? { owner: '', repo: '' };
  const widgets = createWidgets(currentRepository.owner, currentRepository.repo);

  let focusPane: TuiFocusPane = 'clusters';
  const initialPreference = selectedRepository
    ? getTuiRepositoryPreference(params.service.config, currentRepository.owner, currentRepository.repo)
    : { sortMode: 'recent' as TuiClusterSortMode, minClusterSize: 10 as TuiMinSizeFilter, wideLayout: 'columns' as TuiWideLayoutPreference };
  let sortMode: TuiClusterSortMode = initialPreference.sortMode;
  let minSize: TuiMinSizeFilter = initialPreference.minClusterSize;
  let wideLayout: TuiWideLayoutPreference = initialPreference.wideLayout;
  let showClosed = true;
  let search = '';
  let snapshot: TuiSnapshot | null = null;
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
  let syncJobRunning = false;
  let embedJobRunning = false;
  let clusterJobRunning = false;
  let modalOpen = false;

  const clearCaches = (): void => {
    clusterDetailCache.clear();
    threadDetailCache.clear();
  };

  const pushActivity = (message: string): void => {
    activityLines.push(`${formatActivityTimestamp()} ${message}`);
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
      clusterDetail = loadClusterDetail(cluster.clusterId);
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

    if (selectedClusterId !== null) {
      clusterDetail = loadClusterDetail(selectedClusterId);
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

    const clusterItems = snapshot
      ? snapshot.clusters.map((cluster) => {
          const updated = formatClusterDateColumn(cluster.latestUpdatedAt);
          const label = `${String(cluster.totalCount).padStart(3, ' ')}  C${String(cluster.clusterId).padStart(5, ' ')}  ${String(cluster.pullRequestCount).padStart(2, ' ')}P/${String(cluster.issueCount).padStart(2, ' ')}I  ${updated}  ${cluster.displayTitle}`;
          return cluster.isClosed ? `{gray-fg}${escapeBlessedText(label)}{/gray-fg}` : escapeBlessedText(label);
        })
      : ['Pick a repository with p'];
    widgets.clusters.setItems(clusterItems);
    const clusterIndex =
      snapshot && selectedClusterId !== null ? Math.max(0, snapshot.clusters.findIndex((cluster) => cluster.clusterId === selectedClusterId)) : 0;
    widgets.clusters.select(clusterIndex);

    widgets.members.setItems(memberRows.length > 0 ? memberRows.map((row) => row.label) : ['No members']);
    if (memberIndex >= 0) {
      widgets.members.select(memberIndex);
    }

    widgets.detail.setContent(renderDetailPane(threadDetail, clusterDetail, focusPane));
    updatePaneStyles(widgets, focusPane);
    const activeJobs = [syncJobRunning ? 'sync' : null, embedJobRunning ? 'embed' : null, clusterJobRunning ? 'cluster' : null]
      .filter(Boolean)
      .join(', ') || 'idle';
    const logLines = activityLines.slice(-FOOTER_LOG_LINES);
    const footerLines = [...logLines];
    while (footerLines.length < FOOTER_LOG_LINES) {
      footerLines.unshift('');
    }
    footerLines.push(
      `${status}  |  jobs:${activeJobs}  |  h/? help  g update  p repos  u author  / filter  s sort  f min  l layout  x closed`,
    );
    footerLines.push(
      `Tab focus  j/k move-or-scroll  PgUp/PgDn scroll  r refresh  o open  q quit`,
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

  const runSyncStep = async (): Promise<void> => {
    if (syncJobRunning) {
      throw new Error('GitHub reconciliation already running');
    }
    syncJobRunning = true;
    status = 'Running GitHub reconciliation';
    pushActivity('[jobs] starting GitHub reconciliation');
    render();
    try {
      const result = await params.service.syncRepository({
        owner: currentRepository.owner,
        repo: currentRepository.repo,
        onProgress: pushActivity,
      });
      pushActivity(
        `[jobs] GitHub reconciliation complete threads=${result.threadsSynced} comments=${result.commentsSynced} closed=${result.threadsClosed}`,
      );
      refreshAll(true);
    } finally {
      syncJobRunning = false;
      status = 'Ready';
      render();
    }
  };

  const runEmbedStep = async (): Promise<void> => {
    if (embedJobRunning) {
      throw new Error('embed refresh already running');
    }
    embedJobRunning = true;
    status = 'Running embed refresh';
    pushActivity('[jobs] starting embed refresh');
    render();
    try {
      const result = await params.service.embedRepository({
        owner: currentRepository.owner,
        repo: currentRepository.repo,
        onProgress: pushActivity,
      });
      pushActivity(`[jobs] embed refresh complete embeddings=${result.embedded}`);
      refreshAll(true);
    } finally {
      embedJobRunning = false;
      status = 'Ready';
      render();
    }
  };

  const runClusterStep = async (): Promise<void> => {
    if (clusterJobRunning) {
      throw new Error('cluster refresh already running');
    }
    clusterJobRunning = true;
    status = 'Running cluster refresh';
    pushActivity('[jobs] starting cluster refresh');
    render();
    try {
      const result = params.service.clusterRepository({
        owner: currentRepository.owner,
        repo: currentRepository.repo,
        onProgress: pushActivity,
      });
      pushActivity(`[jobs] cluster refresh complete clusters=${result.clusters} edges=${result.edges}`);
      refreshAll(true);
    } finally {
      clusterJobRunning = false;
      status = 'Ready';
      render();
    }
  };

  const moveSelection = (delta: -1 | 1): void => {
    if (!snapshot) return;
    if (focusPane === 'clusters') {
      if (snapshot.clusters.length === 0) return;
      const currentIndex = Math.max(
        0,
        snapshot.clusters.findIndex((cluster) => cluster.clusterId === selectedClusterId),
      );
      const nextIndex = (currentIndex + delta + snapshot.clusters.length) % snapshot.clusters.length;
      selectedClusterId = snapshot.clusters[nextIndex]?.clusterId ?? null;
      if (selectedClusterId !== null) {
        clusterDetail = loadClusterDetail(selectedClusterId);
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
      memberIndex = moveSelectableIndex(memberRows, memberIndex < 0 ? 0 : memberIndex, delta);
      selectedMemberThreadId = selectedThreadIdFromRow(memberRows, memberIndex);
      loadSelectedThreadDetail(false);
      resetDetailScroll();
      status = selectedMemberThreadId !== null ? `Selected #${threadDetail?.thread.number ?? '?'}` : 'No selectable member';
      render();
    }
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

  const promptAuthorThreads = (): void => {
    if (modalOpen) return;
    const authorLogin = threadDetail?.thread.authorLogin?.trim() ?? '';
    if (!authorLogin) {
      status = 'Selected thread has no author login';
      render();
      return;
    }

    void (async () => {
      modalOpen = true;
      try {
        const response = params.service.listAuthorThreads({
          owner: currentRepository.owner,
          repo: currentRepository.repo,
          login: authorLogin,
        });
        const choice = await promptAuthorThreadChoice(widgets.screen, response.authorLogin, response.threads);
        if (!choice) {
          render();
          return;
        }
        jumpToThread(choice.threadId, choice.clusterId);
        updateFocus('members');
      } finally {
        modalOpen = false;
      }
    })();
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

  const promptUpdatePipeline = (): void => {
    if (modalOpen || hasActiveJobs()) {
      if (hasActiveJobs()) {
        pushActivity('[jobs] update pipeline is unavailable while another job is running');
      }
      return;
    }

    void (async () => {
      modalOpen = true;
      try {
        const selection = await promptUpdatePipelineSelection(widgets.screen, snapshot?.stats ?? null);
        if (!selection) {
          render();
          return;
        }
        const selectedTasks = UPDATE_TASK_ORDER.filter((task) => selection[task]).join(' -> ');
        pushActivity(`[jobs] queued update pipeline: ${selectedTasks}`);
        await runUpdatePipeline(selection);
        updateFocus('clusters');
      } finally {
        modalOpen = false;
      }
    })();
  };

  const hasActiveJobs = (): boolean => syncJobRunning || embedJobRunning || clusterJobRunning;

  const runUpdatePipeline = async (selection: UpdateTaskSelection): Promise<boolean> => {
    if (hasActiveJobs()) {
      pushActivity('[jobs] another update pipeline is already running');
      return false;
    }

    try {
      if (selection.sync) {
        await runSyncStep();
      }
      if (selection.embed) {
        await runEmbedStep();
      }
      if (selection.cluster) {
        await runClusterStep();
      }
      return true;
    } catch (error) {
      pushActivity(`[jobs] update pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
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

  const switchRepository = (
    target: RepositoryTarget,
    overrides?: Partial<{
      minClusterSize: TuiMinSizeFilter;
      sortMode: TuiClusterSortMode;
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
    clusterDetail = null;
    threadDetail = null;
    selectedClusterId = null;
    selectedMemberThreadId = null;
    memberRows = [];
    memberIndex = -1;
    status = `Switched to ${target.owner}/${target.repo}`;
    refreshAll(false);
  };

  const runRepositoryBootstrap = async (target: RepositoryTarget): Promise<boolean> => {
    if (hasActiveJobs()) {
      pushActivity('[repo] repository setup is blocked while jobs are already running');
      return false;
    }

    status = `Bootstrapping ${target.owner}/${target.repo}`;
    render();

    try {
      pushActivity(`[repo] starting initial update pipeline for ${target.owner}/${target.repo}`);
      const previousRepository = currentRepository;
      let ok = false;
      try {
        currentRepository = target;
        ok = await runUpdatePipeline({ sync: true, embed: true, cluster: true });
      } finally {
        currentRepository = previousRepository;
      }
      if (!ok) {
        return false;
      }
      pushActivity(`[repo] initial setup complete for ${target.owner}/${target.repo}`);
      switchRepository(target, { minClusterSize: 1 });
      return true;
    } catch (error) {
      pushActivity(
        `[repo] initial setup failed for ${target.owner}/${target.repo}: ${error instanceof Error ? error.message : String(error)}`,
      );
      status = 'Ready';
      render();
      return false;
    }
  };

  const browseRepositories = (): void => {
    if (modalOpen) return;
    if (hasActiveJobs()) {
      pushActivity('[repo] repository switching is disabled while jobs are running');
      return;
    }

    void (async () => {
      modalOpen = true;
      try {
        const choice = await promptRepositoryChoice(widgets.screen, params.service);
        if (!choice) {
          render();
          return;
        }

        if (choice.kind === 'existing') {
          switchRepository(choice.target);
          pushActivity(`[repo] switched to ${choice.target.owner}/${choice.target.repo}`);
          updateFocus('clusters');
          return;
        }

        const target = await promptRepositoryInput(widgets.screen);
        if (!target) {
          render();
          return;
        }
        await runRepositoryBootstrap(target);
        updateFocus('clusters');
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
        switchRepository(choice.target);
        pushActivity(`[repo] opened ${choice.target.owner}/${choice.target.repo}`);
        updateFocus('clusters');
        return true;
      }

      const target = await promptRepositoryInput(widgets.screen);
      if (!target) {
        return false;
      }
      const ready = await runRepositoryBootstrap(target);
      if (!ready) {
        return false;
      }
      updateFocus('clusters');
      return true;
    } finally {
      modalOpen = false;
    }
  };

  widgets.screen.key(['q', 'C-c'], () => {
    widgets.screen.destroy();
  });
  widgets.screen.key(['tab'], () => {
    if (modalOpen) return;
    updateFocus(cycleFocusPane(focusPane, 1));
  });
  widgets.screen.key(['S-tab'], () => {
    if (modalOpen) return;
    updateFocus(cycleFocusPane(focusPane, -1));
  });
  widgets.screen.key(['j', 'down'], () => {
    if (modalOpen) return;
    if (focusPane === 'detail') {
      scrollDetail(3);
      return;
    }
    moveSelection(1);
  });
  widgets.screen.key(['k', 'up'], () => {
    if (modalOpen) return;
    if (focusPane === 'detail') {
      scrollDetail(-3);
      return;
    }
    moveSelection(-1);
  });
  widgets.screen.key(['pageup'], () => {
    if (modalOpen) return;
    scrollDetail(-12);
  });
  widgets.screen.key(['pagedown'], () => {
    if (modalOpen) return;
    scrollDetail(12);
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
  widgets.screen.key(['h', '?'], () => {
    if (modalOpen) return;
    openHelp();
  });
  widgets.screen.key(['p'], () => browseRepositories());
  widgets.screen.key(['g'], () => {
    if (modalOpen) return;
    promptUpdatePipeline();
  });
  widgets.screen.key(['r'], () => {
    if (modalOpen) return;
    status = 'Refreshing';
    refreshAll(true);
  });
  widgets.screen.key(['o'], () => {
    if (modalOpen) return;
    openSelectedThread();
  });
  widgets.screen.key(['u'], () => {
    if (modalOpen) return;
    promptAuthorThreads();
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
  pushActivity('[jobs] press g to run the staged update pipeline: GitHub sync, embeddings, then clusters');
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
    .map(([key, value]) => `{bold}${key}:{/bold}\n${escapeBlessedText(value)}`)
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
    '',
    `{bold}Body{/bold}`,
    escapeBlessedText(thread.body ?? '(no body)'),
    summaries ? `\n\n${summaries}` : '',
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

export function describeUpdateTask(
  task: keyof UpdateTaskSelection,
  stats: TuiRepoStats | null,
  now: Date = new Date(),
): string {
  if (!stats) {
    if (task === 'sync') return 'recommended';
    if (task === 'embed') return 'recommended after sync';
    return 'recommended after embeddings';
  }

  if (task === 'sync') {
    return stats.lastGithubReconciliationAt
      ? `up to date, last ${formatRelativeTime(stats.lastGithubReconciliationAt, now)}`
      : 'never run';
  }

  if (task === 'embed') {
    if (!stats.lastEmbedRefreshAt) return 'never run';
    if (stats.staleEmbedThreadCount > 0) {
      return `outdated: ${stats.staleEmbedThreadCount} stale, last ${formatRelativeTime(stats.lastEmbedRefreshAt, now)}`;
    }
    const syncMs = parseDateOrNull(stats.lastGithubReconciliationAt);
    const embedMs = parseDateOrNull(stats.lastEmbedRefreshAt);
    if (syncMs !== null && embedMs !== null && embedMs < syncMs) {
      return `outdated: GitHub is newer by ${formatAge(syncMs - embedMs)}`;
    }
    return `up to date, last ${formatRelativeTime(stats.lastEmbedRefreshAt, now)}`;
  }

  if (!stats.latestClusterRunFinishedAt) return 'never run';
  const embedMs = parseDateOrNull(stats.lastEmbedRefreshAt);
  const clusterMs = parseDateOrNull(stats.latestClusterRunFinishedAt);
  if (embedMs !== null && clusterMs !== null && clusterMs < embedMs) {
    return `outdated: embeddings are newer by ${formatAge(embedMs - clusterMs)}`;
  }
  return `up to date, last ${formatRelativeTime(stats.latestClusterRunFinishedAt, now)}`;
}

export function buildUpdatePipelineLabels(
  stats: TuiRepoStats | null,
  selection: UpdateTaskSelection,
  now: Date = new Date(),
): string[] {
  return UPDATE_TASK_ORDER.map((task) => {
    const mark = selection[task] ? '[x]' : '[ ]';
    const title = task === 'sync' ? 'GitHub sync/reconcile' : task === 'embed' ? 'Embed refresh' : 'Cluster rebuild';
    return `${mark} ${title}  ${describeUpdateTask(task, stats, now)}`;
  });
}

export function buildHelpContent(): string {
  return [
    '{bold}ghcrawl TUI Help{/bold}',
    '',
    '{bold}Navigation{/bold}',
    'Tab / Shift-Tab  cycle focus across clusters, members, and detail',
    'j / k             move selection, or scroll detail when detail is focused',
    'Up / Down         same as j / k',
    'Enter             clusters -> members, members -> detail',
    'PgUp / PgDn       scroll detail or this help popup faster',
    'Home / End        jump to the top or bottom of detail or help',
    '',
    '{bold}Views And Filters{/bold}',
    's                 cycle cluster sort mode',
    'f                 cycle minimum cluster size filter',
    'l                 toggle wide layout: columns vs. wide-left stacked-right',
    'x                 show or hide locally closed clusters and members',
    '/                 filter clusters by title/member text',
    'r                 refresh the current local view from SQLite',
    '',
    '{bold}Actions{/bold}',
    'g                 open the staged update pipeline (GitHub, embeddings, clusters)',
    'p                 open the repository browser / sync a new repository',
    'u                 show all open threads for the selected author',
    'o                 open the selected thread URL in your browser',
    '',
    '{bold}Help And Exit{/bold}',
    'h or ?            open this help popup',
    'q                 quit the TUI (or close this popup)',
    'Esc               close this popup',
    '',
    '{bold}Notes{/bold}',
    'Clusters show C<clusterId> so the cluster id is easy to copy into CLI or skill flows.',
    'The footer only shows the short command list. Open help to see the full list.',
    'This popup scrolls. Use j/k, arrows, PgUp/PgDn, Home, and End if it does not fit.',
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
    content: 'Scroll with j/k, arrows, PgUp/PgDn, Home, End. Press Esc, q, h, ?, or Enter to close.',
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

async function promptUpdatePipelineSelection(
  screen: blessed.Widgets.Screen,
  stats: TuiRepoStats | null,
): Promise<UpdateTaskSelection | null> {
  const selection: UpdateTaskSelection = { sync: true, embed: true, cluster: true };
  const modalWidth = '76%';
  const box = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Update Pipeline ',
    keys: true,
    vi: true,
    mouse: false,
    top: 'center',
    left: 'center',
    width: modalWidth,
    height: 11,
    style: {
      border: { fg: '#5bc0eb' },
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    items: buildUpdatePipelineLabels(stats, selection),
  });
  const help = blessed.box({
    parent: screen,
    top: 'center-4',
    left: 'center',
    width: modalWidth,
    height: 4,
    style: { fg: 'white', bg: '#101522' },
    content:
      'Usually you want all three. Run order is fixed: GitHub sync/reconcile -> embeddings -> clusters.\n' +
      'Toggle with space, move with j/k or arrows, Enter to start, Esc to cancel.',
  });

  box.focus();
  box.select(0);
  screen.render();

  return await new Promise<UpdateTaskSelection | null>((resolve) => {
    const getSelectedIndex = (): number => {
      const selectedIndex = (box as blessed.Widgets.ListElement & { selected?: number }).selected;
      return typeof selectedIndex === 'number' && selectedIndex >= 0 ? selectedIndex : 0;
    };
    const refreshItems = (): void => {
      const selectedIndex = getSelectedIndex();
      box.setItems(buildUpdatePipelineLabels(stats, selection));
      box.select(selectedIndex);
      screen.render();
    };
    const finish = (value: UpdateTaskSelection | null): void => {
      screen.off('keypress', handleKeypress);
      box.destroy();
      help.destroy();
      screen.render();
      resolve(value);
    };
    const handleKeypress = (_char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape') {
        finish(null);
        return;
      }
      if (key.name === 'space') {
        const index = getSelectedIndex();
        const task = UPDATE_TASK_ORDER[index];
        if (!task) return;
        selection[task] = !selection[task];
        if (!selection.sync && !selection.embed && !selection.cluster) {
          selection[task] = true;
        }
        refreshItems();
      }
    };

    screen.on('keypress', handleKeypress);
    box.on('select', () => finish({ ...selection }));
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
    { kind: 'new' as const, label: '+ Sync a new repository' },
  ];
}

async function promptAuthorThreadChoice(
  screen: blessed.Widgets.Screen,
  authorLogin: string,
  threads: ReturnType<GHCrawlService['listAuthorThreads']>['threads'],
): Promise<AuthorThreadChoice | null> {
  const choices: AuthorThreadChoice[] = threads.map((item) => {
    const match = item.strongestSameAuthorMatch;
    const matchLabel = match ? `  sim:${(match.score * 100).toFixed(1)}% -> #${match.number}` : '  sim:none';
    const clusterLabel = item.thread.clusterId ? `C${item.thread.clusterId}` : 'C-';
    return {
      threadId: item.thread.id,
      clusterId: item.thread.clusterId,
      label: `#${item.thread.number} ${item.thread.kind === 'pull_request' ? 'pr' : 'issue'} ${clusterLabel}${matchLabel}  ${item.thread.title}`,
    };
  });

  const box = blessed.list({
    parent: screen,
    border: 'line',
    label: ` @${authorLogin} Threads `,
    keys: true,
    vi: true,
    mouse: false,
    top: 'center',
    left: 'center',
    width: '80%',
    height: '70%',
    style: {
      border: { fg: '#fde74c' },
      item: { fg: 'white' },
      selected: { bg: '#fde74c', fg: 'black', bold: true },
    },
    items: choices.length > 0 ? choices.map((choice) => choice.label) : ['No open threads for this author'],
  });
  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Enter jumps to the selected thread. Esc cancels.',
    style: { fg: 'black', bg: '#fde74c' },
  });

  box.focus();
  box.select(0);
  screen.render();

  return await new Promise<AuthorThreadChoice | null>((resolve) => {
    const teardown = (): void => {
      screen.off('keypress', handleKeypress);
      box.destroy();
      help.destroy();
      screen.render();
    };
    const finish = (value: AuthorThreadChoice | null): void => {
      teardown();
      resolve(value);
    };
    const handleKeypress = (_char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape') {
        finish(null);
      }
    };

    screen.on('keypress', handleKeypress);
    box.on('select', (_item, index) => finish(choices[index] ?? null));
  });
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
      if (key.name === 'escape') {
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
    prompt.input('Repository to sync (owner/repo)', '', (_error, value) => {
      prompt.destroy();
      const parsed = parseOwnerRepoValue((value ?? '').trim());
      resolve(parsed);
    });
  });
}

async function runColdStartSetup(
  service: GHCrawlService,
  screen: blessed.Widgets.Screen,
  target: RepositoryTarget,
  log?: blessed.Widgets.Log,
  footer?: blessed.Widgets.BoxElement,
): Promise<boolean> {
  log?.log(`[setup] starting initial setup for ${target.owner}/${target.repo}`);
  footer?.setContent('Running initial sync, embed, and cluster. This can take a while.');
  screen.render();

  try {
    const reporter = (message: string): void => {
      log?.log(message);
      screen.render();
    };
    await service.syncRepository({
      owner: target.owner,
      repo: target.repo,
      onProgress: reporter,
    });
    await service.embedRepository({
      owner: target.owner,
      repo: target.repo,
      onProgress: reporter,
    });
    service.clusterRepository({
      owner: target.owner,
      repo: target.repo,
      onProgress: reporter,
    });
    writeTuiRepositoryPreference(service.config, {
      owner: target.owner,
      repo: target.repo,
      minClusterSize: 1,
      sortMode: 'recent',
      wideLayout: 'columns',
    });
    log?.log('[setup] initial setup complete');
    return true;
  } catch (error) {
    log?.log(`[setup] failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
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

function parseDateOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
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

function formatAge(diffMs: number): string {
  const safeDiffMs = Math.max(0, diffMs);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (safeDiffMs < hourMs) {
    return `${Math.max(1, Math.floor(safeDiffMs / minuteMs))}m`;
  }
  if (safeDiffMs < dayMs) {
    return `${Math.floor(safeDiffMs / hourMs)}h`;
  }
  if (safeDiffMs < 14 * dayMs) {
    return `${Math.floor(safeDiffMs / dayMs)}d`;
  }
  return `${Math.floor(safeDiffMs / dayMs)}d`;
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
