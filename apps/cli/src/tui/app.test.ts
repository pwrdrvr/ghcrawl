import test from 'node:test';
import assert from 'node:assert/strict';

import type { TuiClusterDetail, TuiRepoStats, TuiThreadDetail } from '@ghcrawl/api-core';

import {
  buildFooterCommandHints,
  buildRefreshCliArgs,
  buildHelpContent,
  buildUpdatePipelineLabels,
  describeUpdateTask,
  escapeBlessedText,
  formatClusterDateColumn,
  getRepositoryChoices,
  parseOwnerRepoValue,
  renderDetailPane,
  resolveBlessedTerminal,
} from './app.js';

test('escapeBlessedText escapes blessed tag delimiters', () => {
  assert.equal(escapeBlessedText('{bold}wow{/bold}'), '\\{bold\\}wow\\{/bold\\}');
  assert.equal(escapeBlessedText('path\\name'), 'path\\\\name');
});

test('renderDetailPane escapes user-provided text before rendering into a tags-enabled box', () => {
  const cluster: TuiClusterDetail = {
    clusterId: 1,
    displayTitle: 'Cluster {red-fg}boom{/red-fg}',
    isClosed: false,
    closedAtLocal: null,
    closeReasonLocal: null,
    totalCount: 1,
    issueCount: 1,
    pullRequestCount: 0,
    latestUpdatedAt: '2026-03-09T00:00:00Z',
    representativeThreadId: 1,
    representativeNumber: 42,
    representativeKind: 'issue',
    members: [],
  };
  const detail: TuiThreadDetail = {
    thread: {
      id: 1,
      repoId: 1,
      number: 42,
      kind: 'issue',
      state: 'open',
      isClosed: false,
      closedAtGh: null,
      closedAtLocal: null,
      closeReasonLocal: null,
      title: 'Bad {bold}title{/bold}',
      body: 'Body with {red-fg}tags{/red-fg}',
      authorLogin: 'dev{cyan-fg}',
      htmlUrl: 'https://example.com/{oops}',
      labels: ['bug{green-fg}'],
      updatedAtGh: '2026-03-09T00:00:00Z',
      clusterId: 1,
    },
    summaries: {
      dedupe_summary: 'Summary {yellow-fg}text{/yellow-fg}',
    },
    neighbors: [
      {
        threadId: 2,
        number: 43,
        kind: 'pull_request',
        title: 'Neighbor {blue-fg}title{/blue-fg}',
        score: 0.9,
      },
    ],
  };

  const rendered = renderDetailPane(detail, cluster, 'detail');
  assert.match(rendered, /Cluster 1 \(#42 representative issue\)/);
  assert.match(rendered, /Bad \\{bold\\}title\\{\/bold\\}/);
  assert.match(rendered, /Body with \\{red-fg\\}tags\\{\/red-fg\\}/);
  assert.match(rendered, /Summary \\{yellow-fg\\}text\\{\/yellow-fg\\}/);
  assert.match(rendered, /Neighbor \\{blue-fg\\}title\\{\/blue-fg\\}/);
});

test('parseOwnerRepoValue accepts owner slash repo values and rejects invalid ones', () => {
  assert.deepEqual(parseOwnerRepoValue('openclaw/openclaw'), { owner: 'openclaw', repo: 'openclaw' });
  assert.equal(parseOwnerRepoValue('openclaw'), null);
});

test('resolveBlessedTerminal normalizes ghostty to xterm-256color', () => {
  assert.equal(resolveBlessedTerminal({ TERM: 'xterm-ghostty' } as NodeJS.ProcessEnv), 'xterm-256color');
  assert.equal(resolveBlessedTerminal({ TERM: 'xterm-256color' } as NodeJS.ProcessEnv), 'xterm-256color');
});

test('formatClusterDateColumn follows locale month/day ordering while keeping fixed time width', () => {
  const iso = '2026-03-10T16:04:00';

  assert.equal(formatClusterDateColumn(iso, 'en-US'), '03-10 16:04');
  assert.equal(formatClusterDateColumn(iso, 'en-GB'), '10-03 16:04');
});

test('getRepositoryChoices sorts by most recent update and includes the new-repo action', () => {
  const service = {
    listRepositories() {
      return {
        repositories: [
          {
            id: 1,
            owner: 'older',
            name: 'repo',
            fullName: 'older/repo',
            githubRepoId: '1',
            updatedAt: '2026-03-08T12:00:00Z',
          },
          {
            id: 2,
            owner: 'newer',
            name: 'repo',
            fullName: 'newer/repo',
            githubRepoId: '2',
            updatedAt: '2026-03-09T12:00:00Z',
          },
        ],
      };
    },
  };

  const choices = getRepositoryChoices(service, new Date('2026-03-09T12:30:00Z'));
  assert.equal(choices[0]?.kind, 'existing');
  assert.equal(choices[0]?.target.owner, 'newer');
  assert.match(choices[0]?.label ?? '', /newer\/repo/);
  assert.equal(choices.at(-1)?.kind, 'new');
});

test('describeUpdateTask reports stale embeddings relative to GitHub sync', () => {
  const stats: TuiRepoStats = {
    openIssueCount: 10,
    openPullRequestCount: 5,
    lastGithubReconciliationAt: '2026-03-09T14:00:00Z',
    lastEmbedRefreshAt: '2026-03-09T12:00:00Z',
    staleEmbedThreadCount: 0,
    staleEmbedSourceCount: 0,
    latestClusterRunId: 7,
    latestClusterRunFinishedAt: '2026-03-09T14:30:00Z',
  };

  assert.equal(describeUpdateTask('embed', stats, new Date('2026-03-09T15:00:00Z')), 'outdated: GitHub is newer by 2h');
});

test('describeUpdateTask reports stale clusters relative to embed refresh', () => {
  const stats: TuiRepoStats = {
    openIssueCount: 10,
    openPullRequestCount: 5,
    lastGithubReconciliationAt: '2026-03-09T14:00:00Z',
    lastEmbedRefreshAt: '2026-03-09T15:00:00Z',
    staleEmbedThreadCount: 0,
    staleEmbedSourceCount: 0,
    latestClusterRunId: 7,
    latestClusterRunFinishedAt: '2026-03-09T12:00:00Z',
  };

  assert.equal(describeUpdateTask('cluster', stats, new Date('2026-03-09T16:00:00Z')), 'outdated: embeddings are newer by 3h');
});

test('buildUpdatePipelineLabels marks the selected tasks and includes task guidance', () => {
  const stats: TuiRepoStats = {
    openIssueCount: 10,
    openPullRequestCount: 5,
    lastGithubReconciliationAt: '2026-03-09T14:00:00Z',
    lastEmbedRefreshAt: '2026-03-09T15:00:00Z',
    staleEmbedThreadCount: 2,
    staleEmbedSourceCount: 4,
    latestClusterRunId: 7,
    latestClusterRunFinishedAt: '2026-03-09T12:00:00Z',
  };

  const labels = buildUpdatePipelineLabels(
    stats,
    { sync: true, embed: true, cluster: false },
    new Date('2026-03-09T16:00:00Z'),
  );

  assert.match(labels[0] ?? '', /^\[x\] GitHub sync\/reconcile  up to date, last 2h ago$/);
  assert.match(labels[1] ?? '', /^\[x\] Embed refresh  outdated: 2 stale, last 1h ago$/);
  assert.match(labels[2] ?? '', /^\[ \] Cluster rebuild  outdated: embeddings are newer by 3h$/);
});

test('buildHelpContent includes the full key command list', () => {
  const content = buildHelpContent();

  assert.match(content, /Slash Commands/);
  assert.match(content, /\/clusters\s+switch to the current issue and PR cluster explorer/);
  assert.match(content, /\/users\s+switch to the flagged contributor explorer/);
  assert.match(content, /\/users flagged\s+show low-reputation, stale, or hidden-activity contributors/);
  assert.match(content, /\/users trusted\s+show high-reputation contributors with open PRs/);
  assert.match(content, /\/user-refresh\s+refresh the selected user profile and reputation signals/);
  assert.match(content, /\/filter\s+open the cluster filter prompt/);
  assert.match(content, /Tab \/ Shift-Tab/);
  assert.match(content, /Left \/ Right\s+cycle focus backward or forward across panes/);
  assert.match(content, /Up \/ Down\s+move selection, or scroll detail when detail is focused/);
  assert.match(content, /#\s+jump directly to an issue or PR number/);
  assert.match(content, /g\s+start the staged update pipeline in the background/);
  assert.match(content, /p\s+open the repository browser/);
  assert.match(content, /u\s+show all open threads for the selected author/);
  assert.match(content, /l\s+toggle wide layout/);
  assert.match(content, /x\s+show or hide locally closed clusters and members/);
  assert.match(content, /h or \?\s+open this help popup/);
  assert.match(content, /q\s+quit the TUI/);
  assert.doesNotMatch(content, /\/\s+filter clusters by title\/member text/);
  assert.doesNotMatch(content, /j \/ k/);
  assert.match(content, /This popup scrolls\./);
});

test('buildFooterCommandHints leads with slash commands for each screen', () => {
  assert.match(buildFooterCommandHints('clusters')[0], /\/clusters \/users \/filter \/repos \/update \/help \/quit/);
  assert.match(buildFooterCommandHints('users')[0], /\/users flagged \/users trusted \/user-refresh \/user-open \/repos \/help \/quit/);
  assert.match(buildFooterCommandHints('users')[1], /o profile/);
});

test('buildRefreshCliArgs maps the staged selection to refresh skip flags', () => {
  assert.deepEqual(buildRefreshCliArgs({ owner: 'openclaw', repo: 'openclaw' }, { sync: true, embed: true, cluster: true }), [
    'refresh',
    'openclaw/openclaw',
  ]);
  assert.deepEqual(buildRefreshCliArgs({ owner: 'openclaw', repo: 'openclaw' }, { sync: false, embed: true, cluster: false }), [
    'refresh',
    'openclaw/openclaw',
    '--no-sync',
    '--no-cluster',
  ]);
});
