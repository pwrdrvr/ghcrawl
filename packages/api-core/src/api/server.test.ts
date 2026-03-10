import test from 'node:test';
import assert from 'node:assert/strict';

import { clusterDetailResponseSchema, clusterSummariesResponseSchema, healthResponseSchema, neighborsResponseSchema } from '@ghcrawl/api-contract';

import { createApiServer } from './server.js';
import { GitcrawlService } from '../service.js';

test('health endpoint returns contract payload', async () => {
  const service = new GitcrawlService({
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
  const service = new GitcrawlService({
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

test('server returns 400 for malformed request inputs', async () => {
  const service = new GitcrawlService({
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
  const service = new GitcrawlService({
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
