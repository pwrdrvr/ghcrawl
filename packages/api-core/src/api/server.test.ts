import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeResponseSchema,
  clusterDetailResponseSchema,
  clusterExplainResponseSchema,
  clusterOverrideResponseSchema,
  clusterSummariesResponseSchema,
  durableClustersResponseSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  runHistoryResponseSchema,
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
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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

test('runs endpoint returns recent pipeline history', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
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
    .prepare(`insert into sync_runs (id, repo_id, scope, status, started_at, finished_at, stats_json) values (?, ?, ?, ?, ?, ?, ?)`)
    .run(1, 1, 'openclaw/openclaw', 'completed', now, now, '{"threadsSynced":2}');

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/runs?owner=openclaw&repo=openclaw&kind=sync`);
    assert.equal(response.status, 200);
    const payload = runHistoryResponseSchema.parse((await response.json()) as unknown);
    assert.equal(payload.runs[0]?.runKind, 'sync');
    assert.equal(payload.runs[0]?.stats?.threadsSynced, 2);
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
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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

test('exclude cluster member action records a durable override', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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
      `insert into cluster_groups (
        id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(7, 1, 'stable-key', 'trace-alpha-river', 'active', 'duplicate_candidate', 10, 'Cluster trace-alpha-river', now, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/actions/exclude-cluster-member`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'openclaw',
        repo: 'openclaw',
        clusterId: 7,
        threadNumber: 42,
        reason: 'not the same defect',
      }),
    });
    assert.equal(response.status, 200);
    const payload = clusterOverrideResponseSchema.parse((await response.json()) as unknown);
    assert.equal(payload.state, 'removed_by_user');

    const override = service.db.prepare('select action, reason from cluster_overrides where cluster_id = ? and thread_id = ?').get(7, 10) as {
      action: string;
      reason: string;
    };
    assert.deepEqual(override, { action: 'exclude', reason: 'not the same defect' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('set cluster canonical action records a durable override', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
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
  insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Downloader retry loop', 'Retries forever.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
  service.db
    .prepare(
      `insert into cluster_groups (
        id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(7, 1, 'stable-key', 'trace-alpha-river', 'active', 'duplicate_candidate', 10, 'Cluster trace-alpha-river', now, now);
  service.db
    .prepare(
      `insert into cluster_memberships (
        cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
        added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(7, 11, 'related', 'active', 0.8, null, null, 'algo', null, '{}', '{}', now, now, null);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/actions/set-cluster-canonical`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        owner: 'openclaw',
        repo: 'openclaw',
        clusterId: 7,
        threadNumber: 43,
        reason: 'best root issue',
      }),
    });
    assert.equal(response.status, 200);
    const payload = clusterOverrideResponseSchema.parse((await response.json()) as unknown);
    assert.equal(payload.action, 'force_canonical');

    const override = service.db.prepare('select action, reason from cluster_overrides where cluster_id = ? and thread_id = ?').get(7, 11) as {
      action: string;
      reason: string;
    };
    const group = service.db.prepare('select representative_thread_id from cluster_groups where id = ?').get(7) as {
      representative_thread_id: number;
    };
    assert.deepEqual(override, { action: 'force_canonical', reason: 'best root issue' });
    assert.equal(group.representative_thread_id, 11);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});

test('durable clusters endpoint returns stable cluster state', async () => {
  const service = new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: '/tmp/ghcrawl-test',
      configPath: '/tmp/ghcrawl-test/config.json',
      configFileExists: true,
      dbPath: ':memory:',
      dbPathSource: 'config',
      apiPort: 5179,
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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
      `insert into cluster_groups (
        id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(7, 1, 'stable-key', 'trace-alpha-river', 'active', 'duplicate_candidate', null, 'Cluster trace-alpha-river', now, now);

  const server = createApiServer(service);
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');

    const response = await fetch(`http://127.0.0.1:${address.port}/durable-clusters?owner=openclaw&repo=openclaw`);
    assert.equal(response.status, 200);
    const payload = durableClustersResponseSchema.parse((await response.json()) as unknown);
    assert.equal(payload.clusters[0]?.stableSlug, 'trace-alpha-river');
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
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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
      githubTokenSource: 'none',
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
      embedBatchSize: 8,
      embedConcurrency: 10,
      embedMaxUnread: 20,
      openSearchIndex: 'ghcrawl-threads',
      tuiPreferences: {},
    },
    github: {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
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
  service.db
    .prepare(
      `insert into cluster_groups (
        id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(7, 1, 'stable-key', 'trace-alpha-river', 'active', 'duplicate_candidate', 10, 'Cluster trace-alpha-river', now, now);
  service.db
    .prepare(
      `insert into cluster_memberships (
        cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
        added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(7, 10, 'canonical', 'active', 1, null, null, 'algo', null, '{}', null, now, now, null);
  service.db
    .prepare(
      `insert into cluster_events (cluster_id, run_id, event_type, actor_kind, payload_json, created_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(7, null, 'keep_canonical', 'algo', '{"threadId":10}', now);

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

    const explainResponse = await fetch(
      `http://127.0.0.1:${address.port}/cluster-explain?owner=openclaw&repo=openclaw&clusterId=7`,
    );
    assert.equal(explainResponse.status, 200);
    const explain = clusterExplainResponseSchema.parse((await explainResponse.json()) as unknown);
    assert.equal(explain.cluster.clusterId, 7);
    assert.equal(explain.events[0]?.eventType, 'keep_canonical');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    service.close();
  }
});
