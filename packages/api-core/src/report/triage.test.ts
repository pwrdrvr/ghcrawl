import assert from 'node:assert/strict';
import test from 'node:test';

import type { ClusterSummaryDto, RepoStatsDto, RepositoryDto } from '@ghcrawl/api-contract';

import { formatTriageMarkdown, generateSuggestedActions, type TriageReport } from './triage.js';

function makeCluster(overrides: Partial<ClusterSummaryDto> = {}): ClusterSummaryDto {
  return {
    clusterId: 1,
    displayTitle: 'Download stalls on large files',
    isClosed: false,
    closedAtLocal: null,
    closeReasonLocal: null,
    totalCount: 7,
    issueCount: 7,
    pullRequestCount: 0,
    latestUpdatedAt: '2026-01-15T00:00:00Z',
    representativeThreadId: 100,
    representativeNumber: 42,
    representativeKind: 'issue',
    ...overrides,
  };
}

const repository: RepositoryDto = {
  id: 1,
  owner: 'openclaw',
  name: 'openclaw',
  fullName: 'openclaw/openclaw',
  githubRepoId: '123',
  updatedAt: '2026-03-01T00:00:00Z',
};

const stats: RepoStatsDto = {
  openIssueCount: 120,
  openPullRequestCount: 14,
  lastGithubReconciliationAt: '2026-03-10T00:00:00Z',
  lastEmbedRefreshAt: '2026-03-11T00:00:00Z',
  staleEmbedThreadCount: 9,
  staleEmbedSourceCount: 9,
  latestClusterRunId: 88,
  latestClusterRunFinishedAt: '2026-03-12T00:00:00Z',
};

test('generateSuggestedActions returns close, growth, and stale actions when triggered', () => {
  const now = Date.now();
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const fortyDaysAgo = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();

  const actions = generateSuggestedActions([
    makeCluster({ clusterId: 1, totalCount: 7, issueCount: 7, pullRequestCount: 0, latestUpdatedAt: threeDaysAgo }),
    makeCluster({
      clusterId: 2,
      displayTitle: 'Errors spike on nightly builds',
      totalCount: 8,
      issueCount: 6,
      pullRequestCount: 2,
      latestUpdatedAt: threeDaysAgo,
    }),
    makeCluster({
      clusterId: 3,
      displayTitle: 'Legacy auth failures',
      totalCount: 4,
      issueCount: 4,
      pullRequestCount: 0,
      latestUpdatedAt: fortyDaysAgo,
    }),
  ]);

  assert(actions.some((action) => action.action === 'review_duplicate_candidates' && action.clusterId === 1));
  assert(actions.some((action) => action.action === 'investigate_growth' && action.clusterId === 1));
  assert(actions.some((action) => action.action === 'investigate_growth' && action.clusterId === 2));
  assert(actions.some((action) => action.action === 'stale_cluster' && action.clusterId === 3));
});

test('generateSuggestedActions returns empty for clusters below thresholds', () => {
  const actions = generateSuggestedActions([
    makeCluster({ clusterId: 10, totalCount: 2, issueCount: 2, pullRequestCount: 0, latestUpdatedAt: null }),
    makeCluster({ clusterId: 11, totalCount: 4, issueCount: 3, pullRequestCount: 1, latestUpdatedAt: '2026-03-01T00:00:00Z' }),
  ]);

  assert.deepEqual(actions, []);
});

test('formatTriageMarkdown includes expected sections and content', () => {
  const topClusters = [makeCluster({ clusterId: 5, displayTitle: 'High CPU in indexer' })];
  const suggestedActions = generateSuggestedActions(topClusters);
  const report: TriageReport = {
    repository,
    generatedAt: '2026-03-18T10:00:00Z',
    stats,
    topClusters,
    suggestedActions,
  };

  const markdown = formatTriageMarkdown(report);

  assert.match(markdown, /# Triage Report: openclaw\/openclaw/);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /## Top Clusters by Size/);
  assert.match(markdown, /\| # \| Cluster \| Representative \| Members \| Issues \| PRs \| Last Updated \|/);
  assert.match(markdown, /## Suggested Actions/);
  assert.match(markdown, /High CPU in indexer/);
});

test('stale cluster threshold requires more than 30 days', () => {
  const now = Date.now();
  const exactlyThirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyOneDaysAgo = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();

  const actions = generateSuggestedActions([
    makeCluster({ clusterId: 21, totalCount: 3, issueCount: 3, latestUpdatedAt: exactlyThirtyDaysAgo }),
    makeCluster({ clusterId: 22, totalCount: 3, issueCount: 3, latestUpdatedAt: thirtyOneDaysAgo }),
  ]);

  assert.equal(actions.some((action) => action.action === 'stale_cluster' && action.clusterId === 21), false);
  assert.equal(actions.some((action) => action.action === 'stale_cluster' && action.clusterId === 22), true);
});
