import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');
const buildModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'cluster', 'build.js');
const exactEdgesModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'cluster', 'exact-edges.js');

const { GHCrawlService } = await import(serviceModulePath);
const { buildClusters } = await import(buildModulePath);
const { buildSourceKindEdges } = await import(exactEdgesModulePath);

function parseArgs(argv) {
  let repo = 'openclaw/openclaw';
  let clusterRank = 1;
  let backend = 'vectorlite';
  let k;
  let threshold;
  let candidateK;
  let efSearch;
  let topSubclusters = 10;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--repo') {
      repo = argv[index + 1] ?? repo;
      index += 1;
      continue;
    }
    if (token === '--cluster-rank') {
      clusterRank = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--backend') {
      backend = argv[index + 1] ?? backend;
      index += 1;
      continue;
    }
    if (token === '--k') {
      k = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--threshold') {
      threshold = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--candidate-k') {
      candidateK = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--ef-search') {
      efSearch = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--top-subclusters') {
      topSubclusters = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (!token.startsWith('--')) {
      repo = token;
    }
  }

  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Expected owner/repo, received: ${repo}`);
  }

  return {
    owner,
    repo: name,
    fullName: `${owner}/${name}`,
    clusterRank: Number.isFinite(clusterRank) ? Math.max(1, clusterRank) : 1,
    backend: backend === 'exact' ? 'exact' : 'vectorlite',
    k: Number.isFinite(k) ? k : undefined,
    threshold: Number.isFinite(threshold) ? threshold : undefined,
    candidateK: Number.isFinite(candidateK) ? candidateK : undefined,
    efSearch: Number.isFinite(efSearch) ? efSearch : undefined,
    topSubclusters: Number.isFinite(topSubclusters) ? Math.max(1, topSubclusters) : 10,
  };
}

function edgeKey(leftThreadId, rightThreadId) {
  const [left, right] = leftThreadId < rightThreadId ? [leftThreadId, rightThreadId] : [rightThreadId, leftThreadId];
  return `${left}:${right}`;
}

function mergeSourceKindEdges(aggregated, edges) {
  for (const edge of edges) {
    const key = edgeKey(edge.leftThreadId, edge.rightThreadId);
    const existing = aggregated.get(key);
    if (existing) {
      existing.score = Math.max(existing.score, edge.score);
      continue;
    }
    aggregated.set(key, {
      leftThreadId: edge.leftThreadId,
      rightThreadId: edge.rightThreadId,
      score: edge.score,
    });
  }
}

function loadThreadMeta(service, ids) {
  const placeholders = ids.map(() => '?').join(', ');
  const rows = service.db
    .prepare(
      `select id, number, kind, title
       from threads
       where id in (${placeholders})`,
    )
    .all(...ids);
  return new Map(rows.map((row) => [row.id, row]));
}

function normalizeEmbedding(values) {
  let normSquared = 0;
  for (const value of values) {
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (norm === 0) {
    return values.map(() => 0);
  }
  return values.map((value) => value / norm);
}

function normalizeRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    normalizedEmbedding: normalizeEmbedding(JSON.parse(row.embedding_json)),
  }));
}

function describeThread(threadId, metaById) {
  const meta = metaById.get(threadId);
  if (!meta) {
    return `thread:${threadId}`;
  }
  const kind = meta.kind === 'pull_request' ? 'PR' : 'Issue';
  return `${kind} #${meta.number} ${meta.title}`;
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
    includeClusters: true,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });

  const rankedClusters = [...(result.clustersDetail ?? [])].sort(
    (left, right) => right.memberThreadIds.length - left.memberThreadIds.length || left.representativeThreadId - right.representativeThreadId,
  );
  const selectedCluster = rankedClusters[args.clusterRank - 1];
  if (!selectedCluster) {
    throw new Error(`Cluster rank ${args.clusterRank} not found`);
  }

  const repository = service.requireRepository(args.owner, args.repo);
  const ids = [...selectedCluster.memberThreadIds];
  const metaById = loadThreadMeta(service, ids);
  const sourceKinds = service.db
    .prepare(
      `select distinct e.source_kind as sourceKind
       from document_embeddings e
       join threads t on t.id = e.thread_id
       where t.repo_id = ?
         and t.id in (${ids.map(() => '?').join(', ')})
         and e.model = ?
       order by e.source_kind asc`,
    )
    .all(repository.id, ...ids, service.config.embedModel)
    .map((row) => row.sourceKind);

  const aggregated = new Map();
  for (const sourceKind of sourceKinds) {
    const rows = service.db
      .prepare(
        `select t.id, e.embedding_json
         from document_embeddings e
         join threads t on t.id = e.thread_id
         where t.repo_id = ?
           and t.id in (${ids.map(() => '?').join(', ')})
           and e.model = ?
           and e.source_kind = ?`,
      )
      .all(repository.id, ...ids, service.config.embedModel, sourceKind);
    const normalizedRows = normalizeRows(rows);
    const edges = buildSourceKindEdges(normalizedRows, {
      limit: args.k ?? 6,
      minScore: args.threshold ?? 0.82,
    });
    mergeSourceKindEdges(aggregated, edges);
  }

  const refinedClusters = buildClusters(
    ids.map((threadId) => {
      const meta = metaById.get(threadId);
      return {
        threadId,
        number: meta?.number ?? threadId,
        title: meta?.title ?? '',
      };
    }),
    Array.from(aggregated.values()),
  );

  const lines = [
    '## Refined Cluster',
    '',
    `- Repo: ${args.fullName}`,
    `- Source backend cluster: ${args.backend}`,
    `- Source cluster rank: ${args.clusterRank}`,
    `- Source cluster size: ${selectedCluster.memberThreadIds.length}`,
    `- Representative: ${describeThread(selectedCluster.representativeThreadId, metaById)}`,
    `- Exact refined subclusters: ${refinedClusters.length}`,
    '',
    '### Refined Sizes',
    '',
  ];

  for (const [index, cluster] of refinedClusters.slice(0, args.topSubclusters).entries()) {
    lines.push(
      `- #${index + 1} size=${cluster.members.length} representative=${describeThread(cluster.representativeThreadId, metaById)}`,
    );
  }

  process.stdout.write(`\n${lines.join('\n')}\n`);
} finally {
  service.close();
}
