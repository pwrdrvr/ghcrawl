import { spawn } from 'node:child_process';

import blessed from 'neo-blessed';

import type {
  GitcrawlService,
  TuiClusterDetail,
  TuiClusterSortMode,
  TuiSnapshot,
  TuiThreadDetail,
} from '@gitcrawl/api-core';
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
  service: GitcrawlService;
  owner?: string;
  repo?: string;
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

const ACTIVITY_LOG_LIMIT = 200;
const FOOTER_LOG_LINES = 4;

export async function startTui(params: StartTuiParams): Promise<void> {
  const selectedRepository =
    params.owner && params.repo ? { owner: params.owner, repo: params.repo } : await pickRepository(params.service);
  if (!selectedRepository) {
    return;
  }
  const { owner, repo } = selectedRepository;
  const widgets = createWidgets(owner, repo);

  let focusPane: TuiFocusPane = 'clusters';
  let sortMode: TuiClusterSortMode = 'recent';
  let minSize: TuiMinSizeFilter = 10;
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
      owner,
      repo,
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
      owner,
      repo,
      threadId,
      includeNeighbors,
    });
    threadDetailCache.set(threadId, { detail, hasNeighbors: includeNeighbors });
    return detail;
  };

  const loadSelectedThreadDetail = (includeNeighbors: boolean): void => {
    threadDetail = selectedMemberThreadId !== null ? loadThreadDetail(selectedMemberThreadId, includeNeighbors) : null;
  };

  const refreshAll = (preserveSelection: boolean): void => {
    const previousClusterId = preserveSelection ? selectedClusterId : null;
    const previousMemberId = preserveSelection ? selectedMemberThreadId : null;
    clearCaches();
    snapshot = params.service.getTuiSnapshot({
      owner,
      repo,
      minSize,
      sort: sortMode,
      search,
    });
    selectedClusterId = preserveSelectedId(snapshot.clusters.map((cluster) => cluster.clusterId), previousClusterId);

    if (selectedClusterId !== null) {
      clusterDetail = loadClusterDetail(selectedClusterId);
      memberRows = buildMemberRows(clusterDetail);
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
    const layout = computeTuiLayout(width, height);
    applyRect(widgets.header, layout.header);
    applyRect(widgets.clusters, layout.clusters);
    applyRect(widgets.members, layout.members);
    applyRect(widgets.detail, layout.detail);
    applyRect(widgets.footer, layout.footer);

    const repoLabel = snapshot?.repository.fullName ?? `${owner}/${repo}`;
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
      `{bold}${repoLabel}{/bold}  {cyan-fg}${snapshot?.stats.openPullRequestCount ?? 0} PR{/cyan-fg}  {green-fg}${snapshot?.stats.openIssueCount ?? 0} issues{/green-fg}  GH:${ghStatus}  Emb:${embedStatus}  Cl:${clusterStatus}  sort:${sortMode}  min:${minSize === 0 ? 'all' : `${minSize}+`}  filter:${search || 'none'}`,
    );

    const clusterItems =
      snapshot?.clusters.map((cluster) => {
        const updated = cluster.latestUpdatedAt ? cluster.latestUpdatedAt.slice(5, 16).replace('T', ' ') : 'unknown';
        return `${String(cluster.totalCount).padStart(3, ' ')}  ${String(cluster.pullRequestCount).padStart(2, ' ')}P/${String(cluster.issueCount).padStart(2, ' ')}I  ${updated}  ${cluster.displayTitle}`;
      }) ?? ['No clusters'];
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
      `${status}  |  jobs:${activeJobs}  |  Tab focus  j/k move-or-scroll  PgUp/PgDn scroll  g sync  e embed  c cluster  s sort  f min  / filter  r refresh  o open  q quit`,
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

  const startSyncJob = (): void => {
    if (syncJobRunning) {
      pushActivity('[jobs] GitHub reconciliation already running');
      return;
    }
    syncJobRunning = true;
    status = 'Running GitHub reconciliation';
    pushActivity('[jobs] starting GitHub reconciliation');
    void (async () => {
      try {
        const result = await params.service.syncRepository({
          owner,
          repo,
          onProgress: pushActivity,
        });
        pushActivity(
          `[jobs] GitHub reconciliation complete threads=${result.threadsSynced} comments=${result.commentsSynced} closed=${result.threadsClosed}`,
        );
        refreshAll(true);
      } catch (error) {
        pushActivity(`[jobs] GitHub reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        syncJobRunning = false;
        status = 'Ready';
        render();
      }
    })();
  };

  const startEmbedJob = (): void => {
    if (embedJobRunning) {
      pushActivity('[jobs] embed refresh already running');
      return;
    }
    embedJobRunning = true;
    status = 'Running embed refresh';
    pushActivity('[jobs] starting embed refresh');
    void (async () => {
      try {
        const result = await params.service.embedRepository({
          owner,
          repo,
          onProgress: pushActivity,
        });
        pushActivity(`[jobs] embed refresh complete embeddings=${result.embedded}`);
        refreshAll(true);
      } catch (error) {
        pushActivity(`[jobs] embed refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        embedJobRunning = false;
        status = 'Ready';
        render();
      }
    })();
  };

  const startClusterJob = (): void => {
    if (clusterJobRunning) {
      pushActivity('[jobs] cluster refresh already running');
      return;
    }
    clusterJobRunning = true;
    status = 'Running cluster refresh';
    pushActivity('[jobs] starting cluster refresh');
    void (async () => {
      try {
        const result = params.service.clusterRepository({
          owner,
          repo,
          onProgress: pushActivity,
        });
        pushActivity(`[jobs] cluster refresh complete clusters=${result.clusters} edges=${result.edges}`);
        refreshAll(true);
      } catch (error) {
        pushActivity(`[jobs] cluster refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clusterJobRunning = false;
        status = 'Ready';
        render();
      }
    })();
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
        memberRows = buildMemberRows(clusterDetail);
        selectedMemberThreadId = preserveSelectedId(
          memberRows.filter((row) => row.selectable).map((row) => row.threadId),
          null,
        );
        memberIndex = findSelectableIndex(memberRows, selectedMemberThreadId);
        loadSelectedThreadDetail(false);
        resetDetailScroll();
      }
      status = `Cluster ${nextIndex + 1}/${snapshot.clusters.length}`;
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

  widgets.screen.key(['q', 'C-c'], () => {
    widgets.screen.destroy();
  });
  widgets.screen.key(['tab'], () => updateFocus(cycleFocusPane(focusPane, 1)));
  widgets.screen.key(['S-tab'], () => updateFocus(cycleFocusPane(focusPane, -1)));
  widgets.screen.key(['j', 'down'], () => {
    if (focusPane === 'detail') {
      scrollDetail(3);
      return;
    }
    moveSelection(1);
  });
  widgets.screen.key(['k', 'up'], () => {
    if (focusPane === 'detail') {
      scrollDetail(-3);
      return;
    }
    moveSelection(-1);
  });
  widgets.screen.key(['pageup'], () => scrollDetail(-12));
  widgets.screen.key(['pagedown'], () => scrollDetail(12));
  widgets.screen.key(['home'], () => {
    if (focusPane !== 'detail') return;
    widgets.detail.setScroll(0);
    widgets.screen.render();
  });
  widgets.screen.key(['end'], () => {
    if (focusPane !== 'detail') return;
    widgets.detail.setScrollPerc(100);
    widgets.screen.render();
  });
  widgets.screen.key(['enter'], () => {
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
    sortMode = cycleSortMode(sortMode);
    status = `Sort: ${sortMode}`;
    refreshAll(false);
  });
  widgets.screen.key(['f'], () => {
    minSize = cycleMinSizeFilter(minSize);
    status = `Min size: ${minSize === 0 ? 'all' : `${minSize}+`}`;
    refreshAll(false);
  });
  widgets.screen.key(['/'], () => promptFilter());
  widgets.screen.key(['g'], () => startSyncJob());
  widgets.screen.key(['e'], () => startEmbedJob());
  widgets.screen.key(['c'], () => startClusterJob());
  widgets.screen.key(['r'], () => {
    status = 'Refreshing';
    refreshAll(true);
  });
  widgets.screen.key(['o'], () => openSelectedThread());
  widgets.screen.on('resize', () => render());

  widgets.screen.on('destroy', () => {
    widgets.screen.program.showCursor();
  });

  widgets.screen.program.hideCursor();
  refreshAll(false);
  pushActivity('[jobs] press g to reconcile GitHub, e to refresh embeddings, and c to rebuild clusters');
  updateFocus('clusters');

  await new Promise<void>((resolve) => widgets.screen.once('destroy', () => resolve()));
}

function createWidgets(owner: string, repo: string): Widgets {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false,
    title: `gitcrawl ${owner}/${repo}`,
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
    tags: false,
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
    tags: false,
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
    return 'No cluster selected.\n\nRun `gitcrawl cluster owner/repo` if you have not clustered this repository yet.';
  }
  if (!threadDetail) {
    return `{bold}${escapeBlessedText(clusterDetail.displayTitle)}{/bold}\n\nSelect a member to inspect thread details.`;
  }

  const thread = threadDetail.thread;
  const labels = thread.labels.length > 0 ? escapeBlessedText(thread.labels.join(', ')) : 'none';
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
    `{bold}${thread.kind} #${thread.number}{/bold}  ${escapeBlessedText(thread.title)}`,
    '',
    `{bold}Author:{/bold} ${escapeBlessedText(thread.authorLogin ?? 'unknown')}`,
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

async function pickRepository(service: GitcrawlService): Promise<{ owner: string; repo: string } | null> {
  const repositories = service.listRepositories().repositories
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.fullName.localeCompare(right.fullName));

  if (repositories.length === 0) {
    return await runColdStartOnboarding(service);
  }

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false,
    title: 'gitcrawl repository picker',
  });
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
    items: repositories.map((repository) => `${repository.fullName}  ${formatRelativeTime(repository.updatedAt)}`),
  });
  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Select a local repository with Enter. Use j/k or arrows to move. Press q to quit.',
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  box.focus();
  box.select(0);
  screen.render();

  return await new Promise<{ owner: string; repo: string } | null>((resolve) => {
    const finish = (value: { owner: string; repo: string } | null): void => {
      screen.destroy();
      resolve(value);
    };

    screen.key(['q', 'C-c', 'escape'], () => finish(null));
    box.on('select', (_item, index) => {
      const selected = repositories[index];
      finish(selected ? { owner: selected.owner, repo: selected.name } : null);
    });
  });
}

async function runColdStartOnboarding(service: GitcrawlService): Promise<{ owner: string; repo: string } | null> {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    autoPadding: false,
    title: 'gitcrawl onboarding',
  });

  const info = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 6,
    tags: true,
    content: '{bold}No local repositories yet.{/bold}\n\nEnter an {bold}owner/repo{/bold} target and gitcrawl can run an initial sync, embed, and cluster pass for you.',
    style: { fg: 'white', bg: '#0d1321' },
  });
  const log = blessed.log({
    parent: screen,
    top: 6,
    left: 0,
    width: '100%',
    bottom: 1,
    border: 'line',
    label: ' Setup ',
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: ' ' },
    style: {
      border: { fg: '#5bc0eb' },
      fg: 'white',
    },
  });
  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: 'Enter owner/repo to begin. Press q to quit.',
    style: { fg: 'black', bg: '#5bc0eb' },
  });

  screen.render();

  return await new Promise<{ owner: string; repo: string } | null>((resolve) => {
    const finish = (value: { owner: string; repo: string } | null): void => {
      screen.destroy();
      resolve(value);
    };

    screen.key(['q', 'C-c', 'escape'], () => finish(null));

    const prompt = blessed.prompt({
      parent: screen,
      border: 'line',
      height: 7,
      width: '60%',
      top: 'center',
      left: 'center',
      label: ' Initial Repository ',
      tags: true,
      keys: true,
      vi: true,
      style: {
        border: { fg: 'cyan' },
        bg: '#101522',
      },
    });

    const askForRepository = (): void => {
      prompt.input('Repository to sync (owner/repo)', '', async (_error, value) => {
        const trimmed = (value ?? '').trim();
        if (!trimmed) {
          finish(null);
          return;
        }
        const parsed = parseOwnerRepoValue(trimmed);
        if (!parsed) {
          log.log(`[setup] invalid repository target: ${trimmed}`);
          footer.setContent('Use owner/repo format. Press q to quit.');
          screen.render();
          prompt.destroy();
          askForRepository();
          return;
        }

        prompt.destroy();
        log.log(`[setup] starting initial setup for ${parsed.owner}/${parsed.repo}`);
        footer.setContent('Running initial sync, embed, and cluster. This can take a while.');
        screen.render();

        try {
          const reporter = (message: string): void => {
            log.log(message);
            screen.render();
          };
          await service.syncRepository({
            owner: parsed.owner,
            repo: parsed.repo,
            onProgress: reporter,
          });
          await service.embedRepository({
            owner: parsed.owner,
            repo: parsed.repo,
            onProgress: reporter,
          });
          service.clusterRepository({
            owner: parsed.owner,
            repo: parsed.repo,
            onProgress: reporter,
          });
          log.log('[setup] initial setup complete');
          finish(parsed);
        } catch (error) {
          log.log(`[setup] failed: ${error instanceof Error ? error.message : String(error)}`);
          footer.setContent('Initial setup failed. Press q to quit or Enter to try another repo.');
          screen.render();
          screen.key(['enter'], () => {
            screen.removeAllListeners('enter');
            askForRepository();
          });
        }
      });
    };

    askForRepository();
  });
}

function parseOwnerRepoValue(value: string): { owner: string; repo: string } | null {
  const parts = value.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function formatActivityTimestamp(now: Date = new Date()): string {
  return now.toISOString().slice(11, 19);
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
