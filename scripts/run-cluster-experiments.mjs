#!/usr/bin/env node
/**
 * Run all clustering experiments sequentially.
 * Usage: node scripts/run-cluster-experiments.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(repoRoot, '.context', 'compound-engineering', 'ce-optimize', 'embedding-clustering', 'results');

const EXPERIMENTS = [
  // Baseline: all 3 source kinds, max aggregation
  { id: 'baseline-all-max', args: ['--aggregation', 'max'] },

  // Source selection experiments
  { id: 'source-dedupe-only', args: ['--source-kinds', 'dedupe_summary', '--aggregation', 'max'] },
  { id: 'source-title-dedupe', args: ['--source-kinds', 'title,dedupe_summary', '--aggregation', 'max'] },
  { id: 'source-body-dedupe', args: ['--source-kinds', 'body,dedupe_summary', '--aggregation', 'max'] },

  // Aggregation method experiments (all 3 source kinds)
  { id: 'agg-mean', args: ['--aggregation', 'mean'] },
  { id: 'agg-weighted', args: ['--aggregation', 'weighted'] },
  { id: 'agg-weighted-heavy-summary', args: ['--aggregation', 'weighted', '--weights', '{"dedupe_summary":0.7,"title":0.2,"body":0.1}'] },
  { id: 'agg-min-of-2', args: ['--aggregation', 'min-of-2'] },
  { id: 'agg-boost', args: ['--aggregation', 'boost'] },

  // Parameter tuning (using dedupe_summary only, which is likely cleanest signal)
  { id: 'param-low-threshold', args: ['--source-kinds', 'dedupe_summary', '--threshold', '0.75'] },
  { id: 'param-high-threshold', args: ['--source-kinds', 'dedupe_summary', '--threshold', '0.88'] },
  { id: 'param-more-neighbors', args: ['--source-kinds', 'dedupe_summary', '--k', '12'] },
  { id: 'param-large-clusters', args: ['--source-kinds', 'dedupe_summary', '--max-cluster-size', '400'] },

  // Best combos (will add based on early results)
  { id: 'combo-dedupe-weighted-low', args: ['--source-kinds', 'title,dedupe_summary', '--aggregation', 'weighted', '--threshold', '0.78'] },
  { id: 'combo-all-boost-low', args: ['--aggregation', 'boost', '--threshold', '0.78'] },
];

// Check which experiments already have results
const existing = new Set(
  fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
    : []
);

const summaryTable = [];
const commonArgs = [
  'openclaw/openclaw',
  '--cluster-mode', 'bounded',
  '--max-cluster-size', '200',
];

for (const experiment of EXPERIMENTS) {
  if (existing.has(experiment.id)) {
    try {
      const result = JSON.parse(fs.readFileSync(path.join(resultsDir, `${experiment.id}.json`), 'utf8'));
      if (result.judge?.mean_score != null) {
        process.stderr.write(`[SKIP] ${experiment.id} — already has judge results\n`);
        summaryTable.push({ experiment_id: experiment.id, ...result.metrics, ...result.judge, status: 'cached' });
        continue;
      }
    } catch { /* rerun */ }
  }

  process.stderr.write(`\n=== Running ${experiment.id} ===\n`);

  // Override max-cluster-size if the experiment specifies it
  const expArgs = [...experiment.args];
  const hasMaxCluster = expArgs.includes('--max-cluster-size');

  try {
    const allArgs = [
      path.join(repoRoot, 'scripts', 'cluster-judge-experiment.mjs'),
      ...commonArgs,
      '--experiment-id', experiment.id,
      ...(hasMaxCluster ? [] : ['--max-cluster-size', '200']),
      ...expArgs,
    ];

    const stdout = execFileSync('node', allArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 600_000,
      env: process.env,
    });

    const result = JSON.parse(stdout.trim());
    summaryTable.push({ ...result, status: 'completed' });
  } catch (error) {
    process.stderr.write(`[ERROR] ${experiment.id}: ${error.message}\n`);
    summaryTable.push({ experiment_id: experiment.id, status: 'error', error: error.message });
  }
}

process.stderr.write('\n\n=== SUMMARY TABLE ===\n');
process.stdout.write(JSON.stringify(summaryTable, null, 2) + '\n');
