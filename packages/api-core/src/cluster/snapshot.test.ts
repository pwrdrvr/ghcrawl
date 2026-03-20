import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeClusterSnapshots, type ClusterSnapshot } from './snapshot.js';

test('first run with no previous snapshots produces all new outcomes', () => {
  const current: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20, 30]) },
    { clusterId: 2, representativeThreadId: 40, members: new Set([40, 50]) },
  ];
  const result = mergeClusterSnapshots([], current);

  assert.equal(result.stats.newClusters, 2);
  assert.equal(result.stats.updated, 0);
  assert.equal(result.stats.dissolved, 0);
  assert.equal(result.outcomes.length, 2);
  assert.ok(result.outcomes.every((o) => o.type === 'new'));
});

test('identical clusters match as updated with jaccard 1.0', () => {
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20, 30]) },
  ];
  const current: ClusterSnapshot[] = [
    { clusterId: 100, representativeThreadId: 10, members: new Set([10, 20, 30]) },
  ];
  const result = mergeClusterSnapshots(previous, current);

  assert.equal(result.stats.updated, 1);
  assert.equal(result.stats.newClusters, 0);
  assert.equal(result.stats.dissolved, 0);
  const updated = result.outcomes.find((o) => o.type === 'updated');
  assert.ok(updated);
  assert.equal(updated.type === 'updated' && updated.jaccard, 1.0);
});

test('overlapping clusters above threshold match as updated', () => {
  // 3 shared out of 4 union = jaccard 0.75
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20, 30]) },
  ];
  const current: ClusterSnapshot[] = [
    { clusterId: 100, representativeThreadId: 10, members: new Set([10, 20, 30, 40]) },
  ];
  const result = mergeClusterSnapshots(previous, current);

  assert.equal(result.stats.updated, 1);
  const updated = result.outcomes.find((o) => o.type === 'updated');
  assert.ok(updated && updated.type === 'updated');
  assert.ok(updated.jaccard > 0.7 && updated.jaccard < 0.8);
});

test('non-overlapping clusters produce new and dissolved', () => {
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20]) },
  ];
  const current: ClusterSnapshot[] = [
    { clusterId: 100, representativeThreadId: 30, members: new Set([30, 40]) },
  ];
  const result = mergeClusterSnapshots(previous, current);

  assert.equal(result.stats.updated, 0);
  assert.equal(result.stats.newClusters, 1);
  assert.equal(result.stats.dissolved, 1);
});

test('mixed scenario: some updated, some new, some dissolved', () => {
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20, 30]) },
    { clusterId: 2, representativeThreadId: 40, members: new Set([40, 50]) },
    { clusterId: 3, representativeThreadId: 60, members: new Set([60, 70]) },
  ];
  const current: ClusterSnapshot[] = [
    // Matches previous cluster 1 (jaccard = 3/4 = 0.75)
    { clusterId: 100, representativeThreadId: 10, members: new Set([10, 20, 30, 80]) },
    // Brand new cluster
    { clusterId: 101, representativeThreadId: 90, members: new Set([90, 91]) },
    // Matches previous cluster 2 exactly
    { clusterId: 102, representativeThreadId: 40, members: new Set([40, 50]) },
  ];
  const result = mergeClusterSnapshots(previous, current);

  assert.equal(result.stats.updated, 2);
  assert.equal(result.stats.newClusters, 1);
  assert.equal(result.stats.dissolved, 1); // previous cluster 3 dissolved
});

test('below-threshold overlap treated as new + dissolved', () => {
  // 1 shared out of 5 union = jaccard 0.2 (below 0.5 threshold)
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20, 30]) },
  ];
  const current: ClusterSnapshot[] = [
    { clusterId: 100, representativeThreadId: 10, members: new Set([10, 40, 50]) },
  ];
  const result = mergeClusterSnapshots(previous, current, 0.5);

  // jaccard = 1/5 = 0.2, below threshold
  assert.equal(result.stats.updated, 0);
  assert.equal(result.stats.newClusters, 1);
  assert.equal(result.stats.dissolved, 1);
});

test('custom threshold affects matching', () => {
  // 2 shared out of 3 union = jaccard 0.667
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20]) },
  ];
  const current: ClusterSnapshot[] = [
    { clusterId: 100, representativeThreadId: 10, members: new Set([10, 20, 30]) },
  ];

  // With threshold 0.5 -> matched
  const low = mergeClusterSnapshots(previous, current, 0.5);
  assert.equal(low.stats.updated, 1);

  // With threshold 0.8 -> not matched
  const high = mergeClusterSnapshots(previous, current, 0.8);
  assert.equal(high.stats.updated, 0);
  assert.equal(high.stats.newClusters, 1);
  assert.equal(high.stats.dissolved, 1);
});

test('greedy matching picks highest jaccard first', () => {
  const previous: ClusterSnapshot[] = [
    { clusterId: 1, representativeThreadId: 10, members: new Set([10, 20, 30, 40, 50]) },
  ];
  const current: ClusterSnapshot[] = [
    // Low overlap: jaccard = 2/8 = 0.25
    { clusterId: 100, representativeThreadId: 60, members: new Set([10, 20, 60, 70, 80]) },
    // High overlap: jaccard = 4/6 = 0.667
    { clusterId: 101, representativeThreadId: 10, members: new Set([10, 20, 30, 40, 90]) },
  ];
  const result = mergeClusterSnapshots(previous, current);

  const updated = result.outcomes.find((o) => o.type === 'updated');
  assert.ok(updated && updated.type === 'updated');
  assert.equal(updated.currentSnapshotClusterId, 101); // high overlap wins
  assert.equal(updated.previousSnapshotClusterId, 1);
});
