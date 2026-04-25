import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { humanKeyForValue } from './cluster/human-key.js';
import { GHCrawlService } from './service.js';
import type { VectorStore } from './vector/store.js';

function makeTestConfig(overrides: Partial<GHCrawlService['config']> = {}): GHCrawlService['config'] {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-service-test-'));
  return {
    workspaceRoot: process.cwd(),
    configDir,
    configPath: path.join(configDir, 'config.json'),
    configFileExists: true,
    dbPath: ':memory:',
    dbPathSource: 'config',
    apiPort: 5179,
    githubToken: 'ghp_testtoken1234567890',
    githubTokenSource: 'config',
    tuiPreferences: {},
    openaiApiKeySource: 'none',
    summaryModel: 'gpt-5-mini',
    embedModel: 'text-embedding-3-large',
    embeddingBasis: 'title_original',
    vectorBackend: 'vectorlite',
    embedBatchSize: 2,
    embedConcurrency: 2,
    embedMaxUnread: 4,
    openSearchIndex: 'ghcrawl-threads',
    ...overrides,
  };
}

function makeTestService(
  github: GHCrawlService['github'],
  ai?: GHCrawlService['ai'],
): GHCrawlService {
  return new GHCrawlService({
    config: makeTestConfig(),
    github,
    ai,
  });
}

function makeEmbedding(seed: number, variant = 0): number[] {
  return Array.from({ length: 1024 }, (_value, index) => {
    if (index === 0) return seed;
    if (index === 1) return variant;
    return 0;
  });
}

test('doctor reports config path and token presence without network auth checks', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig({
      openaiApiKey: 'sk-proj-testkey1234567890',
      openaiApiKeySource: 'config',
    }),
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
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async () => [],
    },
  });

  try {
    const result = await service.doctor();
    assert.equal(result.health.configPath, service.config.configPath);
    assert.equal(result.github.tokenPresent, true);
    assert.equal(result.openai.tokenPresent, true);
    assert.equal(result.vectorlite.configured, true);
    assert.equal(result.vectorlite.runtimeOk, true);
  } finally {
    service.close();
  }
});

test('doctor reports missing GitHub token without attempting network auth', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig({
      githubToken: undefined,
      githubTokenSource: 'none',
    }),
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

  try {
    const result = await service.doctor();
    assert.equal(result.github.configured, false);
    assert.equal(result.github.tokenPresent, false);
    assert.match(result.github.error ?? '', /GITHUB_TOKEN/);
  } finally {
    service.close();
  }
});

test('optimizeStorage runs SQLite maintenance and reports missing vector store', () => {
  const config = makeTestConfig();
  const service = new GHCrawlService({
    config: {
      ...config,
      dbPath: path.join(config.configDir, 'optimize.db'),
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

  try {
    const now = '2026-03-10T12:00:00Z';
    service.db
      .prepare(
        `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
    service.db.exec('create table optimize_scratch (value text)');
    const insert = service.db.prepare('insert into optimize_scratch (value) values (?)');
    for (let index = 0; index < 200; index += 1) {
      insert.run(`payload-${index}`);
    }
    service.db.exec('delete from optimize_scratch');

    const response = service.optimizeStorage({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(response.ok, true);
    assert.equal(response.repository?.fullName, 'openclaw/openclaw');
    assert.equal(response.targets[0]?.name, 'main');
    assert.equal(response.targets[0]?.existed, true);
    assert.ok(response.targets[0]?.operations.includes('vacuum'));
    assert.equal(response.targets[1]?.name, 'vector');
    assert.equal(response.targets[1]?.existed, false);
    assert.deepEqual(response.targets[1]?.operations, ['skipped_missing_vector_store']);
  } finally {
    service.close();
  }
});

test('listRunHistory returns recent runs across pipeline tables', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    service.db
      .prepare(
        `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', '2026-03-09T00:00:00Z');
    service.db
      .prepare(`insert into sync_runs (id, repo_id, scope, status, started_at, finished_at, stats_json) values (?, ?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', '2026-03-09T00:00:00Z', '2026-03-09T00:01:00Z', '{"threadsSynced":2}');
    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at, error_text) values (?, ?, ?, ?, ?, ?, ?)`)
      .run(2, 1, 'openclaw/openclaw', 'failed', '2026-03-09T00:02:00Z', '2026-03-09T00:03:00Z', 'boom');

    const allRuns = service.listRunHistory({ owner: 'openclaw', repo: 'openclaw' });
    assert.deepEqual(
      allRuns.runs.map((run) => [run.runKind, run.status]),
      [
        ['cluster', 'failed'],
        ['sync', 'completed'],
      ],
    );
    assert.equal(allRuns.runs[1]?.stats?.threadsSynced, 2);

    const syncRuns = service.listRunHistory({ owner: 'openclaw', repo: 'openclaw', kind: 'sync' });
    assert.deepEqual(syncRuns.runs.map((run) => run.runKind), ['sync']);
  } finally {
    service.close();
  }
});

test('syncRepository defaults to metadata-only mode, preserves thread kind, and tracks first/last pull timestamps', async () => {
  const messages: string[] = [];
  let listIssueCommentCalls = 0;
  let listPullReviewCalls = 0;
  let listPullReviewCommentCalls = 0;
  let listPullFileCalls = 0;
  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, _since, limit) =>
      [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Downloader hangs',
          body: 'The transfer never finishes.',
          html_url: 'https://github.com/openclaw/openclaw/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [],
          user: { login: 'alice', type: 'User' },
        },
        {
          id: 101,
          number: 43,
          state: 'open',
          title: 'Downloader PR',
          body: 'Implements a fix.',
          html_url: 'https://github.com/openclaw/openclaw/pull/43',
          labels: [{ name: 'bug' }],
          assignees: [],
          pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/43' },
          user: { login: 'alice', type: 'User' },
        },
      ].slice(0, limit ?? 2),
    getIssue: async (_owner, _repo, number) => ({
      id: 100,
      number,
      state: 'open',
      title: 'Downloader hangs',
      body: 'The transfer never finishes.',
      html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      updated_at: '2026-03-09T00:00:00Z',
    }),
    getPull: async (_owner, _repo, number) => ({
      id: 101,
      number,
      state: 'open',
      title: 'Downloader PR',
      body: 'Implements a fix.',
      html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      draft: false,
      updated_at: '2026-03-09T00:00:00Z',
    }),
    listIssueComments: async () => {
      listIssueCommentCalls += 1;
      return [
        {
          id: 200,
          body: 'same here',
          created_at: '2026-03-09T00:00:00Z',
          updated_at: '2026-03-09T00:00:00Z',
          user: { login: 'bob', type: 'User' },
        },
      ];
    },
    listPullReviews: async () => {
      listPullReviewCalls += 1;
      return [];
    },
    listPullReviewComments: async () => {
      listPullReviewCommentCalls += 1;
      return [];
    },
    listPullFiles: async () => {
      listPullFileCalls += 1;
      return [];
    },
  });

  try {
    const result = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      limit: 2,
      onProgress: (message) => messages.push(message),
    });

    assert.equal(result.threadsSynced, 2);
    assert.equal(result.commentsSynced, 0);
    assert.equal(result.threadsClosed, 0);
    assert.match(messages.join('\n'), /discovered 2 threads/);
    assert.match(messages.join('\n'), /1\/2 issue #42/);
    assert.match(messages.join('\n'), /2\/2 pull_request #43/);
    assert.match(messages.join('\n'), /metadata-only mode; skipping comment, review, and review-comment fetches/);
    assert.match(messages.join('\n'), /\[fingerprint\] latest revisions computed=2 skipped=0/);
    assert.equal(service.listRepositories().repositories.length, 1);
    assert.equal(service.listThreads({ owner: 'openclaw', repo: 'openclaw' }).threads.length, 2);
    assert.deepEqual(
      service.listThreads({ owner: 'openclaw', repo: 'openclaw', numbers: [43, 42, 999] }).threads.map((thread) => thread.number),
      [43, 42],
    );
    assert.equal(listIssueCommentCalls, 0);
    assert.equal(listPullReviewCalls, 0);
    assert.equal(listPullReviewCommentCalls, 0);
    assert.equal(listPullFileCalls, 0);
    const fingerprintCount = service.db.prepare('select count(*) as count from thread_fingerprints').get() as { count: number };
    assert.equal(fingerprintCount.count, 2);

    const rows = service.db
      .prepare('select number, kind, first_pulled_at, last_pulled_at from threads order by number asc')
      .all() as Array<{
      number: number;
      kind: 'issue' | 'pull_request';
      first_pulled_at: string | null;
      last_pulled_at: string | null;
    }>;

    assert.deepEqual(
      rows.map((row) => ({ number: row.number, kind: row.kind })),
      [
        { number: 42, kind: 'issue' },
        { number: 43, kind: 'pull_request' },
      ],
    );
    for (const row of rows) {
      assert.ok(row.first_pulled_at);
      assert.ok(row.last_pulled_at);
      assert.equal(row.first_pulled_at, row.last_pulled_at);
    }
  } finally {
    service.close();
  }
});

test('syncRepository fetches comments, reviews, and review comments when includeComments is enabled', async () => {
  let listIssueCommentCalls = 0;
  let listPullReviewCalls = 0;
  let listPullReviewCommentCalls = 0;

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => [
      {
        id: 101,
        number: 43,
        state: 'open',
        title: 'Downloader PR',
        body: 'Implements a fix.',
        html_url: 'https://github.com/openclaw/openclaw/pull/43',
        labels: [{ name: 'bug' }],
        assignees: [],
        pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/43' },
        user: { login: 'alice', type: 'User' },
      },
    ],
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async (_owner, _repo, number) => ({
      id: 101,
      number,
      state: 'open',
      title: 'Downloader PR',
      body: 'Implements a fix.',
      html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      draft: false,
      updated_at: '2026-03-09T00:00:00Z',
    }),
    listIssueComments: async () => {
      listIssueCommentCalls += 1;
      return [
        {
          id: 200,
          body: 'same here',
          payload: 'x'.repeat(5000),
          created_at: '2026-03-09T00:00:00Z',
          updated_at: '2026-03-09T00:00:00Z',
          user: { login: 'bob', type: 'User' },
        },
      ];
    },
    listPullReviews: async () => {
      listPullReviewCalls += 1;
      return [
        {
          id: 300,
          body: 'Looks good',
          state: 'APPROVED',
          submitted_at: '2026-03-09T00:00:00Z',
          user: { login: 'carol', type: 'User' },
        },
      ];
    },
    listPullReviewComments: async () => {
      listPullReviewCommentCalls += 1;
      return [
        {
          id: 400,
          body: 'Please rename this variable',
          created_at: '2026-03-09T00:00:00Z',
          updated_at: '2026-03-09T00:00:00Z',
          user: { login: 'dave', type: 'User' },
        },
      ];
    },
    listPullFiles: async () => [],
  });

  try {
    const result = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      includeComments: true,
    });

    assert.equal(result.threadsSynced, 1);
    assert.equal(result.commentsSynced, 3);
    assert.equal(listIssueCommentCalls, 1);
    assert.equal(listPullReviewCalls, 1);
    assert.equal(listPullReviewCommentCalls, 1);

    const commentCount = service.db.prepare('select count(*) as count from comments').get() as { count: number };
    assert.equal(commentCount.count, 3);
    const largeComment = service.db
      .prepare("select raw_json, raw_json_blob_id from comments where comment_type = 'issue_comment' limit 1")
      .get() as { raw_json: string; raw_json_blob_id: number | null };
    assert.equal(largeComment.raw_json, '{}');
    assert.equal(typeof largeComment.raw_json_blob_id, 'number');
    const blob = service.db.prepare('select storage_kind from blobs where id = ?').get(largeComment.raw_json_blob_id) as { storage_kind: string };
    assert.equal(blob.storage_kind, 'file');
  } finally {
    service.close();
  }
});

test('syncRepository hydrates pull request code snapshots when includeCode is enabled', async () => {
  let listPullFileCalls = 0;
  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => [
      {
        id: 101,
        number: 43,
        state: 'open',
        title: 'Downloader PR',
        body: 'Implements a fix.',
        html_url: 'https://github.com/openclaw/openclaw/pull/43',
        labels: [{ name: 'bug' }],
        assignees: [],
        pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/43' },
        user: { login: 'alice', type: 'User' },
      },
    ],
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async (_owner, _repo, number) => ({
      id: 101,
      number,
      state: 'open',
      title: 'Downloader PR',
      body: 'Implements a fix.',
      html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      draft: false,
      base: { sha: 'base-sha' },
      head: { sha: 'head-sha' },
      updated_at: '2026-03-09T00:00:00Z',
    }),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => {
      listPullFileCalls += 1;
      return [
        {
          filename: 'packages/api-core/src/service.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-old\n+new',
        },
      ];
    },
  });

  try {
    const result = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      includeCode: true,
    });

    assert.equal(result.codeFilesSynced, 1);
    assert.equal(listPullFileCalls, 1);
    const snapshot = service.db.prepare('select base_sha, head_sha, files_changed from thread_code_snapshots').get() as {
      base_sha: string;
      head_sha: string;
      files_changed: number;
    };
    const file = service.db.prepare('select path from thread_changed_files').get() as { path: string };
    const hunkCount = service.db.prepare('select count(*) as count from thread_hunk_signatures').get() as { count: number };
    const fingerprint = service.db.prepare('select feature_json from thread_fingerprints').get() as { feature_json: string };
    assert.deepEqual(snapshot, { base_sha: 'base-sha', head_sha: 'head-sha', files_changed: 1 });
    assert.equal(file.path, 'packages/api-core/src/service.ts');
    assert.equal(hunkCount.count, 1);
    assert.equal(JSON.parse(fingerprint.feature_json).hunkSignatures.length, 1);
  } finally {
    service.close();
  }
});

test('summarizeRepository excludes hydrated comments by default and reports token usage', async () => {
  const summaryInputs: string[] = [];
  const service = makeTestService(
    {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    {
      summarizeThread: async ({ text }) => {
        summaryInputs.push(text);
        return {
          summary: {
            problemSummary: 'Problem',
            solutionSummary: 'Solution',
            maintainerSignalSummary: 'Signal',
            dedupeSummary: 'Dedupe',
          },
          usage: {
            inputTokens: 123,
            outputTokens: 45,
            totalTokens: 168,
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        };
      },
      embedTexts: async () => [],
    },
  );

  try {
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
        '["bug"]',
        '[]',
        '{}',
        'hash-42',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into comments (
          thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, created_at_gh, updated_at_gh
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, '200', 'issue_comment', 'human', 'User', 'This extra comment should stay out.', 0, '{}', now, now);
    const result = await service.summarizeRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
    });

    assert.equal(result.summarized, 1);
    assert.equal(result.inputTokens, 123);
    assert.equal(result.outputTokens, 45);
    assert.equal(result.totalTokens, 168);
    assert.equal(summaryInputs.length, 1);
    assert.match(summaryInputs[0], /title: Downloader hangs/);
    assert.match(summaryInputs[0], /body: The transfer never finishes\./);
    assert.doesNotMatch(summaryInputs[0], /This extra comment should stay out/);
  } finally {
    service.close();
  }
});

test('summarizeRepository includes hydrated human comments when includeComments is enabled', async () => {
  const summaryInputs: string[] = [];
  const service = makeTestService(
    {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    {
      summarizeThread: async ({ text }) => {
        summaryInputs.push(text);
        return {
          summary: {
            problemSummary: 'Problem',
            solutionSummary: 'Solution',
            maintainerSignalSummary: 'Signal',
            dedupeSummary: 'Dedupe',
          },
        };
      },
      embedTexts: async () => [],
    },
  );

  try {
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
        '["bug"]',
        '[]',
        '{}',
        'hash-42',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into comments (
          thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, created_at_gh, updated_at_gh
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, '200', 'issue_comment', 'human', 'User', 'Same here on macOS.', 0, '{}', now, now);
    service.db
      .prepare(
        `insert into comments (
          thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, created_at_gh, updated_at_gh
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, '201', 'issue_comment', 'dependabot[bot]', 'Bot', 'Noise', 1, '{}', now, now);

    const result = await service.summarizeRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
      includeComments: true,
    });

    assert.equal(result.summarized, 1);
    assert.equal(summaryInputs.length, 1);
    assert.match(summaryInputs[0], /discussion:/);
    assert.match(summaryInputs[0], /@human: Same here on macOS\./);
    assert.doesNotMatch(summaryInputs[0], /dependabot/);
  } finally {
    service.close();
  }
});

test('summarizeRepository prices progress output using the configured summary model', async () => {
  const progress: string[] = [];
  const service = makeTestService(
    {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    {
      summarizeThread: async () => ({
        summary: {
          problemSummary: 'Problem',
          solutionSummary: 'Solution',
          maintainerSignalSummary: 'Signal',
          dedupeSummary: 'Dedupe',
        },
        usage: {
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
      }),
      embedTexts: async () => [],
    },
  );

  try {
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
        '["bug"]',
        '[]',
        '{}',
        'hash-42',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );

    await service.summarizeRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
      onProgress: (message) => progress.push(message),
    });

    assert.ok(progress.some((message) => message.includes('cost=$0.25') && message.includes('est_total=$0.25')));
  } finally {
    service.close();
  }
});

test('generateKeySummaries stores cached structured key summaries', async () => {
  let calls = 0;
  const service = makeTestService(
    {
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
    {
      providerName: 'test-agent',
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      generateKeySummary: async () => {
        calls += 1;
        return {
          summary: {
            purpose: 'Keep downloads from hanging repository sync.',
            intent: 'Fix retry loop.',
            surface: 'Downloader.',
            mechanism: 'Changes timeout handling.',
          },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cachedInputTokens: 0,
            reasoningTokens: 0,
          },
        };
      },
      embedTexts: async () => [],
    },
  );

  try {
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

    const first = await service.generateKeySummaries({ owner: 'openclaw', repo: 'openclaw' });
    const second = await service.generateKeySummaries({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(first.generated, 1);
    assert.equal(first.totalTokens, 15);
    assert.equal(second.skipped, 1);
    assert.equal(calls, 1);
    const row = service.db.prepare('select provider, key_text from thread_key_summaries').get() as { provider: string; key_text: string };
    assert.equal(row.provider, 'test-agent');
    assert.match(row.key_text, /intent: Fix retry loop\./);
  } finally {
    service.close();
  }
});

test('purgeComments removes hydrated comments and refreshes canonical documents', () => {
  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => [],
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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
        '["bug"]',
        '[]',
        '{}',
        'hash-42',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into comments (
          thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, created_at_gh, updated_at_gh
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, '200', 'issue_comment', 'human', 'User', 'Same here on macOS.', 0, '{}', now, now);
    service.db
      .prepare(
        `insert into documents (thread_id, title, body, raw_text, dedupe_text, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        10,
        'Downloader hangs',
        'The transfer never finishes.',
        'Downloader hangs\n\nThe transfer never finishes.\n\nSame here on macOS.',
        'title: Downloader hangs\n\nbody: The transfer never finishes.\n\ndiscussion: @human: Same here on macOS.',
        now,
      );

    const before = service.db.prepare('select dedupe_text from documents where thread_id = ?').get(10) as { dedupe_text: string };
    assert.match(before.dedupe_text, /discussion:/);

    const result = service.purgeComments({ owner: 'openclaw', repo: 'openclaw' });

    const count = service.db.prepare('select count(*) as count from comments').get() as { count: number };
    const after = service.db.prepare('select dedupe_text from documents where thread_id = ?').get(10) as { dedupe_text: string };

    assert.equal(result.purgedComments, 1);
    assert.equal(result.refreshedThreads, 1);
    assert.equal(count.count, 0);
    assert.doesNotMatch(after.dedupe_text, /discussion:/);
  } finally {
    service.close();
  }
});

test('embedRepository batches multi-source embeddings and skips unchanged inputs by hash', async () => {
  const embedCalls: string[][] = [];
  const service = makeTestService(
    {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embedCalls.push(texts);
        return texts.map((text, index) => makeEmbedding(text.length, index));
      },
    },
  );

  try {
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
        '["bug"]',
        '[]',
        '{}',
        'hash-42',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into document_summaries (thread_id, summary_kind, model, prompt_version, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'dedupe_summary', 'gpt-5-mini', 'v1', 'summary-hash', 'Transfer hangs near completion.', now, now);

    const first = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(first.embedded, 1);
    assert.equal(embedCalls.length, 1);
    assert.deepEqual(
      service.db
        .prepare('select basis, vector_json from thread_vectors order by basis asc')
        .all()
        .map((row: unknown) => {
          const typed = row as { basis: string; vector_json: Buffer | string };
          return { basis: typed.basis, vectorKind: Buffer.isBuffer(typed.vector_json) ? 'blob' : typeof typed.vector_json };
        }),
      [{ basis: 'title_original', vectorKind: 'blob' }],
    );

    const second = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(second.embedded, 0);
    assert.equal(embedCalls.length, 1);

    service.db
      .prepare('update threads set body = ?, updated_at = ? where id = ?')
      .run('The transfer now stalls at 99%.', now, 10);
    const third = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(third.embedded, 1);
    assert.equal(embedCalls.length, 2);
    assert.deepEqual(embedCalls[1], ['title: Downloader hangs\n\nbody: The transfer now stalls at 99%.']);
  } finally {
    service.close();
  }
});

test('embedRepository can use stored structured key summaries as active vector input', async () => {
  let embeddedText = '';
  const service = new GHCrawlService({
    config: makeTestConfig({ embeddingBasis: 'llm_key_summary' }),
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
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embeddedText = texts[0] ?? '';
        return texts.map((_text, index) => makeEmbedding(1, index));
      },
    },
  });

  try {
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
        `insert into thread_revisions (id, thread_id, source_updated_at, content_hash, title_hash, body_hash, labels_hash, raw_json_blob_id, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(100, 10, now, 'content-hash', 'title-hash', 'body-hash', 'labels-hash', null, now);
    service.db
      .prepare(
        `insert into thread_key_summaries (
          thread_revision_id, summary_kind, prompt_version, provider, model, input_hash, output_hash, output_json_blob_id, key_text, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        100,
        'llm_key_3line',
        'llm-key-summary-v2',
        'openai',
        'gpt-5-mini',
        'input-hash',
        'output-hash',
        null,
        'purpose: Keep downloads from hanging repository sync.\nintent: Fix retry loop.\nsurface: Downloader.\nmechanism: Changes timeout handling.',
        now,
      );

    const result = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(result.embedded, 1);
    assert.match(embeddedText, /key_summary:/);
    assert.match(embeddedText, /intent: Fix retry loop\./);
  } finally {
    service.close();
  }
});

test('listNeighbors uses the vectorlite sidecar for current active vectors', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0.99, 0.01))),
    },
  });

  try {
    const now = '2026-03-09T00:00:00Z';
    const insertThread = service.db.prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
    const insert = service.db.prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insert.run(11, 1, '101', 43, 'issue', 'open', 'Downloader retry issue', 'The transfer retries forever.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    const result = service.listNeighbors({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
      limit: 2,
      minScore: 0.1,
    });

    assert.equal(result.thread.number, 42);
    assert.deepEqual(result.neighbors.map((neighbor) => neighbor.number), [43]);
  } finally {
    service.close();
  }
});

test('embedRepository prunes closed vectors before reusing current active vectors', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) =>
        texts.map((text) => {
          if (text.includes('Target issue')) return makeEmbedding(1, 0);
          if (text.includes('Closed similar one')) return makeEmbedding(0.999, 0.001);
          if (text.includes('Closed similar two')) return makeEmbedding(0.998, 0.002);
          if (text.includes('Open fallback')) return makeEmbedding(0.9, 0.1);
          throw new Error(`unexpected embedding input: ${text}`);
        }),
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Target issue', 'Primary issue body.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Closed similar one', 'Very similar body.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Closed similar two', 'Also very similar body.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);
    insertThread.run(13, 1, '103', 45, 'issue', 'open', 'Open fallback', 'Somewhat similar body.', 'dave', 'User', 'https://github.com/openclaw/openclaw/issues/45', '[]', '[]', '{}', 'hash-45', 0, now, now, null, null, now, now, now);

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    service.db
      .prepare('update threads set state = ?, closed_at_gh = ?, updated_at = ? where id in (?, ?)')
      .run('closed', now, now, 11, 12);

    const rerun = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(rerun.embedded, 0);

    const vectorCount = service.db.prepare('select count(*) as count from thread_vectors').get() as { count: number };
    assert.equal(vectorCount.count, 2);

    const result = service.listNeighbors({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
      limit: 1,
      minScore: 0.1,
    });
    assert.deepEqual(result.neighbors.map((neighbor) => neighbor.number), [45]);
  } finally {
    service.close();
  }
});

test('embedRepository truncates oversized inputs before submission', async () => {
  const embedCalls: string[][] = [];
  const service = new GHCrawlService({
    config: makeTestConfig({
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
    }),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embedCalls.push(texts);
        return texts.map((text, index) => makeEmbedding(text.length, index));
      },
    },
  });

  try {
    const now = '2026-03-09T00:00:00Z';
    const hugeBody = 'a'.repeat(30000);
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
      .run(
        10,
        1,
        '100',
        42,
        'issue',
        'open',
        'Huge body one',
        hugeBody,
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
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into threads (
          id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
          labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
          merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        11,
        1,
        '101',
        43,
        'issue',
        'open',
        'Huge body two',
        hugeBody,
        'bob',
        'User',
        'https://github.com/openclaw/openclaw/issues/43',
        '[]',
        '[]',
        '{}',
        'hash-43',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );

    const result = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(result.embedded, 2);
    assert.ok(embedCalls.length >= 1);
    const truncatedBodies = embedCalls.flat().filter((text) => text.includes('[truncated for embedding]'));
    assert.equal(truncatedBodies.length, 2);
    for (const text of truncatedBodies) {
      assert.ok(text.length < hugeBody.length);
    }
  } finally {
    service.close();
  }
});

test('embedRepository isolates a failing oversized item from a mixed batch and retries it shortened', async () => {
  const embedCalls: string[][] = [];
  const service = new GHCrawlService({
    config: makeTestConfig({
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
    }),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embedCalls.push(texts);
        for (const text of texts) {
          if (text.length > 9000) {
            throw new Error(
              "400 This model's maximum context length is 8192 tokens, however you requested 18227 tokens (18227 in your prompt; 0 for the completion).",
            );
          }
        }
        return texts.map((text, index) => makeEmbedding(text.length, index));
      },
    },
  });

  try {
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
      .run(
        10,
        1,
        '100',
        42,
        'issue',
        'open',
        'Short title',
        'short body',
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
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into threads (
          id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
          labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
          merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        11,
        1,
        '101',
        43,
        'issue',
        'open',
        'Large body',
        'x'.repeat(20000),
        'bob',
        'User',
        'https://github.com/openclaw/openclaw/issues/43',
        '[]',
        '[]',
        '{}',
        'hash-43',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );

    const result = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(result.embedded, 2);
    assert.ok(embedCalls.length >= 3);
    assert.equal(embedCalls[0].length, 2);
    assert.ok(embedCalls.flat().some((text) => text.includes('[truncated for embedding]')));
  } finally {
    service.close();
  }
});

test('embedRepository recovers from wrapped maximum input length errors by shrinking the offending item in steps', async () => {
  const embedCalls: string[][] = [];
  const service = new GHCrawlService({
    config: makeTestConfig({
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
    }),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embedCalls.push(texts);
        const overLimitIndex = texts.findIndex((text) => text.length > 18000);
        if (overLimitIndex !== -1) {
          throw new Error(
            `OpenAI embeddings failed after 5 attempts: 400 Invalid 'input[${overLimitIndex}]': maximum input length is 8192 tokens.`,
          );
        }
        return texts.map((text, index) => makeEmbedding(text.length, index));
      },
    },
  });

  try {
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
      .run(
        10,
        1,
        '100',
        42,
        'issue',
        'open',
        'Short title',
        'short body',
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
        now,
        now,
        now,
      );
    service.db
      .prepare(
        `insert into threads (
          id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
          labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
          merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        11,
        1,
        '101',
        43,
        'issue',
        'open',
        'Large body',
        'x'.repeat(24000),
        'bob',
        'User',
        'https://github.com/openclaw/openclaw/issues/43',
        '[]',
        '[]',
        '{}',
        'hash-43',
        0,
        now,
        now,
        null,
        null,
        now,
        now,
        now,
      );

    const result = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(result.embedded, 2);
    const shortenedAttempts = Array.from(
      new Set(
        embedCalls
          .flat()
          .filter((text) => text.includes('[truncated for embedding]'))
          .map((text) => text.length),
      ),
    );
    assert.ok(shortenedAttempts.length >= 3);
    assert.ok(shortenedAttempts[0] > shortenedAttempts[1]);
    assert.ok(shortenedAttempts[1] > shortenedAttempts[2]);
    assert.ok(shortenedAttempts[2] <= 18000);
  } finally {
    service.close();
  }
});

test('listNeighbors returns exact nearest neighbors for an embedded thread', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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
        `insert into threads (
          id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
          labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
          merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(12, 1, '102', 44, 'issue', 'open', 'Unrelated auth issue', 'Login is broken.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);
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
    service.db
      .prepare(
        `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(12, 'dedupe_summary', 'text-embedding-3-large', 2, 'hash-44', '[0,1]', now, now);

    const result = service.listNeighbors({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
      limit: 2,
      minScore: 0.1,
    });

    assert.equal(result.thread.number, 42);
    assert.equal(result.neighbors.length, 1);
    assert.equal(result.neighbors[0].number, 43);
    assert.ok(result.neighbors[0].score > 0.9);
  } finally {
    service.close();
  }
});

test('clusterRepository emits timed progress updates while identifying similarities', async () => {
  const messages: string[] = [];
  const originalDateNow = Date.now;
  let fakeNow = 0;
  Date.now = () => {
    fakeNow += 6000;
    return fakeNow;
  };

  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Downloader retries', 'Retries are broken.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const sourceKind of ['title', 'body', 'dedupe_summary'] as const) {
      insertEmbedding.run(10, sourceKind, 'text-embedding-3-large', 2, `hash-42-${sourceKind}`, '[1,0]', now, now);
      insertEmbedding.run(11, sourceKind, 'text-embedding-3-large', 2, `hash-43-${sourceKind}`, '[0.99,0.01]', now, now);
      insertEmbedding.run(12, sourceKind, 'text-embedding-3-large', 2, `hash-44-${sourceKind}`, '[0.98,0.02]', now, now);
    }

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      onProgress: (message) => messages.push(message),
    });

    assert.ok(result.edges > 0);
    assert.ok(messages.some((message) => /identifying similarity edges/.test(message)));
  } finally {
    Date.now = originalDateNow;
    service.close();
  }
});

test('clusterRepository merges source kinds into one edge without directional duplicates', async () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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

    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const sourceKind of ['title', 'body', 'dedupe_summary'] as const) {
      insertEmbedding.run(10, sourceKind, 'text-embedding-3-large', 2, `hash-42-${sourceKind}`, '[1,0]', now, now);
      insertEmbedding.run(11, sourceKind, 'text-embedding-3-large', 2, `hash-43-${sourceKind}`, '[0.99,0.01]', now, now);
    }

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.5,
    });

    const edges = service.db.prepare(
      'select left_thread_id, right_thread_id, explanation_json from similarity_edges where cluster_run_id = ? order by left_thread_id, right_thread_id',
    ).all(result.runId) as Array<{ left_thread_id: number; right_thread_id: number; explanation_json: string }>;

    assert.equal(edges.length, 1);
    assert.deepEqual(
      [edges[0]?.left_thread_id, edges[0]?.right_thread_id],
      [10, 11],
    );
    assert.deepEqual(JSON.parse(edges[0]?.explanation_json ?? '{}').sources, ['body', 'dedupe_summary', 'title']);
  } finally {
    service.close();
  }
});

test('clusterRepository drops weak issue/pr semantic edges', async () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Cache invalidation fails', 'Cache entries remain stale.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Worker cleanup', 'Moves worker code.', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Cache invalidation stale entries', 'Stale cache entries are not removed.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const sourceKind of ['title', 'body', 'dedupe_summary'] as const) {
      insertEmbedding.run(10, sourceKind, 'text-embedding-3-large', 2, `hash-42-${sourceKind}`, '[1,0]', now, now);
      insertEmbedding.run(11, sourceKind, 'text-embedding-3-large', 2, `hash-43-${sourceKind}`, '[0.8,-0.6]', now, now);
      insertEmbedding.run(12, sourceKind, 'text-embedding-3-large', 2, `hash-44-${sourceKind}`, '[0.83,0.56]', now, now);
    }

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 2,
      minScore: 0.78,
    });

    const edges = service.db.prepare(
      'select left_thread_id, right_thread_id from similarity_edges where cluster_run_id = ? order by left_thread_id, right_thread_id',
    ).all(result.runId) as Array<{ left_thread_id: number; right_thread_id: number }>;

    assert.deepEqual(edges, [{ left_thread_id: 10, right_thread_id: 12 }]);
    assert.equal(result.edges, 1);
  } finally {
    service.close();
  }
});

test('clusterRepository prunes older cluster runs for the repo after a successful rebuild', async () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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

    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
    service.db
      .prepare(`insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 10, 11, 'exact_cosine', 0.9, '{}', now);

    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEmbedding.run(10, 'title', 'text-embedding-3-large', 2, 'hash-42-title', '[1,0]', now, now);
    insertEmbedding.run(11, 'title', 'text-embedding-3-large', 2, 'hash-43-title', '[0.99,0.01]', now, now);

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
    });

    const runRows = service.db.prepare('select id from cluster_runs where repo_id = ? order by id asc').all(1) as Array<{ id: number }>;
    const oldEdgeCount = service.db.prepare('select count(*) as count from similarity_edges where cluster_run_id = 1').get() as { count: number };

    assert.deepEqual(runRows.map((row) => row.id), [result.runId]);
    assert.equal(oldEdgeCount.count, 0);
  } finally {
    service.close();
  }
});

test('clusterRepository purges legacy embeddings and inline vector payloads after a current-vector rebuild', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0.99, 0.01))),
    },
  });

  try {
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
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Fix downloader hang', 'Implements a fix.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    const insertLegacy = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const sourceKind of ['title', 'body', 'dedupe_summary'] as const) {
      insertLegacy.run(10, sourceKind, 'text-embedding-3-large', 2, `hash-42-${sourceKind}`, '[1,0]', now, now);
      insertLegacy.run(11, sourceKind, 'text-embedding-3-large', 2, `hash-43-${sourceKind}`, '[0.99,0.01]', now, now);
    }

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    const beforeCluster = service.db.prepare('select count(*) as count from document_embeddings').get() as { count: number };
    assert.equal(beforeCluster.count, 6);

    await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.5,
    });

    const legacyCount = service.db.prepare('select count(*) as count from document_embeddings').get() as { count: number };
    const inlineVectors = service.db
      .prepare('select typeof(vector_json) as vector_kind from thread_vectors order by thread_id asc')
      .all() as Array<{ vector_kind: string }>;

    assert.equal(legacyCount.count, 0);
    assert.deepEqual(inlineVectors.map((row) => row.vector_kind), ['blob', 'blob']);
  } finally {
    service.close();
  }
});

test('clusterRepository rebuilds a corrupted active vector store and retries', async () => {
  const vectors = new Map<number, number[]>();
  let firstQuery = true;
  let resetCalls = 0;
  const vectorStore: VectorStore = {
    checkRuntime: () => ({ ok: true, error: null }),
    resetRepository: () => {
      resetCalls += 1;
      vectors.clear();
    },
    upsertVector: ({ threadId, vector }) => {
      vectors.set(threadId, vector);
    },
    deleteVector: ({ threadId }) => {
      vectors.delete(threadId);
    },
    queryNearest: ({ excludeThreadId }) => {
      if (firstQuery) {
        firstQuery = false;
        throw new Error('Failed to load index from file: Index seems to be corrupted or unsupported');
      }
      return [...vectors.keys()]
        .filter((threadId) => threadId !== excludeThreadId)
        .map((threadId) => ({ threadId, score: 0.95 }));
    },
    close: () => undefined,
  };

  const service = new GHCrawlService({
    config: makeTestConfig(),
    vectorStore,
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0.99, 0.01))),
    },
  });

  try {
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
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Downloader retry issue', 'The transfer retries forever.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.5,
    });

    assert.equal(resetCalls, 2);
    assert.equal(result.edges, 1);
    assert.equal(result.clusters, 1);
    const durableClusters = service.db.prepare('select count(*) as count from cluster_groups').get() as { count: number };
    const durableMemberships = service.db.prepare('select count(*) as count from cluster_memberships').get() as { count: number };
    const durableEdges = service.db.prepare('select count(*) as count from similarity_edge_evidence').get() as { count: number };
    assert.equal(durableClusters.count, 1);
    assert.equal(durableMemberships.count, 2);
    assert.equal(durableEdges.count, 1);

    const cluster = service.db.prepare('select id from cluster_groups limit 1').get() as { id: number };
    service.db
      .prepare(
        `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at)
         values (?, ?, ?, 'exclude', ?, ?)`,
      )
      .run(1, cluster.id, 11, 'maintainer removed from cluster', now);

    await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.1,
    });

    const blocked = service.db
      .prepare('select state, removed_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(cluster.id, 11) as { state: string; removed_by: string | null };
    assert.equal(blocked.state, 'blocked_by_override');
    assert.equal(blocked.removed_by, 'user');
  } finally {
    service.close();
  }
});

test('durable cluster identity survives representative changes by member overlap', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-09T00:00:00Z';
    service.db
      .prepare(
        `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);
    service.db
      .prepare("insert into pipeline_runs (id, repo_id, run_kind, status, started_at) values (?, ?, 'cluster', 'completed', ?)")
      .run(1, 1, now);
    service.db
      .prepare("insert into pipeline_runs (id, repo_id, run_kind, status, started_at) values (?, ?, 'cluster', 'completed', ?)")
      .run(2, 1, now);
    const insertThread = service.db.prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Gateway crash', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Gateway crash duplicate', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Gateway crash follow-up', 'body', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

    const durable = service as unknown as {
      persistDurableClusterState(
        repoId: number,
        pipelineRunId: number,
        aggregatedEdges: Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<never> }>,
        clusters: Array<{ representativeThreadId: number; members: number[] }>,
      ): void;
    };
    const noEdges = new Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<never> }>();

    durable.persistDurableClusterState(1, 1, noEdges, [{ representativeThreadId: 10, members: [10, 11] }]);
    const first = service.db.prepare('select id, stable_slug from cluster_groups limit 1').get() as { id: number; stable_slug: string };

    durable.persistDurableClusterState(1, 2, noEdges, [{ representativeThreadId: 11, members: [10, 11, 12] }]);
    const groups = service.db.prepare('select id, stable_slug, representative_thread_id from cluster_groups order by id asc').all() as Array<{
      id: number;
      stable_slug: string;
      representative_thread_id: number;
    }>;
    const members = service.db
      .prepare('select thread_id from cluster_memberships where cluster_id = ? order by thread_id asc')
      .all(first.id) as Array<{ thread_id: number }>;

    assert.deepEqual(groups, [{ id: first.id, stable_slug: first.stable_slug, representative_thread_id: 11 }]);
    assert.deepEqual(
      members.map((member) => member.thread_id),
      [10, 11, 12],
    );
  } finally {
    service.close();
  }
});

test('clusterRepository falls back to deterministic fingerprints when vectors are missing', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Download retry hangs forever', 'The transfer retry loop never exits after timeout.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Download retry loop never exits', 'Retry hangs forever after timeout.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.1,
    });

    assert.equal(result.edges, 1);
    assert.equal(result.clusters, 1);
    const revisionCount = service.db.prepare('select count(*) as count from thread_revisions').get() as { count: number };
    const fingerprintCount = service.db.prepare('select count(*) as count from thread_fingerprints').get() as { count: number };
    assert.equal(revisionCount.count, 2);
    assert.equal(fingerprintCount.count, 2);
  } finally {
    service.close();
  }
});

test('clusterRepository preserves a forced canonical representative on rebuild', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Download retry hangs forever', 'The transfer retry loop never exits after timeout.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Download retry loop never exits', 'Retry hangs forever after timeout.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.clusterRepository({ owner: 'openclaw', repo: 'openclaw', k: 1, minScore: 0.1 });
    const cluster = service.db.prepare('select id from cluster_groups limit 1').get() as { id: number };

    const override = service.setClusterCanonicalThread({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: cluster.id,
      threadNumber: 43,
      reason: 'best root issue',
    });
    await service.clusterRepository({ owner: 'openclaw', repo: 'openclaw', k: 1, minScore: 0.1 });

    const group = service.db.prepare('select representative_thread_id from cluster_groups where id = ?').get(cluster.id) as {
      representative_thread_id: number;
    };
    const roles = service.db
      .prepare('select thread_id, role, added_by from cluster_memberships where cluster_id = ? order by thread_id asc')
      .all(cluster.id) as Array<{ thread_id: number; role: string; added_by: string }>;

    assert.equal(override.action, 'force_canonical');
    assert.equal(group.representative_thread_id, 11);
    assert.deepEqual(roles, [
      { thread_id: 10, role: 'related', added_by: 'algo' },
      { thread_id: 11, role: 'canonical', added_by: 'user' },
    ]);
  } finally {
    service.close();
  }
});

test('clusterRepository preserves a forced include on rebuild', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Download retry hangs forever', 'The transfer retry loop never exits after timeout.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Download retry loop never exits', 'Retry hangs forever after timeout.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Docs typo', 'Fix a typo in documentation.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

    await service.clusterRepository({ owner: 'openclaw', repo: 'openclaw', k: 1, minScore: 0.1 });
    const cluster = service.db.prepare('select id from cluster_groups limit 1').get() as { id: number };

    const override = service.includeThreadInCluster({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: cluster.id,
      threadNumber: 44,
      reason: 'same incident family',
    });
    await service.clusterRepository({ owner: 'openclaw', repo: 'openclaw', k: 1, minScore: 0.1 });

    const membership = service.db
      .prepare('select role, state, added_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(cluster.id, 12) as { role: string; state: string; added_by: string };

    assert.equal(override.action, 'force_include');
    assert.deepEqual(membership, { role: 'related', state: 'active', added_by: 'user' });
  } finally {
    service.close();
  }
});

test('mergeDurableClusters preserves source slug and force-includes active source members', () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Root issue', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Related issue', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    const insertCluster = service.db.prepare(
      `insert into cluster_groups (
        id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
      ) values (?, ?, ?, ?, 'active', 'duplicate_candidate', ?, ?, ?, ?)`,
    );
    insertCluster.run(7, 1, 'source-key', 'source-slug', 11, 'Source cluster', now, now);
    insertCluster.run(8, 1, 'target-key', 'target-slug', 10, 'Target cluster', now, now);
    service.db
      .prepare(
        `insert into cluster_memberships (
          cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
          added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(7, 11, 'canonical', 'active', 1, null, null, 'algo', null, '{}', '{}', now, now, null);

    const result = service.mergeDurableClusters({
      owner: 'openclaw',
      repo: 'openclaw',
      sourceClusterId: 7,
      targetClusterId: 8,
      reason: 'same root cause',
    });

    const source = service.db.prepare('select status from cluster_groups where id = ?').get(7) as { status: string };
    const alias = service.db.prepare('select reason from cluster_aliases where cluster_id = ? and alias_slug = ?').get(8, 'source-slug') as {
      reason: string;
    };
    const override = service.db.prepare('select action, reason from cluster_overrides where cluster_id = ? and thread_id = ?').get(8, 11) as {
      action: string;
      reason: string;
    };
    const membership = service.db
      .prepare('select state, added_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(8, 11) as { state: string; added_by: string };

    assert.equal(result.targetClusterId, 8);
    assert.equal(source.status, 'merged');
    assert.equal(alias.reason, 'merged_from:7');
    assert.deepEqual(override, { action: 'force_include', reason: 'same root cause' });
    assert.deepEqual(membership, { state: 'active', added_by: 'user' });
  } finally {
    service.close();
  }
});

test('splitDurableCluster creates a governed cluster and blocks source re-entry', () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Canonical issue', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Remaining issue', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Moved issue', 'body', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
        ) values (?, ?, ?, ?, 'active', 'duplicate_candidate', ?, ?, ?, ?)`,
      )
      .run(7, 1, 'source-key', 'source-slug', 10, 'Source cluster', now, now);
    const insertMembership = service.db.prepare(
      `insert into cluster_memberships (
        cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
        added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
      ) values (?, ?, ?, 'active', ?, ?, ?, 'algo', ?, ?, ?, ?, ?, ?)`,
    );
    insertMembership.run(7, 10, 'canonical', 1, null, null, null, '{}', '{}', now, now, null);
    insertMembership.run(7, 11, 'related', 0.72, null, null, null, '{}', '{}', now, now, null);
    insertMembership.run(7, 12, 'related', 0.81, null, null, null, '{}', '{}', now, now, null);

    const result = service.splitDurableCluster({
      owner: 'openclaw',
      repo: 'openclaw',
      sourceClusterId: 7,
      threadNumbers: [42, 44],
      reason: 'separate root cause',
    });

    const sourceCanonical = service.db
      .prepare('select representative_thread_id from cluster_groups where id = ?')
      .get(7) as { representative_thread_id: number };
    const movedSourceMembership = service.db
      .prepare('select state, removed_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(7, 10) as { state: string; removed_by: string };
    const remainingSourceMembership = service.db
      .prepare('select role, state from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(7, 11) as { role: string; state: string };
    const sourceOverride = service.db
      .prepare('select action, reason from cluster_overrides where cluster_id = ? and thread_id = ?')
      .get(7, 10) as { action: string; reason: string };
    const newCanonical = service.db
      .prepare('select role, state, added_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(result.newClusterId, 10) as { role: string; state: string; added_by: string };
    const newRelated = service.db
      .prepare('select role, state, added_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(result.newClusterId, 12) as { role: string; state: string; added_by: string };
    const newOverride = service.db
      .prepare('select action, reason from cluster_overrides where cluster_id = ? and thread_id = ?')
      .get(result.newClusterId, 12) as { action: string; reason: string };

    assert.equal(result.sourceClusterId, 7);
    assert.equal(result.movedCount, 2);
    assert.equal(sourceCanonical.representative_thread_id, 11);
    assert.deepEqual(movedSourceMembership, { state: 'removed_by_user', removed_by: 'user' });
    assert.deepEqual(remainingSourceMembership, { role: 'canonical', state: 'active' });
    assert.deepEqual(sourceOverride, { action: 'exclude', reason: 'separate root cause' });
    assert.deepEqual(newCanonical, { role: 'canonical', state: 'active', added_by: 'user' });
    assert.deepEqual(newRelated, { role: 'related', state: 'active', added_by: 'user' });
    assert.deepEqual(newOverride, { action: 'force_include', reason: 'separate root cause' });
  } finally {
    service.close();
  }
});

test('clusterRepository materializes only changed deterministic fingerprints', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Download retry hangs forever', 'The transfer retry loop never exits after timeout.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Download retry loop never exits', 'Retry hangs forever after timeout.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.clusterRepository({ owner: 'openclaw', repo: 'openclaw', k: 1, minScore: 0.1 });

    const secondMessages: string[] = [];
    await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.1,
      onProgress: (message) => secondMessages.push(message),
    });
    assert.ok(secondMessages.some((message) => message.includes('[fingerprint] latest revisions computed=0 skipped=2')));

    service.db
      .prepare('update threads set body = ?, content_hash = ?, updated_at_gh = ?, updated_at = ? where id = ?')
      .run('The transfer retry loop never exits after a network timeout.', 'hash-42b', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z', 10);

    const thirdMessages: string[] = [];
    await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.1,
      onProgress: (message) => thirdMessages.push(message),
    });

    const revisionCount = service.db.prepare('select count(*) as count from thread_revisions').get() as { count: number };
    const fingerprintCount = service.db.prepare('select count(*) as count from thread_fingerprints').get() as { count: number };
    assert.ok(thirdMessages.some((message) => message.includes('[fingerprint] latest revisions computed=1 skipped=1')));
    assert.equal(revisionCount.count, 3);
    assert.equal(fingerprintCount.count, 3);
  } finally {
    service.close();
  }
});

test('clusterRepository can refresh one durable neighborhood without replacing the full snapshot', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
  });

  try {
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Download retry hangs forever', 'The transfer retry loop never exits after timeout.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Download retry loop never exits', 'Retry hangs forever after timeout.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Improve documentation typography', 'Docs heading sizes look inconsistent.', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

    const full = await service.clusterRepository({ owner: 'openclaw', repo: 'openclaw', k: 1, minScore: 0.1 });
    service.db
      .prepare('update threads set body = ?, content_hash = ?, updated_at_gh = ?, updated_at = ? where id = ?')
      .run('The transfer retry loop never exits after a network timeout.', 'hash-42b', '2026-03-10T00:00:00Z', '2026-03-10T00:00:00Z', 10);

    const messages: string[] = [];
    const incremental = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      threadNumber: 42,
      k: 1,
      minScore: 0.1,
      onProgress: (message) => messages.push(message),
    });

    const fullSnapshotClusters = service.db
      .prepare('select count(*) as count from clusters where cluster_run_id = ?')
      .get(full.runId) as { count: number };
    const incrementalSnapshotClusters = service.db
      .prepare('select count(*) as count from clusters where cluster_run_id = ?')
      .get(incremental.runId) as { count: number };
    const incrementalRun = service.db
      .prepare("select run_kind from pipeline_runs where run_kind = 'cluster_incremental' order by id desc limit 1")
      .get() as { run_kind: string } | undefined;

    assert.ok(messages.some((message) => message.includes('[fingerprint] latest revisions computed=1 skipped=0')));
    assert.ok(messages.some((message) => message.includes('without replacing the full cluster snapshot')));
    assert.ok(fullSnapshotClusters.count > 0);
    assert.equal(incrementalSnapshotClusters.count, 0);
    assert.equal(incrementalRun?.run_kind, 'cluster_incremental');
  } finally {
    service.close();
  }
});

test('clusterRepository uses hydrated code hunk signatures without embeddings', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Rewrite scheduler state',
          body: 'Internal cleanup.',
          html_url: 'https://github.com/openclaw/openclaw/pull/42',
          labels: [],
          pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/42' },
          user: { login: 'alice', type: 'User' },
        },
        {
          id: 101,
          number: 43,
          state: 'open',
          title: 'Patch migration locking',
          body: 'Different prose.',
          html_url: 'https://github.com/openclaw/openclaw/pull/43',
          labels: [],
          pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/43' },
          user: { login: 'bob', type: 'User' },
        },
      ],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async (_owner, _repo, number) => ({
        id: number,
        number,
        state: 'open',
        title: number === 42 ? 'Rewrite scheduler state' : 'Patch migration locking',
        body: number === 42 ? 'Internal cleanup.' : 'Different prose.',
        html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        labels: [],
        user: { login: number === 42 ? 'alice' : 'bob', type: 'User' },
        draft: false,
        base: { sha: 'base-sha' },
        head: { sha: `head-${number}` },
        updated_at: '2026-03-09T00:00:00Z',
      }),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [
        {
          filename: 'packages/api-core/src/cluster/build.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-oldCluster\n+newCluster',
        },
      ],
    },
  });

  try {
    const sync = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      includeCode: true,
    });
    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      minScore: 0.1,
    });

    assert.equal(sync.codeFilesSynced, 2);
    assert.equal(result.edges, 1);
    assert.equal(result.clusters, 1);
  } finally {
    service.close();
  }
});

test('clusterRepository keeps deterministic hunk edges when active vectors are current', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Rewrite scheduler state',
          body: 'Internal cleanup.',
          html_url: 'https://github.com/openclaw/openclaw/pull/42',
          labels: [],
          pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/42' },
          user: { login: 'alice', type: 'User' },
        },
        {
          id: 101,
          number: 43,
          state: 'open',
          title: 'Patch migration locking',
          body: 'Different prose.',
          html_url: 'https://github.com/openclaw/openclaw/pull/43',
          labels: [],
          pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/43' },
          user: { login: 'bob', type: 'User' },
        },
      ],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async (_owner, _repo, number) => ({
        id: number,
        number,
        state: 'open',
        title: number === 42 ? 'Rewrite scheduler state' : 'Patch migration locking',
        body: number === 42 ? 'Internal cleanup.' : 'Different prose.',
        html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        labels: [],
        user: { login: number === 42 ? 'alice' : 'bob', type: 'User' },
        draft: false,
        base: { sha: 'base-sha' },
        head: { sha: `head-${number}` },
        updated_at: '2026-03-09T00:00:00Z',
      }),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [
        {
          filename: 'packages/api-core/src/cluster/build.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: '@@ -1 +1 @@\n-oldCluster\n+newCluster',
        },
      ],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0, 1))),
    },
  });

  try {
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      includeCode: true,
    });
    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      minScore: 0.1,
    });

    const evidence = service.db.prepare('select breakdown_json from similarity_edge_evidence').get() as { breakdown_json: string };
    assert.equal(result.edges, 1);
    assert.deepEqual(JSON.parse(evidence.breakdown_json).sources, ['deterministic_fingerprint']);
  } finally {
    service.close();
  }
});

test('embedRepository rebuilds a corrupted active vector store during upsert', async () => {
  const vectors = new Map<number, number[]>();
  let failNextUpsert = true;
  let resetCalls = 0;
  const vectorStore: VectorStore = {
    checkRuntime: () => ({ ok: true, error: null }),
    resetRepository: () => {
      resetCalls += 1;
      vectors.clear();
    },
    upsertVector: ({ threadId, vector }) => {
      if (failNextUpsert) {
        failNextUpsert = false;
        throw new Error('Failed to load index from file: Index seems to be corrupted or unsupported');
      }
      vectors.set(threadId, vector);
    },
    deleteVector: ({ threadId }) => {
      vectors.delete(threadId);
    },
    queryNearest: ({ excludeThreadId }) =>
      [...vectors.keys()]
        .filter((threadId) => threadId !== excludeThreadId)
        .map((threadId) => ({ threadId, score: 0.95 })),
    close: () => undefined,
  };

  const service = new GHCrawlService({
    config: makeTestConfig(),
    vectorStore,
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0.99, 0.01))),
    },
  });

  try {
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
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Downloader retry issue', 'The transfer retries forever.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(resetCalls, 2);
    assert.deepEqual([...vectors.keys()].sort((a, b) => a - b), [10, 11]);
  } finally {
    service.close();
  }
});

test('clusterExperiment falls back to active vectors when legacy embeddings are absent', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0.99, 0.01))),
    },
  });

  try {
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
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Downloader retry issue', 'The transfer retries forever.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });

    const exact = service.clusterExperiment({
      owner: 'openclaw',
      repo: 'openclaw',
      backend: 'exact',
      k: 1,
      minScore: 0.5,
    });
    const vectorlite = service.clusterExperiment({
      owner: 'openclaw',
      repo: 'openclaw',
      backend: 'vectorlite',
      k: 1,
      minScore: 0.5,
    });

    assert.equal(exact.threads, 2);
    assert.equal(exact.clusters, 1);
    assert.equal(vectorlite.threads, 2);
    assert.equal(vectorlite.clusters, 1);
  } finally {
    service.close();
  }
});

test('clusterRepository can reuse stale active vectors for offline reclustering', async () => {
  const progress: string[] = [];
  const service = new GHCrawlService({
    config: makeTestConfig(),
    github: {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [],
      getIssue: async () => {
        throw new Error('not expected');
      },
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
      listPullFiles: async () => [],
    },
    ai: {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => (index === 0 ? makeEmbedding(1, 0) : makeEmbedding(0.99, 0.01))),
    },
  });

  try {
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
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Downloader retry issue', 'The transfer retries forever.', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    service.db.prepare("update repo_pipeline_state set summary_model = 'previous-model' where repo_id = 1").run();

    const result = await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      minScore: 0.8,
      k: 1,
      onProgress: (message) => progress.push(message),
    });

    assert.equal(result.edges, 1);
    assert.equal(result.clusters, 1);
    assert.ok(progress.some((message) => message.includes('stale active vector')));
    const state = service.db.prepare('select clusters_current_at from repo_pipeline_state where repo_id = 1').get() as {
      clusters_current_at: string | null;
    };
    assert.equal(state.clusters_current_at, null);
  } finally {
    service.close();
  }
});

test('clusterRepository does not retain a parsed embedding cache in-process', async () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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

    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const sourceKind of ['title', 'body', 'dedupe_summary'] as const) {
      insertEmbedding.run(10, sourceKind, 'text-embedding-3-large', 2, `hash-42-${sourceKind}`, '[1,0]', now, now);
      insertEmbedding.run(11, sourceKind, 'text-embedding-3-large', 2, `hash-43-${sourceKind}`, '[0.99,0.01]', now, now);
    }

    await service.clusterRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      k: 1,
      minScore: 0.5,
    });

    assert.equal(Object.hasOwn(service, 'parsedEmbeddingCache'), false);
  } finally {
    service.close();
  }
});

test('tui snapshot returns mixed issue and pull request counts with default visible cluster filter', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-09T12:00:00Z';
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Old issue cluster', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, '2026-03-07T00:00:00Z', null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Old PR cluster', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, '2026-03-07T00:00:00Z', null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Recent issue cluster', 'body', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, '2026-03-09T14:00:00Z', null, null, now, now, now);
    insertThread.run(13, 1, '103', 45, 'issue', 'open', 'Recent issue followup', 'body', 'dave', 'User', 'https://github.com/openclaw/openclaw/issues/45', '[]', '[]', '{}', 'hash-45', 0, now, '2026-03-09T13:00:00Z', null, null, now, now, now);
    insertThread.run(14, 1, '104', 46, 'pull_request', 'open', 'Recent PR followup', 'body', 'erin', 'User', 'https://github.com/openclaw/openclaw/pull/46', '[]', '[]', '{}', 'hash-46', 0, now, '2026-03-09T12:30:00Z', null, null, now, now, now);

    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, '2026-03-09T14:30:00Z');
    service.db
      .prepare(`insert into sync_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, '2026-03-09T12:00:00Z');
    service.db
      .prepare(`insert into embedding_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, '2026-03-09T13:00:00Z');
    service.db
      .prepare(
        `insert into repo_pipeline_state (
          repo_id, summary_model, summary_prompt_version, embedding_basis, embed_model, embed_dimensions,
          embed_pipeline_version, vector_backend, vectors_current_at, clusters_current_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        'previous-summary-model',
        'previous-summary-prompt',
        'title_original',
        'text-embedding-3-large',
        1024,
        'previous-embed-pipeline',
        'vectorlite',
        '2026-03-09T13:00:00Z',
        '2026-03-09T14:30:00Z',
        now,
      );
    service.db
      .prepare(
        `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(100, 1, 1, 10, 2, now);
    service.db
      .prepare(
        `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(101, 1, 1, 12, 3, now);
    const insertMember = service.db.prepare(
      `insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at)
       values (?, ?, ?, ?)`,
    );
    insertMember.run(100, 10, null, now);
    insertMember.run(100, 11, 0.9, now);
    insertMember.run(101, 12, null, now);
    insertMember.run(101, 13, 0.95, now);
    insertMember.run(101, 14, 0.88, now);

    const snapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(snapshot.stats.openIssueCount, 3);
    assert.equal(snapshot.stats.openPullRequestCount, 2);
    assert.equal(snapshot.stats.lastGithubReconciliationAt, '2026-03-09T12:00:00Z');
    assert.equal(snapshot.stats.lastEmbedRefreshAt, '2026-03-09T13:00:00Z');
    assert.equal(snapshot.stats.staleEmbedThreadCount, 5);
    assert.equal(snapshot.stats.staleEmbedSourceCount, 5);
    assert.equal(snapshot.stats.latestClusterRunId, 1);
    assert.deepEqual(
      snapshot.clusters.map((cluster) => cluster.clusterId),
      [101, 100],
    );

    const allSnapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.deepEqual(
      allSnapshot.clusters.map((cluster) => cluster.clusterId),
      [101, 100],
    );
    assert.equal(allSnapshot.clusters[0].issueCount, 2);
    assert.equal(allSnapshot.clusters[0].pullRequestCount, 1);
    assert.match(allSnapshot.clusters[0]?.displayTitle ?? '', /^[a-z]+-[a-z]+-[a-z]+  Recent issue cluster$/);

    const sizeSorted = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0, sort: 'size' });
    assert.deepEqual(
      sizeSorted.clusters.map((cluster) => cluster.clusterId),
      [101, 100],
    );

    const filtered = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0, search: 'old pr cluster' });
    assert.deepEqual(
      filtered.clusters.map((cluster) => cluster.clusterId),
      [100],
    );
  } finally {
    service.close();
  }
});

test('tui cluster detail and thread detail expose members, summaries, and neighbors', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-09T12:00:00Z';
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '["bug"]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Fix downloader hang', 'Implements a fix.', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '["bug"]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
    service.db
      .prepare(
        `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(100, 1, 1, 10, 2, now);
    service.db
      .prepare(
        `insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(100, 10, null, now);
    service.db
      .prepare(
        `insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(100, 11, 0.93, now);
    service.db
      .prepare(
        `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, 10, 11, 'exact_cosine', 0.93, '{}', now);
    service.db
      .prepare(
        `insert into document_summaries (thread_id, summary_kind, model, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'problem_summary', 'gpt-5-mini', 'hash-problem', 'Downloads hang before completion.', now, now);
    service.db
      .prepare(
        `insert into document_summaries (thread_id, summary_kind, model, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'dedupe_summary', 'gpt-5-mini', 'hash-dedupe', 'Transfer stalls near completion.', now, now);
    service.db
      .prepare(
        `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'title', 'text-embedding-3-large', 2, 'hash-title-42', '[1,0]', now, now);
    service.db
      .prepare(
        `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(11, 'title', 'text-embedding-3-large', 2, 'hash-title-43', '[0.95,0.05]', now, now);
    service.db
      .prepare(
        `insert into thread_revisions (id, thread_id, source_updated_at, content_hash, title_hash, body_hash, labels_hash, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1000, 10, now, 'hash-42', 'title-hash', 'body-hash', 'labels-hash', now);
    service.db
      .prepare(
        `insert into thread_code_snapshots (id, thread_revision_id, base_sha, head_sha, files_changed, additions, deletions, patch_digest, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(2000, 1000, 'base', 'head', 2, 14, 4, 'patch-digest', now);
    service.db
      .prepare(
        `insert into thread_changed_files (snapshot_id, path, status, additions, deletions, previous_path, patch_hash)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(2000, 'apps/cli/src/tui/app.ts', 'modified', 10, 2, null, 'patch-1');
    service.db
      .prepare(
        `insert into thread_changed_files (snapshot_id, path, status, additions, deletions, previous_path, patch_hash)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(2000, 'README.md', 'modified', 4, 2, null, 'patch-2');
    service.db
      .prepare(
        `insert into thread_key_summaries (
           thread_revision_id, summary_kind, prompt_version, provider, model, input_hash, output_hash, key_text, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1000,
        'llm_key_3line',
        'v1',
        'openai',
        'gpt-5-mini',
        'input-hash',
        'output-hash',
        'intent: Fix downloader hangs\nsurface: download progress\nmechanism: align timeout handling',
        now,
      );

    const detail = service.getTuiClusterDetail({ owner: 'openclaw', repo: 'openclaw', clusterId: 100 });
    assert.equal(detail.totalCount, 2);
    assert.equal(detail.issueCount, 1);
    assert.equal(detail.pullRequestCount, 1);
    assert.equal(detail.members[0].kind, 'issue');
    assert.equal(detail.members[1].kind, 'pull_request');
    assert.equal(detail.members[1].clusterScore, 0.93);

    const threadDetail = service.getTuiThreadDetail({ owner: 'openclaw', repo: 'openclaw', threadNumber: 42 });
    assert.equal(threadDetail.thread.number, 42);
    assert.equal(threadDetail.thread.labels[0], 'bug');
    assert.equal(threadDetail.thread.htmlUrl, 'https://github.com/openclaw/openclaw/issues/42');
    assert.equal(threadDetail.summaries.problem_summary, 'Downloads hang before completion.');
    assert.equal(threadDetail.summaries.dedupe_summary, 'Transfer stalls near completion.');
    assert.equal(threadDetail.keySummary?.text, 'intent: Fix downloader hangs\nsurface: download progress\nmechanism: align timeout handling');
    assert.equal(threadDetail.keySummary?.model, 'gpt-5-mini');
    assert.deepEqual(threadDetail.topFiles[0], {
      path: 'apps/cli/src/tui/app.ts',
      status: 'modified',
      additions: 10,
      deletions: 2,
    });
    assert.equal(threadDetail.neighbors[0]?.number, 43);
  } finally {
    service.close();
  }
});

test('getTuiThreadDetail prefers stored cluster neighbors over exact embedding search', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-09T12:00:00Z';
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

    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
    service.db
      .prepare(
        `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, 10, 11, 'exact_cosine', 0.91, '{}', now);

    let neighborCalls = 0;
    const originalListNeighbors = service.listNeighbors.bind(service);
    service.listNeighbors = ((...args: Parameters<typeof originalListNeighbors>) => {
      neighborCalls += 1;
      return originalListNeighbors(...args);
    }) as typeof service.listNeighbors;

    const detail = service.getTuiThreadDetail({
      owner: 'openclaw',
      repo: 'openclaw',
      threadId: 10,
      includeNeighbors: true,
    });

    assert.equal(detail.neighbors[0]?.number, 43);
    assert.equal(neighborCalls, 0);
  } finally {
    service.close();
  }
});

test('refreshRepository runs sync, embed, and cluster in order and returns the combined result', async () => {
  const messages: string[] = [];
  const service = makeTestService(
    {
      getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
      listRepositoryIssues: async () => [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Downloader hangs',
          body: 'The transfer never finishes.',
          html_url: 'https://github.com/openclaw/openclaw/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [],
          user: { login: 'alice', type: 'User' },
          updated_at: '2026-03-09T00:00:00Z',
        },
      ],
      getIssue: async (_owner, _repo, number) => ({
        id: 100,
        number,
        state: 'open',
        title: 'Downloader hangs',
        body: 'The transfer never finishes.',
        html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
        labels: [{ name: 'bug' }],
        assignees: [],
        user: { login: 'alice', type: 'User' },
        updated_at: '2026-03-09T00:00:00Z',
      }),
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    listPullFiles: async () => [],
    },
    {
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map((_text, index) => makeEmbedding(1, index)),
    },
  );

  try {
    const result = await service.refreshRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      onProgress: (message) => messages.push(message),
    });

    assert.equal(result.selected.sync, true);
    assert.equal(result.selected.embed, true);
    assert.equal(result.selected.cluster, true);
    assert.equal(result.sync?.threadsSynced, 1);
    assert.equal(result.embed?.embedded, 1);
    assert.equal(result.cluster?.clusters, 1);

    const syncIndex = messages.findIndex((message) => message.includes('[sync]'));
    const embedIndex = messages.findIndex((message) => message.includes('[embed]'));
    const clusterIndex = messages.findIndex((message) => message.includes('[cluster]'));
    assert.ok(syncIndex >= 0);
    assert.ok(embedIndex > syncIndex);
    assert.ok(clusterIndex > embedIndex);
  } finally {
    service.close();
  }
});

test('refreshRepository forwards includeCode to sync stage', async () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });
  let receivedIncludeCode: boolean | undefined;
  const originalSyncRepository = service.syncRepository.bind(service);
  service.syncRepository = (async (params: Parameters<typeof originalSyncRepository>[0]) => {
    receivedIncludeCode = params.includeCode;
    service.db
      .prepare(
        `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', '2026-03-09T00:00:00Z');
    return { runId: 1, threadsSynced: 0, commentsSynced: 0, codeFilesSynced: 0, threadsClosed: 0 };
  }) as typeof service.syncRepository;

  try {
    await service.refreshRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      embed: false,
      cluster: false,
      includeCode: true,
    });

    assert.equal(receivedIncludeCode, true);
  } finally {
    service.syncRepository = originalSyncRepository;
    service.close();
  }
});

test('agent cluster summary and detail dumps expose repo stats, snippets, and summaries', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-09T12:00:00Z';
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
    insertThread.run(
      10,
      1,
      '100',
      42,
      'issue',
      'open',
      'Downloader hangs',
      'The transfer never finishes after a large file download and needs to be retried.',
      'alice',
      'User',
      'https://github.com/openclaw/openclaw/issues/42',
      '["bug"]',
      '[]',
      '{}',
      'hash-42',
      0,
      now,
      '2026-03-09T10:00:00Z',
      null,
      null,
      now,
      now,
      now,
    );
    insertThread.run(
      11,
      1,
      '101',
      43,
      'pull_request',
      'open',
      'Fix downloader hang',
      'This updates the retry logic and timeout handling.',
      'bob',
      'User',
      'https://github.com/openclaw/openclaw/pull/43',
      '["bug"]',
      '[]',
      '{}',
      'hash-43',
      0,
      now,
      '2026-03-09T11:00:00Z',
      null,
      null,
      now,
      now,
      now,
    );

    service.db
      .prepare(`insert into sync_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, '2026-03-09T12:30:00Z');
    service.db
      .prepare(`insert into embedding_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, '2026-03-09T12:45:00Z');
    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, '2026-03-09T13:00:00Z');
    service.db
      .prepare(
        `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(100, 1, 1, 10, 2, now);
    service.db
      .prepare(
        `insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(100, 10, null, now);
    service.db
      .prepare(
        `insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at)
         values (?, ?, ?, ?)`,
      )
      .run(100, 11, 0.93, now);
    service.db
      .prepare(
        `insert into document_summaries (thread_id, summary_kind, model, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'dedupe_summary', 'gpt-5-mini', 'hash-dedupe', 'Transfer stalls near completion.', now, now);
    service.db
      .prepare(
        `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'title', 'text-embedding-3-large', 2, 'hash-title-42', '[1,0]', now, now);
    service.db
      .prepare(
        `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(11, 'title', 'text-embedding-3-large', 2, 'hash-title-43', '[0.95,0.05]', now, now);

    const summaries = service.listClusterSummaries({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(summaries.stats.openIssueCount, 1);
    assert.equal(summaries.clusters.length, 1);
    assert.match(summaries.clusters[0]?.displayTitle ?? '', /^[a-z]+-[a-z]+-[a-z]+  Downloader hangs$/);

    const detail = service.getClusterDetailDump({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: 100,
      memberLimit: 1,
      bodyChars: 30,
    });
    assert.equal(detail.members.length, 1);
    assert.equal(detail.members[0]?.thread.number, 42);
    assert.equal(detail.members[0]?.bodySnippet, 'The transfer never finishes a…');
    assert.equal(detail.members[0]?.summaries.dedupe_summary, 'Transfer stalls near completion.');
  } finally {
    service.close();
  }
});

test('getTuiThreadDetail can skip neighbor loading for fast browse paths', () => {
  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => [],
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
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
          labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh,
          closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        10,
        1,
        '100',
        42,
        'issue',
        'open',
        'Fast browse thread',
        'body',
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
        now,
        now,
        now,
      );

    const originalListNeighbors = service.listNeighbors.bind(service);
    let neighborCalls = 0;
    service.listNeighbors = ((...args: Parameters<typeof originalListNeighbors>) => {
      neighborCalls += 1;
      return originalListNeighbors(...args);
    }) as typeof service.listNeighbors;

    const detail = service.getTuiThreadDetail({
      owner: 'openclaw',
      repo: 'openclaw',
      threadId: 10,
      includeNeighbors: false,
    });

    assert.equal(detail.thread.number, 42);
    assert.deepEqual(detail.neighbors, []);
    assert.equal(neighborCalls, 0);
  } finally {
    service.close();
  }
});

test('local thread closure updates default thread filters and auto-closes fully closed clusters', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-10T12:00:00Z';
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Issue one', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'PR one', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);

    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
    service.db
      .prepare(
        `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(100, 1, 1, 10, 2, now);
    service.db
      .prepare(`insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)`)
      .run(100, 10, null, now);
    service.db
      .prepare(`insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)`)
      .run(100, 11, 0.91, now);

    const firstClose = service.closeThreadLocally({ owner: 'openclaw', repo: 'openclaw', threadNumber: 42 });
    assert.equal(firstClose.ok, true);
    assert.equal(firstClose.thread?.isClosed, true);
    assert.equal(firstClose.clusterClosed, false);
    assert.deepEqual(
      service.listThreads({ owner: 'openclaw', repo: 'openclaw' }).threads.map((thread) => thread.number),
      [43],
    );
    assert.deepEqual(
      service.listThreads({ owner: 'openclaw', repo: 'openclaw', includeClosed: true }).threads.map((thread) => thread.number),
      [43, 42],
    );

    const secondClose = service.closeThreadLocally({ owner: 'openclaw', repo: 'openclaw', threadNumber: 43 });
    assert.equal(secondClose.ok, true);
    assert.equal(secondClose.clusterClosed, true);

    const hiddenSummaries = service.listClusterSummaries({ owner: 'openclaw', repo: 'openclaw', minSize: 0, includeClosed: false });
    assert.equal(hiddenSummaries.clusters.length, 0);

    const summaries = service.listClusterSummaries({
      owner: 'openclaw',
      repo: 'openclaw',
      minSize: 0,
    });
    assert.equal(summaries.clusters.length, 1);
    assert.equal(summaries.clusters[0]?.isClosed, true);
    assert.equal(summaries.clusters[0]?.closeReasonLocal, 'all_members_closed');

    const snapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(snapshot.clusters.length, 1);
    assert.equal(snapshot.clusters[0]?.isClosed, true);
  } finally {
    service.close();
  }
});

test('manual cluster closure is shown by default and can be hidden from JSON summaries', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-10T12:00:00Z';
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
      .run(10, 1, '100', 42, 'issue', 'open', 'Issue one', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    const durableIdentity = humanKeyForValue('repo:1:cluster-representative:10');
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at, closed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(7, 1, durableIdentity.hash, durableIdentity.slug, 'active', 'duplicate_candidate', 10, 'Durable cluster', now, now, null);
    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
    service.db
      .prepare(
        `insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(100, 1, 1, 10, 1, now);
    service.db
      .prepare(`insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)`)
      .run(100, 10, null, now);

    const response = service.closeClusterLocally({ owner: 'openclaw', repo: 'openclaw', clusterId: 100 });
    assert.equal(response.ok, true);
    assert.equal(response.clusterClosed, true);
    const durable = service.db.prepare('select status, closed_at from cluster_groups where id = ?').get(7) as {
      status: string;
      closed_at: string | null;
    };
    assert.deepEqual(durable, { status: 'active', closed_at: null });
    const closure = service.db.prepare('select reason, actor_kind from cluster_closures where cluster_id = ?').get(7) as {
      reason: string;
      actor_kind: string;
    };
    assert.deepEqual(closure, { reason: 'manual', actor_kind: 'user' });

    assert.equal(service.listClusterSummaries({ owner: 'openclaw', repo: 'openclaw', minSize: 0, includeClosed: false }).clusters.length, 0);
    assert.equal(service.listClusterSummaries({ owner: 'openclaw', repo: 'openclaw', minSize: 0 }).clusters.length, 1);
    const detail = service.getClusterDetailDump({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: 100,
      includeClosed: true,
    });
    assert.equal(detail.cluster.isClosed, true);
    assert.equal(detail.cluster.closeReasonLocal, 'manual');

    const snapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(snapshot.clusters.length, 1);
    assert.equal(snapshot.clusters[0]?.isClosed, true);
    assert.equal(snapshot.clusters[0]?.closeReasonLocal, 'manual');

    service.db.prepare('delete from cluster_members where cluster_id = ?').run(100);
    service.db.prepare('delete from clusters where id = ?').run(100);
    const prunedSnapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(prunedSnapshot.clusters.length, 1);
    assert.equal(prunedSnapshot.clusters[0]?.clusterId, 7);
    assert.equal(prunedSnapshot.clusters[0]?.isClosed, true);
    assert.equal(prunedSnapshot.clusters[0]?.closeReasonLocal, 'manual');
  } finally {
    service.close();
  }
});

test('tui snapshot includes durable closed clusters missing from the latest run', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-10T12:00:00Z';
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
      .run(10, 1, '100', 42, 'issue', 'closed', 'Closed durable issue', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, now, null, now, now, now);
    service.db
      .prepare(
        `insert into threads (
          id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
          labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
          merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(11, 1, '101', 43, 'pull_request', 'closed', 'Archived durable PR', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, now, now, now, now, now);
    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'openclaw/openclaw', 'completed', now, now);
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at, closed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(7, 1, 'stable-key', 'trace-alpha-river', 'closed', 'duplicate_candidate', 10, 'Closed durable cluster', now, now, now);
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at, closed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(8, 1, 'stable-key-archived', 'archive-blue-harbor', 'active', 'duplicate_candidate', 11, 'Archived durable cluster', now, now, null);
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at, closed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(9, 1, 'stable-key-duplicate-archived', 'archive-blue-duplicate', 'active', 'duplicate_candidate', 11, 'Duplicate archived durable cluster', now, now, null);
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
        `insert into cluster_memberships (
          cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
          added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(8, 11, 'canonical', 'active', 1, null, null, 'algo', null, '{}', null, now, now, null);
    service.db
      .prepare(
        `insert into cluster_memberships (
          cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
          added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(9, 11, 'canonical', 'active', 1, null, null, 'algo', null, '{}', null, now, now, null);

    const hidden = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0, includeClosedClusters: false });
    assert.equal(hidden.clusters.length, 0);

    const snapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(snapshot.clusters.length, 2);
    assert.equal(snapshot.clusters[0]?.clusterId, 7);
    assert.equal(snapshot.clusters[0]?.isClosed, true);
    assert.equal(snapshot.clusters[0]?.closeReasonLocal, 'all_members_closed');
    assert.equal(snapshot.clusters[1]?.clusterId, 8);
    assert.equal(snapshot.clusters[1]?.isClosed, true);
    assert.equal(snapshot.clusters[1]?.closeReasonLocal, 'all_members_closed');

    const detail = service.getTuiClusterDetail({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: 7,
      clusterRunId: snapshot.clusterRunId ?? undefined,
    });
    assert.equal(detail.members.length, 1);
    assert.equal(detail.members[0]?.number, 42);
    const archivedDetail = service.getTuiClusterDetail({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: 8,
      clusterRunId: snapshot.clusterRunId ?? undefined,
    });
    assert.equal(archivedDetail.members.length, 1);
    assert.equal(archivedDetail.members[0]?.number, 43);
  } finally {
    service.close();
  }
});

test('excludeThreadFromCluster records a durable manual exclusion', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-10T12:00:00Z';
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
      .run(10, 1, '100', 42, 'issue', 'open', 'Issue one', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
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
      .run(7, 10, 'related', 'active', 0.87, null, null, 'algo', null, '{}', null, now, now, null);

    const response = service.excludeThreadFromCluster({
      owner: 'openclaw',
      repo: 'openclaw',
      clusterId: 7,
      threadNumber: 42,
      reason: 'false positive',
    });

    assert.equal(response.ok, true);
    assert.equal(response.state, 'removed_by_user');
    assert.equal(response.thread.number, 42);
    const override = service.db.prepare('select action, reason from cluster_overrides where cluster_id = ? and thread_id = ?').get(7, 10) as {
      action: string;
      reason: string;
    };
    assert.deepEqual(override, { action: 'exclude', reason: 'false positive' });
    const membership = service.db
      .prepare('select state, removed_by from cluster_memberships where cluster_id = ? and thread_id = ?')
      .get(7, 10) as { state: string; removed_by: string };
    assert.deepEqual(membership, { state: 'removed_by_user', removed_by: 'user' });
    const event = service.db.prepare('select event_type, actor_kind from cluster_events where cluster_id = ?').get(7) as {
      event_type: string;
      actor_kind: string;
    };
    assert.deepEqual(event, { event_type: 'manual_exclude_member', actor_kind: 'user' });
  } finally {
    service.close();
  }
});

test('listDurableClusters returns stable slugs and governed member states', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-10T12:00:00Z';
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Issue one', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Issue two', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(7, 1, 'stable-key', 'trace-alpha-river', 'active', 'duplicate_candidate', 10, 'Cluster trace-alpha-river', now, now);
    const insertMembership = service.db.prepare(
      `insert into cluster_memberships (
        cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
        added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMembership.run(7, 10, 'canonical', 'active', 1, null, null, 'algo', null, '{}', null, now, now, null);
    insertMembership.run(7, 11, 'related', 'blocked_by_override', 0.87, null, null, 'algo', 'user', '{}', '{}', now, now, now);

    const response = service.listDurableClusters({ owner: 'openclaw', repo: 'openclaw' });

    assert.equal(response.clusters[0]?.stableSlug, 'trace-alpha-river');
    assert.equal(response.clusters[0]?.activeCount, 1);
    assert.equal(response.clusters[0]?.blockedCount, 1);
    assert.equal(response.clusters[0]?.members[1]?.state, 'blocked_by_override');
  } finally {
    service.close();
  }
});

test('explainDurableCluster returns evidence and governance records', () => {
  const service = makeTestService({
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-10T12:00:00Z';
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
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Issue one', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'issue', 'open', 'Issue two', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    service.db
      .prepare(
        `insert into cluster_groups (
          id, repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(7, 1, 'stable-key', 'trace-alpha-river', 'active', 'duplicate_candidate', 10, 'Cluster trace-alpha-river', now, now);
    const insertMembership = service.db.prepare(
      `insert into cluster_memberships (
        cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
        added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMembership.run(7, 10, 'canonical', 'active', 1, null, null, 'algo', null, '{}', null, now, now, null);
    insertMembership.run(7, 11, 'related', 'active', 0.91, null, null, 'algo', null, '{}', null, now, now, null);
    service.db
      .prepare(
        `insert into similarity_edge_evidence (
          repo_id, left_thread_id, right_thread_id, algorithm_version, config_hash, score, tier, state,
          breakdown_json, first_seen_run_id, last_seen_run_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 10, 11, 'persistent-cluster-v1', 'config', 0.91, 'strong', 'active', '{"sources":["deterministic_fingerprint"],"score":0.91}', null, null, now, now);
    service.db
      .prepare('insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(1, 7, 10, 'force_canonical', 'best root issue', now, null);
    service.db
      .prepare('insert into cluster_aliases (cluster_id, alias_slug, reason, created_at) values (?, ?, ?, ?)')
      .run(7, 'old-slug', 'merged_from:3', now);
    service.db
      .prepare('insert into cluster_events (cluster_id, run_id, event_type, actor_kind, payload_json, created_at) values (?, ?, ?, ?, ?, ?)')
      .run(7, null, 'keep_canonical', 'algo', '{"threadId":10}', now);

    const response = service.explainDurableCluster({ owner: 'openclaw', repo: 'openclaw', clusterId: 7 });

    assert.equal(response.cluster.stableSlug, 'trace-alpha-river');
    assert.equal(response.evidence[0]?.leftThreadNumber, 42);
    assert.equal(response.evidence[0]?.sources[0], 'deterministic_fingerprint');
    assert.equal(response.overrides[0]?.action, 'force_canonical');
    assert.equal(response.aliases[0]?.aliasSlug, 'old-slug');
    assert.deepEqual(response.events[0]?.payload, { threadId: 10 });
  } finally {
    service.close();
  }
});

test('syncRepository keeps source author fields without building actor profiles', async () => {
  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => [
      {
        id: 100,
        number: 42,
        state: 'open',
        title: 'Downloader hangs',
        body: 'The transfer never finishes.',
        html_url: 'https://github.com/openclaw/openclaw/issues/42',
        labels: [],
        user: { id: 501, login: 'alice', type: 'User', site_admin: false },
        created_at: '2026-03-09T00:00:00Z',
        updated_at: '2026-03-09T00:00:00Z',
      },
    ],
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [
      {
        id: 900,
        body: 'same here',
        user: { id: 502, login: 'bob', type: 'User', site_admin: false },
        created_at: '2026-03-09T01:00:00Z',
        updated_at: '2026-03-09T01:00:00Z',
      },
    ],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      includeComments: true,
      limit: 1,
    });

    const thread = service.db.prepare('select author_login, author_type from threads where number = 42').get() as {
      author_login: string;
      author_type: string;
    };
    const comment = service.db.prepare('select author_login, author_type from comments where github_id = ?').get('900') as {
      author_login: string;
      author_type: string;
    };

    assert.deepEqual(thread, { author_login: 'alice', author_type: 'User' });
    assert.deepEqual(comment, { author_login: 'bob', author_type: 'User' });
  } finally {
    service.close();
  }
});

test('syncRepository reconciles stale open threads and marks confirmed closures without re-fetching comments', async () => {
  let listIssueCommentCalls = 0;
  let getIssueCalls = 0;
  let openListCalls = 0;
  let closedListCalls = 0;

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, _since, _limit, _reporter, state = 'open') => {
      if (state === 'closed') {
        closedListCalls += 1;
        return [
          {
            id: 100,
            number: 42,
            state: 'closed',
            title: 'Downloader hangs',
            body: 'The transfer never finishes.',
            html_url: 'https://github.com/openclaw/openclaw/issues/42',
            labels: [{ name: 'bug' }],
            assignees: [],
            user: { login: 'alice', type: 'User' },
            updated_at: '2026-03-10T00:00:00Z',
            closed_at: '2026-03-10T00:00:00Z',
          },
        ];
      }
      openListCalls += 1;
      return openListCalls === 1
        ? [
            {
              id: 100,
              number: 42,
              state: 'open',
              title: 'Downloader hangs',
              body: 'The transfer never finishes.',
              html_url: 'https://github.com/openclaw/openclaw/issues/42',
              labels: [{ name: 'bug' }],
              assignees: [],
              user: { login: 'alice', type: 'User' },
              updated_at: '2026-03-09T00:00:00Z',
            },
          ]
        : [];
    },
    getIssue: async (_owner, _repo, number) => {
      getIssueCalls += 1;
      return {
        id: 100,
        number,
        state: 'closed',
        title: 'Downloader hangs',
        body: 'The transfer never finishes.',
        html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
        labels: [{ name: 'bug' }],
        assignees: [],
        user: { login: 'alice', type: 'User' },
        updated_at: '2026-03-10T00:00:00Z',
        closed_at: '2026-03-10T00:00:00Z',
      };
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => {
      listIssueCommentCalls += 1;
      return [];
    },
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });
    const before = service.db
      .prepare("select state, first_pulled_at, last_pulled_at from threads where number = 42 and kind = 'issue'")
      .get() as { state: string; first_pulled_at: string; last_pulled_at: string };
    assert.equal(before.state, 'open');
    assert.equal(listIssueCommentCalls, 0);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });
    const after = service.db
      .prepare("select state, closed_at_gh, first_pulled_at, last_pulled_at from threads where number = 42 and kind = 'issue'")
      .get() as {
      state: string;
      closed_at_gh: string | null;
      first_pulled_at: string;
      last_pulled_at: string;
    };

    assert.equal(result.threadsSynced, 0);
    assert.equal(result.threadsClosed, 1);
    assert.equal(after.state, 'closed');
    assert.equal(after.closed_at_gh, '2026-03-10T00:00:00Z');
    assert.equal(after.first_pulled_at, before.first_pulled_at);
    assert.notEqual(after.last_pulled_at, before.last_pulled_at);
    assert.equal(getIssueCalls, 0);
    assert.equal(closedListCalls, 1);
    assert.equal(listIssueCommentCalls, 0);
    assert.equal(service.listThreads({ owner: 'openclaw', repo: 'openclaw' }).threads.length, 0);
  } finally {
    service.close();
  }
});

test('syncRepository treats missing stale pull requests as closed and continues', async () => {
  let listRepositoryIssuesCalls = 0;
  let getPullCalls = 0;
  const messages: string[] = [];

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => {
      listRepositoryIssuesCalls += 1;
      return listRepositoryIssuesCalls === 1
        ? [
            {
              id: 101,
              number: 43,
              state: 'open',
              title: 'Fix downloader hang',
              body: 'Implements a fix.',
              html_url: 'https://github.com/openclaw/openclaw/pull/43',
              labels: [{ name: 'bug' }],
              assignees: [],
              pull_request: { url: 'https://api.github.com/repos/openclaw/openclaw/pulls/43' },
              user: { login: 'bob', type: 'User' },
              updated_at: '2026-03-09T00:00:00Z',
            },
          ]
        : [];
    },
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async () => {
      getPullCalls += 1;
      throw Object.assign(new Error('GitHub request failed for GET /repos/openclaw/openclaw/pulls/43: Not Found'), {
        status: 404,
      });
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      fullReconcile: true,
      onProgress: (message) => messages.push(message),
    });
    const after = service.db
      .prepare("select state, closed_at_gh, last_pulled_at from threads where number = 43 and kind = 'pull_request'")
      .get() as {
      state: string;
      closed_at_gh: string | null;
      last_pulled_at: string | null;
    };

    assert.equal(result.threadsSynced, 0);
    assert.equal(result.threadsClosed, 1);
    assert.equal(after.state, 'closed');
    assert.ok(after.closed_at_gh);
    assert.ok(after.last_pulled_at);
    assert.equal(getPullCalls, 1);
    assert.match(messages.join('\n'), /missing on GitHub; marking it closed locally and continuing/);
  } finally {
    service.close();
  }
});

test('syncRepository skips stale-open reconciliation for filtered crawls', async () => {
  let listRepositoryIssuesCalls = 0;
  let getIssueCalls = 0;

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, _since, limit) => {
      listRepositoryIssuesCalls += 1;
      return listRepositoryIssuesCalls === 1
        ? [
            {
              id: 100,
              number: 42,
              state: 'open',
              title: 'Downloader hangs',
              body: 'The transfer never finishes.',
              html_url: 'https://github.com/openclaw/openclaw/issues/42',
              labels: [{ name: 'bug' }],
              assignees: [],
              user: { login: 'alice', type: 'User' },
              updated_at: '2026-03-09T00:00:00Z',
            },
          ].slice(0, limit ?? 1)
        : [];
    },
    getIssue: async (_owner, _repo, number) => {
      getIssueCalls += 1;
      return {
        id: 100,
        number,
        state: 'closed',
        title: 'Downloader hangs',
        body: 'The transfer never finishes.',
        html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
        labels: [{ name: 'bug' }],
        assignees: [],
        user: { login: 'alice', type: 'User' },
        updated_at: '2026-03-10T00:00:00Z',
        closed_at: '2026-03-10T00:00:00Z',
      };
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });
    const result = await service.syncRepository({ owner: 'openclaw', repo: 'openclaw', limit: 1 });
    const after = service.db
      .prepare("select state from threads where number = 42 and kind = 'issue'")
      .get() as { state: string };

    assert.equal(result.threadsClosed, 0);
    assert.equal(getIssueCalls, 0);
    assert.equal(after.state, 'open');
  } finally {
    service.close();
  }
});

test('syncRepository leaves unseen stale open items alone by default when closed overlap does not match them', async () => {
  let getIssueCalls = 0;

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, _since, _limit, _reporter, state = 'open') => {
      if (state === 'closed') {
        return [];
      }
      return [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Downloader hangs',
          body: 'The transfer never finishes.',
          html_url: 'https://github.com/openclaw/openclaw/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [],
          user: { login: 'alice', type: 'User' },
          updated_at: '2026-03-09T00:00:00Z',
        },
      ];
    },
    getIssue: async (_owner, _repo, number) => {
      getIssueCalls += 1;
      return {
        id: 100,
        number,
        state: 'closed',
        title: 'Downloader hangs',
        body: 'The transfer never finishes.',
        html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
        labels: [{ name: 'bug' }],
        assignees: [],
        user: { login: 'alice', type: 'User' },
        updated_at: '2026-03-10T00:00:00Z',
        closed_at: '2026-03-10T00:00:00Z',
      };
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });
    const result = await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });
    const after = service.db
      .prepare("select state from threads where number = 42 and kind = 'issue'")
      .get() as { state: string };

    assert.equal(result.threadsClosed, 0);
    assert.equal(getIssueCalls, 0);
    assert.equal(after.state, 'open');
  } finally {
    service.close();
  }
});

test('syncRepository performs direct stale-open reconciliation when fullReconcile is requested', async () => {
  let getIssueCalls = 0;
  let openListCalls = 0;

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, _since, _limit, _reporter, state = 'open') => {
      if (state === 'closed') {
        return [];
      }
      openListCalls += 1;
      return openListCalls === 1
        ? [
            {
              id: 100,
              number: 42,
              state: 'open',
              title: 'Downloader hangs',
              body: 'The transfer never finishes.',
              html_url: 'https://github.com/openclaw/openclaw/issues/42',
              labels: [{ name: 'bug' }],
              assignees: [],
              user: { login: 'alice', type: 'User' },
              updated_at: '2026-03-09T00:00:00Z',
            },
          ]
        : [];
    },
    getIssue: async (_owner, _repo, number) => {
      getIssueCalls += 1;
      return {
        id: 100,
        number,
        state: 'closed',
        title: 'Downloader hangs',
        body: 'The transfer never finishes.',
        html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
        labels: [{ name: 'bug' }],
        assignees: [],
        user: { login: 'alice', type: 'User' },
        updated_at: '2026-03-10T00:00:00Z',
        closed_at: '2026-03-10T00:00:00Z',
      };
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      startedAt: '2026-03-09T13:13:00.000Z',
    });
    const result = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      fullReconcile: true,
      startedAt: '2026-03-09T14:13:01.000Z',
    });
    const after = service.db
      .prepare("select state from threads where number = 42 and kind = 'issue'")
      .get() as { state: string };

    assert.equal(result.threadsClosed, 1);
    assert.equal(getIssueCalls, 1);
    assert.equal(after.state, 'closed');
  } finally {
    service.close();
  }
});

test('syncRepository derives the default overlapping since window from the last completed full scan', async () => {
  const openSinceValues: Array<string | undefined> = [];
  const closedSinceValues: Array<string | undefined> = [];

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, since, _limit, _reporter, state = 'open') => {
      if (state === 'closed') {
        closedSinceValues.push(since);
        return [];
      }
      openSinceValues.push(since);
      return [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Downloader hangs',
          body: 'The transfer never finishes.',
          html_url: 'https://github.com/openclaw/openclaw/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [],
          user: { login: 'alice', type: 'User' },
          updated_at: '2026-03-09T00:00:00Z',
        },
      ];
    },
    getIssue: async (_owner, _repo, number) => ({
      id: 100,
      number,
      state: 'open',
      title: 'Downloader hangs',
      body: 'The transfer never finishes.',
      html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      updated_at: '2026-03-09T00:00:00Z',
    }),
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      startedAt: '2026-03-09T13:13:00.000Z',
    });
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      startedAt: '2026-03-09T14:13:01.000Z',
    });

    assert.equal(openSinceValues[0], undefined);
    assert.equal(openSinceValues[1], '2026-03-09T12:13:01.000Z');
    assert.deepEqual(closedSinceValues, []);

    const syncState = service.db
      .prepare(
        `select
            last_full_open_scan_started_at,
            last_overlapping_open_scan_completed_at,
            last_non_overlapping_scan_completed_at,
            last_open_close_reconciled_at
         from repo_sync_state`,
      )
      .get() as {
      last_full_open_scan_started_at: string | null;
      last_overlapping_open_scan_completed_at: string | null;
      last_non_overlapping_scan_completed_at: string | null;
      last_open_close_reconciled_at: string | null;
    };

    const rows = service.db.prepare("select stats_json from sync_runs where status = 'completed' order by id asc").all() as Array<{
      stats_json: string | null;
    }>;
    const firstStats = JSON.parse(rows[0]?.stats_json ?? '{}') as Record<string, unknown>;
    const secondStats = JSON.parse(rows[1]?.stats_json ?? '{}') as Record<string, unknown>;

    assert.equal(firstStats.isFullOpenScan, true);
    assert.equal(firstStats.effectiveSince, null);
    assert.equal(secondStats.isOverlappingOpenScan, true);
    assert.equal(secondStats.effectiveSince, '2026-03-09T12:13:01.000Z');
    assert.equal(syncState.last_full_open_scan_started_at, '2026-03-09T13:13:00.000Z');
    assert.ok(syncState.last_overlapping_open_scan_completed_at);
    assert.ok(Date.parse(syncState.last_overlapping_open_scan_completed_at) >= Date.parse('2026-03-09T14:13:01.000Z'));
    assert.equal(syncState.last_non_overlapping_scan_completed_at, null);
    assert.equal(syncState.last_open_close_reconciled_at, syncState.last_overlapping_open_scan_completed_at);
  } finally {
    service.close();
  }
});

test('syncRepository uses an explicit since window for both open and closed overlap scans', async () => {
  const openSinceValues: Array<string | undefined> = [];
  const closedSinceValues: Array<string | undefined> = [];
  let openListCalls = 0;

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, since, _limit, _reporter, state = 'open') => {
      if (state === 'closed') {
        closedSinceValues.push(since);
        return [];
      }
      openSinceValues.push(since);
      openListCalls += 1;
      return openListCalls === 1
        ? [
            {
              id: 100,
              number: 42,
              state: 'open',
              title: 'Downloader hangs',
              body: 'The transfer never finishes.',
              html_url: 'https://github.com/openclaw/openclaw/issues/42',
              labels: [{ name: 'bug' }],
              assignees: [],
              user: { login: 'alice', type: 'User' },
              updated_at: '2026-03-09T00:00:00Z',
            },
          ]
        : [];
    },
    getIssue: async (_owner, _repo, number) => ({
      id: 100,
      number,
      state: 'open',
      title: 'Downloader hangs',
      body: 'The transfer never finishes.',
      html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      updated_at: '2026-03-09T00:00:00Z',
    }),
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      startedAt: '2026-03-09T13:13:00.000Z',
    });

    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      since: '2026-03-09T10:00:00.000Z',
      startedAt: '2026-03-09T14:13:01.000Z',
    });

    assert.deepEqual(openSinceValues, [undefined, '2026-03-09T10:00:00.000Z']);
    assert.deepEqual(closedSinceValues, ['2026-03-09T10:00:00.000Z']);
  } finally {
    service.close();
  }
});

test('syncRepository skips the closed overlap sweep on the first full scan with no overlap cursor', async () => {
  const openSinceValues: Array<string | undefined> = [];
  const closedSinceValues: Array<string | undefined> = [];

  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async (_owner, _repo, since, _limit, _reporter, state = 'open') => {
      if (state === 'closed') {
        closedSinceValues.push(since);
        return [];
      }
      openSinceValues.push(since);
      return [
        {
          id: 100,
          number: 42,
          state: 'open',
          title: 'Downloader hangs',
          body: 'The transfer never finishes.',
          html_url: 'https://github.com/openclaw/openclaw/issues/42',
          labels: [{ name: 'bug' }],
          assignees: [],
          user: { login: 'alice', type: 'User' },
          updated_at: '2026-03-09T00:00:00Z',
        },
      ];
    },
    getIssue: async (_owner, _repo, number) => ({
      id: 100,
      number,
      state: 'open',
      title: 'Downloader hangs',
      body: 'The transfer never finishes.',
      html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
      labels: [{ name: 'bug' }],
      assignees: [],
      user: { login: 'alice', type: 'User' },
      updated_at: '2026-03-09T00:00:00Z',
    }),
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      startedAt: '2026-03-09T13:13:00.000Z',
    });

    assert.deepEqual(openSinceValues, [undefined]);
    assert.deepEqual(closedSinceValues, []);
  } finally {
    service.close();
  }
});

test('repository-scoped reads and neighbors do not leak across repos in the same database', () => {
  const service = makeTestService({
    getRepo: async () => ({ id: 1, full_name: 'owner-one/repo-one' }),
    listRepositoryIssues: async () => [],
    getIssue: async () => {
      throw new Error('not expected');
    },
    getPull: async () => {
      throw new Error('not expected');
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    listPullFiles: async () => [],
  });

  try {
    const now = '2026-03-09T00:00:00Z';
    const insertRepo = service.db.prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertRepo.run(1, 'owner-one', 'repo-one', 'owner-one/repo-one', '1', '{}', now);
    insertRepo.run(2, 'owner-two', 'repo-two', 'owner-two/repo-two', '2', '{}', now);

    const insertThread = service.db.prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh,
        closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Repo one issue', 'body', 'alice', 'User', 'https://github.com/owner-one/repo-one/issues/42', '[]', '[]', '{}', 'hash-10', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Repo one pr', 'body', 'bob', 'User', 'https://github.com/owner-one/repo-one/pull/43', '[]', '[]', '{}', 'hash-11', 0, now, now, null, null, now, now, now);
    insertThread.run(20, 2, '200', 42, 'issue', 'open', 'Repo two issue', 'body', 'carol', 'User', 'https://github.com/owner-two/repo-two/issues/42', '[]', '[]', '{}', 'hash-20', 0, now, now, null, null, now, now, now);

    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(1, 1, 'owner-one/repo-one', 'completed', now, now);
    service.db
      .prepare(`insert into cluster_runs (id, repo_id, scope, status, started_at, finished_at) values (?, ?, ?, ?, ?, ?)`)
      .run(2, 2, 'owner-two/repo-two', 'completed', now, now);
    service.db
      .prepare(`insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at) values (?, ?, ?, ?, ?, ?)`)
      .run(100, 1, 1, 10, 2, now);
    service.db
      .prepare(`insert into clusters (id, repo_id, cluster_run_id, representative_thread_id, member_count, created_at) values (?, ?, ?, ?, ?, ?)`)
      .run(200, 2, 2, 20, 1, now);
    service.db
      .prepare(`insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)`)
      .run(100, 10, null, now);
    service.db
      .prepare(`insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)`)
      .run(100, 11, 0.91, now);
    service.db
      .prepare(`insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)`)
      .run(200, 20, null, now);

    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEmbedding.run(10, 'title', 'text-embedding-3-large', 2, 'hash-a', '[1,0]', now, now);
    insertEmbedding.run(11, 'title', 'text-embedding-3-large', 2, 'hash-b', '[0.9,0.1]', now, now);
    insertEmbedding.run(20, 'title', 'text-embedding-3-large', 2, 'hash-c', '[1,0]', now, now);

    const repoOneThreads = service.listThreads({ owner: 'owner-one', repo: 'repo-one' });
    assert.equal(repoOneThreads.threads.length, 2);
    assert.deepEqual(
      repoOneThreads.threads.map((thread) => thread.number),
      [43, 42],
    );

    const repoOneSnapshot = service.getTuiSnapshot({ owner: 'owner-one', repo: 'repo-one', minSize: 0 });
    assert.equal(repoOneSnapshot.repository.fullName, 'owner-one/repo-one');
    assert.deepEqual(
      repoOneSnapshot.clusters.map((cluster) => cluster.clusterId),
      [100],
    );

    const repoOneNeighbors = service.listNeighbors({
      owner: 'owner-one',
      repo: 'repo-one',
      threadNumber: 42,
      limit: 5,
      minScore: 0.1,
    });
    assert.deepEqual(
      repoOneNeighbors.neighbors.map((neighbor) => neighbor.number),
      [43],
    );
  } finally {
    service.close();
  }
});
