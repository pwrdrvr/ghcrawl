import test from 'node:test';
import assert from 'node:assert/strict';

import { GHCrawlService } from './service.js';

function makeTestConfig(overrides: Partial<GHCrawlService['config']> = {}): GHCrawlService['config'] {
  return {
    workspaceRoot: process.cwd(),
    configDir: '/tmp/ghcrawl-test',
    configPath: '/tmp/ghcrawl-test/config.json',
    configFileExists: true,
    dbPath: ':memory:',
    dbPathSource: 'config',
    apiPort: 5179,
    githubToken: 'ghp_testtoken1234567890',
    githubTokenSource: 'config',
    secretProvider: 'plaintext',
    tuiPreferences: {},
    openaiApiKeySource: 'none',
    summaryModel: 'gpt-5-mini',
    embedModel: 'text-embedding-3-large',
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

test('doctor reports config path and successful auth smoke checks', async () => {
  let githubChecked = 0;
  let openAiChecked = 0;
  const service = new GHCrawlService({
    config: makeTestConfig({
      openaiApiKey: 'sk-proj-testkey1234567890',
      openaiApiKeySource: 'config',
    }),
    github: {
      checkAuth: async () => {
        githubChecked += 1;
      },
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
    ai: {
      checkAuth: async () => {
        openAiChecked += 1;
      },
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async () => [],
    },
  });

  try {
    const result = await service.doctor();
    assert.equal(result.health.configPath, '/tmp/ghcrawl-test/config.json');
    assert.equal(result.github.formatOk, true);
    assert.equal(result.github.authOk, true);
    assert.equal(result.openai.formatOk, true);
    assert.equal(result.openai.authOk, true);
    assert.equal(githubChecked, 1);
    assert.equal(openAiChecked, 1);
  } finally {
    service.close();
  }
});

test('doctor reports invalid token format without attempting auth', async () => {
  let githubChecked = 0;
  const service = new GHCrawlService({
    config: makeTestConfig({
      githubToken: 'not-a-token',
    }),
    github: {
      checkAuth: async () => {
        githubChecked += 1;
      },
      getRepo: async () => ({}),
      listRepositoryIssues: async () => [],
      getIssue: async () => ({}),
      getPull: async () => ({}),
      listIssueComments: async () => [],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  try {
    const result = await service.doctor();
    assert.equal(result.github.formatOk, false);
    assert.equal(result.github.authOk, false);
    assert.match(result.github.error ?? '', /does not look like a GitHub personal access token/);
    assert.equal(githubChecked, 0);
  } finally {
    service.close();
  }
});

test('doctor explains when secrets are expected from 1Password CLI env injection', async () => {
  const service = new GHCrawlService({
    config: makeTestConfig({
      githubToken: undefined,
      githubTokenSource: 'none',
      openaiApiKey: undefined,
      openaiApiKeySource: 'none',
      secretProvider: 'op',
      opVaultName: 'PwrDrvr LLC',
      opItemName: 'ghcrawl',
    }),
  });

  try {
    const result = await service.doctor();
    assert.equal(result.github.configured, false);
    assert.match(result.github.error ?? '', /1Password CLI/);
    assert.equal(result.openai.configured, false);
    assert.match(result.openai.error ?? '', /OPENAI_API_KEY/);
  } finally {
    service.close();
  }
});

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
    assert.deepEqual(
      service.listThreads({ owner: 'openclaw', repo: 'openclaw', numbers: [43, 42, 999] }).threads.map((thread) => thread.number),
      [43, 42],
    );
    const authorThreads = service.listAuthorThreads({ owner: 'openclaw', repo: 'openclaw', login: 'alice' });
    assert.equal(authorThreads.authorLogin, 'alice');
    assert.deepEqual(authorThreads.threads.map((item) => item.thread.number), [43, 42]);
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
  const service = new GHCrawlService({
    config: makeTestConfig({
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
    }),
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
  const service = new GHCrawlService({
    config: makeTestConfig({
      embedBatchSize: 8,
      embedConcurrency: 1,
      embedMaxUnread: 2,
    }),
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

test('listAuthorThreads returns one author view with strongest same-author match from stored cluster edges', () => {
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

    const insertThread = service.db.prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run(10, 1, '100', 42, 'issue', 'open', 'Downloader hangs', 'The transfer never finishes.', 'lqquan', 'User', 'https://github.com/openclaw/openclaw/issues/42', '[]', '[]', '{}', 'hash-42', 0, now, now, null, null, now, now, now);
    insertThread.run(11, 1, '101', 43, 'pull_request', 'open', 'Fix downloader hang', 'Implements a fix.', 'lqquan', 'User', 'https://github.com/openclaw/openclaw/pull/43', '[]', '[]', '{}', 'hash-43', 0, now, now, null, null, now, now, now);
    insertThread.run(12, 1, '102', 44, 'issue', 'open', 'Retry issue', 'Retries are broken.', 'other', 'User', 'https://github.com/openclaw/openclaw/issues/44', '[]', '[]', '{}', 'hash-44', 0, now, now, null, null, now, now, now);

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
    service.db
      .prepare(
        `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 1, 10, 11, 'exact_cosine', 0.91, '{}', now);

    const result = service.listAuthorThreads({ owner: 'openclaw', repo: 'openclaw', login: 'lqquan' });

    assert.deepEqual(result.threads.map((item) => item.thread.number), [43, 42]);
    assert.equal(result.threads[0]?.strongestSameAuthorMatch?.number, 42);
    assert.equal(result.threads[0]?.strongestSameAuthorMatch?.score, 0.91);
    assert.equal(result.threads[1]?.strongestSameAuthorMatch?.number, 43);
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

test('clusterRepository prunes older cluster runs for the repo after a successful rebuild', async () => {
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

test('tui snapshot returns mixed issue and pull request counts with default recent sort and filters', () => {
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
    assert.equal(snapshot.stats.staleEmbedSourceCount, 10);
    assert.equal(snapshot.stats.latestClusterRunId, 1);
    assert.equal(snapshot.clusters.length, 0);

    const allSnapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.deepEqual(
      allSnapshot.clusters.map((cluster) => cluster.clusterId),
      [101, 100],
    );
    assert.equal(allSnapshot.clusters[0].issueCount, 2);
    assert.equal(allSnapshot.clusters[0].pullRequestCount, 1);
    assert.equal(allSnapshot.clusters[0].displayTitle, 'Recent issue cluster');

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
    assert.equal(threadDetail.neighbors[0]?.number, 43);
  } finally {
    service.close();
  }
});

test('getTuiThreadDetail prefers stored cluster neighbors over exact embedding search', () => {
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
      checkAuth: async () => undefined,
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
    },
    {
      checkAuth: async () => undefined,
      summarizeThread: async () => {
        throw new Error('not expected');
      },
      embedTexts: async ({ texts }) => texts.map(() => [1, 0]),
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
    assert.equal(result.embed?.embedded, 2);
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

test('agent cluster summary and detail dumps expose repo stats, snippets, and summaries', () => {
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
    assert.equal(summaries.clusters[0]?.displayTitle, 'Downloader hangs');

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

    const summaries = service.listClusterSummaries({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(summaries.clusters.length, 0);

    const summariesWithClosed = service.listClusterSummaries({
      owner: 'openclaw',
      repo: 'openclaw',
      minSize: 0,
      includeClosed: true,
    });
    assert.equal(summariesWithClosed.clusters.length, 1);
    assert.equal(summariesWithClosed.clusters[0]?.isClosed, true);
    assert.equal(summariesWithClosed.clusters[0]?.closeReasonLocal, 'all_members_closed');

    const snapshot = service.getTuiSnapshot({ owner: 'openclaw', repo: 'openclaw', minSize: 0 });
    assert.equal(snapshot.clusters.length, 1);
    assert.equal(snapshot.clusters[0]?.isClosed, true);
  } finally {
    service.close();
  }
});

test('manual cluster closure is hidden from JSON summaries by default but remains visible in the tui snapshot', () => {
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

    assert.equal(service.listClusterSummaries({ owner: 'openclaw', repo: 'openclaw', minSize: 0 }).clusters.length, 0);
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
    checkAuth: async () => undefined,
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
    checkAuth: async () => undefined,
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
    getPull: async (_owner, _repo, number) => {
      getPullCalls += 1;
      if (getPullCalls === 1) {
        return {
          id: 101,
          number,
          state: 'open',
          title: 'Fix downloader hang',
          body: 'Implements a fix.',
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
          labels: [{ name: 'bug' }],
          assignees: [],
          user: { login: 'bob', type: 'User' },
          draft: false,
          updated_at: '2026-03-09T00:00:00Z',
        };
      }
      throw Object.assign(new Error('GitHub request failed for GET /repos/openclaw/openclaw/pulls/43: Not Found'), {
        status: 404,
      });
    },
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
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
    assert.equal(getPullCalls, 2);
    assert.match(messages.join('\n'), /missing on GitHub; marking it closed locally and continuing/);
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

test('syncRepository leaves unseen stale open items alone by default when closed overlap does not match them', async () => {
  let getIssueCalls = 0;

  const service = makeTestService({
    checkAuth: async () => undefined,
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
    checkAuth: async () => undefined,
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
    checkAuth: async () => undefined,
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
    checkAuth: async () => undefined,
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
    checkAuth: async () => undefined,
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
    checkAuth: async () => undefined,
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

function seedRepoUserExplorerFixture(service: GHCrawlService): void {
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
      labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh,
      closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, files_changed, additions, deletions, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  insertThread.run(10, 1, '100', 10, 'issue', 'open', 'New account question', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/10', '[]', '[]', '{}', 'hash-10', 0, '2026-03-01T00:00:00Z', now, null, null, now, now, null, null, null, now);
  insertThread.run(11, 1, '101', 11, 'issue', 'open', 'Another new account issue', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/11', '[]', '[]', '{}', 'hash-11', 0, '2026-03-02T00:00:00Z', now, null, null, now, now, null, null, null, now);
  insertThread.run(12, 1, '102', 12, 'issue', 'open', 'Third new account issue', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/issues/12', '[]', '[]', '{}', 'hash-12', 0, '2026-03-03T00:00:00Z', now, null, null, now, now, null, null, null, now);
  insertThread.run(13, 1, '103', 13, 'pull_request', 'open', 'Bob tries a fix', 'body', 'bob', 'User', 'https://github.com/openclaw/openclaw/pull/13', '[]', '[]', '{}', 'hash-13', 0, '2026-03-04T00:00:00Z', now, null, null, now, now, 3, 30, 5, now);
  insertThread.run(20, 1, '200', 20, 'issue', 'open', 'Carol issue', 'body', 'carol', 'User', 'https://github.com/openclaw/openclaw/issues/20', '[]', '[]', '{}', 'hash-20', 0, '2026-02-15T00:00:00Z', now, null, null, now, now, null, null, null, now);
  insertThread.run(21, 1, '201', 21, 'pull_request', 'open', 'Carol first PR', 'body', 'carol', 'User', 'https://github.com/openclaw/openclaw/pull/21', '[]', '[]', '{}', 'hash-21', 0, '2026-02-01T00:00:00Z', now, null, null, now, now, 5, 80, 10, now);
  insertThread.run(22, 1, '202', 22, 'pull_request', 'open', 'Carol second PR', 'body', 'carol', 'User', 'https://github.com/openclaw/openclaw/pull/22', '[]', '[]', '{}', 'hash-22', 0, '2026-02-10T00:00:00Z', now, null, null, now, now, 2, 20, 4, now);
  insertThread.run(30, 1, '300', 30, 'pull_request', 'open', 'Alice polished fix', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/pull/30', '[]', '[]', '{}', 'hash-30', 0, '2026-01-10T00:00:00Z', now, null, null, now, now, 4, 120, 30, now);
  insertThread.run(31, 1, '301', 31, 'pull_request', 'open', 'Alice follow-up', 'body', 'alice', 'User', 'https://github.com/openclaw/openclaw/pull/31', '[]', '[]', '{}', 'hash-31', 0, '2026-01-05T00:00:00Z', now, null, null, now, now, 7, 200, 40, now);

  const insertUser = service.db.prepare(
    `insert into users (
      login, github_user_id, account_created_at, public_repo_count, public_gist_count, followers, following,
      profile_url, avatar_url, user_type, recent_public_event_count, likely_hidden_activity, reputation_tier,
      reputation_reason_json, last_global_refresh_at, last_refresh_error, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run('bob', '1000', '2026-02-01T00:00:00Z', 1, 0, 1, 0, 'https://github.com/bob', 'https://avatars.githubusercontent.com/u/1000?v=4', 'User', 1, 0, 'low', '["new account"]', now, null, now);
  insertUser.run('carol', '2000', '2024-01-01T00:00:00Z', 1, 0, 1, 0, 'https://github.com/carol', 'https://avatars.githubusercontent.com/u/2000?v=4', 'User', 0, 1, 'medium', '["likely hidden or sparse public activity relative to repo participation"]', now, null, now);
  insertUser.run('alice', '3000', '2020-01-01T00:00:00Z', 24, 2, 12, 4, 'https://github.com/alice', 'https://avatars.githubusercontent.com/u/3000?v=4', 'User', 5, 0, 'high', '["established public contribution history"]', now, null, now);

  const insertRepoUserState = service.db.prepare(
    `insert into repo_user_state (repo_id, user_login, last_repo_refresh_at, first_seen_at, last_seen_at, last_refresh_error, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );
  insertRepoUserState.run(1, 'bob', now, '2026-03-01T00:00:00Z', now, null, now);
  insertRepoUserState.run(1, 'carol', now, '2026-02-01T00:00:00Z', now, null, now);
  insertRepoUserState.run(1, 'alice', now, '2026-01-01T00:00:00Z', now, null, now);
}

test('syncRepository stores pull request sizing metadata and repo user state for user explorer', async () => {
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
      files_changed: 6,
      additions: 140,
      deletions: 22,
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-09T00:00:00Z',
    }),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
  });

  try {
    await service.syncRepository({ owner: 'openclaw', repo: 'openclaw' });

    const threadRow = service.db
      .prepare('select files_changed, additions, deletions from threads where number = 43 limit 1')
      .get() as { files_changed: number | null; additions: number | null; deletions: number | null };
    assert.deepEqual(threadRow, { files_changed: 6, additions: 140, deletions: 22 });

    const repoState = service.db
      .prepare('select first_seen_at, last_seen_at from repo_user_state where repo_id = 1 and user_login = ? limit 1')
      .get('alice') as { first_seen_at: string | null; last_seen_at: string | null };
    assert.ok(repoState.first_seen_at);
    assert.ok(repoState.last_seen_at);
  } finally {
    service.close();
  }
});

test('listRepoUsers returns flagged and trusted contributor views with totals and ordering', () => {
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
    seedRepoUserExplorerFixture(service);

    const flagged = service.listRepoUsers({ owner: 'openclaw', repo: 'openclaw', mode: 'flagged' });
    assert.deepEqual(flagged.users.map((user) => user.login), ['bob', 'carol']);
    assert.equal(flagged.totals.matchingUserCount, 2);
    assert.equal(flagged.totals.openIssueCount, 4);
    assert.equal(flagged.totals.openPullRequestCount, 3);
    assert.equal(flagged.users[0]?.matchedLowReputation, true);
    assert.equal(flagged.users[1]?.matchedLikelyHiddenActivity, true);

    const trusted = service.listRepoUsers({ owner: 'openclaw', repo: 'openclaw', mode: 'trusted_prs' });
    assert.deepEqual(trusted.users.map((user) => user.login), ['alice']);
    assert.equal(trusted.totals.matchingUserCount, 1);
    assert.equal(trusted.totals.waitingPullRequestCount, 2);
    assert.equal(trusted.users[0]?.reputationTier, 'high');
  } finally {
    service.close();
  }
});

test('getRepoUserDetail returns repo-local issues, PRs, and sizing metrics', () => {
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
    seedRepoUserExplorerFixture(service);

    const detail = service.getRepoUserDetail({ owner: 'openclaw', repo: 'openclaw', login: 'alice' });
    assert.equal(detail.profile.login, 'alice');
    assert.equal(detail.profile.reputationTier, 'high');
    assert.equal(detail.pullRequests.length, 2);
    assert.equal(detail.pullRequests[0]?.number, 31);
    assert.equal(detail.pullRequests[0]?.filesChanged, 7);
    assert.equal(detail.pullRequests[0]?.additions, 200);
    assert.equal(detail.pullRequests[1]?.number, 30);
    assert.equal(detail.issues.length, 0);
  } finally {
    service.close();
  }
});

test('refreshRepoUser reuses fresh cache and refreshes stale user data on demand', async () => {
  let getUserCalls = 0;
  let listUserPublicEventsCalls = 0;
  const service = makeTestService({
    checkAuth: async () => undefined,
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
    getUser: async (login) => {
      getUserCalls += 1;
      return {
        id: 3000,
        login,
        created_at: '2020-01-01T00:00:00Z',
        public_repos: 24,
        public_gists: 2,
        followers: 12,
        following: 4,
        html_url: `https://github.com/${login}`,
        avatar_url: `https://avatars.githubusercontent.com/${login}`,
        type: 'User',
      };
    },
    listUserPublicEvents: async () => {
      listUserPublicEventsCalls += 1;
      return [{ id: 'evt-1' }, { id: 'evt-2' }];
    },
  });

  try {
    seedRepoUserExplorerFixture(service);

    const fresh = await service.refreshRepoUser({ owner: 'openclaw', repo: 'openclaw', login: 'alice' });
    assert.equal(fresh.profile.reputationTier, 'high');
    assert.equal(getUserCalls, 0);
    assert.equal(listUserPublicEventsCalls, 0);

    service.db
      .prepare('update users set last_global_refresh_at = ?, last_refresh_error = null where login = ?')
      .run('2020-01-01T00:00:00Z', 'alice');

    const refreshed = await service.refreshRepoUser({ owner: 'openclaw', repo: 'openclaw', login: 'alice' });
    assert.equal(refreshed.profile.reputationTier, 'high');
    assert.equal(getUserCalls, 1);
    assert.equal(listUserPublicEventsCalls, 1);

    const updatedUser = service.db
      .prepare('select recent_public_event_count, reputation_tier, last_refresh_error from users where login = ? limit 1')
      .get('alice') as {
        recent_public_event_count: number | null;
        reputation_tier: string | null;
        last_refresh_error: string | null;
      };
    assert.equal(updatedUser.recent_public_event_count, 2);
    assert.equal(updatedUser.reputation_tier, 'high');
    assert.equal(updatedUser.last_refresh_error, null);
  } finally {
    service.close();
  }
});
