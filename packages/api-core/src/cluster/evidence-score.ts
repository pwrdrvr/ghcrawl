import { compareDeterministicFingerprints, type DeterministicThreadFingerprint, type FingerprintPairBreakdown } from './thread-fingerprint.js';

export type EvidenceTier = 'strong' | 'weak' | 'none';

export type OptionalEnrichmentEvidence = {
  embeddingSimilarity?: number | null;
  llmKeySimilarity?: number | null;
};

export type EvidenceScoreConfig = {
  minScore: number;
  strongScore: number;
  weightLineage: number;
  weightStructure: number;
  weightLinkedRefs: number;
  weightTitle: number;
  weightMinhash: number;
  weightSimhash: number;
  weightWinnow: number;
  weightEmbedding: number;
  weightLlmKey: number;
};

export type SimilarityEvidenceBreakdown = FingerprintPairBreakdown & {
  embeddingSimilarity: number | null;
  llmKeySimilarity: number | null;
  score: number;
  tier: EvidenceTier;
};

export const DEFAULT_EVIDENCE_SCORE_CONFIG: EvidenceScoreConfig = {
  minScore: 0.48,
  strongScore: 0.74,
  weightLineage: 0.25,
  weightStructure: 0.22,
  weightLinkedRefs: 0.16,
  weightTitle: 0.08,
  weightMinhash: 0.10,
  weightSimhash: 0.08,
  weightWinnow: 0.07,
  weightEmbedding: 0.02,
  weightLlmKey: 0.02,
};

function clamp01(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function scoreSimilarityEvidence(
  left: DeterministicThreadFingerprint,
  right: DeterministicThreadFingerprint,
  enrichment: OptionalEnrichmentEvidence = {},
  config: EvidenceScoreConfig = DEFAULT_EVIDENCE_SCORE_CONFIG,
): SimilarityEvidenceBreakdown {
  const base = compareDeterministicFingerprints(left, right);
  const embeddingSimilarity = enrichment.embeddingSimilarity ?? null;
  const llmKeySimilarity = enrichment.llmKeySimilarity ?? null;
  const score =
    config.weightLineage * base.lineage +
    config.weightStructure * base.structure +
    config.weightLinkedRefs * base.linkedRefOverlap +
    config.weightTitle * base.titleOverlap +
    config.weightMinhash * base.tokenMinhash +
    config.weightSimhash * base.tokenSimhash +
    config.weightWinnow * base.tokenWinnow +
    config.weightEmbedding * clamp01(embeddingSimilarity) +
    config.weightLlmKey * clamp01(llmKeySimilarity);

  let tier: EvidenceTier = 'none';
  if (
    base.lineage >= 0.8 ||
    (base.linkedRefOverlap >= 0.8 && (base.structure >= 0.25 || base.titleOverlap >= 0.25)) ||
    score >= config.strongScore
  ) {
    tier = 'strong';
  } else if (
    score >= config.minScore ||
    (base.titleOverlap >= 0.25 && base.tokenSimhash >= 0.55) ||
    (base.structure >= 0.5 && base.tokenSimhash >= 0.55) ||
    (base.linkedRefOverlap >= 0.5 && base.tokenMinhash >= 0.25)
  ) {
    tier = 'weak';
  }

  return {
    ...base,
    embeddingSimilarity,
    llmKeySimilarity,
    score,
    tier,
  };
}
