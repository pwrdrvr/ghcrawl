/**
 * Summarize a single thread with an optional system prompt override.
 * Outputs the summary JSON to stdout. Does NOT save to DB.
 *
 * Usage:
 *   node scripts/summarize-single.mjs <owner/repo> <thread_number> [--prompt-file <path>]
 *   node scripts/summarize-single.mjs <owner/repo> <thread_number> [--prompt "<text>"]
 *
 * Requires OPENAI_API_KEY in the environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');
const providerModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'openai', 'provider.js');

const { GHCrawlService } = await import(serviceModulePath);
const { OpenAiProvider } = await import(providerModulePath);

function parseArgs(argv) {
  let repo = null;
  let threadNumber = null;
  let promptFile = null;
  let promptText = null;
  let model = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--prompt-file') { promptFile = argv[++index]; continue; }
    if (token === '--prompt') { promptText = argv[++index]; continue; }
    if (token === '--model') { model = argv[++index]; continue; }
    if (!token.startsWith('--')) {
      if (!repo) { repo = token; continue; }
      if (!threadNumber) { threadNumber = Number(token); continue; }
    }
  }

  if (!repo || !threadNumber) {
    throw new Error('Usage: summarize-single.mjs <owner/repo> <thread_number> [--prompt-file <path>] [--prompt "<text>"] [--model <model>]');
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Expected owner/repo, received: ${repo}`);

  let systemPrompt = null;
  if (promptFile) {
    systemPrompt = fs.readFileSync(promptFile, 'utf8').trim();
  } else if (promptText) {
    systemPrompt = promptText;
  }

  return { owner, repo: name, threadNumber, systemPrompt, model };
}

const args = parseArgs(process.argv.slice(2));

const service = new GHCrawlService();
try {
  const repository = service.requireRepository(args.owner, args.repo);

  // Load thread data
  const thread = service.db.prepare(
    'SELECT id, number, title, body, labels_json FROM threads WHERE repo_id = ? AND number = ?'
  ).get(repository.id, args.threadNumber);

  if (!thread) {
    throw new Error(`Thread #${args.threadNumber} not found in ${args.owner}/${args.repo}`);
  }

  // Build summary input (same as service.buildSummarySource but accessible here)
  const body = (thread.body ?? '').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
  const title = thread.title.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
  const labels = JSON.parse(thread.labels_json || '[]');

  const parts = [`title: ${title}`];
  if (body) parts.push(`body: ${body}`);
  if (labels.length > 0) parts.push(`labels: ${labels.join(', ')}`);
  const summaryInput = parts.join('\n\n');

  // Default system prompt (matches current production prompt)
  const defaultPrompt = 'Summarize this GitHub issue or pull request thread. Return concise JSON only with keys problem_summary, solution_summary, maintainer_signal_summary, dedupe_summary. Each field should be plain text, no markdown, and usually 1-3 sentences.';

  const systemPrompt = args.systemPrompt ?? defaultPrompt;
  const model = args.model ?? service.config.summaryModel;

  // Call OpenAI directly with optional prompt override
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Set the env var before running this script.');
  }

  const { default: OpenAI } = await import('openai');
  const { zodTextFormat } = await import('openai/helpers/zod');
  const { z } = await import('zod');

  const summarySchema = z.object({
    problem_summary: z.string(),
    solution_summary: z.string(),
    maintainer_signal_summary: z.string(),
    dedupe_summary: z.string(),
  });

  const client = new OpenAI({ apiKey });
  const format = zodTextFormat(summarySchema, 'ghcrawl_thread_summary');

  const response = await client.responses.create({
    model,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: systemPrompt }],
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: summaryInput }],
      },
    ],
    text: { format, verbosity: 'low' },
    max_output_tokens: 900,
  });

  const parsed = summarySchema.parse(JSON.parse(response.output_text ?? ''));

  const result = {
    thread_number: args.threadNumber,
    thread_id: thread.id,
    title: thread.title,
    model,
    system_prompt_preview: systemPrompt.slice(0, 100) + (systemPrompt.length > 100 ? '...' : ''),
    input_length: summaryInput.length,
    summary: parsed,
    usage: response.usage ? {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: response.usage.total_tokens,
    } : null,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  service.close();
}
