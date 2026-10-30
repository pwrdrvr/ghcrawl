export type ClusterSnapshot = {
  clusterId: number;
  members: Set<number>;
};

export type TransitionType =
  | 'continuing'
  | 'growing'
  | 'shrinking'
  | 'splitting'
  | 'merging'
  | 'forming'
  | 'dissolving';

export type ClusterTransition = {
  fromClusterId: number | null;
  toClusterId: number | null;
  transition: TransitionType;
  jaccardScore: number | null;
  membersAdded: number;
  membersRemoved: number;
  membersRetained: number;
};

type PairScore = {
  oldClusterId: number;
  newClusterId: number;
  intersection: number;
  jaccard: number;
};

export function computeClusterTransitions(
  oldClusters: ClusterSnapshot[],
  newClusters: ClusterSnapshot[],
): ClusterTransition[] {
  const oldById = new Map(oldClusters.map((cluster) => [cluster.clusterId, cluster]));
  const newById = new Map(newClusters.map((cluster) => [cluster.clusterId, cluster]));

  const threadToOld = new Map<number, number>();
  for (const cluster of oldClusters) {
    for (const member of cluster.members) {
      threadToOld.set(member, cluster.clusterId);
    }
  }

  const threadToNew = new Map<number, number>();
  for (const cluster of newClusters) {
    for (const member of cluster.members) {
      threadToNew.set(member, cluster.clusterId);
    }
  }

  const intersections = new Map<number, Map<number, number>>();
  for (const [threadId, oldClusterId] of threadToOld.entries()) {
    const newClusterId = threadToNew.get(threadId);
    if (newClusterId === undefined) continue;
    const byNew = intersections.get(oldClusterId) ?? new Map<number, number>();
    byNew.set(newClusterId, (byNew.get(newClusterId) ?? 0) + 1);
    intersections.set(oldClusterId, byNew);
  }

  const pairs: PairScore[] = [];
  for (const [oldClusterId, byNew] of intersections.entries()) {
    const oldCluster = oldById.get(oldClusterId);
    if (!oldCluster) continue;
    for (const [newClusterId, intersection] of byNew.entries()) {
      const newCluster = newById.get(newClusterId);
      if (!newCluster) continue;
      const denominator = oldCluster.members.size + newCluster.members.size - intersection;
      const jaccard = denominator === 0 ? 0 : intersection / denominator;
      pairs.push({ oldClusterId, newClusterId, intersection, jaccard });
    }
  }

  pairs.sort((left, right) => {
    if (right.jaccard !== left.jaccard) return right.jaccard - left.jaccard;
    if (right.intersection !== left.intersection) return right.intersection - left.intersection;
    if (left.oldClusterId !== right.oldClusterId) return left.oldClusterId - right.oldClusterId;
    return left.newClusterId - right.newClusterId;
  });

  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();
  const transitions: ClusterTransition[] = [];

  for (const pair of pairs) {
    if (pair.jaccard < 0.5) break;
    if (matchedOld.has(pair.oldClusterId) || matchedNew.has(pair.newClusterId)) continue;

    const oldCluster = oldById.get(pair.oldClusterId);
    const newCluster = newById.get(pair.newClusterId);
    if (!oldCluster || !newCluster) continue;

    const oldSize = oldCluster.members.size;
    const newSize = newCluster.members.size;
    const membersRetained = pair.intersection;
    const membersAdded = newSize - membersRetained;
    const membersRemoved = oldSize - membersRetained;
    const transition: TransitionType =
      newSize === oldSize ? 'continuing' : newSize > oldSize ? 'growing' : 'shrinking';

    transitions.push({
      fromClusterId: oldCluster.clusterId,
      toClusterId: newCluster.clusterId,
      transition,
      jaccardScore: pair.jaccard,
      membersAdded,
      membersRemoved,
      membersRetained,
    });

    matchedOld.add(pair.oldClusterId);
    matchedNew.add(pair.newClusterId);
  }

  for (const oldCluster of oldClusters) {
    if (matchedOld.has(oldCluster.clusterId)) continue;
    const destinations = new Map<number, number>();
    let membersRetained = 0;
    for (const member of oldCluster.members) {
      const destinationClusterId = threadToNew.get(member);
      if (destinationClusterId === undefined) continue;
      membersRetained += 1;
      destinations.set(destinationClusterId, (destinations.get(destinationClusterId) ?? 0) + 1);
    }
    const splitTargets = Array.from(destinations.values()).filter((count) => count >= 2).length;
    transitions.push({
      fromClusterId: oldCluster.clusterId,
      toClusterId: null,
      transition: splitTargets >= 2 ? 'splitting' : 'dissolving',
      jaccardScore: null,
      membersAdded: 0,
      membersRemoved: oldCluster.members.size - membersRetained,
      membersRetained,
    });
  }

  for (const newCluster of newClusters) {
    if (matchedNew.has(newCluster.clusterId)) continue;
    const origins = new Map<number, number>();
    let membersRetained = 0;
    for (const member of newCluster.members) {
      const originClusterId = threadToOld.get(member);
      if (originClusterId === undefined) continue;
      membersRetained += 1;
      origins.set(originClusterId, (origins.get(originClusterId) ?? 0) + 1);
    }
    const mergeSources = Array.from(origins.values()).filter((count) => count >= 2).length;
    transitions.push({
      fromClusterId: null,
      toClusterId: newCluster.clusterId,
      transition: mergeSources >= 2 ? 'merging' : 'forming',
      jaccardScore: null,
      membersAdded: newCluster.members.size - membersRetained,
      membersRemoved: 0,
      membersRetained,
    });
  }

  return transitions;
}
