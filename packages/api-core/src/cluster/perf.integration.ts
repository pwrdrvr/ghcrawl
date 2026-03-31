import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { GHCrawlService } from '../service.js';

type EmbeddingSourceKind = 'title' | 'body' | 'dedupe_summary';

type PerfBaseline = {
  schemaVersion: number;
  fixture: {
    clusterCount: number;
    threadsPerCluster: number;
    clusterBlockWidth: number;
    noiseDimensions: number;
    assertExactClusterCount?: boolean;
    sourceKinds: EmbeddingSourceKind[];
    k: number;
    minScore: number;
  };
  benchmark: {
    warmupRuns: number;
    runsPerSample: number;
    minSamples: number;
    maxSamples: number;
    maxTotalMs: number;
  };
  baseline: {
    fixtureMedianMs: number;
    projectedOpenclawMs: number;
  };
  thresholds: {
    maxRegressionPercent: number;
  };
};

type PerfRunResult = {
  backend: 'exact' | 'vectorlite';
  timingBasis: 'cluster-only';
  sampleDurationsMs: number[];
  totalSampleDurationsMs: number[];
  loadSampleDurationsMs: number[];
  setupSampleDurationsMs: number[];
  edgeBuildSampleDurationsMs: number[];
  indexBuildSampleDurationsMs: number[];
  querySampleDurationsMs: number[];
  clusterBuildSampleDurationsMs: number[];
  peakRssBytesSamples: number[];
  peakHeapUsedBytesSamples: number[];
  medianMs: number;
  totalMedianMs: number;
  loadMedianMs: number;
  setupMedianMs: number;
  edgeBuildMedianMs: number;
  indexBuildMedianMs: number;
  queryMedianMs: number;
  clusterBuildMedianMs: number;
  medianPeakRssBytes: number;
  medianPeakHeapUsedBytes: number;
  baselineMedianMs: number;
  deltaMs: number;
  deltaPercent: number;
  projectedOpenclawMs: number;
  projectedBaselineOpenclawMs: number;
  projectedDeltaMs: number;
  projectedDeltaPercent: number;
  samples: number;
  runsPerSample: number;
  threadCount: number;
  sourceKinds: EmbeddingSourceKind[];
  maxRegressionPercent: number;
};

type SuggestedBaseline = {
  fixtureMedianMs: number;
  projectedOpenclawMs: number;
};

const DEFAULT_BASELINE_PATH = fileURLToPath(new URL('./perf-baseline.json', import.meta.url));

function getBaselinePath(): string {
  const configuredPath = process.env.GHCRAWL_CLUSTER_PERF_CONFIG_PATH?.trim();
  return configuredPath ? path.resolve(configuredPath) : DEFAULT_BASELINE_PATH;
}

function loadBaseline(): PerfBaseline {
  return JSON.parse(fs.readFileSync(getBaselinePath(), 'utf8')) as PerfBaseline;
}

function shouldBootstrapBaseline(): boolean {
  return process.env.GHCRAWL_CLUSTER_PERF_BOOTSTRAP === '1';
}

function shouldIgnoreRegressionThreshold(): boolean {
  return process.env.GHCRAWL_CLUSTER_PERF_IGNORE_THRESHOLD === '1';
}

function getPerfBackend(): 'exact' | 'vectorlite' {
  return process.env.GHCRAWL_CLUSTER_PERF_BACKEND === 'vectorlite' ? 'vectorlite' : 'exact';
}

function assertBenchmarkShape(
  result: { clusters: number; edges: number },
  baseline: PerfBaseline,
  backend: 'exact' | 'vectorlite',
): void {
  if (backend === 'exact' && baseline.fixture.assertExactClusterCount !== false) {
    assert.equal(result.clusters, baseline.fixture.clusterCount);
  } else {
    assert.ok(result.clusters > 0);
  }
  assert.ok(result.edges > baseline.fixture.clusterCount);
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return 'n/a';
  if (durationMs < 1000) {
    return `${durationMs.toFixed(1)} ms`;
  }
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(2)} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle] ?? 0;
}

function roundFixtureMedianMs(value: number): number {
  return Number(value.toFixed(1));
}

function roundProjectedOpenclawMs(value: number): number {
  return Math.round(value);
}

function buildSuggestedBaseline(result: PerfRunResult): SuggestedBaseline | null {
  const shouldSuggest = result.deltaPercent < 0 || result.baselineMedianMs === result.medianMs;
  if (!shouldSuggest) {
    return null;
  }

  return {
    fixtureMedianMs: roundFixtureMedianMs(result.medianMs),
    projectedOpenclawMs: roundProjectedOpenclawMs(result.projectedOpenclawMs),
  };
}

function createGitHubStub(): GHCrawlService['github'] {
  return {
    checkAuth: async () => undefined,
    getRepo: async () => ({}),
    listRepositoryIssues: async () => [],
    getIssue: async () => ({}),
    getPull: async () => ({}),
    listIssueComments: async () => [],
    listPullReviews: async () => [],
    listPullReviewComments: async () => [],
  };
}

function createService(dbPath: string): GHCrawlService {
  return new GHCrawlService({
    config: {
      workspaceRoot: process.cwd(),
      configDir: path.dirname(dbPath),
      configPath: path.join(path.dirname(dbPath), 'config.json'),
      configFileExists: true,
      dbPath,
      dbPathSource: 'config',
      apiPort: 5179,
      githubToken: 'ghp_testtoken1234567890',
      githubTokenSource: 'config',
      secretProvider: 'plaintext',
      tuiPreferences: {},
      openaiApiKeySource: 'none',
      summaryModel: 'gpt-5-mini',
      embedModel: 'text-embedding-3-large',
      embedBatchSize: 2,
      embedConcurrency: 2,
      embedMaxUnread: 4,
      openSearchIndex: 'ghcrawl-threads',
    },
    github: createGitHubStub(),
  });
}

function deterministicNoise(seed: number): number {
  const next = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (next / 0xffffffff - 0.5) * 0.025;
}

function buildDeterministicEmbedding(params: {
  clusterIndex: number;
  threadOffset: number;
  sourceIndex: number;
  clusterCount: number;
  clusterBlockWidth: number;
  noiseDimensions: number;
  sourceKinds: EmbeddingSourceKind[];
}): number[] {
  const dimensions = params.clusterCount * params.clusterBlockWidth + params.noiseDimensions + params.sourceKinds.length;
  const embedding = new Array<number>(dimensions).fill(0);
  const clusterBase = params.clusterIndex * params.clusterBlockWidth;
  const sourceBias = 0.02 * (params.sourceIndex + 1);
  const memberBias = 0.01 * ((params.threadOffset % 5) + 1);

  embedding[clusterBase] = 1;
  if (params.clusterBlockWidth > 1) embedding[clusterBase + 1] = 0.72 + sourceBias;
  if (params.clusterBlockWidth > 2) embedding[clusterBase + 2] = 0.48 + memberBias;
  if (params.clusterBlockWidth > 3) embedding[clusterBase + 3] = 0.28 + sourceBias + memberBias;

  const sourceOffset = params.clusterCount * params.clusterBlockWidth + params.sourceIndex;
  embedding[sourceOffset] = 0.12 + sourceBias;

  const noiseBase = params.clusterCount * params.clusterBlockWidth + params.sourceKinds.length;
  for (let index = 0; index < params.noiseDimensions; index += 1) {
    const seed = params.clusterIndex * 10_000 + params.threadOffset * 100 + params.sourceIndex * 10 + index;
    embedding[noiseBase + index] = deterministicNoise(seed);
  }

  return embedding;
}

function seedBenchmarkDatabase(dbPath: string, baseline: PerfBaseline): void {
  const service = createService(dbPath);
  const threadCount = baseline.fixture.clusterCount * baseline.fixture.threadsPerCluster;
  const now = '2026-03-12T12:00:00Z';

  try {
    service.db
      .prepare(
        `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', now);

    const insertThread = service.db.prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
        merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEmbedding = service.db.prepare(
      `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let clusterIndex = 0; clusterIndex < baseline.fixture.clusterCount; clusterIndex += 1) {
      for (let threadOffset = 0; threadOffset < baseline.fixture.threadsPerCluster; threadOffset += 1) {
        const threadId = clusterIndex * baseline.fixture.threadsPerCluster + threadOffset + 1;
        const threadNumber = 10_000 + threadId;
        const kind = threadOffset % 3 === 0 ? 'pull_request' : 'issue';
        insertThread.run(
          threadId,
          1,
          `gh-${threadId}`,
          threadNumber,
          kind,
          'open',
          `Cluster ${clusterIndex + 1} thread ${threadOffset + 1}`,
          `Deterministic benchmark fixture body for cluster ${clusterIndex + 1}, thread ${threadOffset + 1}.`,
          `user${(threadId % 17) + 1}`,
          'User',
          `https://github.com/openclaw/openclaw/${kind === 'issue' ? 'issues' : 'pull'}/${threadNumber}`,
          '[]',
          '[]',
          '{}',
          `hash-${threadId}`,
          0,
          now,
          now,
          null,
          null,
          now,
          now,
          now,
        );

        for (const [sourceIndex, sourceKind] of baseline.fixture.sourceKinds.entries()) {
          const embedding = buildDeterministicEmbedding({
            clusterIndex,
            threadOffset,
            sourceIndex,
            clusterCount: baseline.fixture.clusterCount,
            clusterBlockWidth: baseline.fixture.clusterBlockWidth,
            noiseDimensions: baseline.fixture.noiseDimensions,
            sourceKinds: baseline.fixture.sourceKinds,
          });
          insertEmbedding.run(
            threadId,
            sourceKind,
            'text-embedding-3-large',
            embedding.length,
            `hash-${threadId}-${sourceKind}`,
            JSON.stringify(embedding),
            now,
            now,
          );
        }
      }
    }

    const countRow = service.db.prepare('select count(*) as count from threads').get() as { count: number };
    assert.equal(threadCount, countRow.count);
  } finally {
    service.close();
  }
}

async function runSingleCluster(
  dbPath: string,
  baseline: PerfBaseline,
  backend: 'exact' | 'vectorlite',
): Promise<{
  durationMs: number;
  totalDurationMs: number;
  loadMs: number;
  setupMs: number;
  edgeBuildMs: number;
  indexBuildMs: number;
  queryMs: number;
  clusterBuildMs: number;
  peakRssBytes: number;
  peakHeapUsedBytes: number;
  clusters: number;
  edges: number;
}> {
  const service = createService(dbPath);
  try {
    // clusterExperiment may not exist on older branches (e.g. base worktree in CI)
    if (typeof service.clusterExperiment !== 'function') {
      const startedAt = performance.now();
      const result = await service.clusterRepository({
        owner: 'openclaw',
        repo: 'openclaw',
        k: baseline.fixture.k,
        minScore: baseline.fixture.minScore,
      });
      const durationMs = performance.now() - startedAt;
      return {
        durationMs,
        totalDurationMs: durationMs,
        loadMs: 0,
        setupMs: 0,
        edgeBuildMs: durationMs,
        indexBuildMs: 0,
        queryMs: 0,
        clusterBuildMs: 0,
        peakRssBytes: 0,
        peakHeapUsedBytes: 0,
        clusters: result.clusters,
        edges: result.edges,
      };
    }
    const result = service.clusterExperiment({
      owner: 'openclaw',
      repo: 'openclaw',
      backend,
      k: baseline.fixture.k,
      minScore: baseline.fixture.minScore,
    });
    return {
      durationMs: result.durationMs,
      totalDurationMs: result.totalDurationMs,
      loadMs: result.loadMs,
      setupMs: result.setupMs,
      edgeBuildMs: result.edgeBuildMs,
      indexBuildMs: result.indexBuildMs,
      queryMs: result.queryMs,
      clusterBuildMs: result.clusterBuildMs,
      peakRssBytes: result.memory.peakRssBytes,
      peakHeapUsedBytes: result.memory.peakHeapUsedBytes,
      clusters: result.clusters,
      edges: result.edges,
    };
  } finally {
    service.close();
  }
}

async function measureBenchmark(baseline: PerfBaseline): Promise<PerfRunResult> {
  const backend = getPerfBackend();
  if (baseline.baseline.fixtureMedianMs <= 0 && !shouldBootstrapBaseline()) {
    throw new Error(
      `Cluster perf baseline is not set in ${getBaselinePath()}. Run the benchmark once, then record fixtureMedianMs before enforcing regressions.`,
    );
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-cluster-perf-'));
  const seedDbPath = path.join(tempRoot, 'seed.sqlite');
  try {
    seedBenchmarkDatabase(seedDbPath, baseline);

    const warmupRuns = baseline.benchmark.warmupRuns;
    const runsPerSample = baseline.benchmark.runsPerSample;
    const sampleDurationsMs: number[] = [];
    const totalSampleDurationsMs: number[] = [];
    const loadSampleDurationsMs: number[] = [];
    const setupSampleDurationsMs: number[] = [];
    const edgeBuildSampleDurationsMs: number[] = [];
    const indexBuildSampleDurationsMs: number[] = [];
    const querySampleDurationsMs: number[] = [];
    const clusterBuildSampleDurationsMs: number[] = [];
    const peakRssBytesSamples: number[] = [];
    const peakHeapUsedBytesSamples: number[] = [];
    const benchmarkStartedAt = performance.now();
    let runCounter = 0;

    for (let warmupIndex = 0; warmupIndex < warmupRuns; warmupIndex += 1) {
      const warmupDbPath = path.join(tempRoot, `warmup-${warmupIndex}.sqlite`);
      fs.copyFileSync(seedDbPath, warmupDbPath);
      const warmupResult = await runSingleCluster(warmupDbPath, baseline, backend);
      assertBenchmarkShape(warmupResult, baseline, backend);
    }

    while (sampleDurationsMs.length < baseline.benchmark.maxSamples) {
      let sampleDurationMs = 0;
      let totalSampleDurationMs = 0;
      let loadSampleDurationMs = 0;
      let setupSampleDurationMs = 0;
      let edgeBuildSampleDurationMs = 0;
      let indexBuildSampleDurationMs = 0;
      let querySampleDurationMs = 0;
      let clusterBuildSampleDurationMs = 0;
      let samplePeakRssBytes = 0;
      let samplePeakHeapUsedBytes = 0;
      for (let runIndex = 0; runIndex < runsPerSample; runIndex += 1) {
        const runDbPath = path.join(tempRoot, `run-${runCounter}.sqlite`);
        runCounter += 1;
        fs.copyFileSync(seedDbPath, runDbPath);
        const result = await runSingleCluster(runDbPath, baseline, backend);
        assertBenchmarkShape(result, baseline, backend);
        sampleDurationMs += result.durationMs;
        totalSampleDurationMs += result.totalDurationMs;
        loadSampleDurationMs += result.loadMs;
        setupSampleDurationMs += result.setupMs;
        edgeBuildSampleDurationMs += result.edgeBuildMs;
        indexBuildSampleDurationMs += result.indexBuildMs;
        querySampleDurationMs += result.queryMs;
        clusterBuildSampleDurationMs += result.clusterBuildMs;
        samplePeakRssBytes = Math.max(samplePeakRssBytes, result.peakRssBytes);
        samplePeakHeapUsedBytes = Math.max(samplePeakHeapUsedBytes, result.peakHeapUsedBytes);
      }
      sampleDurationsMs.push(sampleDurationMs);
      totalSampleDurationsMs.push(totalSampleDurationMs);
      loadSampleDurationsMs.push(loadSampleDurationMs);
      setupSampleDurationsMs.push(setupSampleDurationMs);
      edgeBuildSampleDurationsMs.push(edgeBuildSampleDurationMs);
      indexBuildSampleDurationsMs.push(indexBuildSampleDurationMs);
      querySampleDurationsMs.push(querySampleDurationMs);
      clusterBuildSampleDurationsMs.push(clusterBuildSampleDurationMs);
      peakRssBytesSamples.push(samplePeakRssBytes);
      peakHeapUsedBytesSamples.push(samplePeakHeapUsedBytes);

      const elapsedMs = performance.now() - benchmarkStartedAt;
      if (sampleDurationsMs.length >= baseline.benchmark.minSamples && elapsedMs >= baseline.benchmark.maxTotalMs) {
        break;
      }
    }

    const medianMs = median(sampleDurationsMs);
    const totalMedianMs = median(totalSampleDurationsMs);
    const loadMedianMs = median(loadSampleDurationsMs);
    const setupMedianMs = median(setupSampleDurationsMs);
    const edgeBuildMedianMs = median(edgeBuildSampleDurationsMs);
    const indexBuildMedianMs = median(indexBuildSampleDurationsMs);
    const queryMedianMs = median(querySampleDurationsMs);
    const clusterBuildMedianMs = median(clusterBuildSampleDurationsMs);
    const medianPeakRssBytes = median(peakRssBytesSamples);
    const medianPeakHeapUsedBytes = median(peakHeapUsedBytesSamples);
    const baselineMedianMs = baseline.baseline.fixtureMedianMs > 0 ? baseline.baseline.fixtureMedianMs : medianMs;
    const deltaMs = medianMs - baselineMedianMs;
    const deltaPercent = baselineMedianMs > 0 ? (deltaMs / baselineMedianMs) * 100 : 0;
    const projectedOpenclawMs = baseline.baseline.projectedOpenclawMs * (medianMs / baselineMedianMs);
    const projectedBaselineOpenclawMs = baseline.baseline.projectedOpenclawMs;
    const projectedDeltaMs = projectedOpenclawMs - projectedBaselineOpenclawMs;
    const projectedDeltaPercent = (projectedDeltaMs / projectedBaselineOpenclawMs) * 100;

    return {
      backend,
      timingBasis: 'cluster-only',
      sampleDurationsMs,
      totalSampleDurationsMs,
      loadSampleDurationsMs,
      setupSampleDurationsMs,
      edgeBuildSampleDurationsMs,
      indexBuildSampleDurationsMs,
      querySampleDurationsMs,
      clusterBuildSampleDurationsMs,
      peakRssBytesSamples,
      peakHeapUsedBytesSamples,
      medianMs,
      totalMedianMs,
      loadMedianMs,
      setupMedianMs,
      edgeBuildMedianMs,
      indexBuildMedianMs,
      queryMedianMs,
      clusterBuildMedianMs,
      medianPeakRssBytes,
      medianPeakHeapUsedBytes,
      baselineMedianMs,
      deltaMs,
      deltaPercent,
      projectedOpenclawMs,
      projectedBaselineOpenclawMs,
      projectedDeltaMs,
      projectedDeltaPercent,
      samples: sampleDurationsMs.length,
      runsPerSample,
      threadCount: baseline.fixture.clusterCount * baseline.fixture.threadsPerCluster,
      sourceKinds: baseline.fixture.sourceKinds,
      maxRegressionPercent: baseline.thresholds.maxRegressionPercent,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function buildSummary(result: PerfRunResult): string {
  const status = result.deltaPercent > result.maxRegressionPercent ? 'FAIL' : 'PASS';
  const sampleList = result.sampleDurationsMs.map((value) => formatDurationMs(value)).join(', ');
  const suggestedBaseline = buildSuggestedBaseline(result);
  const timingLabel = 'Fixture median';
  const bootstrapLine =
    result.baselineMedianMs === result.medianMs
      ? '- Bootstrap mode: using the current fixture median as the provisional baseline'
      : null;
  const suggestedBaselineLine = suggestedBaseline
    ? `- Suggested baseline update: ${JSON.stringify(suggestedBaseline)}`
    : null;
  return [
    '## Cluster Performance',
    '',
    `- Backend: ${result.backend}`,
    `- Timing basis: ${result.timingBasis}`,
    `- Status: ${status}`,
    `- Fixture median (cluster-only): ${formatDurationMs(result.medianMs)} (${result.samples} samples, ${result.runsPerSample} cluster rebuilds/sample)`,
    `- Fixture median (total run): ${formatDurationMs(result.totalMedianMs)}`,
    `- Fixture median load stage: ${formatDurationMs(result.loadMedianMs)}`,
    `- Fixture median setup stage: ${formatDurationMs(result.setupMedianMs)}`,
    `- Fixture median exact edge-build stage: ${formatDurationMs(result.edgeBuildMedianMs)}`,
    `- Fixture median vector index-build stage: ${formatDurationMs(result.indexBuildMedianMs)}`,
    `- Fixture median vector query stage: ${formatDurationMs(result.queryMedianMs)}`,
    `- Fixture median cluster-assembly stage: ${formatDurationMs(result.clusterBuildMedianMs)}`,
    `- Median peak RSS: ${formatBytes(result.medianPeakRssBytes)}`,
    `- Median peak heap used: ${formatBytes(result.medianPeakHeapUsedBytes)}`,
    `- Fixture baseline: ${formatDurationMs(result.baselineMedianMs)}`,
    `- Fixture delta: ${formatDurationMs(result.deltaMs)} (${formatPercent(result.deltaPercent)})`,
    `- Projected openclaw/openclaw duration: ${formatDurationMs(result.projectedOpenclawMs)}`,
    `- Projected openclaw/openclaw baseline: ${formatDurationMs(result.projectedBaselineOpenclawMs)}`,
    `- Projected delta: ${formatDurationMs(result.projectedDeltaMs)} (${formatPercent(result.projectedDeltaPercent)})`,
    `- Regression threshold: ${formatPercent(result.maxRegressionPercent)}`,
    `- Fixture shape: ${result.threadCount} threads x ${result.sourceKinds.length} source kinds`,
    `- Sample durations: ${sampleList}`,
    suggestedBaselineLine,
    bootstrapLine,
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function writeOutput(result: PerfRunResult, summary: string, bootstrap: boolean): void {
  const outputPath = process.env.GHCRAWL_CLUSTER_PERF_OUTPUT_PATH;
  if (!outputPath) {
    return;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        status: result.deltaPercent > result.maxRegressionPercent ? 'FAIL' : 'PASS',
        bootstrap,
        summary,
        suggestedBaseline: buildSuggestedBaseline(result),
        result,
      },
      null,
      2,
    ) + '\n',
  );
}

async function main(): Promise<void> {
  const baseline = loadBaseline();
  const result = await measureBenchmark(baseline);
  const summary = buildSummary(result);
  const bootstrap = shouldBootstrapBaseline();
  const shouldFail = !bootstrap && !shouldIgnoreRegressionThreshold() && result.deltaPercent > result.maxRegressionPercent;

  process.stdout.write(`${summary}\n`);
  const suggestedBaseline = buildSuggestedBaseline(result);
  if (bootstrap && suggestedBaseline) {
    process.stdout.write(`Suggested baseline update: ${JSON.stringify(suggestedBaseline)}\n`);
  }
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${summary}\n`);
  }
  writeOutput(result, summary, bootstrap);

  if (shouldFail) {
    throw new Error(
      `Cluster perf regression exceeded threshold: ${formatPercent(result.deltaPercent)} > ${formatPercent(result.maxRegressionPercent)}`,
    );
  }
}

await main();
