import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRepoUserListRows,
  buildRepoUserThreadRows,
  describeRepoUserMode,
  renderRepoUserDetail,
  type RepoUserDetailPayload,
  type RepoUsersPayload,
} from './users.js';

function buildUsersPayload(mode: RepoUsersPayload['mode'] = 'flagged'): RepoUsersPayload {
  return {
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: '2026-03-12T00:00:00Z',
    },
    mode,
    totals: {
      matchingUserCount: 1,
      openIssueCount: 2,
      openPullRequestCount: 1,
      waitingPullRequestCount: 1,
    },
    users: [
      {
        login: 'alice',
        reputationTier: mode === 'trusted_prs' ? 'high' : 'low',
        likelyHiddenActivity: mode !== 'trusted_prs',
        isStale: mode !== 'trusted_prs',
        lastRefreshedAt: '2026-03-10T00:00:00Z',
        lastRefreshError: null,
        accountCreatedAt: '2025-01-01T00:00:00Z',
        accountAgeDays: 435,
        openIssueCount: 2,
        openPullRequestCount: 1,
        waitingPullRequestCount: 1,
        matchedLowReputation: mode !== 'trusted_prs',
        matchedLikelyHiddenActivity: mode !== 'trusted_prs',
        reasons: ['example reason'],
      },
    ],
  };
}

function buildDetail(): RepoUserDetailPayload {
  return {
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: '2026-03-12T00:00:00Z',
    },
    profile: {
      login: 'alice',
      githubUserId: '42',
      profileUrl: 'https://github.com/alice',
      avatarUrl: null,
      userType: 'User',
      accountCreatedAt: '2025-01-01T00:00:00Z',
      accountAgeDays: 435,
      publicRepoCount: 12,
      publicGistCount: 1,
      followers: 10,
      following: 2,
      recentPublicEventCount: 4,
      reputationTier: 'high',
      likelyHiddenActivity: false,
      isStale: false,
      lastGlobalRefreshAt: '2026-03-10T00:00:00Z',
      lastRepoRefreshAt: '2026-03-10T00:00:00Z',
      lastRefreshError: null,
      firstSeenAt: '2026-01-01T00:00:00Z',
      lastSeenAt: '2026-03-12T00:00:00Z',
      reasons: ['established public contribution history'],
    },
    totals: {
      matchingUserCount: 1,
      openIssueCount: 1,
      openPullRequestCount: 1,
      waitingPullRequestCount: 1,
    },
    issues: [
      {
        threadId: 10,
        number: 42,
        kind: 'issue',
        title: 'Downloader hangs',
        htmlUrl: 'https://github.com/openclaw/openclaw/issues/42',
        state: 'open',
        isDraft: false,
        createdAtGh: '2026-03-01T00:00:00Z',
        updatedAtGh: '2026-03-10T00:00:00Z',
        ageDays: 11,
        filesChanged: null,
        additions: null,
        deletions: null,
      },
    ],
    pullRequests: [
      {
        threadId: 11,
        number: 43,
        kind: 'pull_request',
        title: 'Fix downloader hang',
        htmlUrl: 'https://github.com/openclaw/openclaw/pull/43',
        state: 'open',
        isDraft: false,
        createdAtGh: '2026-02-20T00:00:00Z',
        updatedAtGh: '2026-03-10T00:00:00Z',
        ageDays: 20,
        filesChanged: 4,
        additions: 120,
        deletions: 30,
      },
    ],
  };
}

test('buildRepoUserListRows shows flagged badges and counts', () => {
  const rows = buildRepoUserListRows(buildUsersPayload('flagged'));

  assert.match(rows[0]?.label ?? '', /2I  1P/);
  assert.match(rows[0]?.label ?? '', /HIDDEN\?/);
  assert.match(rows[0]?.label ?? '', /STALE/);
});

test('buildRepoUserThreadRows prioritizes pull requests in trusted mode', () => {
  const rows = buildRepoUserThreadRows(buildDetail(), 'trusted_prs');

  assert.equal(rows[0]?.selectable, false);
  assert.match(rows[0]?.label ?? '', /PULL REQUESTS/);
  assert.match(rows[1]?.label ?? '', /#43/);
});

test('buildRepoUserThreadRows hides unknown PR size columns instead of rendering zeroes', () => {
  const detail = buildDetail();
  detail.pullRequests[0] = {
    ...detail.pullRequests[0],
    filesChanged: null,
    additions: null,
    deletions: null,
  };

  const rows = buildRepoUserThreadRows(detail, 'trusted_prs');

  assert.doesNotMatch(rows[1]?.label ?? '', /0f \+\s*0 -\s*0/);
});

test('renderRepoUserDetail includes reputation reasons and selected PR sizing', () => {
  const content = renderRepoUserDetail(buildDetail(), 11);

  assert.match(content, /@alice/);
  assert.match(content, /established public contribution history/);
  assert.match(content, /4 files/);
  assert.match(content, /\+120/);
});

test('describeRepoUserMode exposes the user-facing labels', () => {
  assert.equal(describeRepoUserMode('flagged'), 'Flagged contributors');
  assert.equal(describeRepoUserMode('trusted_prs'), 'Trusted PRs');
});
