import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

export type SummaryResult = {
  problemSummary: string;
  solutionSummary: string;
  maintainerSignalSummary: string;
  dedupeSummary: string;
};

export type AiProvider = {
  checkAuth: () => Promise<void>;
  summarizeThread: (params: { model: string; text: string }) => Promise<SummaryResult>;
  embedTexts: (params: { model: string; texts: string[] }) => Promise<number[][]>;
};

const summarySchema = z.object({
  problem_summary: z.string(),
  solution_summary: z.string(),
  maintainer_signal_summary: z.string(),
  dedupe_summary: z.string(),
});

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async checkAuth(): Promise<void> {
    await this.client.models.list();
  }

  async summarizeThread(params: { model: string; text: string }): Promise<SummaryResult> {
    const format = zodTextFormat(summarySchema, 'gitcrawl_thread_summary');
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
                  text:
                    'Summarize this GitHub issue or pull request thread. Return concise JSON only with keys problem_summary, solution_summary, maintainer_signal_summary, dedupe_summary. Each field should be plain text, no markdown, and usually 1-3 sentences.',
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
          problemSummary: parsed.problem_summary,
          solutionSummary: parsed.solution_summary,
          maintainerSignalSummary: parsed.maintainer_signal_summary,
          dedupeSummary: parsed.dedupe_summary,
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

  async embedTexts(params: { model: string; texts: string[] }): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: params.model,
      input: params.texts,
    });

    return response.data.map((item) => item.embedding);
  }
}
