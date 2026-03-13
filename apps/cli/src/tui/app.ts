import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import blessed from 'neo-blessed';

import type {
  GHCrawlService,
  TuiClusterDetail,
  TuiClusterSortMode,
  TuiRepoStats,
  RepoUserExplorerMode,
  TuiSnapshot,
  TuiThreadDetail,
  TuiWideLayoutPreference,
} from '@ghcrawl/api-core';
import { getTuiRepositoryPreference, writeTuiRepositoryPreference } from '@ghcrawl/api-core';
import {
  filterCommands,
  formatCommandLabel,
  resolveCommands,
  selectCommandFromQuery,
  type TuiCommandDefinition,
  type TuiResolvedCommand,
} from './commands.js';
import {
  buildMemberRows,
  cycleFocusPane,
  cycleMinSizeFilter,
  cycleSortMode,
  findSelectableIndex,
  getScreenDefinition,
  getScreenFocusOrder,
  moveSelectableIndex,
  preserveSelectedId,
  selectedThreadIdFromRow,
  type MemberListRow,
  type TuiFocusPane,
  type TuiMinSizeFilter,
  type TuiScreenId,
} from './state.js';
import { computeTuiLayout } from './layout.js';
import {
  buildRepoUserListRows,
  buildRepoUserThreadRows,
  describeRepoUserMode,
  renderRepoUserDetail,
  type RepoUserDetailPayload,
  type RepoUsersPayload,
  type UserListRow,
  type UserThreadRow,
} from './users.js';

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

type UserRefreshChoice =
  | { kind: 'reload-local'; label: string }
  | { kind: 'selected-user'; label: string }
  | { kind: 'bulk'; label: string; limit: number | null };

type Widgets = {
  screen: blessed.Widgets.Screen;
  header: blessed.Widgets.BoxElement;
  clusters: blessed.Widgets.ListElement;
  members: blessed.Widgets.ListElement;
  detail: blessed.Widgets.BoxElement;
  footer: blessed.Widgets.BoxElement;
  commandPalette: blessed.Widgets.BoxElement;
  commandInput: blessed.Widgets.BoxElement;
  commandList: blessed.Widgets.ListElement;
  commandHint: blessed.Widgets.BoxElement;
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

type BackgroundJobResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  error: Error | null;
};

type BackgroundRefreshJob = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  repo: RepositoryTarget;
  selection: UpdateTaskSelection;
  stdoutBuffer: string;
  terminatedByUser: boolean;
  exitPromise: Promise<BackgroundJobResult>;
};

type TuiCommandContext = {
  activeScreen: TuiScreenId;
  currentRepository: RepositoryTarget;
  hasSnapshot: boolean;
  hasSelectedThread: boolean;
  hasSelectedUser: boolean;
  hasActiveJobs: boolean;
};

type CommandPaletteState = {
  open: boolean;
  query: string;
  selectedIndex: number;
  previousFocusPane: TuiFocusPane;
  previousScreen: TuiScreenId;
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

export function buildRefreshCliArgs(target: RepositoryTarget, selection: UpdateTaskSelection): string[] {
  const args = ['refresh', `${target.owner}/${target.repo}`];
  if (!selection.sync) args.push('--no-sync');
  if (!selection.embed) args.push('--no-embed');
  if (!selection.cluster) args.push('--no-cluster');
  return args;
}

function createCliLaunch(args: string[]): { command: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distEntrypoint = path.resolve(here, '..', 'main.js');
  if (existsSync(distEntrypoint)) {
    return { command: process.execPath, args: [distEntrypoint, ...args] };
  }

  const sourceEntrypoint = path.resolve(here, '..', 'main.ts');
  const require = createRequire(import.meta.url);
  const tsxLoader = require.resolve('tsx');
  return {
    command: process.execPath,
    args: ['--conditions=development', '--import', tsxLoader, sourceEntrypoint, ...args],
  };
}

export async function startTui(params: StartTuiParams): Promise<void> {
  const selectedRepository = params.owner && params.repo ? { owner: params.owner, repo: params.repo } : null;
  let currentRepository = selectedRepository ?? { owner: '', repo: '' };
  const widgets = createWidgets(currentRepository.owner, currentRepository.repo);

  let activeScreen: TuiScreenId = 'clusters';
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
  let clusterItems: string[] = ['Pick a repository with p'];
  let clusterIndexById = new Map<number, number>();
  let clusterDetail: TuiClusterDetail | null = null;
  let threadDetail: TuiThreadDetail | null = null;
  let selectedClusterId: number | null = null;
  let selectedMemberThreadId: number | null = null;
  let memberRows: MemberListRow[] = [];
  let memberIndex = -1;
  let userMode: RepoUserExplorerMode = 'flagged';
  let userList: RepoUsersPayload | null = null;
  let userRows: UserListRow[] = [];
  let selectedUserLogin: string | null = null;
  let userDetail: RepoUserDetailPayload | null = null;
  let userThreadRows: UserThreadRow[] = [];
  let selectedUserThreadId: number | null = null;
  let userThreadIndex = -1;
  let status = 'Ready';
  const activityLines: string[] = [];
  const clusterDetailCache = new Map<number, TuiClusterDetail>();
  const threadDetailCache = new Map<number, ThreadDetailCacheEntry>();
  let syncJobRunning = false;
  let embedJobRunning = false;
  let clusterJobRunning = false;
  let activeJob: BackgroundRefreshJob | null = null;
  let modalOpen = false;
  let exitRequested = false;
  let commandDefinitions: TuiCommandDefinition<TuiCommandContext>[] = [];
  let commandPalette: CommandPaletteState = {
    open: false,
    query: '',
    selectedIndex: 0,
    previousFocusPane: focusPane,
    previousScreen: activeScreen,
  };

  const hasActiveJobs = (): boolean => activeJob !== null;
  const hasBlockingOverlay = (): boolean => modalOpen || commandPalette.open;
  const buildCommandContext = (): TuiCommandContext => ({
    activeScreen,
    currentRepository,
    hasSnapshot: snapshot !== null,
    hasSelectedThread: selectedMemberThreadId !== null && threadDetail?.thread.htmlUrl !== undefined,
    hasSelectedUser: selectedUserLogin !== null,
    hasActiveJobs: hasActiveJobs(),
  });

  const clearCaches = (): void => {
    clusterDetailCache.clear();
    threadDetailCache.clear();
  };

  const preserveSelectedLogin = (logins: string[], selectedLogin: string | null): string | null => {
    if (selectedLogin !== null && logins.includes(selectedLogin)) {
      return selectedLogin;
    }
    return logins[0] ?? null;
  };

  const rebuildClusterItems = (): void => {
    if (!snapshot) {
      clusterItems = ['Pick a repository with p'];
      clusterIndexById = new Map();
      widgets.clusters.setItems(clusterItems);
      return;
    }

    clusterIndexById = new Map();
    clusterItems = snapshot.clusters.map((cluster: TuiSnapshot['clusters'][number], index: number) => {
      clusterIndexById.set(cluster.clusterId, index);
      const updated = formatClusterDateColumn(cluster.latestUpdatedAt);
      const label = `${String(cluster.totalCount).padStart(3, ' ')}  C${String(cluster.clusterId).padStart(5, ' ')}  ${String(cluster.pullRequestCount).padStart(2, ' ')}P/${String(cluster.issueCount).padStart(2, ' ')}I  ${updated}  ${cluster.displayTitle}`;
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

  const setActiveJobFlags = (selection: UpdateTaskSelection | null): void => {
    syncJobRunning = selection?.sync === true;
    embedJobRunning = selection?.embed === true;
    clusterJobRunning = selection?.cluster === true;
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
      const cluster = snapshot?.clusters.find((item: TuiSnapshot['clusters'][number]) => item.clusterId === clusterId) ?? null;
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
    selectedClusterId = preserveSelectedId(snapshot.clusters.map((cluster: TuiSnapshot['clusters'][number]) => cluster.clusterId), previousClusterId);
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
        selectedClusterId = preserveSelectedId(snapshot.clusters.map((cluster: TuiSnapshot['clusters'][number]) => cluster.clusterId), null);
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

  const loadSelectedUserDetail = (): void => {
    if (!selectedUserLogin) {
      userDetail = null;
      userThreadRows = [];
      selectedUserThreadId = null;
      userThreadIndex = -1;
      return;
    }

    userDetail = params.service.getRepoUserDetail({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      login: selectedUserLogin,
    });
    userThreadRows = buildRepoUserThreadRows(userDetail, userMode);
    const selectableThreadIds = userThreadRows.filter((row): row is Extract<UserThreadRow, { selectable: true }> => row.selectable).map((row) => row.threadId);
    if (!selectableThreadIds.includes(selectedUserThreadId ?? -1)) {
      selectedUserThreadId = selectableThreadIds[0] ?? null;
    }
    userThreadIndex = userThreadRows.findIndex((row) => row.selectable && row.threadId === selectedUserThreadId);
  };

  const refreshUserExplorer = (preserveSelection: boolean): void => {
    const previousLogin = preserveSelection ? selectedUserLogin : null;
    const previousThreadId = preserveSelection ? selectedUserThreadId : null;
    userList = params.service.listRepoUsers({
      owner: currentRepository.owner,
      repo: currentRepository.repo,
      mode: userMode,
      includeStale: true,
    });
    userRows = buildRepoUserListRows(userList);
    selectedUserLogin = preserveSelectedLogin(
      userList.users.map((user) => user.login),
      previousLogin,
    );
    selectedUserThreadId = previousThreadId;
    if (selectedUserLogin) {
      try {
        loadSelectedUserDetail();
      } catch (error) {
        userDetail = null;
        userThreadRows = [];
        selectedUserThreadId = null;
        userThreadIndex = -1;
        status = error instanceof Error ? error.message : 'Failed to load user detail';
        render();
        return;
      }
    } else {
      userDetail = null;
      userThreadRows = [];
      selectedUserThreadId = null;
      userThreadIndex = -1;
    }
    status = `Loaded ${userList.users.length} user(s) for ${describeRepoUserMode(userMode)}`;
    render();
  };

  const getDefaultFocusPane = (): TuiFocusPane => getScreenFocusOrder(activeScreen)[0] ?? 'detail';

  const updateFocus = (nextFocus: TuiFocusPane): void => {
    const allowedFocus = getScreenFocusOrder(activeScreen);
    focusPane = allowedFocus.includes(nextFocus) ? nextFocus : getDefaultFocusPane();
    if (focusPane === 'detail' && selectedMemberThreadId !== null) {
      loadSelectedThreadDetail(true);
    }
    if (focusPane === 'clusters') widgets.clusters.focus();
    if (focusPane === 'members') widgets.members.focus();
    if (focusPane === 'detail') widgets.detail.focus();
    render();
  };

  const switchScreen = (nextScreen: TuiScreenId): void => {
    if (activeScreen === nextScreen) {
      status = `Already in ${getScreenDefinition(nextScreen).label}`;
      render();
      return;
    }
    activeScreen = nextScreen;
    focusPane = getDefaultFocusPane();
    status =
      nextScreen === 'users'
        ? `Switched to ${describeRepoUserMode(userMode)}`
        : 'Switched to Clusters Explorer';
    if (nextScreen === 'users') {
      refreshUserExplorer(true);
      updateFocus('clusters');
      return;
    }
    updateFocus(getDefaultFocusPane());
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
    const screenDefinition = getScreenDefinition(activeScreen);
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
    if (activeScreen === 'clusters') {
      widgets.header.setContent(
        `{bold}${repoLabel}{/bold}  view:${escapeBlessedText(screenDefinition.label)}  {cyan-fg}${snapshot?.stats.openPullRequestCount ?? 0} PR{/cyan-fg}  {green-fg}${snapshot?.stats.openIssueCount ?? 0} issues{/green-fg}  GH:${ghStatus}  Emb:${embedStatus}  Cl:${clusterStatus}  sort:${sortMode}  min:${minSize === 0 ? 'all' : `${minSize}+`}  layout:${wideLayout === 'columns' ? 'cols' : 'stack'}  closed:${showClosed ? 'shown' : 'hidden'}  filter:${search || 'none'}`,
      );
    } else {
      widgets.header.setContent(
        `{bold}${repoLabel}{/bold}  view:${escapeBlessedText(screenDefinition.label)}  mode:${escapeBlessedText(describeRepoUserMode(userMode))}  matched:${userList?.totals.matchingUserCount ?? 0}  issues:${userList?.totals.openIssueCount ?? 0}  prs:${userList?.totals.openPullRequestCount ?? 0}  waiting:${userList?.totals.waitingPullRequestCount ?? 0}  GH:${ghStatus}  Emb:${embedStatus}  Cl:${clusterStatus}`,
      );
    }

    if (activeScreen === 'clusters') {
      widgets.clusters.setLabel(' Clusters ');
      widgets.members.setLabel(' Members ');
      widgets.detail.setLabel(' Detail ');
      const clusterIndex = snapshot && selectedClusterId !== null ? Math.max(0, clusterIndexById.get(selectedClusterId) ?? -1) : 0;
      widgets.clusters.setItems(clusterItems);
      widgets.clusters.select(clusterIndex);
      widgets.members.setItems(memberRows.length > 0 ? memberRows.map((row) => row.label) : ['No members']);
      if (memberIndex >= 0) {
        widgets.members.select(memberIndex);
      }
      widgets.detail.setContent(renderDetailPane(threadDetail, clusterDetail, focusPane));
    } else {
      widgets.clusters.setLabel(' Users ');
      widgets.members.setLabel(userMode === 'trusted_prs' ? ' Waiting PRs ' : ' Issues & PRs ');
      widgets.detail.setLabel(' User Detail ');
      widgets.clusters.setItems(userRows.length > 0 ? userRows.map((row) => row.label) : ['No matching users']);
      const userIndex = selectedUserLogin ? Math.max(0, userRows.findIndex((row) => row.login === selectedUserLogin)) : 0;
      widgets.clusters.select(userIndex);
      widgets.members.setItems(userThreadRows.length > 0 ? userThreadRows.map((row) => row.label) : ['No open threads for this user']);
      if (userThreadIndex >= 0) {
        widgets.members.select(userThreadIndex);
      } else {
        widgets.members.select(0);
      }
      widgets.detail.setContent(renderRepoUserDetail(userDetail, selectedUserThreadId));
    }

    updatePaneStyles(widgets, focusPane);
    const activeJobs = [syncJobRunning ? 'sync' : null, embedJobRunning ? 'embed' : null, clusterJobRunning ? 'cluster' : null]
      .filter(Boolean)
      .join(', ') || 'idle';
    const logLines = activityLines.slice(-FOOTER_LOG_LINES);
    const footerLines = [...logLines];
    while (footerLines.length < FOOTER_LOG_LINES) {
      footerLines.unshift('');
    }
    const footerHints = buildFooterCommandHints(activeScreen);
    footerLines.push(`${status}  |  jobs:${activeJobs}  |  ${footerHints[0]}`);
    footerLines.push(footerHints[1]);
    widgets.footer.setContent(footerLines.join('\n'));
    renderCommandPaletteOverlay(widgets, {
      width,
      footerTop: layout.footer.top,
      palette: commandPalette,
      commands: filterCommands(resolveCommands(commandDefinitions, buildCommandContext()), commandPalette.query),
    });
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

  const consumeStreamLines = (
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void,
  ): void => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '').trimEnd();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) onLine(line);
      }
    });
    stream.on('end', () => {
      const line = buffer.replace(/\r$/, '').trim();
      if (line.length > 0) onLine(line);
    });
  };

  const finalizeBackgroundJob = (job: BackgroundRefreshJob): void => {
    void (async () => {
      const result = await job.exitPromise;
      if (activeJob === job) {
        activeJob = null;
      }
      setActiveJobFlags(null);

      if (job.terminatedByUser) {
        pushActivity(`[jobs] update pipeline terminated for ${job.repo.owner}/${job.repo.repo}`);
      } else if (result.error) {
        pushActivity(`[jobs] update pipeline failed for ${job.repo.owner}/${job.repo.repo}: ${result.error.message}`);
      } else if (result.code === 0) {
        pushActivity(`[jobs] update pipeline complete for ${job.repo.owner}/${job.repo.repo}`);
        try {
          const parsed = JSON.parse(result.stdout.trim()) as {
            sync?: { threadsSynced?: number; threadsClosed?: number } | null;
            embed?: { embedded?: number } | null;
            cluster?: { clusters?: number; edges?: number } | null;
          };
          const summaryParts = [
            parsed.sync ? `sync:${parsed.sync.threadsSynced ?? 0} threads` : null,
            parsed.sync ? `closed:${parsed.sync.threadsClosed ?? 0}` : null,
            parsed.embed ? `embed:${parsed.embed.embedded ?? 0}` : null,
            parsed.cluster ? `cluster:${parsed.cluster.clusters ?? 0}` : null,
            parsed.cluster ? `edges:${parsed.cluster.edges ?? 0}` : null,
          ].filter((value): value is string => value !== null);
          if (summaryParts.length > 0) {
            pushActivity(`[jobs] result ${summaryParts.join('  ')}`);
          }
        } catch {
          // Ignore malformed stdout; progress is already visible in the activity log.
        }
        if (currentRepository.owner === job.repo.owner && currentRepository.repo === job.repo.repo) {
          refreshAll(true);
        }
      } else {
        const exitSuffix =
          result.signal !== null ? `signal=${result.signal}` : `code=${result.code ?? 1}`;
        pushActivity(`[jobs] update pipeline failed for ${job.repo.owner}/${job.repo.repo}: exited ${exitSuffix}`);
      }

      status = 'Ready';
      if (!exitRequested) {
        render();
      }
    })();
  };

  const startBackgroundUpdatePipeline = (target: RepositoryTarget, selection: UpdateTaskSelection): boolean => {
    if (activeJob !== null) {
      pushActivity('[jobs] another update pipeline is already running');
      return false;
    }
    if (!selection.sync && !selection.embed && !selection.cluster) {
      pushActivity('[jobs] select at least one update step');
      return false;
    }

    const cliArgs = buildRefreshCliArgs(target, selection);
    const launch = createCliLaunch(cliArgs);
    const child = spawn(launch.command, launch.args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const job: BackgroundRefreshJob = {
      child,
      repo: target,
      selection,
      stdoutBuffer: '',
      terminatedByUser: false,
      exitPromise: new Promise<BackgroundJobResult>((resolve) => {
        let resolved = false;
        const finish = (result: BackgroundJobResult): void => {
          if (resolved) return;
          resolved = true;
          resolve(result);
        };
        child.on('error', (error) => {
          finish({ code: null, signal: null, stdout: job.stdoutBuffer, error });
        });
        child.on('close', (code, signal) => {
          finish({ code, signal, stdout: job.stdoutBuffer, error: null });
        });
      }),
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      job.stdoutBuffer += chunk;
    });
    consumeStreamLines(child.stderr, (line) => pushActivity(line, { raw: true }));

    activeJob = job;
    setActiveJobFlags(selection);
    status = `Running update pipeline for ${target.owner}/${target.repo}`;
    pushActivity(
      `[jobs] starting update pipeline for ${target.owner}/${target.repo}: ${UPDATE_TASK_ORDER.filter((task) => selection[task]).join(' -> ')}`,
    );
    render();
    finalizeBackgroundJob(job);
    return true;
  };

  const moveSelection = (delta: -1 | 1, options?: { steps?: number; wrap?: boolean }): void => {
    const steps = Math.max(1, options?.steps ?? 1);
    const wrap = options?.wrap ?? true;
    if (activeScreen === 'users') {
      if (focusPane === 'clusters') {
        if (userRows.length === 0) return;
        const currentIndex = Math.max(0, selectedUserLogin === null ? -1 : userRows.findIndex((row) => row.login === selectedUserLogin));
        let nextIndex = currentIndex + delta * steps;
        if (wrap) {
          nextIndex = ((nextIndex % userRows.length) + userRows.length) % userRows.length;
        } else {
          nextIndex = Math.max(0, Math.min(userRows.length - 1, nextIndex));
        }
        selectedUserLogin = userRows[nextIndex]?.login ?? null;
        selectedUserThreadId = null;
        loadSelectedUserDetail();
        status = selectedUserLogin ? `User @${selectedUserLogin} (${nextIndex + 1}/${userRows.length})` : status;
        render();
        return;
      }

      if (focusPane === 'members') {
        if (userThreadRows.length === 0) return;
        let nextIndex = userThreadIndex < 0 ? 0 : userThreadIndex;
        for (let index = 0; index < steps; index += 1) {
          nextIndex += delta;
          while (nextIndex < 0) nextIndex = wrap ? userThreadRows.length - 1 : 0;
          while (nextIndex >= userThreadRows.length) nextIndex = wrap ? 0 : userThreadRows.length - 1;
          if (userThreadRows[nextIndex]?.selectable) {
            break;
          }
          if (!wrap && (nextIndex === 0 || nextIndex === userThreadRows.length - 1)) {
            break;
          }
        }
        if (!userThreadRows[nextIndex]?.selectable) {
          nextIndex = userThreadRows.findIndex((row) => row.selectable);
        }
        userThreadIndex = nextIndex;
        const selectedRow = userThreadRows[nextIndex];
        selectedUserThreadId = selectedRow?.selectable ? selectedRow.threadId : null;
        status = selectedUserThreadId !== null ? `Selected user thread #${selectedUserThreadId}` : status;
        render();
        return;
      }
      return;
    }

    if (!snapshot) return;

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

  const requireClustersScreen = (actionLabel: string): boolean => {
    if (activeScreen === 'clusters') {
      return true;
    }
    status = `${actionLabel} is only available in Clusters Explorer`;
    render();
    return false;
  };

  const closeCommandPalette = (options?: { restoreFocus?: boolean }): void => {
    if (!commandPalette.open) return;
    const restoreFocus = options?.restoreFocus ?? false;
    commandPalette = {
      open: false,
      query: '',
      selectedIndex: 0,
      previousFocusPane: commandPalette.previousFocusPane,
      previousScreen: commandPalette.previousScreen,
    };
    if (restoreFocus) {
      if (activeScreen !== commandPalette.previousScreen) {
        focusPane = getDefaultFocusPane();
      } else {
        focusPane = commandPalette.previousFocusPane;
      }
      updateFocus(focusPane);
      return;
    }
    render();
  };

  const openCommandPalette = (): void => {
    if (modalOpen) return;
    commandPalette = {
      open: true,
      query: '',
      selectedIndex: 0,
      previousFocusPane: focusPane,
      previousScreen: activeScreen,
    };
    render();
  };

  const getFilteredCommands = (): TuiResolvedCommand<TuiCommandContext>[] =>
    filterCommands(resolveCommands(commandDefinitions, buildCommandContext()), commandPalette.query);

  const moveCommandPaletteSelection = (delta: -1 | 1): void => {
    const filtered = getFilteredCommands();
    if (filtered.length === 0) return;
    commandPalette.selectedIndex =
      ((commandPalette.selectedIndex + delta) % filtered.length + filtered.length) % filtered.length;
    render();
  };

  const executeCommandFromPalette = (): void => {
    const command = selectCommandFromQuery(resolveCommands(commandDefinitions, buildCommandContext()), commandPalette.query, commandPalette.selectedIndex);
    if (!command) {
      status = 'No matching command';
      render();
      return;
    }
    if (!command.enabled) {
      status = command.reason ?? `/${command.definition.slash} is not available yet`;
      render();
      return;
    }
    closeCommandPalette();
    command.definition.execute();
  };

  const updateCommandPaletteQuery = (value: string): void => {
    commandPalette.query = value;
    commandPalette.selectedIndex = 0;
    render();
  };

  const handleCommandPaletteKeypress = (char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
    if (!commandPalette.open) return;
    if (key.name === 'escape') {
      closeCommandPalette({ restoreFocus: true });
      return;
    }
    if (key.name === 'up') {
      moveCommandPaletteSelection(-1);
      return;
    }
    if (key.name === 'down') {
      moveCommandPaletteSelection(1);
      return;
    }
    if (key.name === 'enter') {
      executeCommandFromPalette();
      return;
    }
    if (key.name === 'backspace' || key.name === 'delete') {
      updateCommandPaletteQuery(commandPalette.query.slice(0, -1));
      return;
    }
    if (key.name === 'space') {
      updateCommandPaletteQuery(`${commandPalette.query} `);
      return;
    }
    if (char && !key.ctrl && !key.meta && !key.shift && char.length === 1 && char >= ' ') {
      updateCommandPaletteQuery(`${commandPalette.query}${char}`);
    }
  };

  const promptFilter = (): void => {
    if (!requireClustersScreen('Filtering')) return;
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
    if (!requireClustersScreen('Jumping to threads')) return;
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
    if (!requireClustersScreen('Opening threads')) return;
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
    if (!requireClustersScreen('Author browsing')) return;
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

  const promptConfirm = async (label: string, message: string): Promise<boolean> => {
    const box = blessed.box({
      parent: widgets.screen,
      border: 'line',
      label: ` ${label} `,
      tags: true,
      top: 'center',
      left: 'center',
      width: '68%',
      height: 9,
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        border: { fg: '#fde74c' },
        fg: 'white',
        bg: '#101522',
      },
      content: `${message}\n\nPress y or Enter to confirm. Press n or Esc to cancel.`,
    });

    widgets.screen.render();

    return await new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        widgets.screen.off('keypress', handleKeypress);
        box.destroy();
        widgets.screen.render();
        resolve(value);
      };
      const handleKeypress = (char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
        if (key.name === 'enter' || char.toLowerCase() === 'y') {
          finish(true);
          return;
        }
        if (key.name === 'escape' || char.toLowerCase() === 'n' || key.name === 'q') {
          finish(false);
        }
      };

      widgets.screen.on('keypress', handleKeypress);
    });
  };

  const requestQuit = (): void => {
    if (modalOpen) return;
    void (async () => {
      if (activeJob === null) {
        widgets.screen.destroy();
        return;
      }

      modalOpen = true;
      try {
        const confirmed = await promptConfirm(
          'Stop Update Pipeline',
          `A background update pipeline is still running for ${activeJob.repo.owner}/${activeJob.repo.repo}.\nQuitting now will send SIGTERM to that refresh process and wait for it to exit.`,
        );
        if (!confirmed) {
          render();
          return;
        }

        exitRequested = true;
        status = 'Stopping background update pipeline';
        pushActivity(`[jobs] stopping update pipeline for ${activeJob.repo.owner}/${activeJob.repo.repo}`);
        render();
        activeJob.terminatedByUser = true;
        activeJob.child.kill('SIGTERM');
        await activeJob.exitPromise;
        widgets.screen.destroy();
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
        startBackgroundUpdatePipeline(currentRepository, selection);
        updateFocus('clusters');
      } finally {
        modalOpen = false;
      }
    })();
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

  const withProgressOverlay = async <T>(
    label: string,
    initialMessage: string,
    task: (updateMessage: (message: string) => void) => T | Promise<T>,
  ): Promise<T> => {
    const box = blessed.box({
      parent: widgets.screen,
      border: 'line',
      label: ` ${label} `,
      width: '62%',
      height: 8,
      top: 'center',
      left: 'center',
      tags: true,
      content: `${initialMessage}\n\nThis may take a while on large repositories.`,
      style: {
        border: { fg: '#5bc0eb' },
        fg: 'white',
        bg: '#101522',
      },
    });
    const updateMessage = (message: string): void => {
      box.setContent(`${message}\n\nThis may take a while on large repositories.`);
      widgets.screen.render();
    };
    widgets.screen.render();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      return await task(updateMessage);
    } finally {
      box.destroy();
      widgets.screen.render();
    }
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
    clusterItems = ['Pick a repository with p'];
    clusterIndexById = new Map();
    widgets.clusters.setItems(clusterItems);
    clusterDetail = null;
    threadDetail = null;
    selectedClusterId = null;
    selectedMemberThreadId = null;
    memberRows = [];
    memberIndex = -1;
    status = `Switched to ${target.owner}/${target.repo}`;
    refreshAll(false);
    if (activeScreen === 'users') {
      refreshUserExplorer(false);
    }
  };

  const runRepositoryBootstrap = (target: RepositoryTarget): boolean => {
    if (hasActiveJobs()) {
      pushActivity('[repo] repository setup is blocked while jobs are already running');
      return false;
    }

    switchRepository(target, { minClusterSize: 1 });
    pushActivity(`[repo] opened ${target.owner}/${target.repo}; starting initial update pipeline in the background`);
    return startBackgroundUpdatePipeline(target, { sync: true, embed: true, cluster: true });
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
        runRepositoryBootstrap(target);
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
      const ready = runRepositoryBootstrap(target);
      if (!ready) {
        return false;
      }
      updateFocus('clusters');
      return true;
    } finally {
      modalOpen = false;
    }
  };

  const cycleSortAction = (): void => {
    if (!requireClustersScreen('Sorting clusters')) return;
    sortMode = cycleSortMode(sortMode);
    persistRepositoryPreference();
    status = `Sort: ${sortMode}`;
    refreshAll(false);
  };

  const cycleMinSizeAction = (): void => {
    if (!requireClustersScreen('Changing the minimum size filter')) return;
    minSize = cycleMinSizeFilter(minSize);
    persistRepositoryPreference();
    status = `Min size: ${minSize === 0 ? 'all' : `${minSize}+`}`;
    refreshAll(false);
  };

  const toggleLayoutAction = (): void => {
    wideLayout = wideLayout === 'columns' ? 'right-stack' : 'columns';
    persistRepositoryPreference();
    status = `Layout: ${wideLayout === 'columns' ? 'three columns' : 'wide left + stacked right'}`;
    render();
  };

  const toggleClosedAction = (): void => {
    if (!requireClustersScreen('Toggling closed clusters')) return;
    showClosed = !showClosed;
    status = showClosed ? 'Showing closed clusters and members' : 'Hiding closed clusters and members';
    refreshAll(true);
  };

  const refreshAction = (): void => {
    if (activeScreen === 'users') {
      promptUserRefreshAction();
      return;
    }
    status = 'Refreshing';
    refreshAll(true);
  };

  const switchUserMode = (nextMode: RepoUserExplorerMode): void => {
    userMode = nextMode;
    activeScreen = 'users';
    focusPane = 'clusters';
    refreshUserExplorer(false);
    updateFocus('clusters');
  };

  const refreshSelectedUserAction = (): void => {
    if (activeScreen !== 'users' || !selectedUserLogin) {
      status = 'Select a user first';
      render();
      return;
    }

    const login = selectedUserLogin;
    void (async () => {
      modalOpen = true;
      try {
        await withLoadingOverlay(`Refreshing @${login}...`, async () => {
          await params.service.refreshRepoUser({
            owner: currentRepository.owner,
            repo: currentRepository.repo,
            login,
          });
        });
        refreshUserExplorer(true);
        status = `Refreshed @${login}`;
      } catch (error) {
        status = error instanceof Error ? error.message : 'Failed to refresh user';
        render();
      } finally {
        modalOpen = false;
      }
    })();
  };

  const refreshBulkUsersAction = (limit: number | null): void => {
    if (activeScreen !== 'users') {
      status = 'Open User Explorer first';
      render();
      return;
    }
    const selectedCount = limit ?? userList?.totals.matchingUserCount ?? userRows.length;
    if (selectedCount <= 0) {
      status = 'No matching users to refresh';
      render();
      return;
    }

    void (async () => {
      modalOpen = true;
      try {
        const result = await withProgressOverlay(
          ' User Refresh ',
          `Refreshing ${selectedCount} contributor profile(s)...`,
          async (updateMessage) =>
            params.service.refreshRepoUsers({
              owner: currentRepository.owner,
              repo: currentRepository.repo,
              mode: userMode,
              limit: limit ?? undefined,
              onProgress: (message) => updateMessage(message.replace(/^\[users\]\s*/, '')),
            }),
        );
        refreshUserExplorer(true);
        status = `User refresh: ${result.refreshedCount} refreshed, ${result.skippedCount} skipped, ${result.failedCount} failed`;
        if (result.failures.length > 0) {
          pushActivity(`[users] refresh failures: ${result.failures.slice(0, 5).map((failure) => `@${failure.login}`).join(', ')}`);
        }
        render();
      } catch (error) {
        status = error instanceof Error ? error.message : 'Failed to refresh users';
        render();
      } finally {
        modalOpen = false;
      }
    })();
  };

  const promptUserRefreshAction = (): void => {
    if (activeScreen !== 'users' || modalOpen) return;
    void (async () => {
      let delegated = false;
      modalOpen = true;
      try {
        const choice = await promptUserRefreshChoice(
          widgets.screen,
          describeRepoUserMode(userMode),
          userList?.totals.matchingUserCount ?? userRows.length,
          selectedUserLogin,
        );
        if (!choice) {
          render();
          return;
        }
        if (choice.kind === 'reload-local') {
          status = 'Refreshing local user view';
          refreshUserExplorer(true);
          return;
        }
        if (choice.kind === 'selected-user') {
          delegated = true;
          refreshSelectedUserAction();
          return;
        }
        delegated = true;
        refreshBulkUsersAction(choice.limit);
      } finally {
        if (!delegated) {
          modalOpen = false;
        }
      }
    })();
  };

  const openSelectedUserProfileAction = (): void => {
    if (activeScreen !== 'users' || !userDetail?.profile.profileUrl) {
      status = 'No selected user profile to open';
      render();
      return;
    }
    openUrl(userDetail.profile.profileUrl);
    status = `Opened ${userDetail.profile.profileUrl}`;
    render();
  };

  const focusForwardAction = (): void => {
    updateFocus(cycleFocusPane(focusPane, 1, getScreenFocusOrder(activeScreen)));
  };

  const focusBackwardAction = (): void => {
    updateFocus(cycleFocusPane(focusPane, -1, getScreenFocusOrder(activeScreen)));
  };

  commandDefinitions = [
    {
      id: 'view.clusters',
      slash: 'clusters',
      label: 'Clusters Explorer',
      description: 'Switch to the issue and PR cluster explorer.',
      aliases: ['cluster', 'home'],
      execute: () => switchScreen('clusters'),
    },
    {
      id: 'view.users',
      slash: 'users',
      label: 'User Explorer',
      description: 'Switch to the flagged contributor explorer.',
      aliases: ['user'],
      execute: () => switchUserMode('flagged'),
    },
    {
      id: 'view.users-flagged',
      slash: 'users flagged',
      label: 'Flagged contributors',
      description: 'Show low-reputation, hidden, stale, or unknown contributors.',
      aliases: ['flagged'],
      execute: () => switchUserMode('flagged'),
    },
    {
      id: 'view.users-trusted',
      slash: 'users trusted',
      label: 'Trusted PRs',
      description: 'Show high-reputation contributors with open PRs.',
      aliases: ['trusted'],
      execute: () => switchUserMode('trusted_prs'),
    },
    {
      id: 'view.filter',
      slash: 'filter',
      label: 'Filter clusters',
      description: 'Filter clusters by title and member text.',
      screens: ['clusters'],
      execute: () => promptFilter(),
    },
    {
      id: 'view.refresh',
      slash: 'refresh',
      label: 'Refresh view',
      description: 'Reload the current local TUI view from SQLite.',
      aliases: ['reload'],
      execute: () => refreshAction(),
    },
    {
      id: 'view.layout',
      slash: 'layout',
      label: 'Toggle layout',
      description: 'Switch between wide columns and stacked-right layout.',
      aliases: ['wide'],
      execute: () => toggleLayoutAction(),
    },
    {
      id: 'view.toggle-closed',
      slash: 'toggle-closed',
      label: 'Toggle closed items',
      description: 'Show or hide locally closed clusters and members.',
      screens: ['clusters'],
      aliases: ['closed'],
      execute: () => toggleClosedAction(),
    },
    {
      id: 'view.sort',
      slash: 'sort',
      label: 'Cycle sort mode',
      description: 'Toggle cluster ordering between recent and size.',
      screens: ['clusters'],
      execute: () => cycleSortAction(),
    },
    {
      id: 'view.min-size',
      slash: 'min-size',
      label: 'Cycle minimum cluster size',
      description: 'Rotate through the minimum cluster size presets.',
      screens: ['clusters'],
      aliases: ['min'],
      execute: () => cycleMinSizeAction(),
    },
    {
      id: 'data.repos',
      slash: 'repos',
      label: 'Browse repositories',
      description: 'Open the repository browser or sync a new repository.',
      aliases: ['repo'],
      getAvailability: () => (hasActiveJobs() ? { enabled: false, reason: 'blocked while jobs are running' } : { enabled: true }),
      execute: () => browseRepositories(),
    },
    {
      id: 'data.update',
      slash: 'update',
      label: 'Run update pipeline',
      description: 'Start the staged GitHub, embed, and cluster refresh flow.',
      aliases: ['refresh-pipeline'],
      getAvailability: () => (hasActiveJobs() ? { enabled: false, reason: 'already running' } : { enabled: true }),
      execute: () => promptUpdatePipeline(),
    },
    {
      id: 'data.open',
      slash: 'open',
      label: 'Open selected thread',
      description: 'Open the selected issue or PR in your browser.',
      screens: ['clusters'],
      getAvailability: () => ({ enabled: selectedMemberThreadId !== null, reason: 'select a thread first' }),
      execute: () => openSelectedThread(),
    },
    {
      id: 'data.author',
      slash: 'author',
      label: 'Browse selected author',
      description: 'Show the selected author’s open threads.',
      screens: ['clusters'],
      getAvailability: () => ({
        enabled: Boolean(threadDetail?.thread.authorLogin?.trim()),
        reason: 'select a thread with an author login',
      }),
      execute: () => promptAuthorThreads(),
    },
    {
      id: 'data.jump',
      slash: 'jump',
      label: 'Jump to issue or PR',
      description: 'Jump directly to a thread number.',
      screens: ['clusters'],
      aliases: ['thread'],
      execute: () => promptThreadJump(),
    },
    {
      id: 'data.user-refresh',
      slash: 'user-refresh',
      label: 'Refresh selected user',
      description: 'Refresh the selected user profile and reputation signals.',
      screens: ['users'],
      getAvailability: () => ({ enabled: selectedUserLogin !== null, reason: 'select a user first' }),
      execute: () => refreshSelectedUserAction(),
    },
    {
      id: 'data.user-refresh-bulk',
      slash: 'user-refresh-bulk',
      label: 'Bulk refresh users',
      description: 'Refresh the top contributors in the current user mode.',
      screens: ['users'],
      getAvailability: () => ({
        enabled: (userList?.totals.matchingUserCount ?? userRows.length) > 0,
        reason: 'no matching users',
      }),
      execute: () => promptUserRefreshAction(),
    },
    {
      id: 'data.user-open',
      slash: 'user-open',
      label: 'Open selected user profile',
      description: 'Open the selected user profile in your browser.',
      screens: ['users'],
      getAvailability: () => ({ enabled: Boolean(userDetail?.profile.profileUrl), reason: 'select a user first' }),
      execute: () => openSelectedUserProfileAction(),
    },
    {
      id: 'utility.help',
      slash: 'help',
      label: 'Help',
      description: 'Open the TUI help popup.',
      aliases: ['?'],
      execute: () => openHelp(),
    },
    {
      id: 'utility.quit',
      slash: 'quit',
      label: 'Quit',
      description: 'Quit the TUI.',
      aliases: ['exit'],
      execute: () => requestQuit(),
    },
  ];

  widgets.screen.key(['q'], () => {
    if (commandPalette.open) return;
    requestQuit();
  });
  widgets.screen.key(['C-c'], () => {
    requestQuit();
  });
  widgets.screen.key(['tab', 'right'], () => {
    if (hasBlockingOverlay()) return;
    focusForwardAction();
  });
  widgets.screen.key(['S-tab', 'left'], () => {
    if (hasBlockingOverlay()) return;
    focusBackwardAction();
  });
  widgets.screen.key(['down'], () => {
    if (hasBlockingOverlay()) return;
    if (focusPane === 'detail') {
      scrollDetail(3);
      return;
    }
    moveSelection(1);
  });
  widgets.screen.key(['up'], () => {
    if (hasBlockingOverlay()) return;
    if (focusPane === 'detail') {
      scrollDetail(-3);
      return;
    }
    moveSelection(-1);
  });
  widgets.screen.key(['pageup'], () => {
    if (hasBlockingOverlay()) return;
    pageFocusedPane(-1);
  });
  widgets.screen.key(['pagedown'], () => {
    if (hasBlockingOverlay()) return;
    pageFocusedPane(1);
  });
  widgets.screen.key(['home'], () => {
    if (hasBlockingOverlay()) return;
    if (focusPane !== 'detail') return;
    widgets.detail.setScroll(0);
    widgets.screen.render();
  });
  widgets.screen.key(['end'], () => {
    if (hasBlockingOverlay()) return;
    if (focusPane !== 'detail') return;
    widgets.detail.setScrollPerc(100);
    widgets.screen.render();
  });
  widgets.screen.key(['enter'], () => {
    if (hasBlockingOverlay()) return;
    if (focusPane === 'clusters') {
      updateFocus('members');
      return;
    }
    if (focusPane === 'members') {
      if (activeScreen === 'clusters') {
        loadSelectedThreadDetail(true);
        status = selectedMemberThreadId !== null ? `Loaded neighbors for #${threadDetail?.thread.number ?? '?'}` : status;
      }
      updateFocus('detail');
    }
  });
  widgets.screen.key(['s'], () => {
    if (hasBlockingOverlay()) return;
    cycleSortAction();
  });
  widgets.screen.key(['f'], () => {
    if (hasBlockingOverlay()) return;
    cycleMinSizeAction();
  });
  widgets.screen.key(['l'], () => {
    if (hasBlockingOverlay()) return;
    toggleLayoutAction();
  });
  widgets.screen.key(['x'], () => {
    if (hasBlockingOverlay()) return;
    toggleClosedAction();
  });
  widgets.screen.key(['/'], () => {
    if (hasBlockingOverlay()) return;
    openCommandPalette();
  });
  widgets.screen.key(['#'], () => {
    if (hasBlockingOverlay()) return;
    promptThreadJump();
  });
  widgets.screen.key(['h', '?'], () => {
    if (hasBlockingOverlay()) return;
    openHelp();
  });
  widgets.screen.key(['p'], () => {
    if (hasBlockingOverlay()) return;
    browseRepositories();
  });
  widgets.screen.key(['g'], () => {
    if (hasBlockingOverlay()) return;
    promptUpdatePipeline();
  });
  widgets.screen.key(['r'], () => {
    if (hasBlockingOverlay()) return;
    refreshAction();
  });
  widgets.screen.key(['o'], () => {
    if (hasBlockingOverlay()) return;
    if (activeScreen === 'users') {
      openSelectedUserProfileAction();
      return;
    }
    openSelectedThread();
  });
  widgets.screen.key(['u'], () => {
    if (hasBlockingOverlay()) return;
    promptAuthorThreads();
  });
  widgets.screen.on('keypress', handleCommandPaletteKeypress);
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
  const commandPalette = blessed.box({
    parent: screen,
    border: 'line',
    label: ' Commands ',
    tags: true,
    hidden: true,
    style: {
      border: { fg: '#5bc0eb' },
      fg: 'white',
      bg: '#101522',
    },
  });
  const commandInput = blessed.box({
    parent: commandPalette,
    top: 1,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    style: {
      fg: 'white',
      bg: '#101522',
    },
  });
  const commandList = blessed.list({
    parent: commandPalette,
    top: 3,
    left: 1,
    right: 1,
    bottom: 1,
    tags: true,
    keys: false,
    style: {
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    scrollbar: { ch: ' ' },
  });
  const commandHint = blessed.box({
    parent: commandPalette,
    top: 2,
    left: 1,
    right: 1,
    height: 1,
    tags: false,
    style: {
      fg: '#9bc53d',
      bg: '#101522',
    },
  });

  return { screen, header, clusters, members, detail, footer, commandPalette, commandInput, commandList, commandHint };
}

function updatePaneStyles(widgets: Widgets, focus: TuiFocusPane): void {
  widgets.clusters.style.border = { fg: focus === 'clusters' ? 'white' : '#5bc0eb' };
  widgets.members.style.border = { fg: focus === 'members' ? 'white' : '#9bc53d' };
  widgets.detail.style.border = { fg: focus === 'detail' ? 'white' : '#fde74c' };
}

function renderCommandPaletteOverlay(
  widgets: Widgets,
  params: {
    width: number;
    footerTop: number;
    palette: CommandPaletteState;
    commands: TuiResolvedCommand<TuiCommandContext>[];
  },
): void {
  widgets.commandPalette.hidden = !params.palette.open;
  if (!params.palette.open) {
    return;
  }

  const paletteWidth = Math.max(42, Math.min(Math.floor(params.width * 0.54), 78));
  const paletteHeight = 10;
  widgets.commandPalette.width = paletteWidth;
  widgets.commandPalette.height = paletteHeight;
  widgets.commandPalette.left = 0;
  widgets.commandPalette.top = Math.max(1, params.footerTop - paletteHeight);
  widgets.commandInput.setContent(`{bold}/${escapeBlessedText(params.palette.query || '')}{/bold}`);
  widgets.commandHint.setContent('Type to filter, arrows to move, Enter to run, Esc to close.');
  const items = params.commands.length > 0 ? params.commands.map((command) => formatCommandLabel(command)) : ['No matching commands'];
  widgets.commandList.setItems(items);
  widgets.commandList.select(params.commands.length > 0 ? Math.max(0, Math.min(params.palette.selectedIndex, params.commands.length - 1)) : 0);
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
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `{bold}${key}:{/bold}\n${escapeBlessedText(value)}`)
    .join('\n\n');
  const neighbors =
    threadDetail.neighbors.length > 0
      ? threadDetail.neighbors
          .map((neighbor: TuiThreadDetail['neighbors'][number]) => `#${neighbor.number} ${neighbor.kind} ${(neighbor.score * 100).toFixed(1)}%  ${escapeBlessedText(neighbor.title)}`)
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

export function buildFooterCommandHints(activeScreen: TuiScreenId): [string, string] {
  const screenHint =
    activeScreen === 'clusters'
      ? '/clusters /users /filter /repos /update /help /quit'
      : '/users flagged /users trusted /refresh /user-refresh-bulk /user-open /repos /help /quit';
  const hotkeyHint =
    activeScreen === 'clusters'
      ? 'Hotkeys: Tab/arrows move  # jump  p repos  g update  q quit'
      : 'Hotkeys: Tab/arrows move  r refresh menu  o profile  p repos  g update  q quit';
  return [`/ commands: ${screenHint}`, hotkeyHint];
}

export function buildHelpContent(): string {
  return [
    '{bold}ghcrawl TUI Help{/bold}',
    '',
    '{bold}Slash Commands{/bold}',
    '/                 open the command palette in the bottom-left corner',
    '/clusters         switch to the current issue and PR cluster explorer',
    '/users            switch to the flagged contributor explorer',
    '/users flagged    show low-reputation, stale, or hidden-activity contributors',
    '/users trusted    show high-reputation contributors with open PRs',
    '/filter           open the cluster filter prompt',
    '/refresh          reload the current view, or open the user refresh menu on /users',
    '/user-refresh     refresh the selected user profile and reputation signals',
    '/user-refresh-bulk open the bulk user refresh menu for the current user mode',
    '/user-open        open the selected user profile in your browser',
    '/repos            browse repositories or sync a new one',
    '/update           start the staged background refresh pipeline',
    '/help             open this popup',
    '/quit             quit the TUI',
    'Hotkeys remain available as fast aliases while we transition to slash commands.',
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
    '/filter           filter clusters by title/member text',
    'r                 refresh the current view, or open the user refresh menu on /users',
    '',
    '{bold}Actions{/bold}',
    'g                 start the staged update pipeline in the background (GitHub, embeddings, clusters)',
    'p                 open the repository browser / sync a new repository',
    'u                 show all open threads for the selected author',
    'o                 open the selected thread URL in your browser',
    '',
    '{bold}Help And Exit{/bold}',
    'h or ?            open this help popup',
    'q                 quit the TUI (or close this popup); warns if a background update is running',
    'Esc               close this popup',
    '',
    '{bold}Notes{/bold}',
    'Clusters show C<clusterId> so the cluster id is easy to copy into CLI or skill flows.',
    'The footer leads with slash commands now; hotkeys are still available as aliases.',
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
      'Toggle with space, move with arrows, Enter to start, Esc to cancel.',
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
      if (key.name === 'escape' || key.name === 'q') {
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

async function promptUserRefreshChoice(
  screen: blessed.Widgets.Screen,
  modeLabel: string,
  matchingUserCount: number,
  selectedUserLogin: string | null,
): Promise<UserRefreshChoice | null> {
  const choices: UserRefreshChoice[] = [
    { kind: 'reload-local', label: 'Reload the local user view only' },
    ...(selectedUserLogin ? [{ kind: 'selected-user' as const, label: `Refresh selected user @${selectedUserLogin}` }] : []),
  ];
  for (const limit of [25, 100]) {
    if (matchingUserCount >= limit) {
      choices.push({
        kind: 'bulk',
        limit,
        label: `Refresh top ${limit} ${modeLabel.toLowerCase()} contributor${limit === 1 ? '' : 's'}`,
      });
    }
  }
  if (matchingUserCount > 0) {
    choices.push({
      kind: 'bulk',
      limit: null,
      label: `Refresh all ${matchingUserCount} matched contributor${matchingUserCount === 1 ? '' : 's'} (slow)`,
    });
  }

  const box = blessed.list({
    parent: screen,
    border: 'line',
    label: ' User Refresh ',
    keys: true,
    vi: true,
    mouse: false,
    top: 'center',
    left: 'center',
    width: '74%',
    height: 11,
    style: {
      border: { fg: '#5bc0eb' },
      item: { fg: 'white' },
      selected: { bg: '#5bc0eb', fg: 'black', bold: true },
    },
    items: choices.map((choice) => choice.label),
  });
  const help = blessed.box({
    parent: screen,
    top: 'center-4',
    left: 'center',
    width: '74%',
    height: 4,
    style: { fg: 'white', bg: '#101522' },
    content:
      `Current mode: ${modeLabel}. Bulk refresh uses cached data and skips fresh profiles automatically.\n` +
      'Use Enter to choose. Start with top 25 or top 100 before trying all matched users.',
  });

  box.focus();
  box.select(0);
  screen.render();

  return await new Promise<UserRefreshChoice | null>((resolve) => {
    const teardown = (): void => {
      screen.off('keypress', handleKeypress);
      box.destroy();
      help.destroy();
      screen.render();
    };
    const finish = (value: UserRefreshChoice | null): void => {
      teardown();
      resolve(value);
    };
    const handleKeypress = (_char: string, key: blessed.Widgets.Events.IKeyEventArg): void => {
      if (key.name === 'escape' || key.name === 'q') {
        finish(null);
      }
    };

    screen.on('keypress', handleKeypress);
    box.on('select', (_item, index) => finish(choices[index] ?? null));
  });
}

export function getRepositoryChoices(service: Pick<GHCrawlService, 'listRepositories'>, now: Date = new Date()): RepositoryChoice[] {
  type ListedRepository = ReturnType<GHCrawlService['listRepositories']>['repositories'][number];
  const repositories = service.listRepositories().repositories
    .slice()
    .sort(
      (left: ListedRepository, right: ListedRepository) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.fullName.localeCompare(right.fullName),
    );

  return [
    ...repositories.map((repository: ListedRepository) => ({
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
  const choices: AuthorThreadChoice[] = threads.map((item: ReturnType<GHCrawlService['listAuthorThreads']>['threads'][number]) => {
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
      if (key.name === 'escape' || key.name === 'q') {
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
    await service.clusterRepository({
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
