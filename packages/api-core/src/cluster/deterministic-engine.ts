import { buildClusters, type SimilarityEdge } from './build.js';
import { scoreSimilarityEvidence, type SimilarityEvidenceBreakdown } from './evidence-score.js';
import { buildDeterministicThreadFingerprint, type DeterministicThreadFingerprint } from './thread-fingerprint.js';

const REF_RE = /(?:#|issues\/|pull\/)(\d+)/gi;

export type DeterministicClusterInput = {
  id: number;
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  body: string | null;
  labels: string[];
  changedFiles?: string[];
  linkedRefs?: string[];
  hunkSignatures?: string[];
  patchIds?: string[];
};

export type DeterministicClusterNode = {
  id: number;
  number: number;
  title: string;
};

export type DeterministicClusterEdge = SimilarityEdge & {
  tier: 'strong' | 'weak';
  breakdown: SimilarityEvidenceBreakdown;
};

export type DeterministicClusterResult = {
  edges: DeterministicClusterEdge[];
  clusters: Array<{ representativeThreadId: number; members: number[] }>;
  fingerprints: Map<number, DeterministicThreadFingerprint>;
};

export function extractDeterministicRefs(value: string | null): string[] {
  const refs = new Set<string>();
  for (const match of value?.matchAll(REF_RE) ?? []) {
    refs.add(match[1]);
  }
  return Array.from(refs).sort();
}

function bump(index: Map<string, Set<number>>, key: string, id: number): void {
  const bucket = index.get(key) ?? new Set<number>();
  bucket.add(id);
  index.set(key, bucket);
}

function buildCandidatePairs(
  fingerprints: Map<number, DeterministicThreadFingerprint>,
  params: { maxBucketSize: number; topK: number; seedThreadIds?: Set<number> },
): Array<[number, number]> {
  const index = new Map<string, Set<number>>();
  for (const [id, fingerprint] of fingerprints.entries()) {
    for (const token of fingerprint.salientTitleTokens) bump(index, `title:${token}`, id);
    for (const ref of fingerprint.linkedRefs) bump(index, `ref:${ref}`, id);
    for (const file of fingerprint.changedFiles) bump(index, `file:${file}`, id);
    for (const module of fingerprint.moduleBuckets) bump(index, `module:${module}`, id);
    for (const hunk of fingerprint.hunkSignatures) bump(index, `hunk:${hunk}`, id);
  }

  const votes = new Map<string, number>();
  for (const bucket of index.values()) {
    if (bucket.size > params.maxBucketSize) continue;
    const ids = Array.from(bucket).sort((left, right) => left - right);
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
        if (params.seedThreadIds && !params.seedThreadIds.has(ids[leftIndex]) && !params.seedThreadIds.has(ids[rightIndex])) {
          continue;
        }
        const key = `${ids[leftIndex]}:${ids[rightIndex]}`;
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    }
  }

  return Array.from(votes.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, fingerprints.size * params.topK)
    .map(([key]) => {
      const [left, right] = key.split(':').map(Number);
      return [left, right] as [number, number];
    });
}

export function buildDeterministicClusterGraph(
  inputs: DeterministicClusterInput[],
  params: { maxBucketSize?: number; topK?: number; seedThreadIds?: number[] } = {},
): DeterministicClusterResult {
  const fingerprints = new Map<number, DeterministicThreadFingerprint>();
  for (const input of inputs) {
    const inferredRefs = extractDeterministicRefs(`${input.title}\n${input.body ?? ''}`);
    fingerprints.set(
      input.id,
      buildDeterministicThreadFingerprint({
        ...input,
        threadId: input.id,
        linkedRefs: Array.from(new Set([...(input.linkedRefs ?? []), ...inferredRefs])).sort(),
      }),
    );
  }

  return buildDeterministicClusterGraphFromFingerprints(
    inputs.map((input) => ({
      id: input.id,
      number: input.number,
      title: input.title,
    })),
    fingerprints,
    params,
  );
}

export function buildDeterministicClusterGraphFromFingerprints(
  nodes: DeterministicClusterNode[],
  fingerprints: Map<number, DeterministicThreadFingerprint>,
  params: { maxBucketSize?: number; topK?: number; seedThreadIds?: number[] } = {},
): DeterministicClusterResult {
  const titleById = new Map(nodes.map((node) => [node.id, node.title]));
  const seedThreadIds = params.seedThreadIds ? new Set(params.seedThreadIds) : undefined;
  const pairs = buildCandidatePairs(fingerprints, {
    maxBucketSize: params.maxBucketSize ?? 500,
    topK: params.topK ?? 64,
    seedThreadIds,
  });
  const edges: DeterministicClusterEdge[] = [];
  for (const [leftThreadId, rightThreadId] of pairs) {
    const left = fingerprints.get(leftThreadId);
    const right = fingerprints.get(rightThreadId);
    if (!left || !right) continue;
    const breakdown = scoreSimilarityEvidence(left, right);
    if (breakdown.tier === 'none') continue;
    edges.push({
      leftThreadId,
      rightThreadId,
      score: breakdown.score,
      tier: breakdown.tier,
      breakdown,
    });
  }

  const clusterNodeIds = new Set<number>();
  if (seedThreadIds) {
    for (const id of seedThreadIds) clusterNodeIds.add(id);
    for (const edge of edges) {
      clusterNodeIds.add(edge.leftThreadId);
      clusterNodeIds.add(edge.rightThreadId);
    }
  }
  const clusterNodes = seedThreadIds ? nodes.filter((node) => clusterNodeIds.has(node.id)) : nodes;
  const clusters = buildClusters(
    clusterNodes.map((node) => ({
      threadId: node.id,
      number: node.number,
      title: titleById.get(node.id) ?? node.title,
    })),
    edges,
  );

  return { edges, clusters, fingerprints };
}
