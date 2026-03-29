import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModulePath = path.join(repoRoot, 'packages', 'api-core', 'dist', 'service.js');

const { GHCrawlService } = await import(serviceModulePath);

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs)) return 'n/a';
  if (durationMs < 1000) return `${durationMs.toFixed(1)} ms`;
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  const absoluteBytes = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (absoluteBytes < 1024 * 1024) {
    return `${sign}${(absoluteBytes / 1024).toFixed(1)} KiB`;
  }
  return `${sign}${(absoluteBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatPercent(value) {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function parseArgs(argv) {
  let repo = 'openclaw/openclaw';
  let k;
  let threshold;
  let candidateK;
  let childBackend = null;
  let backend = 'both';
  let maxOldSpaceSizeMb;

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
    if (token === '--child-backend') {
      childBackend = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (token === '--backend') {
      backend = argv[index + 1] ?? backend;
      index += 1;
      continue;
    }
    if (token === '--max-old-space-size') {
      maxOldSpaceSizeMb = Number(argv[index + 1]);
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
    childBackend,
    backend,
    maxOldSpaceSizeMb: Number.isFinite(maxOldSpaceSizeMb) ? maxOldSpaceSizeMb : undefined,
  };
}

function getRepoStats(service, fullName) {
  const repoRow = service.db
    .prepare('select id, full_name from repositories where full_name = ?')
    .get(fullName);
  if (!repoRow) {
    throw new Error(`Repository not found in local DB: ${fullName}`);
  }

  const openThreadCount = service.db
    .prepare(
      `select count(*) as count
       from threads
       where repo_id = ?
         and state = 'open'
         and closed_at_local is null`,
    )
    .get(repoRow.id).count;

  const embeddingCounts = service.db
    .prepare(
      `select e.source_kind as sourceKind, count(*) as count
       from document_embeddings e
       join threads t on t.id = e.thread_id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and e.model = ?
       group by e.source_kind
       order by e.source_kind asc`,
    )
    .all(repoRow.id, service.config.embedModel);

  return {
    repoId: repoRow.id,
    openThreadCount,
    embeddingCounts,
  };
}

function buildReportLines(label, result) {
  return [
    `### ${label}`,
    '',
    `- Cluster-only duration: ${formatDurationMs(result.durationMs)}`,
    `- Total duration: ${formatDurationMs(result.totalDurationMs)}`,
    `- Load stage: ${formatDurationMs(result.loadMs)}`,
    `- Temp DB setup: ${formatDurationMs(result.setupMs)}`,
    `- Exact edge-build: ${formatDurationMs(result.edgeBuildMs)}`,
    `- Vector index-build: ${formatDurationMs(result.indexBuildMs)}`,
    `- Vector query: ${formatDurationMs(result.queryMs)}`,
    `- Cluster assembly: ${formatDurationMs(result.clusterBuildMs)}`,
    `- Edges: ${result.edges}`,
    `- Clusters: ${result.clusters}`,
    `- Threads: ${result.threads}`,
    `- Source kinds: ${result.sourceKinds}`,
    `- Candidate K: ${result.candidateK}`,
    `- Peak RSS: ${formatBytes(result.memory.peakRssBytes)}`,
    `- Peak heap used: ${formatBytes(result.memory.peakHeapUsedBytes)}`,
    '',
  ];
}

function buildDeltaLines(exactResult, vectorliteResult) {
  const clusterDeltaMs = vectorliteResult.durationMs - exactResult.durationMs;
  const clusterDeltaPercent = exactResult.durationMs > 0 ? (clusterDeltaMs / exactResult.durationMs) * 100 : 0;
  const totalDeltaMs = vectorliteResult.totalDurationMs - exactResult.totalDurationMs;
  const totalDeltaPercent = exactResult.totalDurationMs > 0 ? (totalDeltaMs / exactResult.totalDurationMs) * 100 : 0;
  const peakRssDelta = vectorliteResult.memory.peakRssBytes - exactResult.memory.peakRssBytes;
  const peakHeapDelta = vectorliteResult.memory.peakHeapUsedBytes - exactResult.memory.peakHeapUsedBytes;

  return [
    '### Delta',
    '',
    `- Cluster-only delta vs exact: ${formatDurationMs(clusterDeltaMs)} (${formatPercent(clusterDeltaPercent)})`,
    `- Total duration delta vs exact: ${formatDurationMs(totalDeltaMs)} (${formatPercent(totalDeltaPercent)})`,
    `- Peak RSS delta vs exact: ${formatBytes(peakRssDelta)}`,
    `- Peak heap used delta vs exact: ${formatBytes(peakHeapDelta)}`,
    '',
  ];
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
      onProgress: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(`__GHCRAWL_RESULT__${JSON.stringify(result)}\n`);
  } finally {
    service.close();
  }
}

async function runBackend(backend, args) {
  return await new Promise((resolve, reject) => {
    const childArgs = ['--expose-gc'];
    if (args.maxOldSpaceSizeMb !== undefined) {
      childArgs.push(`--max-old-space-size=${args.maxOldSpaceSizeMb}`);
    }
    childArgs.push(
      path.join(repoRoot, 'scripts', 'cluster-perf-real-compare.mjs'),
      `${args.fullName}`,
      '--child-backend',
      backend,
    );
    if (args.k !== undefined) {
      childArgs.push('--k', String(args.k));
    }
    if (args.threshold !== undefined) {
      childArgs.push('--threshold', String(args.threshold));
    }
    if (args.candidateK !== undefined) {
      childArgs.push('--candidate-k', String(args.candidateK));
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
        reject(new Error(`${backend} benchmark exited with ${detail}`));
        return;
      }
      if (!result) {
        reject(new Error(`${backend} benchmark did not emit a result payload`));
        return;
      }
      resolve(result);
    });
  });
}

async function runParent(args) {
  const service = new GHCrawlService();
  let stats;
  let dbPath;
  let embedModel;
  try {
    stats = getRepoStats(service, args.fullName);
    dbPath = service.config.dbPath;
    embedModel = service.config.embedModel;
  } finally {
    service.close();
  }

  const lines = [
    '## Real Cluster Perf Comparison',
    '',
    `- Repo: ${args.fullName}`,
    `- Config DB: ${dbPath}`,
    `- Embed model: ${embedModel}`,
    `- Open threads: ${stats.openThreadCount}`,
    `- Embedding counts: ${stats.embeddingCounts.map((row) => `${row.sourceKind}=${row.count}`).join(', ') || 'none'}`,
    `- Parameters: k=${args.k ?? 'default'} threshold=${args.threshold ?? 'default'} candidateK=${args.candidateK ?? 'default'}`,
    `- Requested backend(s): ${args.backend}`,
    `- Child max old space size: ${args.maxOldSpaceSizeMb ?? 'default'}`,
    '',
  ];

  let exactResult = null;
  let vectorliteResult = null;

  if (args.backend === 'both' || args.backend === 'exact') {
    process.stdout.write(`[exact] starting real-db cluster experiment for ${args.fullName}\n`);
    exactResult = await runBackend('exact', args);
    lines.push(...buildReportLines('Exact', exactResult));
    if (args.backend === 'both') {
      process.stdout.write(`\n${lines.join('\n')}\n`);
    }
  }

  if (args.backend === 'both' || args.backend === 'vectorlite') {
    process.stdout.write(`[vectorlite] starting real-db cluster experiment for ${args.fullName}\n`);
    vectorliteResult = await runBackend('vectorlite', args);
    lines.push(...buildReportLines('Vectorlite', vectorliteResult));
    if (exactResult) {
      lines.push(...buildDeltaLines(exactResult, vectorliteResult));
    }
  }

  process.stdout.write(`\n${lines.join('\n')}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.childBackend === 'exact' || args.childBackend === 'vectorlite') {
  await runChild(args);
} else {
  await runParent(args);
}
