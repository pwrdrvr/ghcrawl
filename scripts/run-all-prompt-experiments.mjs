#!/usr/bin/env node
/**
 * Run all prompt experiments sequentially.
 * Usage: node scripts/op-run.mjs run -- node scripts/run-all-prompt-experiments.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptDir = path.join(repoRoot, '.context', 'compound-engineering', 'ce-optimize', 'summary-prompt', 'prompts');
const resultsDir = path.join(repoRoot, '.context', 'compound-engineering', 'ce-optimize', 'summary-prompt', 'results');

const promptFiles = fs.readdirSync(promptDir)
  .filter(f => f.endsWith('.txt'))
  .sort();

// Check which experiments already have results
const existing = new Set(
  fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
    : []
);

const summaryTable = [];

for (const file of promptFiles) {
  const experimentId = file.replace('.txt', '');

  if (existing.has(experimentId)) {
    // Load existing result
    const result = JSON.parse(fs.readFileSync(path.join(resultsDir, `${experimentId}.json`), 'utf8'));
    const scored = result.results.filter(r => r.judge?.score != null);
    if (scored.length >= 30) {
      process.stderr.write(`[SKIP] ${experimentId} — already has ${scored.length} scored results\n`);
      summaryTable.push({ experiment_id: experimentId, ...result.aggregate, status: 'cached' });
      continue;
    }
    process.stderr.write(`[RERUN] ${experimentId} — only ${scored.length} scored results, rerunning\n`);
  }

  process.stderr.write(`\n=== Running ${experimentId} ===\n`);
  const promptPath = path.join(promptDir, file);

  try {
    const stdout = execFileSync('node', [
      path.join(repoRoot, 'scripts', 'summarize-prompt-experiment.mjs'),
      'openclaw/openclaw',
      '--prompt-file', promptPath,
      '--experiment-id', experimentId,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 1_800_000,
      env: process.env,
    });

    const result = JSON.parse(stdout.trim());
    summaryTable.push({ ...result, status: 'completed' });
  } catch (error) {
    process.stderr.write(`[ERROR] ${experimentId}: ${error.message}\n`);
    summaryTable.push({ experiment_id: experimentId, status: 'error', error: error.message });
  }
}

process.stderr.write('\n\n=== SUMMARY TABLE ===\n');
process.stdout.write(JSON.stringify(summaryTable, null, 2) + '\n');
