import type { ClusterExperimentClusterSizeStats } from '../service-types.js';

export function summarizeClusterSizes(
  clusters: Array<{ representativeThreadId: number; members: number[] }>,
): ClusterExperimentClusterSizeStats {
  const histogramCounts = new Map<number, number>();
  const topClusterSizes = clusters.map((cluster) => cluster.members.length).sort((left, right) => right - left);
  let soloClusters = 0;

  for (const cluster of clusters) {
    const size = cluster.members.length;
    histogramCounts.set(size, (histogramCounts.get(size) ?? 0) + 1);
    if (size === 1) {
      soloClusters += 1;
    }
  }

  return {
    soloClusters,
    maxClusterSize: topClusterSizes[0] ?? 0,
    topClusterSizes: topClusterSizes.slice(0, 50),
    histogram: Array.from(histogramCounts.entries())
      .map(([size, count]) => ({ size, count }))
      .sort((left, right) => left.size - right.size),
  };
}

export function summarizeClusterQuality(
  clusters: Array<{ representativeThreadId: number; members: number[] }>,
  threadKinds: Map<number, 'issue' | 'pull_request'>,
  maxClusterSize: number,
): {
  maxClusterSize: number;
  maxObservedClusterSize: number;
  maxedClusterCount: number;
  mixedKindClusterCount: number;
  singletonClusterCount: number;
  nonSingletonClusterCount: number;
} {
  let maxObservedClusterSize = 0;
  let maxedClusterCount = 0;
  let mixedKindClusterCount = 0;
  let singletonClusterCount = 0;

  for (const cluster of clusters) {
    const size = cluster.members.length;
    maxObservedClusterSize = Math.max(maxObservedClusterSize, size);
    if (size >= maxClusterSize) maxedClusterCount += 1;
    if (size === 1) singletonClusterCount += 1;

    let hasIssue = false;
    let hasPullRequest = false;
    for (const memberId of cluster.members) {
      const kind = threadKinds.get(memberId);
      hasIssue ||= kind === 'issue';
      hasPullRequest ||= kind === 'pull_request';
      if (hasIssue && hasPullRequest) {
        mixedKindClusterCount += 1;
        break;
      }
    }
  }

  return {
    maxClusterSize,
    maxObservedClusterSize,
    maxedClusterCount,
    mixedKindClusterCount,
    singletonClusterCount,
    nonSingletonClusterCount: clusters.length - singletonClusterCount,
  };
}
