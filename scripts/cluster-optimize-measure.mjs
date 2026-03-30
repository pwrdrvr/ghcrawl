/**
 * Measurement harness for cluster optimization experiments.
 *
 * Runs clusterExperiment with configurable parameters and outputs JSON metrics.
 * Does NOT modify the shared DB — clusterExperiment is read-only on the main DB.
 *
 * Usage:
 *   node scripts/cluster-optimize-measure.mjs [owner/repo] \
 *     --k 6 --threshold 0.82 --candidate-k 96 --ef-search 200 --backend vectorlite
 *
 * Output: JSON object with all metrics to stdout (progress to stderr).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');

const { GHCrawlService } = await import(serviceModulePath);

function parseArgs(argv) {
  let repo = 'openclaw/openclaw';
  let k;
  let threshold;
  let candidateK;
  let efSearch;
  let backend = 'vectorlite';
  let maxClusterSize;
  let refineStep;
  let clusterMode;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--k') { k = Number(argv[++index]); continue; }
    if (token === '--threshold') { threshold = Number(argv[++index]); continue; }
    if (token === '--candidate-k') { candidateK = Number(argv[++index]); continue; }
    if (token === '--ef-search') { efSearch = Number(argv[++index]); continue; }
    if (token === '--backend') { backend = argv[++index]; continue; }
    if (token === '--max-cluster-size') { maxClusterSize = Number(argv[++index]); continue; }
    if (token === '--refine-step') { refineStep = Number(argv[++index]); continue; }
    if (token === '--cluster-mode') { clusterMode = argv[++index]; continue; }
    if (!token.startsWith('--')) repo = token;
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Expected owner/repo, received: ${repo}`);

  return {
    owner,
    repo: name,
    fullName: `${owner}/${name}`,
    k: Number.isFinite(k) ? k : undefined,
    threshold: Number.isFinite(threshold) ? threshold : undefined,
    candidateK: Number.isFinite(candidateK) ? candidateK : undefined,
    efSearch: Number.isFinite(efSearch) ? efSearch : undefined,
    backend,
    maxClusterSize: Number.isFinite(maxClusterSize) ? maxClusterSize : undefined,
    refineStep: Number.isFinite(refineStep) ? refineStep : undefined,
    clusterMode: clusterMode || undefined,
  };
}

const args = parseArgs(process.argv.slice(2));

const service = new GHCrawlService();
try {
  const result = service.clusterExperiment({
    owner: args.owner,
    repo: args.repo,
    backend: args.backend,
    k: args.k,
    minScore: args.threshold,
    candidateK: args.candidateK,
    efSearch: args.efSearch,
    maxClusterSize: args.maxClusterSize,
    refineStep: args.refineStep,
    clusterMode: args.clusterMode,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });

  const totalThreads = result.threads;
  const soloClusters = result.clusterSizes.soloClusters;
  const multiMemberClusters = result.clusters - soloClusters;
  const threadsInMulti = totalThreads - soloClusters;
  const multiMemberPct = totalThreads > 0 ? threadsInMulti / totalThreads : 0;

  const metrics = {
    // Primary metric
    multi_member_pct: Math.round(multiMemberPct * 10000) / 100,

    // Gate metrics
    edge_count: result.edges,
    cluster_count: result.clusters,
    solo_clusters: soloClusters,
    multi_member_clusters: multiMemberClusters,
    threads_in_multi: threadsInMulti,
    total_threads: totalThreads,
    max_cluster_size: result.clusterSizes.maxClusterSize,

    // Diagnostics
    solo_pct: Math.round((soloClusters / Math.max(result.clusters, 1)) * 10000) / 100,
    avg_multi_size: multiMemberClusters > 0
      ? Math.round((threadsInMulti / multiMemberClusters) * 100) / 100
      : 0,

    // Timing
    duration_ms: result.durationMs,
    total_duration_ms: result.totalDurationMs,
    load_ms: result.loadMs,
    setup_ms: result.setupMs,
    index_build_ms: result.indexBuildMs,
    query_ms: result.queryMs,
    cluster_build_ms: result.clusterBuildMs,

    // Params used
    params: {
      backend: result.backend,
      k: args.k ?? 6,
      min_score: args.threshold ?? 0.82,
      candidate_k: result.candidateK,
      ef_search: args.efSearch ?? null,
      max_cluster_size: args.maxClusterSize ?? null,
      refine_step: args.refineStep ?? null,
      cluster_mode: args.clusterMode ?? null,
    },

    // Size distribution (top 20)
    top_cluster_sizes: result.clusterSizes.topClusterSizes.slice(0, 20),
    histogram: result.clusterSizes.histogram,
  };

  process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
} finally {
  service.close();
}
