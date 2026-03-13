import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionRequestSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  repoUserBulkRefreshResponseSchema,
  repoUserDetailResponseSchema,
  repoUsersResponseSchema,
  searchResponseSchema,
} from './contracts.js';

test('health schema accepts configured status payload', () => {
  const parsed = healthResponseSchema.parse({
    ok: true,
    configPath: '/Users/example/.config/ghcrawl/config.json',
    configFileExists: true,
    dbPath: 'data/ghcrawl.db',
    apiPort: 5179,
    githubConfigured: true,
    openaiConfigured: false,
  });

  assert.equal(parsed.apiPort, 5179);
});

test('search schema rejects invalid mode', () => {
  assert.throws(() =>
    searchResponseSchema.parse({
      repository: {
        id: 1,
        owner: 'openclaw',
        name: 'openclaw',
        fullName: 'openclaw/openclaw',
        githubRepoId: null,
        updatedAt: new Date().toISOString(),
      },
      query: 'panic',
      mode: 'invalid',
      hits: [],
    }),
  );
});

test('action request accepts optional thread number', () => {
  const parsed = actionRequestSchema.parse({
    owner: 'openclaw',
    repo: 'openclaw',
    action: 'summarize',
    threadNumber: 42,
  });

  assert.equal(parsed.threadNumber, 42);
});

test('neighbors schema accepts repository, source thread, and neighbor list', () => {
  const parsed = neighborsResponseSchema.parse({
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: new Date().toISOString(),
    },
    thread: {
      id: 10,
      repoId: 1,
      number: 42,
      kind: 'issue',
      state: 'open',
      isClosed: false,
      closedAtGh: null,
      closedAtLocal: null,
      closeReasonLocal: null,
      title: 'Downloader hangs',
      body: 'The transfer never finishes.',
      authorLogin: 'alice',
      htmlUrl: 'https://github.com/openclaw/openclaw/issues/42',
      labels: ['bug'],
      updatedAtGh: new Date().toISOString(),
      clusterId: null,
    },
    neighbors: [
      {
        threadId: 11,
        number: 43,
        kind: 'pull_request',
        title: 'Fix downloader hang',
        score: 0.93,
      },
    ],
  });

  assert.equal(parsed.neighbors[0].number, 43);
});

test('repo users schema accepts flagged contributor summaries and totals', () => {
  const parsed = repoUsersResponseSchema.parse({
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: new Date().toISOString(),
    },
    mode: 'flagged',
    totals: {
      matchingUserCount: 1,
      openIssueCount: 2,
      openPullRequestCount: 1,
      waitingPullRequestCount: 1,
    },
    users: [
      {
        login: 'alice',
        reputationTier: 'low',
        likelyHiddenActivity: true,
        isStale: false,
        lastRefreshedAt: new Date().toISOString(),
        lastRefreshError: null,
        accountCreatedAt: new Date().toISOString(),
        accountAgeDays: 42,
        openIssueCount: 2,
        openPullRequestCount: 1,
        waitingPullRequestCount: 1,
        matchedLowReputation: true,
        matchedLikelyHiddenActivity: true,
        reasons: ['new account'],
      },
    ],
  });

  assert.equal(parsed.users[0]?.login, 'alice');
});

test('repo user detail schema accepts profile metrics and PR sizing', () => {
  const parsed = repoUserDetailResponseSchema.parse({
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: new Date().toISOString(),
    },
    profile: {
      login: 'alice',
      githubUserId: '42',
      profileUrl: 'https://github.com/alice',
      avatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
      userType: 'User',
      accountCreatedAt: new Date().toISOString(),
      accountAgeDays: 500,
      publicRepoCount: 20,
      publicGistCount: 3,
      followers: 12,
      following: 1,
      recentPublicEventCount: 5,
      reputationTier: 'high',
      likelyHiddenActivity: false,
      isStale: false,
      lastGlobalRefreshAt: new Date().toISOString(),
      lastRepoRefreshAt: new Date().toISOString(),
      lastRefreshError: null,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      reasons: ['established account'],
    },
    totals: {
      matchingUserCount: 1,
      openIssueCount: 0,
      openPullRequestCount: 1,
      waitingPullRequestCount: 1,
    },
    issues: [],
    pullRequests: [
      {
        threadId: 10,
        number: 43,
        kind: 'pull_request',
        title: 'Fix downloader hang',
        htmlUrl: 'https://github.com/openclaw/openclaw/pull/43',
        state: 'open',
        isDraft: false,
        createdAtGh: new Date().toISOString(),
        updatedAtGh: new Date().toISOString(),
        ageDays: 10,
        filesChanged: 4,
        additions: 120,
        deletions: 30,
      },
    ],
  });

  assert.equal(parsed.pullRequests[0]?.filesChanged, 4);
});

test('repo user bulk refresh schema accepts summary counts and failures', () => {
  const parsed = repoUserBulkRefreshResponseSchema.parse({
    ok: true,
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: new Date().toISOString(),
    },
    mode: 'flagged',
    selectedUserCount: 25,
    refreshedCount: 20,
    skippedCount: 4,
    failedCount: 1,
    failures: [{ login: 'alice', error: 'rate limited' }],
  });

  assert.equal(parsed.failedCount, 1);
  assert.equal(parsed.failures[0]?.login, 'alice');
});
