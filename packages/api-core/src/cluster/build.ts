export type SimilarityEdge = {
  leftThreadId: number;
  rightThreadId: number;
  score: number;
};

type Node = {
  threadId: number;
  number: number;
  title: string;
};

class UnionFind {
  private readonly parent = new Map<number, number>();
  private readonly size = new Map<number, number>();

  add(value: number): void {
    if (!this.parent.has(value)) {
      this.parent.set(value, value);
      this.size.set(value, 1);
    }
  }

  find(value: number): number {
    let parent = this.parent.get(value);
    if (parent === undefined) {
      this.parent.set(value, value);
      this.size.set(value, 1);
      return value;
    }
    // Iterative path-finding to avoid stack overflow on deep chains
    let current: number = value;
    while (parent !== current) {
      const grandparent: number = this.parent.get(parent) ?? parent;
      this.parent.set(current, grandparent); // path splitting
      current = parent;
      parent = grandparent;
    }
    return current;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) {
      const leftSize = this.size.get(leftRoot) ?? 1;
      const rightSize = this.size.get(rightRoot) ?? 1;
      this.parent.set(rightRoot, leftRoot);
      this.size.set(leftRoot, leftSize + rightSize);
    }
  }

  /** Merge only if the combined component would not exceed maxSize. Returns true if merged. */
  unionBounded(left: number, right: number, maxSize: number): boolean {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return true; // already same component
    const leftSize = this.size.get(leftRoot) ?? 1;
    const rightSize = this.size.get(rightRoot) ?? 1;
    if (leftSize + rightSize > maxSize) return false;
    this.parent.set(rightRoot, leftRoot);
    this.size.set(leftRoot, leftSize + rightSize);
    return true;
  }

  getSize(value: number): number {
    return this.size.get(this.find(value)) ?? 1;
  }
}

export function buildClusters(nodes: Node[], edges: SimilarityEdge[]): Array<{ representativeThreadId: number; members: number[] }> {
  const uf = new UnionFind();
  for (const node of nodes) uf.add(node.threadId);
  for (const edge of edges) uf.union(edge.leftThreadId, edge.rightThreadId);

  const byRoot = new Map<number, number[]>();
  for (const node of nodes) {
    const root = uf.find(node.threadId);
    const list = byRoot.get(root) ?? [];
    list.push(node.threadId);
    byRoot.set(root, list);
  }

  return formatClusters(nodes, edges, byRoot);
}

/**
 * Build clusters with size-bounded Union-Find.
 *
 * Process edges from highest to lowest score, merging components only when
 * the combined size stays within `maxClusterSize`. Strongest connections are
 * preserved; weaker edges that would create oversized clusters are skipped.
 * This avoids the "threshold raising" problem where splitting mega-clusters
 * creates many solos.
 */
export function buildSizeBoundedClusters(
  nodes: Node[],
  edges: SimilarityEdge[],
  options: { maxClusterSize: number },
): Array<{ representativeThreadId: number; members: number[] }> {
  const uf = new UnionFind();
  for (const node of nodes) uf.add(node.threadId);

  // Sort edges by score descending — strongest connections first
  const sortedEdges = [...edges].sort((a, b) => b.score - a.score);
  const keptEdges: SimilarityEdge[] = [];

  for (const edge of sortedEdges) {
    if (uf.unionBounded(edge.leftThreadId, edge.rightThreadId, options.maxClusterSize)) {
      keptEdges.push(edge);
    }
  }

  const byRoot = new Map<number, number[]>();
  for (const node of nodes) {
    const root = uf.find(node.threadId);
    const list = byRoot.get(root) ?? [];
    list.push(node.threadId);
    byRoot.set(root, list);
  }

  return formatClusters(nodes, keptEdges, byRoot);
}

/**
 * Build clusters with iterative refinement of oversized components.
 *
 * 1. Run Union-Find at the base threshold (edges already filtered by minScore).
 * 2. For any cluster above `maxClusterSize`, re-cluster its members using only
 *    edges above a progressively higher threshold (raised by `refineStep` each
 *    iteration) until all clusters are within limits or threshold reaches 1.0.
 */
export function buildRefinedClusters(
  nodes: Node[],
  edges: SimilarityEdge[],
  options: { maxClusterSize: number; refineStep: number },
): Array<{ representativeThreadId: number; members: number[] }> {
  const nodesById = new Map(nodes.map((node) => [node.threadId, node]));
  const result: Array<{ representativeThreadId: number; members: number[] }> = [];

  // Initial Union-Find pass
  const uf = new UnionFind();
  for (const node of nodes) uf.add(node.threadId);
  for (const edge of edges) uf.union(edge.leftThreadId, edge.rightThreadId);

  const byRoot = new Map<number, number[]>();
  for (const node of nodes) {
    const root = uf.find(node.threadId);
    const list = byRoot.get(root) ?? [];
    list.push(node.threadId);
    byRoot.set(root, list);
  }

  // Build adjacency list for O(E) iteration instead of O(n²) pair scanning
  const adjacency = new Map<number, SimilarityEdge[]>();
  for (const edge of edges) {
    let list = adjacency.get(edge.leftThreadId);
    if (!list) { list = []; adjacency.set(edge.leftThreadId, list); }
    list.push(edge);
    let rList = adjacency.get(edge.rightThreadId);
    if (!rList) { rList = []; adjacency.set(edge.rightThreadId, rList); }
    rList.push(edge);
  }

  // Process each initial cluster
  type WorkItem = { memberIds: number[]; currentThreshold: number };
  const workQueue: WorkItem[] = [];

  for (const members of byRoot.values()) {
    if (members.length <= options.maxClusterSize) {
      const clusterNodes = members.map((id) => nodesById.get(id)).filter((n): n is Node => n !== undefined);
      const clusterEdges = edgesWithinSet(new Set(members), adjacency);
      result.push(...formatClusters(clusterNodes, clusterEdges, new Map([[0, members]])));
    } else {
      workQueue.push({ memberIds: members, currentThreshold: 0 });
    }
  }

  // Iteratively refine oversized clusters
  while (workQueue.length > 0) {
    const item = workQueue.pop()!;
    const newThreshold = item.currentThreshold + options.refineStep;
    if (newThreshold >= 1.0) {
      for (const memberId of item.memberIds) {
        result.push({ representativeThreadId: memberId, members: [memberId] });
      }
      continue;
    }

    // Filter edges within this component to the higher threshold
    const memberSet = new Set(item.memberIds);
    const filteredEdges: SimilarityEdge[] = [];
    for (const memberId of item.memberIds) {
      for (const edge of adjacency.get(memberId) ?? []) {
        const otherId = edge.leftThreadId === memberId ? edge.rightThreadId : edge.leftThreadId;
        if (otherId > memberId && memberSet.has(otherId) && edge.score >= newThreshold) {
          filteredEdges.push(edge);
        }
      }
    }

    // Re-cluster with filtered edges
    const subUf = new UnionFind();
    for (const memberId of item.memberIds) subUf.add(memberId);
    for (const edge of filteredEdges) subUf.union(edge.leftThreadId, edge.rightThreadId);

    const subByRoot = new Map<number, number[]>();
    for (const memberId of item.memberIds) {
      const root = subUf.find(memberId);
      const list = subByRoot.get(root) ?? [];
      list.push(memberId);
      subByRoot.set(root, list);
    }

    for (const subMembers of subByRoot.values()) {
      if (subMembers.length <= options.maxClusterSize) {
        const clusterNodes = subMembers.map((id) => nodesById.get(id)).filter((n): n is Node => n !== undefined);
        const clusterEdges = edgesWithinSet(new Set(subMembers), adjacency);
        result.push(...formatClusters(clusterNodes, clusterEdges, new Map([[0, subMembers]])));
      } else {
        workQueue.push({ memberIds: subMembers, currentThreshold: newThreshold });
      }
    }
  }

  return result.sort((left, right) => right.members.length - left.members.length);
}

function edgesWithinSet(memberSet: Set<number>, adjacency: Map<number, SimilarityEdge[]>): SimilarityEdge[] {
  const edges: SimilarityEdge[] = [];
  for (const memberId of memberSet) {
    for (const edge of adjacency.get(memberId) ?? []) {
      const otherId = edge.leftThreadId === memberId ? edge.rightThreadId : edge.leftThreadId;
      if (otherId > memberId && memberSet.has(otherId)) {
        edges.push(edge);
      }
    }
  }
  return edges;
}

function formatClusters(
  nodes: Node[],
  edges: SimilarityEdge[],
  byRoot: Map<number, number[]>,
): Array<{ representativeThreadId: number; members: number[] }> {
  const edgeCounts = new Map<number, number>();
  for (const edge of edges) {
    edgeCounts.set(edge.leftThreadId, (edgeCounts.get(edge.leftThreadId) ?? 0) + 1);
    edgeCounts.set(edge.rightThreadId, (edgeCounts.get(edge.rightThreadId) ?? 0) + 1);
  }

  const nodesById = new Map(nodes.map((node) => [node.threadId, node]));
  return Array.from(byRoot.values())
    .map((members) => {
      const representative = [...members].sort((leftId, rightId) => {
        const left = nodesById.get(leftId);
        const right = nodesById.get(rightId);
        const edgeDelta = (edgeCounts.get(rightId) ?? 0) - (edgeCounts.get(leftId) ?? 0);
        if (edgeDelta !== 0) return edgeDelta;
        if (!left || !right) return leftId - rightId;
        return left.number - right.number;
      })[0];
      return { representativeThreadId: representative, members: members.sort((left, right) => left - right) };
    })
    .sort((left, right) => right.members.length - left.members.length);
}
