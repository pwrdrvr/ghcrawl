import test from 'node:test';
import assert from 'node:assert/strict';

import type { TuiClusterDetail, TuiRepoStats, TuiThreadDetail } from '@gitcrawl/api-core';

import {
  buildUpdatePipelineLabels,
  describeUpdateTask,
  escapeBlessedText,
  getRepositoryChoices,
  parseOwnerRepoValue,
  renderDetailPane,
} from './app.js';

test('escapeBlessedText escapes blessed tag delimiters', () => {
  assert.equal(escapeBlessedText('{bold}wow{/bold}'), '\\{bold\\}wow\\{/bold\\}');
  assert.equal(escapeBlessedText('path\\name'), 'path\\\\name');
});

test('renderDetailPane escapes user-provided text before rendering into a tags-enabled box', () => {
  const cluster: TuiClusterDetail = {
    clusterId: 1,
    displayTitle: 'Cluster {red-fg}boom{/red-fg}',
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
  assert.match(rendered, /Bad \\{bold\\}title\\{\/bold\\}/);
  assert.match(rendered, /Body with \\{red-fg\\}tags\\{\/red-fg\\}/);
  assert.match(rendered, /Summary \\{yellow-fg\\}text\\{\/yellow-fg\\}/);
  assert.match(rendered, /Neighbor \\{blue-fg\\}title\\{\/blue-fg\\}/);
});

test('parseOwnerRepoValue accepts owner slash repo values and rejects invalid ones', () => {
  assert.deepEqual(parseOwnerRepoValue('openclaw/openclaw'), { owner: 'openclaw', repo: 'openclaw' });
  assert.equal(parseOwnerRepoValue('openclaw'), null);
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
