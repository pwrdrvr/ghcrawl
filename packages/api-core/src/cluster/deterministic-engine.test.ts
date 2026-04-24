import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeterministicClusterGraph } from './deterministic-engine.js';

test('buildDeterministicClusterGraph clusters without embeddings or LLM summaries', () => {
  const result = buildDeterministicClusterGraph([
    {
      id: 10,
      number: 10,
      kind: 'issue',
      title: 'Download retry hangs forever',
      body: 'The transfer retry loop never exits after timeout.',
      labels: ['bug'],
    },
    {
      id: 11,
      number: 11,
      kind: 'issue',
      title: 'Download retry loop never exits',
      body: 'Retry hangs forever after timeout.',
      labels: ['bug'],
    },
    {
      id: 12,
      number: 12,
      kind: 'issue',
      title: 'Improve documentation typography',
      body: 'Docs heading sizes look inconsistent.',
      labels: ['docs'],
    },
  ]);

  const duplicateCluster = result.clusters.find((cluster) => cluster.members.includes(10));

  assert.ok(result.edges.length >= 1);
  assert.ok(duplicateCluster);
  assert.deepEqual(new Set(duplicateCluster?.members), new Set([10, 11]));
});

test('buildDeterministicClusterGraph infers hard refs from text', () => {
  const result = buildDeterministicClusterGraph([
    {
      id: 10,
      number: 10,
      kind: 'pull_request',
      title: 'Fixes #99',
      body: 'Patch retry loop.',
      labels: [],
      changedFiles: ['packages/api-core/src/retry.ts'],
    },
    {
      id: 11,
      number: 11,
      kind: 'issue',
      title: 'Retry loop broken',
      body: 'See pull/99 and timeout notes.',
      labels: [],
      changedFiles: ['packages/api-core/src/retry.ts'],
    },
  ]);

  assert.equal(result.edges[0]?.tier, 'strong');
});
