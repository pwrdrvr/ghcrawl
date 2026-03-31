#!/usr/bin/env node
/**
 * Run a clustering experiment with LLM-as-judge evaluation.
 *
 * 1. Runs clusterExperiment with given params
 * 2. Samples clusters (stratified: top-by-size, mid-range, small)
 * 3. Samples singletons for false-negative evaluation
 * 4. Judges each sample with an LLM
 * 5. Outputs aggregate scores + full results JSON
 *
 * Usage:
 *   node scripts/cluster-judge-experiment.mjs openclaw/openclaw \
 *     --experiment-id baseline \
 *     --source-kinds title,body,dedupe_summary \
 *     --aggregation max \
 *     --threshold 0.82 \
 *     --output-dir .context/compound-engineering/ce-optimize/embedding-clustering/results
 *
 * Requires OPENAI_API_KEY in environment.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');
const { GHCrawlService } = await import(serviceModulePath);

const apiCoreRequire = createRequire(path.join(repoRoot, 'packages', 'api-core', 'package.json'));
const { default: OpenAI } = await import(apiCoreRequire.resolve('openai'));

const CLUSTER_RUBRIC = `You are evaluating a cluster of GitHub issues/PRs that were grouped together by embedding similarity. Each item shows its number, kind (issue/PR), title, and dedupe_summary.

Rate this cluster 1-5 for COHERENCE:
- 5: All items clearly about the same specific issue, feature, or component
- 4: Strong theme with minor outliers (1 loosely related item)
- 3: Related topic area but covers 2-3 distinct sub-topics that could be split
- 2: Weak connection — items share superficial similarity only
- 1: Unrelated items grouped together, no meaningful connection

Also report:
- distinct_topics: integer — how many distinct sub-topics are in this cluster
- outlier_count: integer — items that don't belong
- dominant_theme: string — 1 sentence describing the main topic

Return JSON only: { "score": <int>, "distinct_topics": <int>, "outlier_count": <int>, "dominant_theme": "<string>", "reasoning": "<string>" }`;

const SINGLETON_RUBRIC = `This GitHub thread is currently a SINGLETON — it was not grouped with any other thread in a repository of ~18k issues/PRs. Given its title and dedupe_summary, evaluate whether this is correct.

Rate 1-5:
- 5: Clearly unique topic, no plausible duplicates would exist
- 4: Probably unique, though a loose connection to other topics is possible
- 3: Uncertain — could go either way, might have related threads
- 2: Likely should be grouped — the topic is common enough to have duplicates
- 1: Obvious false negative — this clearly belongs with other threads on a common topic

Return JSON only: { "score": <int>, "reasoning": "<string>" }`;

function parseArgs(argv) {
  let repo = 'openclaw/openclaw';
  let experimentId = 'unnamed';
  let outputDir = '.context/compound-engineering/ce-optimize/embedding-clustering/results';
  let sourceKinds;
  let aggregation;
  let aggregationWeights;
  let threshold;
  let k;
  let candidateK;
  let efSearch;
  let maxClusterSize = 200;
  let clusterMode = 'bounded';
  let clusterSampleSize = 30;
  let singletonSampleSize = 15;
  let judgeModel = 'gpt-5-mini';

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--experiment-id') { experimentId = argv[++index]; continue; }
    if (token === '--output-dir') { outputDir = argv[++index]; continue; }
    if (token === '--source-kinds') { sourceKinds = argv[++index].split(','); continue; }
    if (token === '--aggregation') { aggregation = argv[++index]; continue; }
    if (token === '--weights') { aggregationWeights = JSON.parse(argv[++index]); continue; }
    if (token === '--threshold') { threshold = Number(argv[++index]); continue; }
    if (token === '--k') { k = Number(argv[++index]); continue; }
    if (token === '--candidate-k') { candidateK = Number(argv[++index]); continue; }
    if (token === '--ef-search') { efSearch = Number(argv[++index]); continue; }
    if (token === '--max-cluster-size') { maxClusterSize = Number(argv[++index]); continue; }
    if (token === '--cluster-mode') { clusterMode = argv[++index]; continue; }
    if (token === '--cluster-sample-size') { clusterSampleSize = Number(argv[++index]); continue; }
    if (token === '--singleton-sample-size') { singletonSampleSize = Number(argv[++index]); continue; }
    if (token === '--judge-model') { judgeModel = argv[++index]; continue; }
    if (!token.startsWith('--')) repo = token;
  }

  const [owner, name] = repo.split('/');
  return {
    owner, repo: name,
    experimentId, outputDir,
    sourceKinds, aggregation, aggregationWeights,
    threshold, k, candidateK, efSearch,
    maxClusterSize, clusterMode,
    clusterSampleSize, singletonSampleSize,
    judgeModel,
  };
}

function sampleClusters(clusters, sampleSize, seed = 42) {
  // Separate multi-member clusters from singletons
  const multiMember = clusters.filter(c => c.memberThreadIds.length > 1);
  const singletons = clusters.filter(c => c.memberThreadIds.length === 1);

  // Sort by size descending
  multiMember.sort((a, b) => b.memberThreadIds.length - a.memberThreadIds.length);

  const perBucket = Math.floor(sampleSize / 3);
  const sampled = [];

  // Top by size
  sampled.push(...multiMember.slice(0, perBucket).map(c => ({ ...c, bucket: 'top_by_size' })));

  // Mid range
  const midStart = Math.floor(multiMember.length * 0.3);
  const midEnd = Math.floor(multiMember.length * 0.7);
  const midPool = multiMember.slice(midStart, midEnd);
  // Deterministic pseudo-random selection
  const midSampled = deterministicSample(midPool, perBucket, seed);
  sampled.push(...midSampled.map(c => ({ ...c, bucket: 'mid_range' })));

  // Small clusters (size 2-3)
  const smallPool = multiMember.filter(c => c.memberThreadIds.length <= 3);
  const remaining = sampleSize - sampled.length;
  const smallSampled = deterministicSample(smallPool, remaining, seed + 1);
  sampled.push(...smallSampled.map(c => ({ ...c, bucket: 'small_clusters' })));

  return { sampled, singletons };
}

function deterministicSample(pool, count, seed) {
  if (pool.length <= count) return [...pool];
  // Simple seeded shuffle
  const indices = pool.map((_, i) => i);
  let s = seed;
  for (let i = indices.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count).map(i => pool[i]);
}

async function judgeCluster(client, model, cluster, threadDetails) {
  const items = cluster.memberThreadIds.map(id => {
    const t = threadDetails.get(id);
    if (!t) return `  - Thread ID ${id}: (details not found)`;
    return `  - #${t.number} (${t.kind}): "${t.title}" — ${t.dedupeSummary || '(no summary)'}`;
  }).join('\n');

  const input = `Cluster with ${cluster.memberThreadIds.length} items:\n${items}`;

  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: CLUSTER_RUBRIC }] },
      { role: 'user', content: [{ type: 'input_text', text: input }] },
    ],
    text: {
      format: { type: 'json_schema', name: 'cluster_judge', strict: true, schema: {
        type: 'object',
        properties: {
          score: { type: 'integer' },
          distinct_topics: { type: 'integer' },
          outlier_count: { type: 'integer' },
          dominant_theme: { type: 'string' },
          reasoning: { type: 'string' },
        },
        required: ['score', 'distinct_topics', 'outlier_count', 'dominant_theme', 'reasoning'],
        additionalProperties: false,
      }},
    },
    max_output_tokens: 500,
  });

  try {
    return JSON.parse(response.output_text ?? '{}');
  } catch {
    return { score: null, reasoning: 'parse error' };
  }
}

async function judgeSingleton(client, model, threadDetail) {
  const input = `Thread #${threadDetail.number} (${threadDetail.kind}): "${threadDetail.title}"\ndedupe_summary: ${threadDetail.dedupeSummary || '(none)'}`;

  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: SINGLETON_RUBRIC }] },
      { role: 'user', content: [{ type: 'input_text', text: input }] },
    ],
    text: {
      format: { type: 'json_schema', name: 'singleton_judge', strict: true, schema: {
        type: 'object',
        properties: {
          score: { type: 'integer' },
          reasoning: { type: 'string' },
        },
        required: ['score', 'reasoning'],
        additionalProperties: false,
      }},
    },
    max_output_tokens: 300,
  });

  try {
    return JSON.parse(response.output_text ?? '{}');
  } catch {
    return { score: null, reasoning: 'parse error' };
  }
}

// Main execution
const args = parseArgs(process.argv.slice(2));

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY not set');
const client = new OpenAI({ apiKey });

const service = new GHCrawlService();

try {
  // Step 1: Run clustering
  process.stderr.write(`[experiment] ${args.experimentId}: running clustering...\n`);
  const result = service.clusterExperiment({
    owner: args.owner,
    repo: args.repo,
    backend: 'vectorlite',
    minScore: args.threshold,
    k: args.k,
    candidateK: args.candidateK,
    efSearch: args.efSearch,
    maxClusterSize: args.maxClusterSize,
    clusterMode: args.clusterMode,
    sourceKinds: args.sourceKinds,
    aggregation: args.aggregation,
    aggregationWeights: args.aggregationWeights,
    includeClusters: true,
    onProgress: (msg) => process.stderr.write(`${msg}\n`),
  });

  const totalThreads = result.threads;
  const soloClusters = result.clusterSizes.soloClusters;
  const multiMemberClusters = result.clusters - soloClusters;
  const threadsInMulti = totalThreads - soloClusters;
  const multiMemberPct = totalThreads > 0 ? threadsInMulti / totalThreads : 0;

  const metrics = {
    multi_member_pct: Math.round(multiMemberPct * 10000) / 100,
    edge_count: result.edges,
    cluster_count: result.clusters,
    solo_clusters: soloClusters,
    multi_member_clusters: multiMemberClusters,
    threads_in_multi: threadsInMulti,
    total_threads: totalThreads,
    max_cluster_size: result.clusterSizes.maxClusterSize,
    solo_pct: Math.round((soloClusters / Math.max(result.clusters, 1)) * 10000) / 100,
    avg_multi_size: multiMemberClusters > 0 ? Math.round((threadsInMulti / multiMemberClusters) * 100) / 100 : 0,
    duration_ms: result.durationMs,
  };

  process.stderr.write(`[experiment] clustering done: ${metrics.multi_member_pct}% multi-member, ${metrics.edge_count} edges\n`);

  // Check degenerate gates
  if (metrics.solo_pct >= 95 || metrics.max_cluster_size > 500 || metrics.multi_member_pct < 5) {
    process.stderr.write(`[experiment] DEGENERATE: solo_pct=${metrics.solo_pct} max_cluster=${metrics.max_cluster_size} multi%=${metrics.multi_member_pct}\n`);
    const output = { experiment_id: args.experimentId, outcome: 'degenerate', metrics, judge: null };
    fs.mkdirSync(path.resolve(args.outputDir), { recursive: true });
    fs.writeFileSync(path.resolve(args.outputDir, `${args.experimentId}.json`), JSON.stringify(output, null, 2));
    process.stdout.write(JSON.stringify({ experiment_id: args.experimentId, outcome: 'degenerate', ...metrics }, null, 2) + '\n');
    process.exit(0);
  }

  // Step 2: Load thread details for judging
  process.stderr.write(`[experiment] loading thread details for judging...\n`);
  const clusters = result.clustersDetail;
  const allThreadIds = new Set();
  for (const c of clusters) {
    for (const id of c.memberThreadIds) allThreadIds.add(id);
  }

  const threadDetails = new Map();
  const threadIds = Array.from(allThreadIds);
  for (let i = 0; i < threadIds.length; i += 500) {
    const batch = threadIds.slice(i, i + 500);
    const placeholders = batch.map(() => '?').join(',');
    const rows = service.db.prepare(
      `select t.id, t.number, t.kind, t.title, s.summary_text as dedupe_summary
       from threads t
       left join document_summaries s on s.thread_id = t.id and s.summary_kind = 'dedupe_summary'
       where t.id in (${placeholders})`
    ).all(...batch);
    for (const row of rows) {
      threadDetails.set(row.id, {
        number: row.number,
        kind: row.kind,
        title: row.title,
        dedupeSummary: row.dedupe_summary,
      });
    }
  }

  // Step 3: Sample clusters
  const { sampled, singletons } = sampleClusters(clusters, args.clusterSampleSize);
  const singletonSample = deterministicSample(singletons, args.singletonSampleSize, 42);

  process.stderr.write(`[experiment] sampled ${sampled.length} clusters + ${singletonSample.length} singletons for judging\n`);

  // Step 4: Judge clusters
  const clusterJudgments = [];
  for (const [i, cluster] of sampled.entries()) {
    process.stderr.write(`[judge] cluster ${i + 1}/${sampled.length} (size=${cluster.memberThreadIds.length}, bucket=${cluster.bucket})\n`);
    const judgment = await judgeCluster(client, args.judgeModel, cluster, threadDetails);
    clusterJudgments.push({
      bucket: cluster.bucket,
      size: cluster.memberThreadIds.length,
      representativeThreadId: cluster.representativeThreadId,
      judgment,
    });
  }

  // Step 5: Judge singletons
  const singletonJudgments = [];
  for (const [i, singleton] of singletonSample.entries()) {
    const threadId = singleton.memberThreadIds[0];
    const detail = threadDetails.get(threadId);
    if (!detail) continue;
    process.stderr.write(`[judge] singleton ${i + 1}/${singletonSample.length} #${detail.number}\n`);
    const judgment = await judgeSingleton(client, args.judgeModel, detail);
    singletonJudgments.push({
      threadId,
      number: detail.number,
      title: detail.title,
      judgment,
    });
  }

  // Step 6: Aggregate
  const scoredClusters = clusterJudgments.filter(j => j.judgment?.score != null);
  const meanScore = scoredClusters.length > 0
    ? scoredClusters.reduce((s, j) => s + j.judgment.score, 0) / scoredClusters.length
    : 0;
  const meanDistinctTopics = scoredClusters.length > 0
    ? scoredClusters.reduce((s, j) => s + (j.judgment.distinct_topics ?? 0), 0) / scoredClusters.length
    : 0;
  const totalOutliers = scoredClusters.reduce((s, j) => s + (j.judgment.outlier_count ?? 0), 0);
  const totalMembers = scoredClusters.reduce((s, j) => s + j.size, 0);
  const outlierRate = totalMembers > 0 ? totalOutliers / totalMembers : 0;

  const scoredSingletons = singletonJudgments.filter(j => j.judgment?.score != null);
  const singletonScore = scoredSingletons.length > 0
    ? scoredSingletons.reduce((s, j) => s + j.judgment.score, 0) / scoredSingletons.length
    : 0;

  // Per-bucket breakdown
  const bucketScores = {};
  for (const bucket of ['top_by_size', 'mid_range', 'small_clusters']) {
    const bucketItems = scoredClusters.filter(j => j.bucket === bucket);
    bucketScores[bucket] = bucketItems.length > 0
      ? Math.round(bucketItems.reduce((s, j) => s + j.judgment.score, 0) / bucketItems.length * 100) / 100
      : null;
  }

  const judgeResults = {
    mean_score: Math.round(meanScore * 100) / 100,
    mean_distinct_topics: Math.round(meanDistinctTopics * 100) / 100,
    outlier_rate: Math.round(outlierRate * 10000) / 100,
    singleton_score: Math.round(singletonScore * 100) / 100,
    bucket_scores: bucketScores,
    clusters_judged: scoredClusters.length,
    singletons_judged: scoredSingletons.length,
  };

  // Save full results
  const output = {
    experiment_id: args.experimentId,
    outcome: 'measured',
    timestamp: new Date().toISOString(),
    params: {
      source_kinds: args.sourceKinds ?? 'all',
      aggregation: args.aggregation ?? 'max',
      threshold: args.threshold ?? 0.82,
      k: args.k ?? 6,
      max_cluster_size: args.maxClusterSize,
      cluster_mode: args.clusterMode,
    },
    metrics,
    judge: judgeResults,
    cluster_judgments: clusterJudgments,
    singleton_judgments: singletonJudgments,
  };

  fs.mkdirSync(path.resolve(args.outputDir), { recursive: true });
  const outputPath = path.resolve(args.outputDir, `${args.experimentId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  process.stderr.write(`\n[experiment] results saved to ${outputPath}\n`);

  // Print summary to stdout
  process.stdout.write(JSON.stringify({
    experiment_id: args.experimentId,
    outcome: 'measured',
    ...metrics,
    ...judgeResults,
  }, null, 2) + '\n');
} finally {
  service.close();
}
