import test from 'node:test';
import assert from 'node:assert/strict';

import { Octokit } from 'octokit';

import { makeGitHubClient } from './client.js';

test('makeGitHubClient exposes getUser through the Octokit users API', async () => {
  const originalPlugin = Octokit.plugin;
  const calls: Array<{ owner?: string; repo?: string; login?: string }> = [];

  class FakeOctokit {
    rest = {
      users: {
        getByUsername: async ({ username }: { username: string }) => {
          calls.push({ login: username });
          return {
            data: {
              id: 42,
              login: username,
              html_url: `https://github.com/${username}`,
            },
          };
        },
      },
    };
  }

  Object.defineProperty(Octokit, 'plugin', {
    configurable: true,
    value: () => FakeOctokit,
  });

  try {
    const client = makeGitHubClient({ token: 'ghp_testtoken1234567890' });
    const payload = await client.getUser?.('alice');

    assert.deepEqual(calls, [{ login: 'alice' }]);
    assert.deepEqual(payload, {
      id: 42,
      login: 'alice',
      html_url: 'https://github.com/alice',
    });
  } finally {
    Object.defineProperty(Octokit, 'plugin', {
      configurable: true,
      value: originalPlugin,
    });
  }
});

test('makeGitHubClient exposes listUserPublicEvents through Octokit pagination', async () => {
  const originalPlugin = Octokit.plugin;
  const calls: string[] = [];

  class FakeOctokit {
    rest = {
      activity: {
        listPublicEventsForUser: Symbol('listPublicEventsForUser'),
      },
    };

    paginate = {
      iterator: (_endpoint: unknown, params: { username: string; per_page: number }) =>
        (async function* iterator() {
          calls.push(params.username);
          yield { data: [{ id: 'evt-1' }, { id: 'evt-2' }] };
        })(),
    };
  }

  Object.defineProperty(Octokit, 'plugin', {
    configurable: true,
    value: () => FakeOctokit,
  });

  try {
    const client = makeGitHubClient({ token: 'ghp_testtoken1234567890', pageDelayMs: 0 });
    const payload = await client.listUserPublicEvents?.('alice');

    assert.deepEqual(calls, ['alice']);
    assert.deepEqual(payload, [{ id: 'evt-1' }, { id: 'evt-2' }]);
  } finally {
    Object.defineProperty(Octokit, 'plugin', {
      configurable: true,
      value: originalPlugin,
    });
  }
});
