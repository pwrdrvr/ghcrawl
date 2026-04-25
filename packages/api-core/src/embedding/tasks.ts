import type { EmbeddingBasis } from '../config.js';
import {
  ACTIVE_EMBED_DIMENSIONS,
  ACTIVE_EMBED_PIPELINE_VERSION,
  EMBED_ESTIMATED_CHARS_PER_TOKEN,
  EMBED_MAX_ITEM_TOKENS,
  EMBED_TRUNCATION_MARKER,
} from '../service-constants.js';
import type { ActiveVectorTask, EmbeddingSourceKind } from '../service-types.js';
import { normalizeSummaryText, stableContentHash } from '../service-utils.js';

export function activeVectorSourceKind(embeddingBasis: EmbeddingBasis): EmbeddingSourceKind {
  if (embeddingBasis === 'title_summary') {
    return 'dedupe_summary';
  }
  if (embeddingBasis === 'llm_key_summary') {
    return 'llm_key_summary';
  }
  return 'body';
}

export function buildActiveVectorTask(params: {
  threadId: number;
  threadNumber: number;
  title: string;
  body: string | null;
  dedupeSummary: string | null;
  keySummary: string | null;
  embeddingBasis: EmbeddingBasis;
  embedModel: string;
}): ActiveVectorTask | null {
  const sections = [`title: ${normalizeSummaryText(params.title)}`];
  if (params.embeddingBasis === 'title_summary') {
    const summary = normalizeSummaryText(params.dedupeSummary ?? '');
    if (!summary) {
      return null;
    }
    sections.push(`summary: ${summary}`);
  } else if (params.embeddingBasis === 'llm_key_summary') {
    const keySummary = normalizeSummaryText(params.keySummary ?? '');
    if (!keySummary) {
      return null;
    }
    sections.push(`key_summary:\n${keySummary}`);
  } else {
    const body = normalizeSummaryText(params.body ?? '');
    if (body) {
      sections.push(`body: ${body}`);
    }
  }

  const prepared = prepareEmbeddingText(sections.join('\n\n'), EMBED_MAX_ITEM_TOKENS);
  if (!prepared) {
    return null;
  }

  return {
    threadId: params.threadId,
    threadNumber: params.threadNumber,
    basis: params.embeddingBasis,
    text: prepared.text,
    contentHash: stableContentHash(
      `embedding:${ACTIVE_EMBED_PIPELINE_VERSION}:${params.embeddingBasis}:${params.embedModel}:${ACTIVE_EMBED_DIMENSIONS}\n${prepared.text}`,
    ),
    estimatedTokens: prepared.estimatedTokens,
    wasTruncated: prepared.wasTruncated,
  };
}

export function prepareEmbeddingText(
  text: string,
  maxEstimatedTokens: number,
): { text: string; estimatedTokens: number; wasTruncated: boolean } | null {
  if (!text) {
    return null;
  }

  const maxChars = maxEstimatedTokens * EMBED_ESTIMATED_CHARS_PER_TOKEN;
  const wasTruncated = text.length > maxChars;
  const prepared = wasTruncated
    ? `${text.slice(0, Math.max(0, maxChars - EMBED_TRUNCATION_MARKER.length)).trimEnd()}${EMBED_TRUNCATION_MARKER}`
    : text;
  return {
    text: prepared,
    estimatedTokens: estimateEmbeddingTokens(prepared),
    wasTruncated,
  };
}

export function estimateEmbeddingTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / EMBED_ESTIMATED_CHARS_PER_TOKEN));
}
