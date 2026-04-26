import crypto from 'node:crypto';

import { z } from 'zod';

export const LLM_KEY_SUMMARY_PROMPT_VERSION = 'llm-key-summary-v2';

export const LLM_KEY_SUMMARY_SYSTEM_PROMPT = `You produce stable deduplication keys for GitHub issues and pull requests.
Return only strict JSON with exactly these fields:
purpose: one sentence, max 160 chars, issue or feature summary describing why this exists or what user need it serves.
intent: one sentence, max 120 chars, what outcome is being requested or changed.
surface: one sentence, max 120 chars, affected user/API/module/file area.
mechanism: one sentence, max 160 chars, cause or implementation approach.
Use concrete nouns from the input. Do not mention uncertainty. Do not add advice.`;

export const llmKeySummarySchema = z.object({
  purpose: z.string().trim().min(1),
  intent: z.string().trim().min(1),
  surface: z.string().trim().min(1),
  mechanism: z.string().trim().min(1),
});

export type LlmKeySummary = z.infer<typeof llmKeySummarySchema>;

export function parseLlmKeySummary(value: unknown): LlmKeySummary {
  const summary = llmKeySummarySchema.parse(value);
  return {
    purpose: clampSentence(summary.purpose, 160),
    intent: clampSentence(summary.intent, 120),
    surface: clampSentence(summary.surface, 120),
    mechanism: clampSentence(summary.mechanism, 160),
  };
}

function clampSentence(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength - 1).trimEnd() + '.';
}

export function llmKeyEmbeddingText(summary: LlmKeySummary): string {
  return [
    `purpose: ${summary.purpose}`,
    `intent: ${summary.intent}`,
    `surface: ${summary.surface}`,
    `mechanism: ${summary.mechanism}`,
  ].join('\n');
}

export function llmKeyInputHash(input: {
  promptVersion?: string;
  title: string;
  body: string | null;
  commentsText?: string | null;
  diffText?: string | null;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        promptVersion: input.promptVersion ?? LLM_KEY_SUMMARY_PROMPT_VERSION,
        title: input.title,
        body: input.body ?? '',
        commentsText: input.commentsText ?? '',
        diffText: input.diffText ?? '',
      }),
    )
    .digest('hex');
}
