import { createRequire } from 'node:module';

import type { SummaryModelPricing } from './service-types.js';

export const SYNC_BATCH_SIZE = 100;
export const SYNC_BATCH_DELAY_MS = 5000;
export const STALE_CLOSED_SWEEP_LIMIT = 1000;
export const STALE_CLOSED_BACKFILL_LIMIT = 5000;
export const MAX_DIRECT_RECONCILE_THREADS = 500;
export const CLUSTER_PROGRESS_INTERVAL_MS = 5000;
export const DURABLE_CLUSTER_REUSE_MIN_OVERLAP = 0.8;
export const RAW_JSON_INLINE_THRESHOLD_BYTES = 4096;
export const CLUSTER_PARALLEL_MIN_EMBEDDINGS = 5000;
export const EMBED_ESTIMATED_CHARS_PER_TOKEN = 3;
export const EMBED_MAX_ITEM_TOKENS = 7000;
export const EMBED_MAX_BATCH_TOKENS = 250000;
export const requireFromHere = createRequire(import.meta.url);
export const EMBED_TRUNCATION_MARKER = '\n\n[truncated for embedding]';
export const EMBED_CONTEXT_RETRY_ATTEMPTS = 5;
export const EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO = 0.9;
export const EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO = 0.95;
export const KEY_SUMMARY_MAX_BODY_CHARS = 6000;
export const KEY_SUMMARY_CONCURRENCY = 24;
export const KEY_SUMMARY_MAX_UNREAD = 48;
export const SUMMARY_PROMPT_VERSION = 'v1';
export const ACTIVE_EMBED_DIMENSIONS = 1024;
export const ACTIVE_EMBED_PIPELINE_VERSION = 'vectorlite-1024-v1';
export const DEFAULT_CLUSTER_MIN_SCORE = 0.8;
export const DEFAULT_DETERMINISTIC_CLUSTER_MIN_SCORE = 0.36;
export const DEFAULT_CROSS_KIND_CLUSTER_MIN_SCORE = 0.93;
export const DEFAULT_CLUSTER_MAX_SIZE = 40;
export const VECTORLITE_CLUSTER_EXPANDED_K = 24;
export const VECTORLITE_CLUSTER_EXPANDED_MULTIPLIER = 4;
export const VECTORLITE_CLUSTER_EXPANDED_CANDIDATE_K = 512;
export const VECTORLITE_CLUSTER_EXPANDED_EF_SEARCH = 1024;

export const SUMMARY_MODEL_PRICING: Record<string, SummaryModelPricing> = {
  'gpt-5-mini': {
    inputCostPerM: 0.25,
    cachedInputCostPerM: 0.025,
    outputCostPerM: 2.0,
  },
  'gpt-5.4-mini': {
    inputCostPerM: 0.75,
    cachedInputCostPerM: 0.075,
    outputCostPerM: 4.5,
  },
};
