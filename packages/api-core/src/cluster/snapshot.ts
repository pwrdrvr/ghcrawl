/**
 * Cluster snapshot comparison using Jaccard similarity.
 * Each run stores its own cluster snapshot; a merge step compares
 * current vs previous snapshots to determine which clusters are
 * continuations, new arrivals, or dissolved.
 */

export type ClusterSnapshot = {
  clusterId: number;
  representativeThreadId: number | null;
  members: Set<number>;
};

export type MergeOutcome =
  | { type: 'updated'; currentSnapshotClusterId: number; previousSnapshotClusterId: number; jaccard: number }
  | { type: 'new'; currentSnapshotClusterId: number }
  | { type: 'dissolved'; previousSnapshotClusterId: number };

export type MergeResult = {
  outcomes: MergeOutcome[];
  stats: { updated: number; newClusters: number; dissolved: number };
};

function jaccardSimilarity(a: Set<number>, b: Set<number>): number {
  let intersection = 0;
  for (const id of a) {
    if (b.has(id)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Compare current cluster snapshots against previous ones using Jaccard similarity.
 * Greedy matching: highest Jaccard first, threshold >= 0.5 to count as "same cluster".
 */
export function mergeClusterSnapshots(
  previousSnapshots: ClusterSnapshot[],
  currentSnapshots: ClusterSnapshot[],
  threshold = 0.5,
): MergeResult {
  if (previousSnapshots.length === 0) {
    return {
      outcomes: currentSnapshots.map((s) => ({ type: 'new' as const, currentSnapshotClusterId: s.clusterId })),
      stats: { updated: 0, newClusters: currentSnapshots.length, dissolved: 0 },
    };
  }

  // Compute all pairwise Jaccard scores
  const pairs: Array<{ currentIdx: number; previousIdx: number; jaccard: number }> = [];
  for (let ci = 0; ci < currentSnapshots.length; ci++) {
    for (let pi = 0; pi < previousSnapshots.length; pi++) {
      const j = jaccardSimilarity(currentSnapshots[ci].members, previousSnapshots[pi].members);
      if (j >= threshold) {
        pairs.push({ currentIdx: ci, previousIdx: pi, jaccard: j });
      }
    }
  }

  // Greedy matching: sort by Jaccard descending, then by intersection size descending
  pairs.sort((a, b) => b.jaccard - a.jaccard);

  const matchedCurrent = new Set<number>();
  const matchedPrevious = new Set<number>();
  const outcomes: MergeOutcome[] = [];

  for (const pair of pairs) {
    if (matchedCurrent.has(pair.currentIdx) || matchedPrevious.has(pair.previousIdx)) continue;
    matchedCurrent.add(pair.currentIdx);
    matchedPrevious.add(pair.previousIdx);
    outcomes.push({
      type: 'updated',
      currentSnapshotClusterId: currentSnapshots[pair.currentIdx].clusterId,
      previousSnapshotClusterId: previousSnapshots[pair.previousIdx].clusterId,
      jaccard: pair.jaccard,
    });
  }

  // Unmatched current = new clusters
  for (let ci = 0; ci < currentSnapshots.length; ci++) {
    if (!matchedCurrent.has(ci)) {
      outcomes.push({ type: 'new', currentSnapshotClusterId: currentSnapshots[ci].clusterId });
    }
  }

  // Unmatched previous = dissolved clusters
  for (let pi = 0; pi < previousSnapshots.length; pi++) {
    if (!matchedPrevious.has(pi)) {
      outcomes.push({ type: 'dissolved', previousSnapshotClusterId: previousSnapshots[pi].clusterId });
    }
  }

  return {
    outcomes,
    stats: {
      updated: outcomes.filter((o) => o.type === 'updated').length,
      newClusters: outcomes.filter((o) => o.type === 'new').length,
      dissolved: outcomes.filter((o) => o.type === 'dissolved').length,
    },
  };
}
