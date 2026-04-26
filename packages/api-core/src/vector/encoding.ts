import {
  CLUSTER_PARALLEL_MIN_EMBEDDINGS,
  VECTORLITE_CLUSTER_EXPANDED_CANDIDATE_K,
  VECTORLITE_CLUSTER_EXPANDED_EF_SEARCH,
  VECTORLITE_CLUSTER_EXPANDED_K,
  VECTORLITE_CLUSTER_EXPANDED_MULTIPLIER,
} from '../service-constants.js';

export function vectorBlob(values: number[]): Buffer {
  return Buffer.from(Float32Array.from(values).buffer);
}

export function parseStoredVector(value: Buffer | string): number[] {
  if (typeof value === 'string') {
    if (!value) {
      throw new Error('Stored vector payload is empty. Run refresh or embed first.');
    }
    return JSON.parse(value) as number[];
  }
  const floats = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / Float32Array.BYTES_PER_ELEMENT));
  return Array.from(floats);
}

export function normalizedEmbeddingBuffer(values: number[]): Buffer {
  return vectorBlob(values);
}

export function normalizedDistanceToScore(distance: number): number {
  return 1 - distance / 2;
}

export function getVectorliteClusterQuery(
  totalItems: number,
  requestedK: number,
): {
  limit: number;
  candidateK: number;
  efSearch?: number;
} {
  if (totalItems < CLUSTER_PARALLEL_MIN_EMBEDDINGS) {
    return {
      limit: requestedK,
      candidateK: Math.max(requestedK * 16, 64),
    };
  }

  const limit = Math.min(
    Math.max(requestedK * VECTORLITE_CLUSTER_EXPANDED_MULTIPLIER, VECTORLITE_CLUSTER_EXPANDED_K),
    Math.max(1, totalItems - 1),
  );
  const candidateK = Math.min(
    Math.max(limit * 16, VECTORLITE_CLUSTER_EXPANDED_CANDIDATE_K),
    Math.max(limit, totalItems - 1),
  );
  return {
    limit,
    candidateK,
    efSearch: Math.max(candidateK * 2, VECTORLITE_CLUSTER_EXPANDED_EF_SEARCH),
  };
}
