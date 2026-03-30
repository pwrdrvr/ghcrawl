/**
 * Run a summarization prompt experiment against the 40 test threads.
 * Summarizes each thread, then judges the summary quality.
 *
 * Usage:
 *   node scripts/summarize-prompt-experiment.mjs <owner/repo> \
 *     --prompt-file prompts/v1.txt \
 *     --experiment-id baseline \
 *     --output-dir .context/compound-engineering/ce-optimize/summary-prompt/results
 *
 * Outputs: JSON file per experiment with all summaries and judge scores.
 * Requires OPENAI_API_KEY in environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');

const { GHCrawlService } = await import(serviceModulePath);

const TEST_THREAD_IDS = [
  // Issues
  15126, 8920, 19616, 16324, 10106, 14855, 18179, 2538, 9401, 9156,
  18848, 14856, 14863, 18847, 5022, 14862, 14859, 14142, 14861, 21902,
  // PRs
  22366, 17692, 20932, 13791, 4208, 9553, 8969, 17568, 4129, 21735,
  2463, 5418, 5796, 766, 17924, 5712, 21769, 8098, 539, 5565,
];

const DEFAULT_PROMPT = 'Summarize this GitHub issue or pull request thread. Return concise JSON only with keys problem_summary, solution_summary, maintainer_signal_summary, dedupe_summary. Each field should be plain text, no markdown, and usually 1-3 sentences.';

const JUDGE_PROMPT = `You are evaluating the quality of a dedupe_summary generated from a GitHub issue or pull request. The dedupe_summary will be embedded and used for clustering similar issues together.

A good dedupe_summary:
- Captures the CORE problem or change in 1-3 sentences
- Strips away template boilerplate, checklists, testing instructions, deployment notes
- Focuses on WHAT the issue/PR is about, not HOW it was found or tested
- Uses specific technical terms that would match similar issues (e.g., "Discord REST API proxy" not "network issue")
- Avoids generic phrases that could match unrelated issues
- Does NOT include version numbers, dates, or reproduction steps (these don't help deduplication)

Rate the dedupe_summary on a 1-5 scale:
- 5: Perfectly captures the core issue/change. Would cluster correctly with similar items. No noise.
- 4: Good signal, minor noise or missing detail that wouldn't hurt clustering much.
- 3: Adequate but includes some noise (testing details, template artifacts) or misses a key aspect.
- 2: Weak — too generic, too verbose, or includes significant noise that could cause false matches.
- 1: Poor — misses the point, is mostly boilerplate, or would cluster incorrectly.

Also report:
- has_boilerplate: boolean — does the summary contain template artifacts, checklists, or testing notes?
- signal_density: 1-5 — how much of the summary is useful signal vs noise?
- would_cluster_correctly: boolean — given the title, would this summary help find duplicates?

Return JSON only with keys: score, has_boilerplate, signal_density, would_cluster_correctly, reasoning (1 sentence).`;

function parseArgs(argv) {
  let repo = 'openclaw/openclaw';
  let promptFile = null;
  let promptText = null;
  let experimentId = 'unnamed';
  let outputDir = '.context/compound-engineering/ce-optimize/summary-prompt/results';
  let model = null;
  let judgeModel = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--prompt-file') { promptFile = argv[++index]; continue; }
    if (token === '--prompt') { promptText = argv[++index]; continue; }
    if (token === '--experiment-id') { experimentId = argv[++index]; continue; }
    if (token === '--output-dir') { outputDir = argv[++index]; continue; }
    if (token === '--model') { model = argv[++index]; continue; }
    if (token === '--judge-model') { judgeModel = argv[++index]; continue; }
    if (!token.startsWith('--')) repo = token;
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Expected owner/repo, received: ${repo}`);

  let systemPrompt = DEFAULT_PROMPT;
  if (promptFile) {
    systemPrompt = fs.readFileSync(path.resolve(promptFile), 'utf8').trim();
  } else if (promptText) {
    systemPrompt = promptText;
  }

  return { owner, repo: name, systemPrompt, experimentId, outputDir, model, judgeModel };
}

async function summarizeThread(client, model, systemPrompt, summaryInput, format, summarySchema) {
  for (const [attemptIndex, maxOutputTokens] of [500, 900, 1400].entries()) {
    try {
      const response = await client.responses.create({
        model,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: summaryInput }] },
        ],
        text: { format, verbosity: 'low' },
        max_output_tokens: maxOutputTokens,
      });
      const parsed = summarySchema.parse(JSON.parse(response.output_text ?? ''));
      return {
        summary: parsed,
        usage: response.usage ? {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        } : null,
      };
    } catch (error) {
      if (attemptIndex === 2) throw error;
    }
  }
}

async function judgeResult(client, judgeModel, title, body, dedupeSummary, judgeSchema) {
  const judgeInput = `Title: ${title}\n\nOriginal body (first 1000 chars): ${(body ?? '').slice(0, 1000)}\n\ndedupe_summary to evaluate: ${dedupeSummary}`;

  const response = await client.responses.create({
    model: judgeModel,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: JUDGE_PROMPT }] },
      { role: 'user', content: [{ type: 'input_text', text: judgeInput }] },
    ],
    text: {
      format: { type: 'json_schema', name: 'judge_result', strict: true, schema: {
        type: 'object',
        properties: {
          score: { type: 'integer' },
          has_boilerplate: { type: 'boolean' },
          signal_density: { type: 'integer' },
          would_cluster_correctly: { type: 'boolean' },
          reasoning: { type: 'string' },
        },
        required: ['score', 'has_boilerplate', 'signal_density', 'would_cluster_correctly', 'reasoning'],
        additionalProperties: false,
      }},
    },
    max_output_tokens: 800,
  });

  const text = response.output_text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    process.stderr.write(`  judge parse error, raw: ${text.slice(0, 200)}\n`);
    return { score: null, has_boilerplate: null, signal_density: null, would_cluster_correctly: null, reasoning: `parse error: ${text.slice(0, 100)}` };
  }
}

const args = parseArgs(process.argv.slice(2));

import { createRequire } from 'node:module';
const apiCoreRequire = createRequire(path.join(repoRoot, 'packages', 'api-core', 'package.json'));
const { default: OpenAI } = await import(apiCoreRequire.resolve('openai'));
const { zodTextFormat } = await import(apiCoreRequire.resolve('openai/helpers/zod'));
const { z } = await import(apiCoreRequire.resolve('zod'));

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY not set');

const client = new OpenAI({ apiKey });
const service = new GHCrawlService();
const summarySchema = z.object({
  problem_summary: z.string(),
  solution_summary: z.string(),
  maintainer_signal_summary: z.string(),
  dedupe_summary: z.string(),
});
const format = zodTextFormat(summarySchema, 'ghcrawl_thread_summary');

try {
  const repository = service.requireRepository(args.owner, args.repo);
  const model = args.model ?? service.config.summaryModel;
  const judgeModel = args.judgeModel ?? 'gpt-5-mini';

  const results = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const [index, threadId] of TEST_THREAD_IDS.entries()) {
    const thread = service.db.prepare(
      'SELECT id, number, kind, title, body, labels_json FROM threads WHERE id = ?'
    ).get(threadId);

    if (!thread) {
      process.stderr.write(`[${index + 1}/${TEST_THREAD_IDS.length}] thread ${threadId} not found, skipping\n`);
      continue;
    }

    const body = (thread.body ?? '').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
    const title = thread.title.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
    const labels = JSON.parse(thread.labels_json || '[]');
    const parts = [`title: ${title}`];
    if (body) parts.push(`body: ${body}`);
    if (labels.length > 0) parts.push(`labels: ${labels.join(', ')}`);
    const summaryInput = parts.join('\n\n');

    process.stderr.write(`[${index + 1}/${TEST_THREAD_IDS.length}] #${thread.number} (${thread.kind}) summarizing...\n`);

    try {
      const summaryResult = await summarizeThread(client, model, args.systemPrompt, summaryInput, format, summarySchema);
      if (summaryResult.usage) {
        totalInputTokens += summaryResult.usage.input_tokens;
        totalOutputTokens += summaryResult.usage.output_tokens;
      }

      process.stderr.write(`[${index + 1}/${TEST_THREAD_IDS.length}] #${thread.number} judging...\n`);
      const judgeResult_ = await judgeResult(client, judgeModel, title, thread.body, summaryResult.summary.dedupe_summary);

      results.push({
        thread_id: threadId,
        number: thread.number,
        kind: thread.kind,
        title: thread.title,
        summary: summaryResult.summary,
        judge: judgeResult_,
        usage: summaryResult.usage,
      });
    } catch (error) {
      process.stderr.write(`[${index + 1}/${TEST_THREAD_IDS.length}] #${thread.number} ERROR: ${error.message}\n`);
      results.push({
        thread_id: threadId,
        number: thread.number,
        kind: thread.kind,
        title: thread.title,
        error: error.message,
      });
    }
  }

  // Aggregate scores
  const scored = results.filter(r => r.judge?.score != null);
  const avgScore = scored.length > 0 ? scored.reduce((s, r) => s + r.judge.score, 0) / scored.length : 0;
  const avgSignalDensity = scored.length > 0 ? scored.reduce((s, r) => s + r.judge.signal_density, 0) / scored.length : 0;
  const boilerplateCount = scored.filter(r => r.judge.has_boilerplate).length;
  const wouldClusterCount = scored.filter(r => r.judge.would_cluster_correctly).length;

  const experiment = {
    experiment_id: args.experimentId,
    model,
    judge_model: judgeModel,
    system_prompt: args.systemPrompt,
    timestamp: new Date().toISOString(),
    aggregate: {
      avg_score: Math.round(avgScore * 100) / 100,
      avg_signal_density: Math.round(avgSignalDensity * 100) / 100,
      boilerplate_count: boilerplateCount,
      boilerplate_pct: Math.round((boilerplateCount / Math.max(scored.length, 1)) * 100),
      would_cluster_correctly_pct: Math.round((wouldClusterCount / Math.max(scored.length, 1)) * 100),
      total_scored: scored.length,
      total_errors: results.length - scored.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
    },
    results,
  };

  // Save to disk
  fs.mkdirSync(path.resolve(args.outputDir), { recursive: true });
  const outputPath = path.resolve(args.outputDir, `${args.experimentId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(experiment, null, 2));
  process.stderr.write(`\nResults saved to ${outputPath}\n`);

  // Print summary to stdout
  process.stdout.write(JSON.stringify({
    experiment_id: args.experimentId,
    ...experiment.aggregate,
    prompt_preview: args.systemPrompt.slice(0, 120),
  }, null, 2) + '\n');
} finally {
  service.close();
}
