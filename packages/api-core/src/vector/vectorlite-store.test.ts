import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { VectorliteStore } from './vectorlite-store.js';

function makeStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-vector-store-test-'));
  return path.join(dir, 'repo.sqlite');
}

test('vectorlite store persists vectors across reopen', () => {
  const storePath = makeStorePath();
  const vector = [1, 0, 0, 0];
  const neighbor = [0.9, 0.1, 0, 0];
  const far = [0, 1, 0, 0];

  const first = new VectorliteStore();
  try {
    const health = first.checkRuntime();
    assert.equal(health.ok, true);
    first.upsertVector({ storePath, dimensions: 4, threadId: 1, vector });
    first.upsertVector({ storePath, dimensions: 4, threadId: 2, vector: neighbor });
    first.upsertVector({ storePath, dimensions: 4, threadId: 3, vector: far });
  } finally {
    first.close();
  }

  const reopened = new VectorliteStore();
  try {
    const results = reopened.queryNearest({
      storePath,
      dimensions: 4,
      vector,
      limit: 2,
      excludeThreadId: 1,
      candidateK: 3,
    });
    assert.deepEqual(results.map((row) => row.threadId), [2, 3]);
    assert.ok(results[0]!.score > results[1]!.score);
  } finally {
    reopened.close();
  }
});

test('vectorlite store update and delete affect later queries', () => {
  const storePath = makeStorePath();
  const store = new VectorliteStore();
  try {
    store.upsertVector({ storePath, dimensions: 3, threadId: 1, vector: [1, 0, 0] });
    store.upsertVector({ storePath, dimensions: 3, threadId: 2, vector: [0.8, 0.2, 0] });
    let results = store.queryNearest({
      storePath,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 1,
      excludeThreadId: 1,
      candidateK: 2,
    });
    assert.deepEqual(results.map((row) => row.threadId), [2]);

    store.upsertVector({ storePath, dimensions: 3, threadId: 2, vector: [0, 1, 0] });
    results = store.queryNearest({
      storePath,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 1,
      excludeThreadId: 1,
      candidateK: 2,
    });
    assert.ok(results[0]!.score < 0.5);

    store.deleteVector({ storePath, dimensions: 3, threadId: 2 });
    results = store.queryNearest({
      storePath,
      dimensions: 3,
      vector: [1, 0, 0],
      limit: 1,
      excludeThreadId: 1,
      candidateK: 2,
    });
    assert.deepEqual(results, []);
  } finally {
    store.close();
  }
});
