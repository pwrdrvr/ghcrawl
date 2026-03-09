import test from 'node:test';
import assert from 'node:assert/strict';

import { GitcrawlService } from './service.js';

function makeTestService(github: GitcrawlService['github']): GitcrawlService {
  return new GitcrawlService({
    config: {
      workspaceRoot: process.cwd(),
      dbPath: ':memory:',
      apiPort: 5179,
      summaryModel: 'gpt-4.1-mini',
      embedModel: 'text-embedding-3-small',
      openSearchIndex: 'gitcrawl-threads',
      githubToken: 'test-token',
    },
    github,
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
