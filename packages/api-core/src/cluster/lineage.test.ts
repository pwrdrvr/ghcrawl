import assert from 'node:assert/strict';
import test from 'node:test';

import { computeClusterTransitions, type ClusterSnapshot } from './lineage.js';

function snapshot(clusterId: number, members: number[]): ClusterSnapshot {
  return { clusterId, members: new Set(members) };
}

test('identical clusters are continuing with jaccard 1.0', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2]), snapshot(2, [3, 4])], [snapshot(10, [1, 2]), snapshot(20, [3, 4])]);
  assert.equal(transitions.length, 2);
  for (const transition of transitions) {
    assert.equal(transition.transition, 'continuing');
    assert.equal(transition.jaccardScore, 1);
  }
});

test('cluster gains members is growing', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2])], [snapshot(10, [1, 2, 3])]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.transition, 'growing');
  assert.equal(transitions[0]?.membersAdded, 1);
  assert.equal(transitions[0]?.membersRemoved, 0);
});

test('cluster loses members is shrinking', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2, 3])], [snapshot(10, [1, 2])]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.transition, 'shrinking');
  assert.equal(transitions[0]?.membersAdded, 0);
  assert.equal(transitions[0]?.membersRemoved, 1);
});

test('one cluster splitting into two', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2, 3, 4, 5])], [snapshot(10, [1, 2]), snapshot(20, [3, 4])]);
  assert.equal(transitions.length, 3);
  const split = transitions.find((transition) => transition.transition === 'splitting');
  assert.ok(split);
  assert.equal(split.fromClusterId, 1);
  assert.equal(split.toClusterId, null);
});

test('two clusters merging into one', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2]), snapshot(2, [3, 4])], [snapshot(10, [1, 2, 3, 4, 5, 6])]);
  assert.equal(transitions.length, 3);
  const merge = transitions.find((transition) => transition.transition === 'merging');
  assert.ok(merge);
  assert.equal(merge.fromClusterId, null);
  assert.equal(merge.toClusterId, 10);
});

test('brand new cluster is forming', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2])], [snapshot(10, [1, 2]), snapshot(20, [3, 4])]);
  const forming = transitions.find((transition) => transition.transition === 'forming');
  assert.ok(forming);
  assert.equal(forming.toClusterId, 20);
});

test('cluster disappearing is dissolving', () => {
  const transitions = computeClusterTransitions([snapshot(1, [1, 2])], []);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.transition, 'dissolving');
  assert.equal(transitions[0]?.fromClusterId, 1);
});

test('mixed scenario includes all seven transition types', () => {
  const oldClusters = [
    snapshot(1, [1, 2]),
    snapshot(2, [3, 4]),
    snapshot(3, [6, 7, 8]),
    snapshot(4, [9, 10, 11, 12, 13]),
    snapshot(5, [14, 15]),
    snapshot(6, [16, 17]),
    snapshot(7, [18, 19]),
  ];
  const newClusters = [
    snapshot(101, [1, 2]),
    snapshot(102, [3, 4, 5]),
    snapshot(103, [6, 7]),
    snapshot(104, [9, 10]),
    snapshot(105, [11, 12]),
    snapshot(106, [16, 17, 18, 19, 20, 21]),
    snapshot(107, [22, 23]),
  ];

  const transitions = computeClusterTransitions(oldClusters, newClusters);
  const types = new Set(transitions.map((transition) => transition.transition));
  assert.deepEqual(types, new Set(['continuing', 'growing', 'shrinking', 'splitting', 'merging', 'forming', 'dissolving']));
});

test('first run with empty old clusters is all forming', () => {
  const transitions = computeClusterTransitions([], [snapshot(1, [1, 2]), snapshot(2, [3])]);
  assert.equal(transitions.length, 2);
  assert.ok(transitions.every((transition) => transition.transition === 'forming'));
});
