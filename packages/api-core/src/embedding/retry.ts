import {
  ACTIVE_EMBED_DIMENSIONS,
  ACTIVE_EMBED_PIPELINE_VERSION,
  EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO,
  EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO,
  EMBED_TRUNCATION_MARKER,
} from '../service-constants.js';
import type { ActiveVectorTask } from '../service-types.js';
import { stableContentHash } from '../service-utils.js';
import { estimateEmbeddingTokens } from './tasks.js';

export type EmbeddingContextError = { limitTokens: number | null; requestedTokens: number | null };

export function parseEmbeddingContextError(error: unknown): EmbeddingContextError | null {
  const message = error instanceof Error ? error.message : String(error);
  const requestedMatch = message.match(/requested\s+(\d+)\s+tokens/i);
  const contextLimitMatch = message.match(/maximum context length is\s+(\d+)\s+tokens/i);
  const inputLimitMatch = message.match(/maximum input length is\s+(\d+)\s+tokens/i);
  const limitTokens = Number(contextLimitMatch?.[1] ?? inputLimitMatch?.[1] ?? NaN);
  const requestedTokens = Number(requestedMatch?.[1] ?? NaN);

  if (!Number.isFinite(limitTokens) && !Number.isFinite(requestedTokens)) {
    return null;
  }

  return {
    limitTokens: Number.isFinite(limitTokens) ? limitTokens : null,
    requestedTokens: Number.isFinite(requestedTokens) ? requestedTokens : null,
  };
}

export function isEmbeddingContextError(error: unknown): boolean {
  return parseEmbeddingContextError(error) !== null;
}

export function shrinkEmbeddingTask(
  task: ActiveVectorTask,
  params: { embedModel: string; context?: EmbeddingContextError },
): ActiveVectorTask | null {
  const withoutMarker = task.text.endsWith(EMBED_TRUNCATION_MARKER)
    ? task.text.slice(0, -EMBED_TRUNCATION_MARKER.length)
    : task.text;
  if (withoutMarker.length < 256) {
    return null;
  }

  const nextLength = Math.max(
    256,
    projectEmbeddingRetryLength(withoutMarker.length, task.estimatedTokens, params.context),
  );
  if (nextLength >= withoutMarker.length) {
    return null;
  }
  const nextText = `${withoutMarker.slice(0, Math.max(0, nextLength - EMBED_TRUNCATION_MARKER.length)).trimEnd()}${EMBED_TRUNCATION_MARKER}`;
  return {
    ...task,
    text: nextText,
    contentHash: stableContentHash(
      `embedding:${ACTIVE_EMBED_PIPELINE_VERSION}:${task.basis}:${params.embedModel}:${ACTIVE_EMBED_DIMENSIONS}\n${nextText}`,
    ),
    estimatedTokens: estimateEmbeddingTokens(nextText),
    wasTruncated: true,
  };
}

function projectEmbeddingRetryLength(
  textLength: number,
  estimatedTokens: number,
  context?: EmbeddingContextError,
): number {
  const limitTokens = context?.limitTokens ?? null;
  const requestedTokens = context?.requestedTokens ?? null;
  if (limitTokens && requestedTokens && requestedTokens > limitTokens) {
    const targetRatio = (limitTokens * EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO) / requestedTokens;
    return Math.floor(textLength * Math.max(0.1, Math.min(targetRatio, EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO)));
  }

  if (limitTokens && estimatedTokens > limitTokens) {
    const targetRatio = (limitTokens * EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO) / estimatedTokens;
    return Math.floor(textLength * Math.max(0.1, Math.min(targetRatio, EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO)));
  }

  return Math.floor(textLength * EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO);
}
