import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { computeClusterTransitions, type ClusterSnapshot } from './lineage.js';

/**
 * Generate synthetic cluster data at a given scale.
 *
 * Creates `clusterCount` clusters each with `membersPerCluster` members.
 * The "new" run shares ~80% of members with the old run (simulating realistic
 * churn between consecutive clustering runs).
 */
function generateScenario(clusterCount: number, membersPerCluster: number): {
  oldClusters: ClusterSnapshot[];
  newClusters: ClusterSnapshot[];
  totalMembers: number;
} {
  const oldClusters: ClusterSnapshot[] = [];
  const newClusters: ClusterSnapshot[] = [];
  let nextMemberId = 1;

  for (let i = 0; i < clusterCount; i++) {
    const oldMembers = new Set<number>();
    const newMembers = new Set<number>();

    // 80% overlap: shared members
    const sharedCount = Math.floor(membersPerCluster * 0.8);
    for (let j = 0; j < sharedCount; j++) {
      const id = nextMemberId++;
      oldMembers.add(id);
      newMembers.add(id);
    }

    // 20% churn: old-only and new-only members
    const churnCount = membersPerCluster - sharedCount;
    for (let j = 0; j < churnCount; j++) {
      oldMembers.add(nextMemberId++);
    }
    for (let j = 0; j < churnCount; j++) {
      newMembers.add(nextMemberId++);
    }

    oldClusters.push({ clusterId: i + 1, members: oldMembers });
    newClusters.push({ clusterId: clusterCount + i + 1, members: newMembers });
  }

  return { oldClusters, newClusters, totalMembers: nextMemberId - 1 };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const SCALES = [
  { clusters: 100, membersPerCluster: 8, label: '100 clusters (800 members)' },
  { clusters: 500, membersPerCluster: 8, label: '500 clusters (4,000 members)' },
  { clusters: 1000, membersPerCluster: 10, label: '1,000 clusters (10,000 members)' },
  { clusters: 2000, membersPerCluster: 10, label: '2,000 clusters (20,000 members)' },
];

const WARMUP_RUNS = 2;
const BENCH_RUNS = 5;

test('lineage performance at multiple scales', () => {
  const results: Array<{ label: string; medianMs: number; transitionCount: number }> = [];

  for (const scale of SCALES) {
    const { oldClusters, newClusters, totalMembers } = generateScenario(
      scale.clusters,
      scale.membersPerCluster,
    );

    // Warmup
    for (let i = 0; i < WARMUP_RUNS; i++) {
      computeClusterTransitions(oldClusters, newClusters);
    }

    // Bench
    const durations: number[] = [];
    let lastResult: ReturnType<typeof computeClusterTransitions> | null = null;
    for (let i = 0; i < BENCH_RUNS; i++) {
      const start = performance.now();
      lastResult = computeClusterTransitions(oldClusters, newClusters);
      durations.push(performance.now() - start);
    }

    const med = median(durations);
    results.push({
      label: scale.label,
      medianMs: med,
      transitionCount: lastResult?.length ?? 0,
    });
  }

  // Print results table
  console.log('\n=== Lineage Performance Benchmark ===\n');
  console.log('Scale                              | Median     | Transitions');
  console.log('-----------------------------------|------------|------------');
  for (const r of results) {
    const label = r.label.padEnd(35);
    const ms = `${r.medianMs.toFixed(1)} ms`.padStart(10);
    console.log(`${label}| ${ms} | ${r.transitionCount}`);
  }
  console.log('');

  // ghcrawl/ghcrawl has ~17k issues. With typical cluster sizes of 8-15,
  // that's roughly 1,100-2,100 clusters. Assert sub-second at 2,000 clusters.
  const largest = results[results.length - 1];
  assert.ok(
    largest.medianMs < 1000,
    `Expected <1s at ${largest.label}, got ${largest.medianMs.toFixed(1)}ms`,
  );

  // Assert sub-100ms at 500 clusters (the stated comfortable range)
  const mid = results[1];
  assert.ok(
    mid.medianMs < 100,
    `Expected <100ms at ${mid.label}, got ${mid.medianMs.toFixed(1)}ms`,
  );
});
