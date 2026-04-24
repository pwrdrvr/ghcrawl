import test from 'node:test';
import assert from 'node:assert/strict';

import { applyClusterGovernance, type ClusterMembership, type DurableCluster } from './governance.js';

test('applyClusterGovernance creates a stable cluster for new evidence', () => {
  const result = applyClusterGovernance({
    repoId: 1,
    existingClusters: [],
    existingMemberships: [],
    overrides: [],
    proposals: [
      {
        representativeThreadId: 10,
        memberThreadIds: [10, 11],
        scoresToRepresentative: new Map([[10, 1], [11, 0.82]]),
      },
    ],
  });

  assert.equal(result.clusters.length, 1);
  assert.match(result.clusters[0].stableSlug, /^[a-z]+-[a-z]+-[a-z]+-[a-z0-9]{4}$/);
  assert.deepEqual(result.clusters[0].memberThreadIds, [10, 11]);
  assert.equal(result.events[0].eventType, 'create_cluster');
});

test('applyClusterGovernance reuses existing cluster identity across syncs', () => {
  const existingCluster: DurableCluster = {
    id: 'focus-bridge-signal-9m',
    repoId: 1,
    stableKey: 'hash',
    stableSlug: 'focus-bridge-signal-9m',
    representativeThreadId: 10,
    memberThreadIds: [10, 11],
  };
  const existingMemberships: ClusterMembership[] = [
    {
      clusterId: existingCluster.id,
      threadId: 10,
      role: 'canonical',
      state: 'active',
      scoreToRepresentative: 1,
      addedBy: 'algo',
      removedBy: null,
    },
    {
      clusterId: existingCluster.id,
      threadId: 11,
      role: 'related',
      state: 'active',
      scoreToRepresentative: 0.82,
      addedBy: 'algo',
      removedBy: null,
    },
  ];

  const result = applyClusterGovernance({
    repoId: 1,
    existingClusters: [existingCluster],
    existingMemberships,
    overrides: [],
    proposals: [
      {
        representativeThreadId: 10,
        memberThreadIds: [10, 11, 12],
        scoresToRepresentative: new Map([[10, 1], [11, 0.85], [12, 0.8]]),
      },
    ],
  });

  assert.equal(result.clusters[0].id, existingCluster.id);
  assert.deepEqual(result.clusters[0].memberThreadIds, [10, 11, 12]);
});

test('applyClusterGovernance blocks automatic re-add after maintainer exclusion', () => {
  const existingCluster: DurableCluster = {
    id: 'focus-bridge-signal-9m',
    repoId: 1,
    stableKey: 'hash',
    stableSlug: 'focus-bridge-signal-9m',
    representativeThreadId: 10,
    memberThreadIds: [10],
  };

  const result = applyClusterGovernance({
    repoId: 1,
    existingClusters: [existingCluster],
    existingMemberships: [
      {
        clusterId: existingCluster.id,
        threadId: 10,
        role: 'canonical',
        state: 'active',
        scoreToRepresentative: 1,
        addedBy: 'algo',
        removedBy: null,
      },
      {
        clusterId: existingCluster.id,
        threadId: 11,
        role: 'related',
        state: 'removed_by_user',
        scoreToRepresentative: 0.82,
        addedBy: 'algo',
        removedBy: 'user',
      },
    ],
    overrides: [
      {
        clusterId: existingCluster.id,
        threadId: 11,
        action: 'exclude',
      },
    ],
    proposals: [
      {
        representativeThreadId: 10,
        memberThreadIds: [10, 11],
        scoresToRepresentative: new Map([[10, 1], [11, 0.95]]),
      },
    ],
  });

  const membership = result.memberships.find((item) => item.threadId === 11);
  assert.equal(membership?.state, 'blocked_by_override');
  assert.equal(membership?.removedBy, 'user');
  assert.deepEqual(result.clusters[0].memberThreadIds, [10]);
});
