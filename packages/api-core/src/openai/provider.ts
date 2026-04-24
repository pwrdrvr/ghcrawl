import OpenAI from 'openai';
import { APIConnectionError, APIConnectionTimeoutError, APIError, RateLimitError } from 'openai/error';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

import { LLM_KEY_SUMMARY_SYSTEM_PROMPT, llmKeySummarySchema, type LlmKeySummary } from '../cluster/llm-key-summary.js';

export type SummaryResult = {
  problemSummary: string;
  solutionSummary: string;
  maintainerSignalSummary: string;
  dedupeSummary: string;
};

export type SummaryUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export type AiProvider = {
  providerName?: string;
  summarizeThread: (params: { model: string; text: string }) => Promise<{ summary: SummaryResult; usage?: SummaryUsage }>;
  generateKeySummary?: (params: { model: string; text: string }) => Promise<{ summary: LlmKeySummary; usage?: SummaryUsage }>;
  embedTexts: (params: { model: string; texts: string[]; dimensions?: number }) => Promise<number[][]>;
};

const summarySchema = z.object({
  problem_summary: z.string(),
  solution_summary: z.string(),
  maintainer_signal_summary: z.string(),
  dedupe_summary: z.string(),
});

export class OpenAiProvider implements AiProvider {
  readonly providerName = 'openai';

  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async summarizeThread(params: { model: string; text: string }): Promise<{ summary: SummaryResult; usage?: SummaryUsage }> {
    const format = zodTextFormat(summarySchema, 'ghcrawl_thread_summary');
    let lastError: Error | null = null;

    for (const [attemptIndex, maxOutputTokens] of [500, 900, 1400].entries()) {
      try {
        const response = await this.client.responses.create({
          model: params.model,
          input: [
            {
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: [
                    'Summarize this GitHub issue or pull request for automated duplicate detection. Your summary will be embedded and clustered.',
                    '',
                    'Structure your analysis:',
                    '1. First identify the COMPONENT or SUBSYSTEM (e.g., "Discord gateway", "WhatsApp delivery", "Telegram media handler", "CLI routing", "session management")',
                    '2. Then identify the SPECIFIC PROBLEM or CHANGE within that component',
                    '3. Combine into a clear dedupe_summary that starts with the component name',
                    '',
                    'Ignore completely: template boilerplate, testing instructions, checklists, environment info, reproduction steps, deployment notes, version numbers, cross-references.',
                    '',
                    'Return JSON with keys: problem_summary, solution_summary, maintainer_signal_summary, dedupe_summary.',
                    'Plain text, no markdown, 1-3 sentences each.',
                    'dedupe_summary format: "[Component]: [specific issue or change]" — this helps cluster by subsystem.',
                  ].join('\n'),
                },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: params.text }],
            },
          ],
          text: {
            format,
            verbosity: 'low',
          },
          max_output_tokens: maxOutputTokens,
        });

        const raw = response.output_text ?? '';
        const parsed = summarySchema.parse(JSON.parse(raw));

        return {
          summary: {
            problemSummary: parsed.problem_summary,
            solutionSummary: parsed.solution_summary,
            maintainerSignalSummary: parsed.maintainer_signal_summary,
            dedupeSummary: parsed.dedupe_summary,
          },
          usage: response.usage
            ? {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
                cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
                reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
              }
            : undefined,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attemptIndex === 2) {
          break;
        }
      }
    }

    throw new Error(`OpenAI summarization failed after 3 attempts: ${lastError?.message ?? 'unknown error'}`);
  }

  async generateKeySummary(params: { model: string; text: string }): Promise<{ summary: LlmKeySummary; usage?: SummaryUsage }> {
    const format = zodTextFormat(llmKeySummarySchema, 'ghcrawl_key_summary');
    let lastError: Error | null = null;

    for (const [attemptIndex, maxOutputTokens] of [240, 400, 600].entries()) {
      try {
        const response = await this.client.responses.create({
          model: params.model,
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: LLM_KEY_SUMMARY_SYSTEM_PROMPT }],
            },
            {
              role: 'user',
              content: [{ type: 'input_text', text: params.text }],
            },
          ],
          text: {
            format,
            verbosity: 'low',
          },
          max_output_tokens: maxOutputTokens,
        });

        const raw = response.output_text ?? '';
        return {
          summary: llmKeySummarySchema.parse(JSON.parse(raw)),
          usage: response.usage
            ? {
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
                cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
                reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens ?? 0,
              }
            : undefined,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attemptIndex === 2) {
          break;
        }
      }
    }

    throw new Error(`OpenAI key summarization failed after 3 attempts: ${lastError?.message ?? 'unknown error'}`);
  }

  async embedTexts(params: { model: string; texts: string[]; dimensions?: number }): Promise<number[][]> {
    if (params.texts.length === 0) {
      return [];
    }

    let lastError: Error | null = null;
    for (const attempt of [1, 2, 3, 4, 5]) {
      try {
        const response = await this.client.embeddings.create({
          model: params.model,
          input: params.texts,
          dimensions: params.dimensions,
        });

        return response.data.map((item) => item.embedding);
      } catch (error) {
        const shouldRetry =
          error instanceof RateLimitError ||
          error instanceof APIConnectionError ||
          error instanceof APIConnectionTimeoutError ||
          (error instanceof APIError && typeof error.status === 'number' && error.status >= 500);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!shouldRetry || attempt === 5) {
          break;
        }
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }

    throw new Error(`OpenAI embeddings failed after 5 attempts: ${lastError?.message ?? 'unknown error'}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
