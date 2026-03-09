import test from 'node:test';
import assert from 'node:assert/strict';

import { GitcrawlService } from './service.js';

function makeTestService(
  github: GitcrawlService['github'],
  ai?: GitcrawlService['ai'],
): GitcrawlService {
  return new GitcrawlService({
    config: {
      workspaceRoot: process.cwd(),
      dbPath: ':memory:',
      apiPort: 5179,
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 2,
      embedConcurrency: 2,
      embedMaxUnread: 4,
      openSearchIndex: 'gitcrawl-threads',
      githubToken: 'test-token',
    },
    github,
    ai,
  });
}

test('syncRepository defaults to metadata-only mode, preserves thread kind, and tracks first/last pull timestamps', async () => {
  const messages: string[] = [];
  let listIssueCommentCalls = 0;
  let listPullReviewCalls = 0;
  let listPullReviewCommentCalls = 0;
  const service = makeTestService({
    checkAuth: async () => undefined,
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
    assert.equal(service.listRepositories().repositories.length, 1);
    assert.equal(service.listThreads({ owner: 'openclaw', repo: 'openclaw' }).threads.length, 2);
    assert.equal(listIssueCommentCalls, 0);
    assert.equal(listPullReviewCalls, 0);
    assert.equal(listPullReviewCommentCalls, 0);

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
    checkAuth: async () => undefined,
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
  } finally {
    service.close();
  }
});

test('summarizeRepository excludes hydrated comments by default and reports token usage', async () => {
  const summaryInputs: string[] = [];
  const service = makeTestService(
    {
      checkAuth: async () => undefined,
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
    },
    {
      checkAuth: async () => undefined,
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
      checkAuth: async () => undefined,
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
    },
    {
      checkAuth: async () => undefined,
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

test('purgeComments removes hydrated comments and refreshes canonical documents', () => {
  const service = makeTestService({
    checkAuth: async () => undefined,
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
      checkAuth: async () => undefined,
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
    },
    {
      checkAuth: async () => undefined,
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embedCalls.push(texts);
        return texts.map((text, index) => [text.length, index]);
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
        `insert into document_summaries (thread_id, summary_kind, model, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(10, 'dedupe_summary', 'gpt-5-mini', 'summary-hash', 'Transfer hangs near completion.', now, now);

    const first = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(first.embedded, 3);
    assert.equal(embedCalls.length, 2);
    assert.deepEqual(
      service.db
        .prepare('select source_kind from document_embeddings order by source_kind asc')
        .all()
        .map((row: unknown) => (row as { source_kind: string }).source_kind),
      ['body', 'dedupe_summary', 'title'],
    );

    const second = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(second.embedded, 0);
    assert.equal(embedCalls.length, 2);

    service.db
      .prepare('update threads set body = ?, updated_at = ? where id = ?')
      .run('The transfer now stalls at 99%.', now, 10);
    const third = await service.embedRepository({ owner: 'openclaw', repo: 'openclaw' });
    assert.equal(third.embedded, 1);
    assert.equal(embedCalls.length, 3);
    assert.deepEqual(embedCalls[2], ['The transfer now stalls at 99%.']);
  } finally {
    service.close();
  }
});

test('embedRepository truncates oversized inputs before submission', async () => {
  const embedCalls: string[][] = [];
  const service = new GitcrawlService({
    config: {
      workspaceRoot: process.cwd(),
      dbPath: ':memory:',
      apiPort: 5179,
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
      openSearchIndex: 'gitcrawl-threads',
      githubToken: 'test-token',
    },
    github: {
      checkAuth: async () => undefined,
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
    },
    ai: {
      checkAuth: async () => undefined,
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => {
        embedCalls.push(texts);
        return texts.map((text, index) => [text.length, index]);
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

    assert.equal(result.embedded, 4);
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
  const service = new GitcrawlService({
    config: {
      workspaceRoot: process.cwd(),
      dbPath: ':memory:',
      apiPort: 5179,
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
      openSearchIndex: 'gitcrawl-threads',
      githubToken: 'test-token',
    },
    github: {
      checkAuth: async () => undefined,
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
    },
    ai: {
      checkAuth: async () => undefined,
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
        return texts.map((text, index) => [text.length, index]);
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

    assert.equal(result.embedded, 4);
    assert.ok(embedCalls.length >= 3);
    assert.equal(embedCalls[0].length, 4);
    assert.ok(embedCalls.flat().some((text) => text.includes('[truncated for embedding]')));
  } finally {
    service.close();
  }
});

test('listNeighbors returns exact nearest neighbors for an embedded thread', () => {
  const service = makeTestService({
    checkAuth: async () => undefined,
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
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

test('syncRepository reconciles stale open threads and marks confirmed closures without re-fetching comments', async () => {
  let listIssueCommentCalls = 0;
  let getIssueCalls = 0;
  let listRepositoryIssuesCalls = 0;

  const service = makeTestService({
    checkAuth: async () => undefined,
    getRepo: async () => ({ id: 1, full_name: 'openclaw/openclaw' }),
    listRepositoryIssues: async () => {
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
    assert.equal(getIssueCalls, 1);
    assert.equal(listIssueCommentCalls, 0);
    assert.equal(service.listThreads({ owner: 'openclaw', repo: 'openclaw' }).threads.length, 0);
  } finally {
    service.close();
  }
});

test('syncRepository skips stale-open reconciliation for filtered crawls', async () => {
  let listRepositoryIssuesCalls = 0;
  let getIssueCalls = 0;

  const service = makeTestService({
    checkAuth: async () => undefined,
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
