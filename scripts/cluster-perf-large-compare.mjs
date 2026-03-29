import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const apiCoreRoot = path.join(repoRoot, 'packages', 'api-core');
const perfConfigPath = path.join(apiCoreRoot, 'src', 'cluster', 'perf-large.json');
const perfEntryPath = path.join(apiCoreRoot, 'dist', 'cluster', 'perf.integration.js');

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs)) return 'n/a';
  if (durationMs < 1000) return `${durationMs.toFixed(1)} ms`;
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatPercent(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function runPerf({ backend, outputPath }) {
  const env = {
    ...process.env,
    GHCRAWL_CLUSTER_PERF_BOOTSTRAP: '1',
    GHCRAWL_CLUSTER_PERF_IGNORE_THRESHOLD: '1',
    GHCRAWL_CLUSTER_PERF_CONFIG_PATH: perfConfigPath,
    GHCRAWL_CLUSTER_PERF_OUTPUT_PATH: outputPath,
  };

  if (backend === 'vectorlite') {
    env.GHCRAWL_CLUSTER_PERF_BACKEND = 'vectorlite';
  } else {
    delete env.GHCRAWL_CLUSTER_PERF_BACKEND;
  }

  execFileSync(process.execPath, [perfEntryPath], {
    cwd: apiCoreRoot,
    env,
    stdio: 'inherit',
  });

  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-cluster-perf-large-'));
  try {
    const exactOutputPath = path.join(tempRoot, 'exact.json');
    const vectorliteOutputPaths = [1, 2, 3].map((attempt) => path.join(tempRoot, `vectorlite-${attempt}.json`));

    const exact = runPerf({ backend: 'exact', outputPath: exactOutputPath });
    let vectorlite = null;
    for (const outputPath of vectorliteOutputPaths) {
      vectorlite = runPerf({ backend: 'vectorlite', outputPath });
    }

    if (!vectorlite) {
      throw new Error('Vectorlite perf result was not produced.');
    }

    const exactMedianMs = exact.result.medianMs;
    const vectorliteMedianMs = vectorlite.result.medianMs;
    const deltaMs = vectorliteMedianMs - exactMedianMs;
    const deltaPercent = exactMedianMs > 0 ? (deltaMs / exactMedianMs) * 100 : 0;
    const speedup = vectorliteMedianMs > 0 ? exactMedianMs / vectorliteMedianMs : 0;

    const lines = [
      '## Large Cluster Perf Comparison',
      '',
      `- Fixture config: ${path.relative(repoRoot, perfConfigPath)}`,
      `- Exact median (cluster-only): ${formatDurationMs(exactMedianMs)}`,
      `- Exact median (total run): ${formatDurationMs(exact.result.totalMedianMs)}`,
      `- Exact edge-build median: ${formatDurationMs(exact.result.edgeBuildMedianMs)}`,
      `- Exact cluster-assembly median: ${formatDurationMs(exact.result.clusterBuildMedianMs)}`,
      `- Exact median peak RSS: ${formatBytes(exact.result.medianPeakRssBytes)}`,
      `- Exact median peak heap used: ${formatBytes(exact.result.medianPeakHeapUsedBytes)}`,
      `- Vectorlite median (cluster-only, run 3/3): ${formatDurationMs(vectorliteMedianMs)}`,
      `- Vectorlite median (total run, run 3/3): ${formatDurationMs(vectorlite.result.totalMedianMs)}`,
      `- Vectorlite setup median: ${formatDurationMs(vectorlite.result.setupMedianMs)}`,
      `- Vectorlite index-build median: ${formatDurationMs(vectorlite.result.indexBuildMedianMs)}`,
      `- Vectorlite query median: ${formatDurationMs(vectorlite.result.queryMedianMs)}`,
      `- Vectorlite cluster-assembly median: ${formatDurationMs(vectorlite.result.clusterBuildMedianMs)}`,
      `- Vectorlite median peak RSS: ${formatBytes(vectorlite.result.medianPeakRssBytes)}`,
      `- Vectorlite median peak heap used: ${formatBytes(vectorlite.result.medianPeakHeapUsedBytes)}`,
      `- Vectorlite delta vs exact: ${formatDurationMs(deltaMs)} (${formatPercent(deltaPercent)})`,
      `- Speedup: ${speedup.toFixed(2)}x`,
      '',
      '### Exact Summary',
      '',
      exact.summary.trim(),
      '',
      '### Vectorlite Summary (run 3/3)',
      '',
      vectorlite.summary.trim(),
      '',
    ];

    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
