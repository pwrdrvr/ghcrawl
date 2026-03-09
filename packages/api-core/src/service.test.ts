import test from 'node:test';
import assert from 'node:assert/strict';

import { GitcrawlService } from './service.js';

test('syncRepository reports progress and persists repository/thread data', async () => {
  const messages: string[] = [];
  const service = new GitcrawlService({
    config: {
      workspaceRoot: process.cwd(),
      dbPath: ':memory:',
      apiPort: 5179,
      summaryModel: 'gpt-4.1-mini',
      embedModel: 'text-embedding-3-small',
      openSearchIndex: 'gitcrawl-threads',
      githubToken: 'test-token',
    },
    github: {
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
        },
      ],
      getPull: async () => {
        throw new Error('not expected');
      },
      listIssueComments: async () => [
        {
          id: 200,
          body: 'same here',
          created_at: '2026-03-09T00:00:00Z',
          updated_at: '2026-03-09T00:00:00Z',
          user: { login: 'bob', type: 'User' },
        },
      ],
      listPullReviews: async () => [],
      listPullReviewComments: async () => [],
    },
  });

  try {
    const result = await service.syncRepository({
      owner: 'openclaw',
      repo: 'openclaw',
      limit: 1,
      onProgress: (message) => messages.push(message),
    });

    assert.equal(result.threadsSynced, 1);
    assert.match(messages.join('\n'), /discovered 1 threads/);
    assert.match(messages.join('\n'), /1\/1 issue #42/);
    assert.equal(service.listRepositories().repositories.length, 1);
    assert.equal(service.listThreads({ owner: 'openclaw', repo: 'openclaw' }).threads.length, 1);
  } finally {
    service.close();
  }
});
