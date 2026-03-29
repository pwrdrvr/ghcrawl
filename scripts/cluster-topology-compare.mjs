import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');

const { GHCrawlService } = await import(serviceModulePath);

function parseArgs(argv) {
  let repo = 'openclaw/openclaw';
  let k;
  let threshold;
  let candidateK;
  let childBackend = null;
  let top = 5;
  let sampleMembers = 12;
  let efSearch;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;
    if (token === '--repo') {
      repo = argv[index + 1] ?? repo;
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
    if (token === '--child-backend') {
      childBackend = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === '--top') {
      top = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--sample-members') {
      sampleMembers = Number(argv[index + 1]);
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
    k: Number.isFinite(k) ? k : undefined,
    threshold: Number.isFinite(threshold) ? threshold : undefined,
    candidateK: Number.isFinite(candidateK) ? candidateK : undefined,
    efSearch: Number.isFinite(efSearch) ? efSearch : undefined,
    childBackend,
    top: Number.isFinite(top) ? Math.max(1, top) : 5,
    sampleMembers: Number.isFinite(sampleMembers) ? Math.max(1, sampleMembers) : 12,
  };
}

async function runChild(args) {
  const service = new GHCrawlService();
  try {
    const result = service.clusterExperiment({
      owner: args.owner,
      repo: args.repo,
      backend: args.childBackend,
      k: args.k,
      minScore: args.threshold,
      candidateK: args.candidateK,
      efSearch: args.efSearch,
      includeClusters: true,
      onProgress: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`__GHCRAWL_RESULT__${JSON.stringify(result)}\n`);
  } finally {
    service.close();
  }
}

async function runBackend(backend, args) {
  return await new Promise((resolve, reject) => {
    const childArgs = [
      '--expose-gc',
      path.join(repoRoot, 'scripts', 'cluster-topology-compare.mjs'),
      args.fullName,
      '--child-backend',
      backend,
      '--top',
      String(args.top),
      '--sample-members',
      String(args.sampleMembers),
    ];
    if (args.k !== undefined) {
      childArgs.push('--k', String(args.k));
    }
    if (args.threshold !== undefined) {
      childArgs.push('--threshold', String(args.threshold));
    }
    if (args.candidateK !== undefined) {
      childArgs.push('--candidate-k', String(args.candidateK));
    }
    if (args.efSearch !== undefined) {
      childArgs.push('--ef-search', String(args.efSearch));
    }

    const child = spawn(process.execPath, childArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let result = null;
    const pipeStream = (stream, label) => {
      const rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => {
        if (label === 'stdout' && line.startsWith('__GHCRAWL_RESULT__')) {
          result = JSON.parse(line.slice('__GHCRAWL_RESULT__'.length));
          return;
        }
        process.stdout.write(`[${backend}] ${line}\n`);
      });
    };

    pipeStream(child.stdout, 'stdout');
    pipeStream(child.stderr, 'stderr');

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const detail = signal ? `signal ${signal}` : `code ${code}`;
        reject(new Error(`${backend} topology comparison exited with ${detail}`));
        return;
      }
      if (!result) {
        reject(new Error(`${backend} topology comparison did not emit a result payload`));
        return;
      }
      resolve(result);
    });
  });
}

function sortClusters(clusters) {
  return [...clusters].sort((left, right) => {
    const sizeDelta = right.memberThreadIds.length - left.memberThreadIds.length;
    if (sizeDelta !== 0) return sizeDelta;
    return left.representativeThreadId - right.representativeThreadId;
  });
}

function buildClusterIndex(clusters) {
  return clusters.map((cluster, index) => ({
    rank: index + 1,
    representativeThreadId: cluster.representativeThreadId,
    memberThreadIds: cluster.memberThreadIds,
    memberSet: new Set(cluster.memberThreadIds),
    size: cluster.memberThreadIds.length,
  }));
}

function findContributors(targetCluster, sourceClusters) {
  const contributors = [];
  for (const sourceCluster of sourceClusters) {
    let overlap = 0;
    for (const threadId of targetCluster.memberThreadIds) {
      if (sourceCluster.memberSet.has(threadId)) {
        overlap += 1;
      }
    }
    if (overlap > 0) {
      contributors.push({
        rank: sourceCluster.rank,
        representativeThreadId: sourceCluster.representativeThreadId,
        size: sourceCluster.size,
        overlap,
      });
    }
  }
  contributors.sort((left, right) => right.overlap - left.overlap || left.rank - right.rank);
  return contributors;
}

function collectSampleIds(vectorTop, exactTop, matches, sampleMembers) {
  const ids = new Set();
  for (const cluster of [...vectorTop, ...exactTop]) {
    ids.add(cluster.representativeThreadId);
  }
  for (const match of matches) {
    if (!match.bestContributor) {
      continue;
    }
    ids.add(match.bestContributor.representativeThreadId);
    for (const contributor of match.contributors.slice(0, 5)) {
      ids.add(contributor.representativeThreadId);
    }
    for (const threadId of match.vectorOnly.slice(0, sampleMembers)) {
      ids.add(threadId);
    }
    for (const threadId of match.bestExactOnly.slice(0, sampleMembers)) {
      ids.add(threadId);
    }
  }
  return [...ids];
}

function fetchThreadMeta(ids) {
  if (ids.length === 0) {
    return new Map();
  }

  const service = new GHCrawlService();
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = service.db
      .prepare(
        `select id, number, kind, title
         from threads
         where id in (${placeholders})`,
      )
      .all(...ids);
    return new Map(rows.map((row) => [row.id, row]));
  } finally {
    service.close();
  }
}

function describeThread(threadId, metaById) {
  const meta = metaById.get(threadId);
  if (!meta) {
    return `thread:${threadId}`;
  }
  const kind = meta.kind === 'pull_request' ? 'PR' : 'Issue';
  return `${kind} #${meta.number} ${meta.title}`;
}

function formatContributor(contributor, targetSize) {
  const coverage = ((contributor.overlap / Math.max(targetSize, 1)) * 100).toFixed(1);
  return `exact #${contributor.rank} size=${contributor.size} overlap=${contributor.overlap} (${coverage}% of vector cluster)`;
}

function buildSummaryTable(exactTop, vectorTop, matches) {
  const lines = ['## Top Cluster Size Comparison', '', 'rank  exact  vectorlite  best exact overlap', '----  -----  ----------  ------------------'];
  for (let index = 0; index < Math.max(exactTop.length, vectorTop.length); index += 1) {
    const exactSize = exactTop[index]?.size ?? 0;
    const vectorSize = vectorTop[index]?.size ?? 0;
    const overlap = matches[index]?.bestContributor?.overlap ?? 0;
    lines.push(
      `${String(index + 1).padStart(4)}  ${String(exactSize).padStart(5)}  ${String(vectorSize).padStart(10)}  ${String(overlap).padStart(18)}`,
    );
  }
  lines.push('');
  return lines;
}

function buildDetailLines(vectorTop, matches, metaById, sampleMembers) {
  const lines = ['## Largest Vectorlite Clusters Vs Exact', ''];

  for (let index = 0; index < vectorTop.length; index += 1) {
    const vectorCluster = vectorTop[index];
    const match = matches[index];
    const representative = describeThread(vectorCluster.representativeThreadId, metaById);

    lines.push(
      `### Vectorlite #${index + 1} size=${vectorCluster.size} representative=${representative}`,
    );

    if (!match.bestContributor) {
      lines.push('- No overlapping exact cluster found.');
      lines.push('');
      continue;
    }

    const contributorSummary = match.contributors
      .slice(0, 5)
      .map((contributor) => formatContributor(contributor, vectorCluster.size))
      .join('; ');
    lines.push(`- Top exact contributors: ${contributorSummary}`);

    const bestRepresentative = describeThread(match.bestContributor.representativeThreadId, metaById);
    lines.push(`- Best exact representative: ${bestRepresentative}`);
    lines.push(
      `- Members only in vectorlite vs best exact: ${match.vectorOnly.length}; members only in best exact vs vectorlite: ${match.bestExactOnly.length}`,
    );

    if (match.vectorOnly.length > 0) {
      lines.push(
        `- Sample vectorlite-only members: ${match.vectorOnly
          .slice(0, sampleMembers)
          .map((threadId) => describeThread(threadId, metaById))
          .join(' | ')}`,
      );
    }

    if (match.bestExactOnly.length > 0) {
      lines.push(
        `- Sample exact-only members: ${match.bestExactOnly
          .slice(0, sampleMembers)
          .map((threadId) => describeThread(threadId, metaById))
          .join(' | ')}`,
      );
    }

    lines.push('');
  }

  return lines;
}

async function runParent(args) {
  process.stdout.write(`[exact] starting topology comparison for ${args.fullName}\n`);
  const exactResult = await runBackend('exact', args);

  process.stdout.write(`[vectorlite] starting topology comparison for ${args.fullName}\n`);
  const vectorliteResult = await runBackend('vectorlite', args);

  const exactClusters = buildClusterIndex(sortClusters(exactResult.clustersDetail ?? []));
  const vectorClusters = buildClusterIndex(sortClusters(vectorliteResult.clustersDetail ?? []));
  const exactTop = exactClusters.slice(0, args.top);
  const vectorTop = vectorClusters.slice(0, args.top);

  const matches = vectorTop.map((vectorCluster) => {
    const contributors = findContributors(vectorCluster, exactClusters);
    const bestContributor = contributors[0] ?? null;
    const bestExactSet = bestContributor
      ? exactClusters[bestContributor.rank - 1].memberSet
      : new Set();
    const vectorOnly = vectorCluster.memberThreadIds.filter((threadId) => !bestExactSet.has(threadId));
    const bestExactOnly = bestContributor
      ? exactClusters[bestContributor.rank - 1].memberThreadIds.filter((threadId) => !vectorCluster.memberSet.has(threadId))
      : [];

    return {
      contributors,
      bestContributor,
      vectorOnly,
      bestExactOnly,
    };
  });

  const metaById = fetchThreadMeta(collectSampleIds(vectorTop, exactTop, matches, args.sampleMembers));

  const lines = [
    '## Cluster Topology Comparison',
    '',
    `- Repo: ${args.fullName}`,
    `- Parameters: k=${args.k ?? 'default'} threshold=${args.threshold ?? 'default'} candidateK=${args.candidateK ?? 'default'}`,
    `- Vectorlite efSearch: ${args.efSearch ?? 'default(10)'}`,
    `- Exact clusters: ${exactResult.clusters}`,
    `- Vectorlite clusters: ${vectorliteResult.clusters}`,
    '',
    ...buildSummaryTable(exactTop, vectorTop, matches),
    ...buildDetailLines(vectorTop, matches, metaById, args.sampleMembers),
  ];

  process.stdout.write(`\n${lines.join('\n')}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.childBackend === 'exact' || args.childBackend === 'vectorlite') {
  await runChild(args);
} else {
  await runParent(args);
}
