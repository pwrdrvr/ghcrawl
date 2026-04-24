import { spawn, spawnSync } from 'node:child_process';

import blessed from 'neo-blessed';

import type {
  GHCrawlService,
  TuiClusterDetail,
  TuiClusterSummary,
  TuiClusterSortMode,
  TuiSnapshot,
  TuiThreadDetail,
  TuiWideLayoutPreference,
} from '@ghcrawl/api-core';
import { getTuiRepositoryPreference, writeTuiRepositoryPreference } from '@ghcrawl/api-core';
import {
  buildMemberRows,
  cycleMemberSortMode,
  cycleFocusPane,
  cycleMinSizeFilter,
  cycleSortMode,
  findSelectableIndex,
  formatRelativeTime,
  moveSelectableIndex,
  preserveSelectedId,
  resolveMemberHeaderSortFromClick,
  type MemberListRow,
  type TuiFocusPane,
  type TuiMemberSortMode,
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

type MouseEventArg = blessed.Widgets.Events.IMouseEventArg & {
  button?: 'left' | 'middle' | 'right' | 'unknown';
};

export type ThreadContextAction =
  | 'open'
  | 'copy-url'
  | 'copy-title'
  | 'copy-markdown-link'
  | 'open-first-link'
  | 'copy-first-link'
  | 'load-neighbors'
  | 'close';

export type ThreadContextMenuItem = {
  label: string;
  action: ThreadContextAction;
};

type ContextMenuItem = {
  label: string;
  run: () => boolean | void;
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
const FOOTER_LOG_LINES = 1;
const CLUSTER_LIST_HEADER_INDEX = 0;
const CLUSTER_LIST_FIRST_ITEM_INDEX = 1;
const CLUSTER_COUNT_WIDTH = 3;
const CLUSTER_NAME_WIDTH = 22;
const CLUSTER_TITLE_WIDTH = 56;
const CLUSTER_MIX_WIDTH = 7;
const CLUSTER_UPDATED_WIDTH = 8;
const CLUSTER_COLUMN_GAP = 2;
const CLUSTER_NAME_START = CLUSTER_COUNT_WIDTH + CLUSTER_COLUMN_GAP;
const CLUSTER_TITLE_START = CLUSTER_NAME_START + CLUSTER_NAME_WIDTH + CLUSTER_COLUMN_GAP;
const CLUSTER_MIX_START = CLUSTER_TITLE_START + CLUSTER_TITLE_WIDTH + CLUSTER_COLUMN_GAP;
const CLUSTER_UPDATED_START = CLUSTER_MIX_START + CLUSTER_MIX_WIDTH + CLUSTER_COLUMN_GAP;

export async function startTui(params: StartTuiParams): Promise<void> {
  const selectedRepository = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : null;
  let currentRepository = selectedRepository ?? { owner: '', repo: '' };
  const widgets = createWidgets(currentRepository.owner, currentRepository.repo);

  let focusPane: TuiFocusPane = 'clusters';
  let isRendering = false;
  const initialPreference = selectedRepository
    ? getTuiRepositoryPreference(params.service.config, currentRepository.owner, currentRepository.repo)
    : { sortMode: 'size' as TuiClusterSortMode, minClusterSize: 1 as TuiMinSizeFilter, wideLayout: 'columns' as TuiWideLayoutPreference };
  let sortMode: TuiClusterSortMode = initialPreference.sortMode;
  let memberSortMode: TuiMemberSortMode = 'kind';
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
  let suppressNextClusterSelect = false;
  let suppressNextMemberSelect = false;

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
    clusterItems = [`{bold}${formatClusterListHeader(sortMode)}{/bold}`];
    clusterItems.push(...snapshot.clusters.map((cluster, index) => {
      clusterIndexById.set(cluster.clusterId, index + CLUSTER_LIST_FIRST_ITEM_INDEX);
      const label = formatClusterListLabel(cluster);
      return cluster.isClosed ? `{gray-fg}${escapeBlessedText(label)}{/gray-fg}` : escapeBlessedText(label);
    }));
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
      memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed, sortMode: memberSortMode });
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
      memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed, sortMode: memberSortMode });
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
      `{bold}${repoLabel}{/bold}  {cyan-fg}${snapshot?.stats.openPullRequestCount ?? 0} PR{/cyan-fg}  {green-fg}${snapshot?.stats.openIssueCount ?? 0} issues{/green-fg}  GH:${ghStatus}  Emb:${embedStatus}  Cl:${clusterStatus}  sort:${sortMode}  members:${memberSortMode}  min:${minSize === 0 ? 'all' : `${minSize}+`}  layout:${wideLayout === 'columns' ? 'cols' : 'stack'}  closed:${showClosed ? 'shown' : 'hidden'}  filter:${search || 'none'}`,
    );

    isRendering = true;
    try {
      const clusterIndex =
        snapshot && selectedClusterId !== null ? Math.max(CLUSTER_LIST_FIRST_ITEM_INDEX, clusterIndexById.get(selectedClusterId) ?? -1) : CLUSTER_LIST_HEADER_INDEX;
      widgets.clusters.select(clusterIndex);

      widgets.members.setItems(memberRows.length > 0 ? memberRows.map((row) => row.label) : ['No members']);
      if (memberIndex >= 0) {
        widgets.members.select(memberIndex);
      }
    } finally {
      isRendering = false;
    }

    widgets.detail.setContent(renderDetailPane(threadDetail, clusterDetail, focusPane, snapshot));
    updatePaneStyles(widgets, focusPane);
    const footerLines = [
      activityLines.at(-1) ?? status,
      `focus:${focusPane} sort:${sortMode} members:${memberSortMode} min:${minSize === 0 ? 'all' : `${minSize}+`}  Tab focus  / filter  s sort  m members  f min  o open  h help`,
    ];
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
      const currentIndex = Math.max(
        CLUSTER_LIST_FIRST_ITEM_INDEX,
        selectedClusterId === null ? CLUSTER_LIST_FIRST_ITEM_INDEX : (clusterIndexById.get(selectedClusterId) ?? CLUSTER_LIST_FIRST_ITEM_INDEX),
      );
      let nextIndex = currentIndex + delta * steps;
      if (wrap) {
        const relativeIndex = nextIndex - CLUSTER_LIST_FIRST_ITEM_INDEX;
        nextIndex = ((relativeIndex % snapshot.clusters.length) + snapshot.clusters.length) % snapshot.clusters.length + CLUSTER_LIST_FIRST_ITEM_INDEX;
      } else {
        nextIndex = Math.max(CLUSTER_LIST_FIRST_ITEM_INDEX, Math.min(snapshot.clusters.length, nextIndex));
      }
      selectClusterIndex(nextIndex);
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
      selectMemberIndex(nextIndex);
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

  const setSortMode = (nextSortMode: TuiClusterSortMode): void => {
    if (sortMode === nextSortMode) {
      return;
    }
    sortMode = nextSortMode;
    persistRepositoryPreference();
    status = `Sort: ${sortMode}`;
    refreshAll(true);
  };

  const toggleSortMode = (): void => {
    setSortMode(cycleSortMode(sortMode));
  };

  const toggleClosedVisibility = (): void => {
    showClosed = !showClosed;
    status = showClosed ? 'Showing closed clusters and members' : 'Hiding closed clusters and members';
    refreshAll(true);
  };

  const setMemberSortMode = (nextMemberSortMode: TuiMemberSortMode): void => {
    if (memberSortMode === nextMemberSortMode) {
      return;
    }
    const previousMemberId = selectedMemberThreadId;
    memberSortMode = nextMemberSortMode;
    if (clusterDetail) {
      memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed, sortMode: memberSortMode });
      selectedMemberThreadId = preserveSelectedId(
        memberRows.filter((row) => row.selectable).map((row) => row.threadId),
        previousMemberId,
      );
      memberIndex = findSelectableIndex(memberRows, selectedMemberThreadId);
      loadSelectedThreadDetail(false);
    }
    status = `Member sort: ${memberSortMode}`;
    render();
  };

  const toggleMemberSortMode = (): void => {
    setMemberSortMode(cycleMemberSortMode(memberSortMode));
  };

  const setMinSize = (nextMinSize: TuiMinSizeFilter): void => {
    if (minSize === nextMinSize) {
      return;
    }
    minSize = nextMinSize;
    persistRepositoryPreference();
    status = `Min size: ${minSize === 0 ? 'all' : `${minSize}+`}`;
    refreshAll(true);
  };

  const selectClusterIndex = (nextIndex: number): void => {
    if (!snapshot || snapshot.clusters.length === 0) return;
    if (nextIndex === CLUSTER_LIST_HEADER_INDEX) {
      toggleSortMode();
      return;
    }
    const snapshotIndex = Math.max(0, Math.min(snapshot.clusters.length - 1, nextIndex - CLUSTER_LIST_FIRST_ITEM_INDEX));
    selectedClusterId = snapshot.clusters[snapshotIndex]?.clusterId ?? null;
    if (selectedClusterId !== null) {
      try {
        clusterDetail = loadClusterDetail(selectedClusterId);
      } catch {
        status = 'Cluster data changed; refreshing view';
        refreshAll(true);
        return;
      }
      memberRows = buildMemberRows(clusterDetail, { includeClosedMembers: showClosed, sortMode: memberSortMode });
      selectedMemberThreadId = preserveSelectedId(
        memberRows.filter((row) => row.selectable).map((row) => row.threadId),
        null,
      );
      memberIndex = findSelectableIndex(memberRows, selectedMemberThreadId);
      loadSelectedThreadDetail(false);
      resetDetailScroll();
    }
    status =
      selectedClusterId !== null
        ? `Cluster ${selectedClusterId} (${snapshotIndex + 1}/${snapshot.clusters.length})`
        : `Cluster ${snapshotIndex + 1}/${snapshot.clusters.length}`;
    render();
  };

  const selectMemberIndex = (nextIndex: number): void => {
    if (memberRows.length === 0) return;
    const row = memberRows[nextIndex];
    if (!row?.selectable) {
      render();
      return;
    }
    memberIndex = nextIndex;
    selectedMemberThreadId = row.threadId;
    loadSelectedThreadDetail(false);
    resetDetailScroll();
    status = selectedMemberThreadId !== null ? `Selected #${threadDetail?.thread.number ?? '?'}` : 'No selectable member';
    render();
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

  const openContextMenu = (label: string, items: ContextMenuItem[], event?: MouseEventArg): void => {
    if (modalOpen || items.length === 0) {
      return;
    }
    modalOpen = true;
    const width = Math.max(26, Math.min(42, Math.max(...items.map((item) => item.label.length)) + 4));
    const height = items.length + 2;
    const screenWidth = Number(widgets.screen.width);
    const screenHeight = Number(widgets.screen.height);
    const left = Math.max(0, Math.min((event?.x ?? Math.floor(screenWidth * 0.72)) - 1, screenWidth - width));
    const top = Math.max(0, Math.min((event?.y ?? Math.floor(screenHeight * 0.35)) - 1, screenHeight - height));
    const menu = blessed.list({
      parent: widgets.screen,
      border: 'line',
      top,
      left,
      width,
      height,
      tags: true,
      keys: true,
      mouse: true,
      label: ` ${label} `,
      items: items.map((item) => item.label),
      style: {
        border: { fg: '#fde74c' },
        selected: { bg: '#f7f7ff', fg: 'black', bold: true },
        item: { fg: 'white' },
        bg: '#101522',
      },
    });

    const closeMenu = (): void => {
      menu.destroy();
      modalOpen = false;
      render();
    };
    menu.key(['escape', 'q'], closeMenu);
    menu.on('select', (_item, index) => {
      const item = items[Number(index)];
      closeMenu();
      const shouldRender = item?.run();
      if (shouldRender !== false) {
        render();
      }
    });
    menu.focus();
    widgets.screen.render();
  };

  const threadContextItems = (): ContextMenuItem[] => {
    const selectedThread = threadDetail?.thread;
    if (!selectedThread) {
      return [{ label: 'Close', run: () => undefined }];
    }
    return buildThreadContextMenuItems(threadDetail).map((item) => ({
      label: item.label,
      run: () => {
        if (item.action === 'open') {
          openUrl(selectedThread.htmlUrl);
          status = `Opened ${selectedThread.htmlUrl}`;
        } else if (item.action === 'copy-url') {
          status = copyTextToClipboard(selectedThread.htmlUrl) ? 'Copied URL' : 'Clipboard copy failed';
        } else if (item.action === 'copy-title') {
          status = copyTextToClipboard(`#${selectedThread.number} ${selectedThread.title}`) ? 'Copied title' : 'Clipboard copy failed';
        } else if (item.action === 'copy-markdown-link') {
          const markdownLink = `[#${selectedThread.number} ${selectedThread.title}](${selectedThread.htmlUrl})`;
          status = copyTextToClipboard(markdownLink) ? 'Copied markdown link' : 'Clipboard copy failed';
        } else if (item.action === 'open-first-link') {
          const url = getThreadReferenceLinks(threadDetail).at(0);
          if (url) {
            openUrl(url);
            status = `Opened ${url}`;
          } else {
            status = 'No referenced links found';
          }
        } else if (item.action === 'copy-first-link') {
          const url = getThreadReferenceLinks(threadDetail).at(0);
          status = url ? (copyTextToClipboard(url) ? 'Copied referenced link' : 'Clipboard copy failed') : 'No referenced links found';
        } else if (item.action === 'load-neighbors') {
          loadSelectedThreadDetail(true);
          status = `Loaded neighbors for #${threadDetail?.thread.number ?? selectedThread.number}`;
          focusPane = 'detail';
        }
      },
    }));
  };

  const clusterContextItems = (): ContextMenuItem[] => {
    const selectedCluster = clusterDetail;
    const title = selectedCluster ? splitClusterDisplayTitle(selectedCluster.displayTitle) : null;
    return [
      ...(selectedCluster
        ? [
            { label: 'Focus members', run: () => updateFocus('members') },
            {
              label: 'Copy cluster id',
              run: () => {
                status = copyTextToClipboard(String(selectedCluster.clusterId)) ? `Copied cluster ${selectedCluster.clusterId}` : 'Clipboard copy failed';
              },
            },
            {
              label: 'Copy cluster title',
              run: () => {
                status = copyTextToClipboard(title?.title ?? selectedCluster.displayTitle) ? 'Copied cluster title' : 'Clipboard copy failed';
              },
            },
          ]
        : []),
      { label: 'Sort by size', run: () => setSortMode('size') },
      { label: 'Sort by recent', run: () => setSortMode('recent') },
      { label: 'Member sort grouped', run: () => setMemberSortMode('kind') },
      { label: 'Member sort recent', run: () => setMemberSortMode('recent') },
      { label: 'Member sort number', run: () => setMemberSortMode('number') },
      { label: 'Member sort state', run: () => setMemberSortMode('state') },
      { label: 'Min size 1+', run: () => setMinSize(1) },
      { label: 'Min size 10+', run: () => setMinSize(10) },
      { label: 'Min size all', run: () => setMinSize(0) },
      { label: showClosed ? 'Hide closed' : 'Show closed', run: () => toggleClosedVisibility() },
      { label: 'Filter clusters', run: promptFilter },
      { label: 'Refresh', run: () => refreshAll(true) },
      { label: 'Help', run: openHelp },
    ];
  };

  const globalContextItems = (): ContextMenuItem[] => [
    { label: 'Refresh', run: () => refreshAll(true) },
    { label: 'Repository browser', run: browseRepositories },
    { label: 'Sort by size', run: () => setSortMode('size') },
    { label: 'Sort by recent', run: () => setSortMode('recent') },
    { label: 'Member sort grouped', run: () => setMemberSortMode('kind') },
    { label: 'Member sort recent', run: () => setMemberSortMode('recent') },
    { label: 'Min size 1+', run: () => setMinSize(1) },
    { label: 'Min size 10+', run: () => setMinSize(10) },
    { label: 'Min size all', run: () => setMinSize(0) },
    { label: showClosed ? 'Hide closed' : 'Show closed', run: () => toggleClosedVisibility() },
    { label: 'Help', run: openHelp },
    {
      label: 'Quit',
      run: () => {
        requestQuit();
        return false;
      },
    },
  ];

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
    toggleSortMode();
  });
  widgets.screen.key(['m'], () => {
    if (modalOpen) return;
    toggleMemberSortMode();
  });
  widgets.screen.key(['f'], () => {
    if (modalOpen) return;
    setMinSize(cycleMinSizeFilter(minSize));
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
    toggleClosedVisibility();
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
  widgets.clusters.on('select item', (_item, index) => {
    if (isRendering || modalOpen) return;
    if (suppressNextClusterSelect) {
      suppressNextClusterSelect = false;
      return;
    }
    focusPane = 'clusters';
    widgets.clusters.focus();
    selectClusterIndex(Number(index));
  });
  widgets.clusters.on('select', () => {
    if (isRendering || modalOpen) return;
    updateFocus('members');
  });
  widgets.clusters.on('mousedown', (event: MouseEventArg) => {
    if (isRendering || modalOpen) return;
    const itemIndex = getListItemIndexFromMouse(widgets.clusters, event);
    if (event.button === 'left' && itemIndex === CLUSTER_LIST_HEADER_INDEX) {
      suppressNextClusterSelect = true;
      const relativeX = Math.max(0, Number(event.x) - Number(widgets.clusters.aleft) - 2);
      const innerWidth = Math.max(1, Number(widgets.clusters.width) - 2);
      setSortMode(resolveClusterHeaderSortFromClick(relativeX, innerWidth, sortMode));
      return;
    }
    if (event.button !== 'right') return;
    focusPane = 'clusters';
    widgets.clusters.focus();
    if (itemIndex !== null && itemIndex >= CLUSTER_LIST_FIRST_ITEM_INDEX) {
      selectClusterIndex(itemIndex);
    } else {
      render();
    }
    openContextMenu('Cluster', clusterContextItems(), event);
  });
  widgets.members.on('select item', (_item, index) => {
    if (isRendering || modalOpen) return;
    if (suppressNextMemberSelect) {
      suppressNextMemberSelect = false;
      return;
    }
    focusPane = 'members';
    widgets.members.focus();
    selectMemberIndex(Number(index));
  });
  widgets.members.on('select', () => {
    if (isRendering || modalOpen) return;
    loadSelectedThreadDetail(true);
    status = selectedMemberThreadId !== null ? `Loaded neighbors for #${threadDetail?.thread.number ?? '?'}` : status;
    updateFocus('detail');
  });
  widgets.members.on('mousedown', (event: MouseEventArg) => {
    if (isRendering || modalOpen) return;
    focusPane = 'members';
    widgets.members.focus();
    const itemIndex = getListItemIndexFromMouse(widgets.members, event);
    if (event.button === 'left' && itemIndex === 0) {
      suppressNextMemberSelect = true;
      const relativeX = Math.max(0, Number(event.x) - Number(widgets.members.aleft) - 2);
      setMemberSortMode(resolveMemberHeaderSortFromClick(relativeX, memberSortMode));
      return;
    }
    if (event.button !== 'right') return;
    const row = itemIndex !== null && itemIndex >= 0 && itemIndex < memberRows.length ? memberRows[itemIndex] : null;
    if (!row?.selectable) {
      openContextMenu('Members', clusterContextItems(), event);
      return;
    }
    if (row.threadId !== selectedMemberThreadId) {
      selectMemberIndex(itemIndex ?? 0);
    }
    openContextMenu('Thread', threadContextItems(), event);
  });
  widgets.detail.on('click', () => {
    if (modalOpen) return;
    updateFocus('detail');
  });
  widgets.detail.on('mousedown', (event: MouseEventArg) => {
    if (modalOpen || event.button !== 'right') return;
    updateFocus('detail');
    openContextMenu(threadDetail ? 'Thread' : clusterDetail ? 'Cluster' : 'ghcrawl', threadDetail ? threadContextItems() : clusterDetail ? clusterContextItems() : globalContextItems(), event);
  });
  widgets.header.on('mousedown', (event: MouseEventArg) => {
    if (modalOpen || event.button !== 'right') return;
    openContextMenu('ghcrawl', globalContextItems(), event);
  });
  widgets.footer.on('mousedown', (event: MouseEventArg) => {
    if (modalOpen || event.button !== 'right') return;
    openContextMenu('ghcrawl', globalContextItems(), event);
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
    mouse: true,
    title: owner && repo ? `ghcrawl ${owner}/${repo}` : 'ghcrawl',
  });
  const header = blessed.box({
    parent: screen,
    tags: true,
    mouse: true,
    style: { fg: 'white', bg: '#0d1321' },
  });
  const clusters = blessed.list({
    parent: screen,
    border: 'line',
    label: ' Clusters ',
    tags: true,
    keys: false,
    mouse: true,
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
    mouse: true,
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
    mouse: true,
    scrollbar: { ch: ' ' },
    style: {
      border: { fg: '#fde74c' },
      fg: 'white',
    },
  });
  const footer = blessed.box({
    parent: screen,
    tags: false,
    mouse: true,
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  return { screen, header, clusters, members, detail, footer };
}

function updatePaneStyles(widgets: Widgets, focus: TuiFocusPane): void {
  widgets.clusters.setLabel(`${focus === 'clusters' ? '[*]' : '[ ]'} Clusters `);
  widgets.members.setLabel(`${focus === 'members' ? '[*]' : '[ ]'} Members `);
  widgets.detail.setLabel(`${focus === 'detail' ? '[*]' : '[ ]'} Detail `);
  widgets.clusters.style.border = { fg: focus === 'clusters' ? 'white' : '#5bc0eb' };
  widgets.members.style.border = { fg: focus === 'members' ? 'white' : '#9bc53d' };
  widgets.detail.style.border = { fg: focus === 'detail' ? 'white' : '#fde74c' };
  widgets.clusters.style.selected =
    focus === 'clusters' ? { bg: '#f7f7ff', fg: 'black', bold: true } : { bg: '#23445c', fg: 'white', bold: true };
  widgets.members.style.selected =
    focus === 'members' ? { bg: '#f7f7ff', fg: 'black', bold: true } : { bg: '#33521e', fg: 'white', bold: true };
}

export function renderDetailPane(
  threadDetail: TuiThreadDetail | null,
  clusterDetail: TuiClusterDetail | null,
  focusPane: TuiFocusPane,
  snapshot?: TuiSnapshot | null,
): string {
  if (!clusterDetail) {
    const repoLabel = snapshot?.repository.fullName ?? 'No repository selected';
    const clusterCount = snapshot?.clusters.length ?? 0;
    return [
      `{bold}${escapeBlessedText(repoLabel)}{/bold}`,
      '',
      clusterCount > 0 ? `${clusterCount} clusters loaded. Click a cluster or press Enter to inspect members.` : 'No clusters visible in this view.',
      '',
      `{bold}Controls{/bold}`,
      's sort  f min size  / filter  x closed  r refresh',
      'right-click any pane for actions',
    ].join('\n');
  }
  const clusterTitle = splitClusterDisplayTitle(clusterDetail.displayTitle);
  if (!threadDetail) {
    const representativeLabel =
      clusterDetail.representativeNumber !== null && clusterDetail.representativeKind !== null
        ? ` (#${clusterDetail.representativeNumber} representative ${clusterDetail.representativeKind === 'pull_request' ? 'pr' : 'issue'})`
        : '';
    return [
      `{bold}Cluster ${clusterDetail.clusterId}${escapeBlessedText(representativeLabel)}{/bold}`,
      `{cyan-fg}${escapeBlessedText(clusterTitle.name)}{/cyan-fg}`,
      escapeBlessedText(clusterTitle.title),
      '',
      'Select a member to inspect thread details.',
    ].join('\n');
  }

  const thread = threadDetail.thread;
  const representativeLabel =
    clusterDetail.representativeNumber !== null && clusterDetail.representativeKind !== null
      ? ` (#${clusterDetail.representativeNumber} representative ${clusterDetail.representativeKind === 'pull_request' ? 'pr' : 'issue'})`
      : '';
  const labels = thread.labels.length > 0 ? thread.labels.map((label) => `{cyan-fg}${escapeBlessedText(label)}{/cyan-fg}`).join(' ') : 'none';
  const closedLabel = thread.isClosed
    ? `{bold}Closed:{/bold} ${escapeBlessedText(thread.closedAtLocal ?? thread.closedAtGh ?? 'yes')} ${thread.closeReasonLocal ? `(${escapeBlessedText(thread.closeReasonLocal)})` : ''}`.trimEnd()
    : '{bold}Closed:{/bold} no';
  const summaries = renderSummarySections(threadDetail.summaries);
  const neighbors =
    threadDetail.neighbors.length > 0
      ? threadDetail.neighbors
          .map((neighbor) => `#${neighbor.number} ${neighbor.kind} ${(neighbor.score * 100).toFixed(1)}%  ${escapeBlessedText(neighbor.title)}`)
          .join('\n')
      : focusPane === 'detail'
        ? 'No neighbors available.'
        : 'Neighbors load when the detail pane is focused.';
  const body = renderMarkdownForTerminal(thread.body ?? '(no body)');
  return [
    `{bold}${thread.kind === 'pull_request' ? 'PR' : 'Issue'} #${thread.number}{/bold}  ${escapeBlessedText(thread.title)}`,
    `{cyan-fg}${escapeBlessedText(clusterTitle.name)}{/cyan-fg}  C${clusterDetail.clusterId}${escapeBlessedText(representativeLabel)}`,
    '',
    `${closedLabel}  {bold}Updated:{/bold} ${escapeBlessedText(formatRelativeTime(thread.updatedAtGh))}  {bold}Author:{/bold} ${escapeBlessedText(thread.authorLogin ?? 'unknown')}`,
    `{bold}Labels:{/bold} ${labels}`,
    `{bold}URL:{/bold} ${formatTerminalLink(thread.htmlUrl, thread.htmlUrl)}`,
    '',
    summaries ? `\n\n${summaries}` : '',
    '',
    `{bold}Main{/bold}`,
    body,
    `\n\n{bold}Neighbors{/bold}\n${neighbors}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function escapeBlessedText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export function splitClusterDisplayTitle(displayTitle: string): { name: string; title: string } {
  const match = displayTitle.match(/^([a-z]+(?:-[a-z]+){2})\s{2,}(.+)$/);
  if (match) {
    return { name: match[1] ?? 'cluster', title: match[2] ?? displayTitle };
  }
  return { name: formatClusterShortName(displayTitle), title: displayTitle || 'Untitled cluster' };
}

export function renderMarkdownForTerminal(markdown: string): string {
  let inFence = false;
  const rendered = markdown.split(/\r?\n/).map((line) => {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      return '{gray-fg}--- code ---{/gray-fg}';
    }
    if (inFence) {
      return `{gray-fg}${escapeBlessedText(line)}{/gray-fg}`;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      return `{bold}${escapeBlessedText(heading[2] ?? '')}{/bold}`;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      return `{gray-fg}> ${renderInlineMarkdown(quote[1] ?? '')}{/gray-fg}`;
    }
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const indent = listItem[1] ?? '';
      return `${indent}- ${renderInlineMarkdown(listItem[3] ?? '')}`;
    }
    return renderInlineMarkdown(line);
  });
  return rendered.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd();
}

export function getThreadReferenceLinks(threadDetail: TuiThreadDetail | null): string[] {
  if (!threadDetail) return [];
  return uniqueStrings([
    ...extractMarkdownLinks(threadDetail.thread.body ?? ''),
    ...Object.values(threadDetail.summaries).flatMap((summary) => extractMarkdownLinks(summary ?? '')),
  ]).filter((url) => url !== threadDetail.thread.htmlUrl);
}

function extractMarkdownLinks(markdown: string): string[] {
  const urls: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)) {
    urls.push(stripTrailingUrlPunctuation(match[1] ?? ''));
  }
  for (const match of markdown.matchAll(/(^|[\s(<])(https?:\/\/[^\s<>)]+)/g)) {
    urls.push(stripTrailingUrlPunctuation(match[2] ?? ''));
  }
  return urls.filter(Boolean);
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/g, '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

type SummaryKey = NonNullable<keyof TuiThreadDetail['summaries']>;

const SUMMARY_SECTION_ORDER: SummaryKey[] = ['problem_summary', 'solution_summary', 'maintainer_signal_summary', 'dedupe_summary'];

export function renderSummarySections(summaries: TuiThreadDetail['summaries']): string {
  return SUMMARY_SECTION_ORDER.flatMap((key) => {
    const value = summaries[key];
    if (!value) return [];
    return [`{bold}${formatSummaryLabel(key)}:{/bold}\n${renderMarkdownForTerminal(value)}`];
  }).join('\n\n');
}

function formatSummaryLabel(key: SummaryKey): string {
  if (key === 'problem_summary') return 'Purpose';
  if (key === 'solution_summary') return 'Solution';
  if (key === 'maintainer_signal_summary') return 'Maintainer signal';
  return 'Cluster signal';
}

type InlineMarkdownSegment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; label: string; url: string };

function renderInlineMarkdown(value: string): string {
  const segments: InlineMarkdownSegment[] = [];
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let cursor = 0;

  for (const match of value.matchAll(markdownLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      pushBareLinkSegments(value.slice(cursor, index), segments);
    }
    segments.push({ kind: 'link', label: match[1] ?? '', url: match[2] ?? '' });
    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    pushBareLinkSegments(value.slice(cursor), segments);
  }

  return segments.map((segment) => (segment.kind === 'link' ? formatTerminalLink(segment.url, segment.label) : renderInlineText(segment.value))).join('');
}

function pushBareLinkSegments(value: string, segments: InlineMarkdownSegment[]): void {
  const bareLinkPattern = /https?:\/\/[^\s)]+/g;
  let cursor = 0;
  for (const match of value.matchAll(bareLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ kind: 'text', value: value.slice(cursor, index) });
    }
    const url = match[0];
    segments.push({ kind: 'link', label: url, url });
    cursor = index + url.length;
  }
  if (cursor < value.length) {
    segments.push({ kind: 'text', value: value.slice(cursor) });
  }
}

function renderInlineText(value: string): string {
  return escapeBlessedText(value)
    .replace(/`([^`]+)`/g, '{yellow-fg}$1{/yellow-fg}')
    .replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}');
}

function formatTerminalLink(url: string, label: string): string {
  const safeUrl = stripTerminalControls(url);
  const safeLabel = stripTerminalControls(label);
  const visibleLink = safeLabel && safeLabel !== safeUrl ? `${safeLabel} <${safeUrl}>` : safeUrl;
  return escapeBlessedText(visibleLink);
}

function stripTerminalControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

export function buildThreadContextMenuItems(threadDetail: TuiThreadDetail | null): ThreadContextMenuItem[] {
  if (!threadDetail) {
    return [{ label: 'Close', action: 'close' }];
  }
  const referenceLinks = getThreadReferenceLinks(threadDetail);
  return [
    { label: 'Open in browser', action: 'open' },
    { label: 'Copy URL', action: 'copy-url' },
    { label: 'Copy title', action: 'copy-title' },
    { label: 'Copy Markdown link', action: 'copy-markdown-link' },
    ...(referenceLinks.length > 0
      ? [
          { label: 'Open first body link', action: 'open-first-link' as const },
          { label: 'Copy first body link', action: 'copy-first-link' as const },
        ]
      : []),
    { label: 'Load neighbors', action: 'load-neighbors' },
    { label: 'Close', action: 'close' },
  ];
}

function applyRect(element: blessed.Widgets.BoxElement | blessed.Widgets.ListElement, rect: { top: number; left: number; width: number; height: number }): void {
  element.top = rect.top;
  element.left = rect.left;
  element.width = rect.width;
  element.height = rect.height;
}

function getListItemIndexFromMouse(list: blessed.Widgets.ListElement, event: MouseEventArg): number | null {
  const itemIndex = Number(event.y) - Number(list.atop) - 2 + Number(list.getScroll());
  return Number.isInteger(itemIndex) ? itemIndex : null;
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

function copyTextToClipboard(value: string): boolean {
  const copyCommand =
    process.platform === 'darwin'
      ? { command: 'pbcopy', args: [] }
      : process.platform === 'win32'
        ? { command: 'clip', args: [] }
        : { command: 'xclip', args: ['-selection', 'clipboard'] };
  const result = spawnSync(copyCommand.command, copyCommand.args, {
    input: value,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return result.status === 0;
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
    'Mouse             click to focus/select; click list headers to sort; right-click opens pane actions; wheel scrolls',
    'PgUp / PgDn       page through the focused pane or this help popup faster',
    'Home / End        jump to the top or bottom of detail or help',
    '',
    '{bold}Views And Filters{/bold}',
    '#                 jump directly to an issue or PR number',
    's                 cycle cluster sort mode',
    'm                 cycle member sort mode',
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
    'The default sort is size. Press s to toggle size and recent.',
    'Member rows default to issue/PR grouping. Press m or click the member header to sort by updated, number, state, or title.',
    'Mouse clicks focus panes; clicking an already selected row advances to the next pane. Right-click works on every pane.',
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
    mouse: true,
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
    mouse: true,
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

export function formatClusterListLabel(cluster: TuiClusterSummary): string {
  const countLabel = String(cluster.totalCount).padStart(CLUSTER_COUNT_WIDTH);
  const mixLabel = `${cluster.issueCount}I/${cluster.pullRequestCount}P`.padStart(CLUSTER_MIX_WIDTH);
  const updated = formatRelativeTime(cluster.latestUpdatedAt).padStart(CLUSTER_UPDATED_WIDTH);
  const title = splitClusterDisplayTitle(cluster.displayTitle);
  return [
    countLabel,
    title.name.padEnd(CLUSTER_NAME_WIDTH).slice(0, CLUSTER_NAME_WIDTH),
    title.title.padEnd(CLUSTER_TITLE_WIDTH).slice(0, CLUSTER_TITLE_WIDTH),
    mixLabel,
    updated,
  ].join('  ');
}

export function formatClusterListHeader(sortMode: TuiClusterSortMode): string {
  const countLabel = (sortMode === 'size' ? 'cnt*' : 'cnt').padStart(CLUSTER_COUNT_WIDTH);
  const updated = (sortMode === 'recent' ? 'updated*' : 'updated').padStart(CLUSTER_UPDATED_WIDTH);
  return [
    countLabel,
    'cluster'.padEnd(CLUSTER_NAME_WIDTH),
    'title'.padEnd(CLUSTER_TITLE_WIDTH),
    'mix'.padStart(CLUSTER_MIX_WIDTH),
    updated,
  ].join('  ');
}

export function resolveClusterHeaderSortFromClick(relativeX: number, visibleWidth: number, currentSortMode: TuiClusterSortMode): TuiClusterSortMode {
  if (relativeX < CLUSTER_NAME_START) {
    return 'size';
  }

  const visibleUpdatedStart = Math.min(CLUSTER_UPDATED_START, Math.max(CLUSTER_NAME_START, visibleWidth - CLUSTER_UPDATED_WIDTH - CLUSTER_COLUMN_GAP));
  if (relativeX >= visibleUpdatedStart) {
    return 'recent';
  }

  return cycleSortMode(currentSortMode);
}

export function formatClusterShortName(title: string, maxWords = 3): string {
  const words = title
    .replace(/[\[\]{}()<>]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .map((word) => word.replace(/^[:/#-]+|[:/#-]+$/g, ''))
    .filter((word) => word && !CLUSTER_SHORT_NAME_STOPWORDS.has(word.toLowerCase()))
    .slice(0, maxWords);
  return words.join(' ') || 'untitled';
}

const CLUSTER_SHORT_NAME_STOPWORDS = new Set([
  'ai',
  'assisted',
  'bug',
  'chore',
  'codex',
  'docs',
  'feat',
  'feature',
  'fix',
  'issue',
  'pr',
  'refactor',
  'test',
]);

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
