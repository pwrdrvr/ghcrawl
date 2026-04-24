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

export type DeterministicClusterEdge = SimilarityEdge & {
  tier: 'strong' | 'weak';
  breakdown: SimilarityEvidenceBreakdown;
};

export type DeterministicClusterResult = {
  edges: DeterministicClusterEdge[];
  clusters: Array<{ representativeThreadId: number; members: number[] }>;
  fingerprints: Map<number, DeterministicThreadFingerprint>;
};

function extractRefs(value: string | null): string[] {
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
  params: { maxBucketSize: number; topK: number },
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
  params: { maxBucketSize?: number; topK?: number } = {},
): DeterministicClusterResult {
  const fingerprints = new Map<number, DeterministicThreadFingerprint>();
  const titleById = new Map<number, string>();
  for (const input of inputs) {
    const inferredRefs = extractRefs(`${input.title}\n${input.body ?? ''}`);
    fingerprints.set(
      input.id,
      buildDeterministicThreadFingerprint({
        ...input,
        linkedRefs: Array.from(new Set([...(input.linkedRefs ?? []), ...inferredRefs])).sort(),
      }),
    );
    titleById.set(input.id, input.title);
  }

  const pairs = buildCandidatePairs(fingerprints, {
    maxBucketSize: params.maxBucketSize ?? 500,
    topK: params.topK ?? 64,
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

  const clusters = buildClusters(
    inputs.map((input) => ({
      threadId: input.id,
      number: input.number,
      title: titleById.get(input.id) ?? input.title,
    })),
    edges,
  );

  return { edges, clusters, fingerprints };
}
