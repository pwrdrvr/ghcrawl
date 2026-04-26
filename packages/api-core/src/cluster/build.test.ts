import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClusters, buildSizeBoundedClusters } from './build.js';

test('buildClusters groups connected components', () => {
  const clusters = buildClusters(
    [
      { threadId: 1, number: 10, title: 'a' },
      { threadId: 2, number: 11, title: 'b' },
      { threadId: 3, number: 12, title: 'c' },
    ],
    [{ leftThreadId: 1, rightThreadId: 2, score: 0.9 }],
  );

  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0]?.members, [1, 2]);
});

test('buildSizeBoundedClusters prevents weak chains from forming catch-all clusters', () => {
  const nodes = Array.from({ length: 6 }, (_, index) => ({
    threadId: index + 1,
    number: index + 10,
    title: `thread ${index + 1}`,
  }));
  const clusters = buildSizeBoundedClusters(
    nodes,
    [
      { leftThreadId: 1, rightThreadId: 2, score: 0.95 },
      { leftThreadId: 2, rightThreadId: 3, score: 0.94 },
      { leftThreadId: 3, rightThreadId: 4, score: 0.82 },
      { leftThreadId: 4, rightThreadId: 5, score: 0.81 },
      { leftThreadId: 5, rightThreadId: 6, score: 0.8 },
    ],
    { maxClusterSize: 3 },
  );

  assert.deepEqual(
    clusters.map((cluster) => cluster.members),
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  );
});
