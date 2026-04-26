import type { AggregatedClusterEdge, EmbeddingSourceKind, SimilaritySourceKind } from '../service-types.js';

export type PerSourceScoreEntry = {
  leftThreadId: number;
  rightThreadId: number;
  scores: Map<EmbeddingSourceKind, number>;
};

export type EdgeAggregationMode = 'max' | 'mean' | 'weighted' | 'min-of-2' | 'boost';

export function edgeKey(leftThreadId: number, rightThreadId: number): string {
  const left = Math.min(leftThreadId, rightThreadId);
  const right = Math.max(leftThreadId, rightThreadId);
  return `${left}:${right}`;
}

export function mergeSourceKindEdges(
  aggregated: Map<string, AggregatedClusterEdge>,
  edges: Array<{ leftThreadId: number; rightThreadId: number; score: number }>,
  sourceKind: SimilaritySourceKind,
): void {
  for (const edge of edges) {
    const key = edgeKey(edge.leftThreadId, edge.rightThreadId);
    const existing = aggregated.get(key);
    if (existing) {
      existing.score = Math.max(existing.score, edge.score);
      existing.sourceKinds.add(sourceKind);
      continue;
    }
    aggregated.set(key, {
      leftThreadId: edge.leftThreadId,
      rightThreadId: edge.rightThreadId,
      score: edge.score,
      sourceKinds: new Set([sourceKind]),
    });
  }
}

export function pruneWeakCrossKindEdges(
  aggregated: Map<string, AggregatedClusterEdge>,
  threadKinds: Map<number, 'issue' | 'pull_request'>,
  crossKindMinScore: number,
): number {
  let dropped = 0;
  for (const [key, edge] of aggregated) {
    const leftKind = threadKinds.get(edge.leftThreadId);
    const rightKind = threadKinds.get(edge.rightThreadId);
    if (!leftKind || !rightKind || leftKind === rightKind) {
      continue;
    }
    if (edge.sourceKinds.has('deterministic_fingerprint') || edge.score >= crossKindMinScore) {
      continue;
    }
    aggregated.delete(key);
    dropped += 1;
  }
  return dropped;
}

export function collectSourceKindScores(
  perSourceScores: Map<string, PerSourceScoreEntry>,
  edges: Array<{ leftThreadId: number; rightThreadId: number; score: number }>,
  sourceKind: EmbeddingSourceKind,
): void {
  for (const edge of edges) {
    const key = edgeKey(edge.leftThreadId, edge.rightThreadId);
    const existing = perSourceScores.get(key);
    if (existing) {
      existing.scores.set(sourceKind, Math.max(existing.scores.get(sourceKind) ?? -1, edge.score));
      continue;
    }
    const scores = new Map<EmbeddingSourceKind, number>();
    scores.set(sourceKind, edge.score);
    perSourceScores.set(key, {
      leftThreadId: edge.leftThreadId,
      rightThreadId: edge.rightThreadId,
      scores,
    });
  }
}

export function finalizeEdgeScores(
  perSourceScores: Map<string, PerSourceScoreEntry>,
  aggregation: EdgeAggregationMode,
  weights: Record<EmbeddingSourceKind, number>,
  minScore: number,
): Array<{ leftThreadId: number; rightThreadId: number; score: number }> {
  const result: Array<{ leftThreadId: number; rightThreadId: number; score: number }> = [];

  for (const entry of perSourceScores.values()) {
    const scoreValues = Array.from(entry.scores.values());
    let finalScore: number;

    switch (aggregation) {
      case 'max':
        finalScore = Math.max(...scoreValues);
        break;

      case 'mean':
        finalScore = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
        break;

      case 'weighted': {
        let weightedSum = 0;
        let weightSum = 0;
        for (const [kind, score] of entry.scores) {
          const weight = weights[kind] ?? 0.1;
          weightedSum += score * weight;
          weightSum += weight;
        }
        finalScore = weightSum > 0 ? weightedSum / weightSum : 0;
        break;
      }

      case 'min-of-2':
        if (scoreValues.length < 2) {
          continue;
        }
        finalScore = Math.max(...scoreValues);
        break;

      case 'boost': {
        const best = Math.max(...scoreValues);
        const bonusSources = scoreValues.length - 1;
        finalScore = Math.min(1.0, best + bonusSources * 0.05);
        break;
      }
    }

    if (finalScore >= minScore) {
      result.push({
        leftThreadId: entry.leftThreadId,
        rightThreadId: entry.rightThreadId,
        score: finalScore,
      });
    }
  }

  return result;
}
