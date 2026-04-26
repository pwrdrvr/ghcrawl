import blessed from 'neo-blessed';

import type {
  GHCrawlService,
  TuiClusterDetail,
  TuiClusterSortMode,
  TuiRefreshState,
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
import {
  buildThreadContextMenuItems,
  escapeBlessedText,
  formatClusterForClipboard,
  formatClusterMembersForClipboard,
  formatLinkChoiceLabel,
  formatSummariesForClipboard,
  formatThreadDetailForClipboard,
  formatVisibleClustersForClipboard,
  getThreadReferenceLinks,
  renderDetailPane,
  type DetailMode,
} from './detail-render.js';
import {
  formatClusterDateColumn,
  formatClusterListHeader,
  formatClusterListLabel,
  formatClusterShortName,
  resolveClusterHeaderSortFromClick,
  splitClusterDisplayTitle,
} from './cluster-render.js';
import { promptHelp } from './help.js';
import { copyTextToClipboard, openUrl } from './platform.js';
import {
  promptRepositoryChoice,
  promptRepositoryInput,
  type RepositoryTarget,
} from './repository-picker.js';
import {
  applyRect,
  createWidgets,
  getListItemIndexFromMouse,
  updatePaneStyles,
  type MouseEventArg,
  type Widgets,
} from './widgets.js';

export { resolveBlessedTerminal } from './widgets.js';
export { buildHelpContent } from './help.js';

type StartTuiParams = {
  service: GHCrawlService;
  owner?: string;
  repo?: string;
};

type ThreadDetailCacheEntry = {
  detail: TuiThreadDetail;
  hasNeighbors: boolean;
};

type ContextMenuItem = {
  label: string;
  run: () => boolean | void;
};

const ACTIVITY_LOG_LIMIT = 200;
const FOOTER_LOG_LINES = 1;
const CLUSTER_LIST_HEADER_INDEX = 0;
const CLUSTER_LIST_FIRST_ITEM_INDEX = 1;
const TUI_AUTO_REFRESH_INTERVAL_MS = 15_000;

export async function startTui(params: StartTuiParams): Promise<void> {
  const selectedRepository = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : null;
  let currentRepository = selectedRepository ?? { owner: '', repo: '' };
  const widgets = createWidgets(currentRepository.owner, currentRepository.repo);

  let focusPane: TuiFocusPane = 'clusters';
  let isRendering = false;
  const initialPreference = selectedRepository
    ? getTuiRepositoryPreference(params.service.config, currentRepository.owner, currentRepository.repo)
    : {
        sortMode: 'size' as TuiClusterSortMode,
        memberSortMode: 'kind' as TuiMemberSortMode,
        minClusterSize: 5 as TuiMinSizeFilter,
        wideLayout: 'columns' as TuiWideLayoutPreference,
      };
  let sortMode: TuiClusterSortMode = initialPreference.sortMode;
  let memberSortMode: TuiMemberSortMode = initialPreference.memberSortMode;
  let detailMode: DetailMode = 'full';
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
  let dismissModal: (() => void) | null = null;
  let suppressNextClusterSelect = false;
  let suppressNextMemberSelect = false;
  let lastRefreshState: TuiRefreshState | null = null;

  const clearCaches = (): void => {
    clusterDetailCache.clear();
    threadDetailCache.clear();
  };

  const formatTuiError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  const clearModal = (): void => {
    modalOpen = false;
    dismissModal = null;
  };

  const dismissActiveModal = (): boolean => {
    if (!modalOpen) {
      return false;
    }
    const dismiss = dismissModal;
    if (dismiss) {
      dismiss();
      return true;
    }
    clearModal();
    render();
    return true;
  };

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
      return cluster.isClosed ? `{gray-fg}${escapeBlessedText(label)}{/gray-fg}` : `{green-fg}${escapeBlessedText(label)}{/green-fg}`;
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
      embeddingStatsMode: 'pipeline',
    });
    lastRefreshState = params.service.getTuiRefreshState({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
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
          embeddingStatsMode: 'pipeline',
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

  const autoRefreshIfChanged = (): void => {
    if (!currentRepository.owner || !currentRepository.repo || modalOpen || isRendering) {
      return;
    }
    try {
      const nextState = params.service.getTuiRefreshState({
        owner: currentRepository.owner,
        repo: currentRepository.repo,
      });
      if (lastRefreshState && formatTuiRefreshStateKey(nextState) !== formatTuiRefreshStateKey(lastRefreshState)) {
        refreshAll(true);
        status = 'External DB update detected; refreshed';
        render();
        return;
      }
      lastRefreshState = nextState;
    } catch (error) {
      status = `Auto-refresh failed: ${formatTuiError(error)}`;
      render();
    }
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

    widgets.detail.setContent(renderDetailPane(threadDetail, clusterDetail, focusPane, snapshot, detailMode));
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

  const jumpFocusedPaneToEdge = (edge: 'start' | 'end'): void => {
    if (focusPane === 'detail') {
      if (edge === 'start') {
        widgets.detail.setScroll(0);
      } else {
        widgets.detail.setScrollPerc(100);
      }
      widgets.screen.render();
      return;
    }

    if (focusPane === 'clusters') {
      if (!snapshot || snapshot.clusters.length === 0) return;
      selectClusterIndex(edge === 'start' ? CLUSTER_LIST_FIRST_ITEM_INDEX : snapshot.clusters.length);
      return;
    }

    if (focusPane === 'members') {
      const selectable = memberRows
        .map((row, index) => ({ row, index }))
        .filter((item) => item.row.selectable);
      const target = edge === 'start' ? selectable.at(0) : selectable.at(-1);
      if (target) {
        selectMemberIndex(target.index);
      }
    }
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
    persistRepositoryPreference();
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
    let closed = false;
    const closePrompt = (): boolean => {
      if (closed) return false;
      closed = true;
      prompt.destroy();
      clearModal();
      render();
      return true;
    };
    dismissModal = () => {
      closePrompt();
    };
    prompt.input('Filter clusters', search, (_error, value) => {
      if (closed) return;
      closed = true;
      search = (value ?? '').trim();
      status = search ? `Filter: ${search}` : 'Filter cleared';
      refreshAll(false);
      prompt.destroy();
      clearModal();
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
    let closed = false;
    const closePrompt = (): boolean => {
      if (closed) return false;
      closed = true;
      prompt.destroy();
      clearModal();
      render();
      return true;
    };
    dismissModal = () => {
      closePrompt();
    };
    prompt.input('Issue or PR number', '', (_error, value) => {
      if (closed) return;
      closed = true;
      prompt.destroy();
      clearModal();
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

  const copyToStatus = (label: string, value: string): void => {
    if (!value.trim()) {
      status = `No ${label} to copy`;
      return;
    }
    status = copyTextToClipboard(value) ? `Copied ${label}` : 'Clipboard copy failed';
  };

  const toggleDetailMode = (): void => {
    detailMode = detailMode === 'full' ? 'compact' : 'full';
    status = `Detail mode: ${detailMode}`;
    render();
  };

  const runLocalMutation = (action: () => { message?: string }): void => {
    try {
      const result = action();
      status = result.message ?? 'Updated local state';
      clearCaches();
      refreshAll(true);
    } catch (error) {
      status = formatTuiError(error);
      render();
    }
  };

  const confirmMutation = (message: string, action: () => { message?: string }): void => {
    if (modalOpen) return;
    modalOpen = true;
    const box = blessed.box({
      parent: widgets.screen,
      border: 'line',
      label: ' Confirm ',
      top: 'center',
      left: 'center',
      width: '62%',
      height: 7,
      tags: true,
      mouse: true,
      content: `${message}\n\nDefault: no. Press y to confirm, Enter/Esc/n/q to cancel.`,
      style: {
        border: { fg: '#fde74c' },
        fg: 'white',
        bg: '#101522',
      },
    });
    let closed = false;
    const closeConfirm = (confirmed: boolean): void => {
      if (closed) return;
      closed = true;
      widgets.screen.off('keypress', handleKeypress);
      box.destroy();
      clearModal();
      if (confirmed) {
        runLocalMutation(action);
        return;
      }
      status = 'Cancelled';
      render();
    };
    const handleKeypress = (_char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'y') {
        closeConfirm(true);
        return;
      }
      if (key.name === 'enter' || key.name === 'escape' || key.name === 'n' || key.name === 'q') {
        closeConfirm(false);
      }
    };
    box.on('mousedown', (event: MouseEventArg) => {
      if (event.button === 'right') {
        closeConfirm(false);
      }
    });
    dismissModal = () => closeConfirm(false);
    widgets.screen.on('keypress', handleKeypress);
    box.focus();
    widgets.screen.render();
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

    let closed = false;
    const closeMenu = (): void => {
      if (closed) return;
      closed = true;
      menu.destroy();
      clearModal();
      render();
    };
    dismissModal = closeMenu;
    menu.key(['escape', 'q'], closeMenu);
    menu.on('mousedown', (mouseEvent: MouseEventArg) => {
      if (mouseEvent.button === 'right') {
        closeMenu();
      }
    });
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
    return [
      ...buildThreadContextMenuItems(threadDetail).map((item) => ({
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
        } else if (item.action === 'open-link-picker') {
          openLinkPicker('open');
        } else if (item.action === 'copy-link-picker') {
          openLinkPicker('copy');
        } else if (item.action === 'load-neighbors') {
          loadSelectedThreadDetail(true);
          status = `Loaded neighbors for #${threadDetail?.thread.number ?? selectedThread.number}`;
          focusPane = 'detail';
        }
      },
      })),
      ...detailCopyContextItems(),
      ...clusterCopyContextItems({ includeVisibleClusters: false }),
      {
        label: 'Close thread locally',
        run: () =>
          confirmMutation(
            `Close ${selectedThread.kind === 'pull_request' ? 'PR' : 'issue'} #${selectedThread.number} locally? This hides it from active sync/cluster views.`,
            () =>
              params.service.closeThreadLocally({
                owner: currentRepository.owner,
                repo: currentRepository.repo,
                threadNumber: selectedThread.number,
              }),
          ),
      },
      {
        label: 'Remove from durable cluster',
        run: () =>
          confirmMutation(
            `Remove #${selectedThread.number} from durable cluster ${clusterDetail?.clusterId ?? selectedThread.clusterId ?? '?'}? Future clustering should respect this override.`,
            () =>
              params.service.excludeThreadFromCluster({
                owner: currentRepository.owner,
                repo: currentRepository.repo,
                clusterId: clusterDetail?.clusterId ?? selectedThread.clusterId ?? 0,
                threadNumber: selectedThread.number,
                reason: 'TUI manual remove',
              }),
          ),
      },
      {
        label: 'Set as durable canonical',
        run: () =>
          confirmMutation(
            `Set #${selectedThread.number} as canonical for durable cluster ${clusterDetail?.clusterId ?? selectedThread.clusterId ?? '?'}?`,
            () =>
              params.service.setClusterCanonicalThread({
                owner: currentRepository.owner,
                repo: currentRepository.repo,
                clusterId: clusterDetail?.clusterId ?? selectedThread.clusterId ?? 0,
                threadNumber: selectedThread.number,
                reason: 'TUI manual canonical',
              }),
          ),
      },
    ];
  };

  const detailCopyContextItems = (): ContextMenuItem[] => {
    if (!threadDetail) return [];
    const selectedThreadDetail = threadDetail;
    return [
      {
        label: detailMode === 'full' ? 'Use compact detail' : 'Use full detail',
        run: toggleDetailMode,
      },
      {
        label: 'Copy all detail',
        run: () => {
          copyToStatus('detail', formatThreadDetailForClipboard(selectedThreadDetail, clusterDetail));
        },
      },
      {
        label: 'Copy body',
        run: () => {
          copyToStatus('body', selectedThreadDetail.thread.body ?? '');
        },
      },
      {
        label: 'Copy summaries',
        run: () => {
          copyToStatus('summaries', formatSummariesForClipboard(selectedThreadDetail.summaries));
        },
      },
      {
        label: 'Copy links',
        run: () => {
          const links = getThreadReferenceLinks(selectedThreadDetail);
          copyToStatus('links', links.join('\n'));
        },
      },
    ];
  };

  const openLinkPicker = (mode: 'open' | 'copy'): void => {
    const links = getThreadReferenceLinks(threadDetail);
    if (links.length === 0 || modalOpen) {
      status = 'No referenced links found';
      render();
      return;
    }
    modalOpen = true;
    const width = Math.min(92, Math.max(48, Math.max(...links.map((url) => url.length)) + 8));
    const height = Math.min(Number(widgets.screen.height) - 4, Math.max(5, links.length + 2));
    const picker = blessed.list({
      parent: widgets.screen,
      border: 'line',
      label: mode === 'open' ? ' Open Link ' : ' Copy Link ',
      top: 'center',
      left: 'center',
      width,
      height,
      tags: false,
      keys: true,
      vi: true,
      mouse: true,
      items: links.map((url, index) => formatLinkChoiceLabel(url, index)),
      scrollbar: { ch: ' ' },
      style: {
        border: { fg: '#fde74c' },
        selected: { bg: '#f7f7ff', fg: 'black', bold: true },
        item: { fg: 'white' },
        bg: '#101522',
      },
    });

    let closed = false;
    const closePicker = (): void => {
      if (closed) return;
      closed = true;
      picker.destroy();
      clearModal();
      render();
    };
    dismissModal = closePicker;
    picker.key(['escape', 'q'], closePicker);
    picker.on('mousedown', (mouseEvent: MouseEventArg) => {
      if (mouseEvent.button === 'right') {
        closePicker();
      }
    });
    picker.on('select', (_item, index) => {
      const url = links[Number(index)];
      if (!url) {
        closePicker();
        return;
      }
      if (mode === 'open') {
        openUrl(url);
        status = `Opened ${url}`;
      } else {
        status = copyTextToClipboard(url) ? 'Copied referenced link' : 'Clipboard copy failed';
      }
      closePicker();
    });
    picker.focus();
    widgets.screen.render();
  };

  const clusterContextItems = (): ContextMenuItem[] => {
    const selectedCluster = clusterDetail;
    return [
      ...(selectedCluster
        ? [
            { label: 'Focus members', run: () => updateFocus('members') },
          ]
        : []),
      ...clusterCopyContextItems({ includeVisibleClusters: true }),
      ...(selectedCluster
        ? [
            {
              label: 'Close cluster locally',
              run: () =>
                confirmMutation(
                  `Close cluster ${selectedCluster.clusterId} locally? Default is no.`,
                  () =>
                    params.service.closeClusterLocally({
                      owner: currentRepository.owner,
                      repo: currentRepository.repo,
                      clusterId: selectedCluster.clusterId,
                    }),
                ),
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
      { label: 'Min size 5+', run: () => setMinSize(5) },
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
    {
      label: 'Copy visible clusters',
      run: () => {
        copyToStatus('visible clusters', formatVisibleClustersForClipboard(snapshot?.clusters ?? []));
      },
    },
    { label: 'Sort by size', run: () => setSortMode('size') },
    { label: 'Sort by recent', run: () => setSortMode('recent') },
    { label: 'Member sort grouped', run: () => setMemberSortMode('kind') },
    { label: 'Member sort recent', run: () => setMemberSortMode('recent') },
    { label: 'Min size 1+', run: () => setMinSize(1) },
    { label: 'Min size 5+', run: () => setMinSize(5) },
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

  const clusterCopyContextItems = (options: { includeVisibleClusters: boolean }): ContextMenuItem[] => {
    const selectedCluster = clusterDetail;
    const title = selectedCluster ? splitClusterDisplayTitle(selectedCluster.displayTitle) : null;
    return [
      ...(selectedCluster && title
        ? [
            {
              label: 'Copy cluster name',
              run: () => copyToStatus('cluster name', title.name),
            },
            {
              label: 'Copy cluster title',
              run: () => copyToStatus('cluster title', title.title),
            },
            {
              label: 'Copy cluster id',
              run: () => copyToStatus('cluster id', String(selectedCluster.clusterId)),
            },
            {
              label: 'Copy cluster details',
              run: () => copyToStatus('cluster details', formatClusterForClipboard(selectedCluster)),
            },
            {
              label: 'Copy member list',
              run: () => copyToStatus('member list', formatClusterMembersForClipboard(selectedCluster)),
            },
          ]
        : []),
      ...(options.includeVisibleClusters
        ? [
            {
              label: 'Copy visible clusters',
              run: () => copyToStatus('visible clusters', formatVisibleClustersForClipboard(snapshot?.clusters ?? [])),
            },
          ]
        : []),
    ];
  };

  const openHelp = (): void => {
    if (modalOpen) return;
    void (async () => {
      modalOpen = true;
      try {
        await promptHelp(widgets.screen);
        render();
      } finally {
        clearModal();
      }
    })();
  };

  const requestQuit = (): void => {
    if (dismissActiveModal()) return;
    widgets.screen.destroy();
  };

  const persistRepositoryPreference = (): void => {
    writeTuiRepositoryPreference(params.service.config, {
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      minClusterSize: minSize,
      sortMode,
      memberSortMode,
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
    memberSortMode = preference.memberSortMode;
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
          minClusterSize: 5,
          status: `No local data for ${target.owner}/${target.repo}; run sync/embed/cluster in the CLI, then press r`,
        });
        pushActivity(`[repo] selected ${target.owner}/${target.repo}; run ghcrawl sync/embed/cluster from the shell`);
        updateFocus('clusters');
      } catch (error) {
        status = 'Repository action failed';
        pushActivity(`[repo] action failed: ${formatTuiError(error)}`);
      } finally {
        clearModal();
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
        minClusterSize: 5,
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
      clearModal();
    }
  };

  widgets.screen.key(['q'], () => {
    requestQuit();
  });
  widgets.screen.key(['C-c'], () => {
    widgets.screen.destroy();
  });
  widgets.screen.key(['escape'], () => {
    dismissActiveModal();
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
    jumpFocusedPaneToEdge('start');
  });
  widgets.screen.key(['end'], () => {
    if (modalOpen) return;
    jumpFocusedPaneToEdge('end');
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
  widgets.clusters.on('wheelup', () => {
    if (isRendering || modalOpen) return;
    focusPane = 'clusters';
    widgets.clusters.focus();
    moveSelection(-1, { wrap: false });
  });
  widgets.clusters.on('wheeldown', () => {
    if (isRendering || modalOpen) return;
    focusPane = 'clusters';
    widgets.clusters.focus();
    moveSelection(1, { wrap: false });
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
  widgets.members.on('wheelup', () => {
    if (isRendering || modalOpen) return;
    focusPane = 'members';
    widgets.members.focus();
    moveSelection(-1, { wrap: false });
  });
  widgets.members.on('wheeldown', () => {
    if (isRendering || modalOpen) return;
    focusPane = 'members';
    widgets.members.focus();
    moveSelection(1, { wrap: false });
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
  widgets.detail.on('wheelup', () => {
    if (modalOpen) return;
    focusPane = 'detail';
    widgets.detail.focus();
    scrollDetail(-3);
  });
  widgets.detail.on('wheeldown', () => {
    if (modalOpen) return;
    focusPane = 'detail';
    widgets.detail.focus();
    scrollDetail(3);
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

  const autoRefreshTimer = setInterval(autoRefreshIfChanged, TUI_AUTO_REFRESH_INTERVAL_MS);
  autoRefreshTimer.unref?.();

  widgets.screen.on('destroy', () => {
    clearInterval(autoRefreshTimer);
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

function formatTuiRefreshStateKey(state: TuiRefreshState): string {
  return [
    state.repositoryUpdatedAt ?? '',
    state.threadUpdatedAt ?? '',
    state.threadClosedAt ?? '',
    state.clusterClosedAt ?? '',
    state.durableClusterUpdatedAt ?? '',
    state.durableMembershipUpdatedAt ?? '',
    state.latestSyncRunId ?? '',
    state.latestEmbeddingRunId ?? '',
    state.latestClusterRunId ?? '',
  ].join('|');
}

function formatActivityTimestamp(now: Date = new Date()): string {
  return now.toISOString().slice(11, 19);
}
