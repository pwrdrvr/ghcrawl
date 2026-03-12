import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorThreadsResponseSchema,
  closeResponseSchema,
  clusterDetailResponseSchema,
  clusterSummariesResponseSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  repoUserDetailResponseSchema,
  repoUserRefreshResponseSchema,
  repoUsersResponseSchema,
  threadsResponseSchema,
} from '@ghcrawl/api-contract';

import { createApiServer } from './server.js';
import { GHCrawlService } from '../service.js';

test('health endpoint returns contract payload', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    const payload = healthResponseSchema.parse((await response.json()) as unknown);

    assert.equal(payload.ok, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('neighbors endpoint returns contract payload', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const now = '2026-03-09T00:00:00Z';
  service.db
    .prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
  service.db
    .prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
  service.db
    .prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(11, 1, '101', 43, 'pull_request', 'open', 'Fix downloader hang', 'Implements a fix.', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
  service.db
    .prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(10, 'dedupe_summary', 'text-embedding-3-large', 2, 'hash-42', '[1,0]', now, now);
  service.db
    .prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(11, 'dedupe_summary', 'text-embedding-3-large', 2, 'hash-43', '[0.99,0.01]', now, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/neighbors?owner=openclaw&repo=openclaw&number=42&limit=5&minScore=0.1`,
    );
    assert.equal(response.status, 200);
    const payload = neighborsResponseSchema.parse((await response.json()) as unknown);

    assert.equal(payload.thread.number, 42);
    assert.equal(payload.neighbors.length, 1);
    assert.equal(payload.neighbors[0].number, 43);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('threads endpoint can filter by a bulk number list', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const now = '2026-03-09T00:00:00Z';
  service.db
    .prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
  const insertThread = service.db.prepare(
    `insert into threads (
      id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
      labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
      merged_at_gh, first_pulled_at, last_pulled_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
  insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Fix downloader hang', 'Implements a fix.', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
  insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Retry is broken', 'Retries never start.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/threads?owner=openclaw&repo=openclaw&numbers=44,42,999`,
    );
    assert.equal(response.status, 200);
    const payload = threadsResponseSchema.parse((await response.json()) as unknown);
    assert.deepEqual(payload.threads.map((thread) => thread.number), [44, 42]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('author-threads endpoint returns one author with strongest same-author matches', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const now = '2026-03-09T00:00:00Z';
  service.db
    .prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
  const insertThread = service.db.prepare(
    `insert into threads (
      id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
      labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
      merged_at_gh, first_pulled_at, last_pulled_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'lqquan', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
  insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Fix downloader hang', 'Implements a fix.', 'lqquan', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
  service.db
    .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
    .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
  service.db
    .prepare(
      `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 1, 10, 11, 'exact_cosine', 0.91, '{}', now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(
      `http://127.0.0.1:${address.port}/author-threads?owner=openclaw&repo=openclaw&login=lqquan`,
    );
    assert.equal(response.status, 200);
    const payload = authorThreadsResponseSchema.parse((await response.json()) as unknown);
    assert.equal(payload.authorLogin, 'lqquan');
    assert.deepEqual(payload.threads.map((item) => item.thread.number), [43, 42]);
    assert.equal(payload.threads[0]?.strongestSameAuthorMatch?.number, 42);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('repo user endpoints expose summaries, detail, and refresh', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      getUser: async () => ({
        id: 42,
        login: 'alice',
        created_at: '2024-01-01T00:00:00Z',
        public_repos: 12,
        public_gists: 1,
        followers: 11,
        following: 2,
        html_url: 'https://github.com/alice',
        avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4',
        type: 'User',
      }),
      listUserPublicEvents: async () => [{ id: 'evt-1' }, { id: 'evt-2' }],
    },
  });

  const now = '2026-03-09T00:00:00Z';
  service.db
    .prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
  service.db
    .prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, files_changed, additions, deletions, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      10,
      1,
      '100',
      42,
      'issue',
      'open',
      'Downloader hangs',
      'The transfer never finishes.',
      'alice',
      'User',
      'https://github.com/openclaw/openclaw/issues/42',
      '[]',
      '[]',
      '{}',
      'hash-42',
      0,
      now,
      now,
      null,
      null,
      null,
      null,
      null,
      now,
      now,
      now,
    );
  service.db
    .prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, files_changed, additions, deletions, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      11,
      1,
      '101',
      43,
      'pull_request',
      'open',
      'Fix downloader hang',
      'Implements a fix.',
      'alice',
      'User',
      'https://github.com/openclaw/openclaw/pull/43',
      '[]',
      '[]',
      '{}',
      'hash-43',
      0,
      '2026-02-20T00:00:00Z',
      now,
      null,
      null,
      4,
      120,
      30,
      now,
      now,
      now,
    );
  service.db
    .prepare(
      `insert into users (
        login, github_user_id, account_created_at, public_repo_count, public_gist_count, followers, following,
        profile_url, avatar_url, user_type, recent_public_event_count, likely_hidden_activity, reputation_tier,
        reputation_reason_json, last_global_refresh_at, last_refresh_error, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'alice',
      '42',
      '2024-01-01T00:00:00Z',
      12,
      1,
      11,
      2,
      'https://github.com/alice',
      'https://avatars.githubusercontent.com/u/42?v=4',
      'User',
      2,
      0,
      'high',
      '["established public contribution history"]',
      now,
      null,
      now,
    );
  service.db
    .prepare(
      `insert into repo_user_state (repo_id, user_login, last_repo_refresh_at, first_seen_at, last_seen_at, last_refresh_error, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'alice', now, now, now, null, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const listResponse = await fetch(
      `http://127.0.0.1:${address.port}/repo-users?owner=openclaw&repo=openclaw&mode=trusted_prs`,
    );
    assert.equal(listResponse.status, 200);
    const listPayload = repoUsersResponseSchema.parse((await listResponse.json()) as unknown);
    assert.equal(listPayload.users[0]?.login, 'alice');

    const detailResponse = await fetch(
      `http://127.0.0.1:${address.port}/repo-user-detail?owner=openclaw&repo=openclaw&login=alice`,
    );
    assert.equal(detailResponse.status, 200);
    const detailPayload = repoUserDetailResponseSchema.parse((await detailResponse.json()) as unknown);
    assert.equal(detailPayload.pullRequests[0]?.filesChanged, 4);

    const refreshResponse = await fetch(`http://127.0.0.1:${address.port}/actions/refresh-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'openclaw', repo: 'openclaw', login: 'alice', force: true }),
    });
    assert.equal(refreshResponse.status, 200);
    const refreshPayload = repoUserRefreshResponseSchema.parse((await refreshResponse.json()) as unknown);
    assert.equal(refreshPayload.profile.reputationTier, 'high');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('close-thread and includeClosed thread routes expose locally closed items', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const now = '2026-03-09T00:00:00Z';
  service.db
    .prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
  service.db
    .prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const closeResponse = await fetch(`http://127.0.0.1:${address.port}/actions/close-thread`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ owner: 'openclaw', repo: 'openclaw', threadNumber: 42 }),
    });
    assert.equal(closeResponse.status, 200);
    const closedPayload = closeResponseSchema.parse((await closeResponse.json()) as unknown);
    assert.equal(closedPayload.thread?.isClosed, true);

    const defaultResponse = await fetch(`http://127.0.0.1:${address.port}/threads?owner=openclaw&repo=openclaw`);
    assert.equal(defaultResponse.status, 200);
    const defaultPayload = threadsResponseSchema.parse((await defaultResponse.json()) as unknown);
    assert.equal(defaultPayload.threads.length, 0);

    const includeClosedResponse = await fetch(
      `http://127.0.0.1:${address.port}/threads?owner=openclaw&repo=openclaw&includeClosed=true`,
    );
    assert.equal(includeClosedResponse.status, 200);
    const includeClosedPayload = threadsResponseSchema.parse((await includeClosedResponse.json()) as unknown);
    assert.equal(includeClosedPayload.threads.length, 1);
    assert.equal(includeClosedPayload.threads[0]?.isClosed, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('server returns 400 for malformed request inputs', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const missingRepo = await fetch(`http://127.0.0.1:${address.port}/threads?owner=openclaw`);
    assert.equal(missingRepo.status, 400);

    const badJson = await fetch(`http://127.0.0.1:${address.port}/actions/rerun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"owner":"openclaw"',
    });
    assert.equal(badJson.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('cluster summary and detail endpoints return contract payloads', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      secretProvider: 'plaintext',
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      checkAuth: async () => undefined,
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  const now = '2026-03-09T00:00:00Z';
  service.db
    .prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
  service.db
    .prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
  service.db
    .prepare(
      `insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`,
    )
    .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
  service.db
    .prepare(
      `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(100, 1, 1, 10, 1, now);
  service.db
    .prepare(
      `insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at)
       values (?, ?, ?, ?)`,
    )
    .run(100, 10, null, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const summariesResponse = await fetch(
      `http://127.0.0.1:${address.port}/cluster-summaries?owner=openclaw&repo=openclaw&minSize=0`,
    );
    assert.equal(summariesResponse.status, 200);
    const summaries = clusterSummariesResponseSchema.parse((await summariesResponse.json()) as unknown);
    assert.equal(summaries.clusters[0]?.clusterId, 100);

    const detailResponse = await fetch(
      `http://127.0.0.1:${address.port}/cluster-detail?owner=openclaw&repo=openclaw&clusterId=100&bodyChars=20`,
    );
    assert.equal(detailResponse.status, 200);
    const detail = clusterDetailResponseSchema.parse((await detailResponse.json()) as unknown);
    assert.equal(detail.cluster.clusterId, 100);
    assert.equal(detail.members[0]?.thread.number, 42);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});
