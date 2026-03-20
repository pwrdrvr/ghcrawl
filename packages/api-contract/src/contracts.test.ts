import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actionRequestSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  prTemplateMatchesResponseSchema,
  searchResponseSchema,
} from './contracts.js';

test('health schema accepts configured status payload', () => {
  const parsed = healthResponseSchema.parse({
    ok: true,
    configPath: '/Users/example/.config/ghcrawl/config.json',
    configFileExists: true,
    dbPath: 'data/ghcrawl.db',
    apiPort: 5179,
    githubConfigured: true,
    openaiConfigured: false,
  });

  assert.equal(parsed.apiPort, 5179);
});

test('search schema rejects invalid mode', () => {
  assert.throws(() =>
    searchResponseSchema.parse({
      repository: {
        id: 1,
        owner: 'openclaw',
        name: 'openclaw',
        fullName: 'openclaw/openclaw',
        githubRepoId: null,
        updatedAt: new Date().toISOString(),
      },
      query: 'panic',
      mode: 'invalid',
      hits: [],
    }),
  );
});

test('action request accepts optional thread number', () => {
  const parsed = actionRequestSchema.parse({
    owner: 'openclaw',
    repo: 'openclaw',
    action: 'summarize',
    threadNumber: 42,
  });

  assert.equal(parsed.threadNumber, 42);
});

test('neighbors schema accepts repository, source thread, and neighbor list', () => {
  const parsed = neighborsResponseSchema.parse({
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: new Date().toISOString(),
    },
    thread: {
      id: 10,
      repoId: 1,
      number: 42,
      kind: 'issue',
      state: 'open',
      isClosed: false,
      closedAtGh: null,
      closedAtLocal: null,
      closeReasonLocal: null,
      title: 'Downloader hangs',
      body: 'The transfer never finishes.',
      authorLogin: 'alice',
      htmlUrl: 'https://github.com/openclaw/openclaw/issues/42',
      labels: ['bug'],
      updatedAtGh: new Date().toISOString(),
      clusterId: null,
    },
    neighbors: [
      {
        threadId: 11,
        number: 43,
        kind: 'pull_request',
        title: 'Fix downloader hang',
        score: 0.93,
      },
    ],
  });

  assert.equal(parsed.neighbors[0].number, 43);
});

test('pr template matches schema accepts heuristic match payload', () => {
  const parsed = prTemplateMatchesResponseSchema.parse({
    repository: {
      id: 1,
      owner: 'openclaw',
      name: 'openclaw',
      fullName: 'openclaw/openclaw',
      githubRepoId: null,
      updatedAt: new Date().toISOString(),
    },
    template: {
      source: {
        mode: 'github',
        label: '.github/pull_request_template.md',
      },
      length: 128,
    },
    filters: {
      exact: true,
      maxDistance: 200,
      includeClosed: false,
    },
    matches: [
      {
        thread: {
          id: 11,
          repoId: 1,
          number: 43,
          kind: 'pull_request',
          state: 'open',
          isClosed: false,
          closedAtGh: null,
          closedAtLocal: null,
          closeReasonLocal: null,
          title: 'Fix downloader hang',
          body: 'Checklist here',
          authorLogin: 'alice',
          htmlUrl: 'https://github.com/openclaw/openclaw/pull/43',
          labels: ['bug'],
          updatedAtGh: new Date().toISOString(),
          clusterId: null,
        },
        exactMatch: true,
        exactMatchOffset: 12,
        templateSectionFound: true,
        templateSectionExactMatch: false,
        templateSectionStartOffset: 12,
        templateSectionEndOffset: 140,
        levenshteinDistance: 42,
        fullBodyLevenshteinDistance: 55,
        bodyLength: 150,
      },
    ],
  });

  assert.equal(parsed.matches[0].exactMatch, true);
  assert.equal(parsed.matches[0].levenshteinDistance, 42);
});
