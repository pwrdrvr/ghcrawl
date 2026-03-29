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
  let top = 20;
  let maxSize = 20;

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
    if (token === '--top') {
      top = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--max-size') {
      maxSize = Number(argv[index + 1]);
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
    top: Number.isFinite(top) ? Math.max(1, top) : 20,
    maxSize: Number.isFinite(maxSize) ? Math.max(1, maxSize) : 20,
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function countThreadsRepresented(histogram) {
  return histogram.reduce((sum, bucket) => sum + bucket.size * bucket.count, 0);
}

function histogramToMap(histogram) {
  return new Map(histogram.map((bucket) => [bucket.size, bucket.count]));
}

function formatDelta(value) {
  return value > 0 ? `+${value}` : String(value);
}

function repeat(character, count) {
  return count > 0 ? character.repeat(count) : '';
}

function buildBar(count, maxCount, width) {
  if (maxCount <= 0) return '';
  const scaled = Math.round((count / maxCount) * width);
  return repeat('#', scaled);
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
    const childArgs = [
      '--expose-gc',
      path.join(repoRoot, 'scripts', 'cluster-population-compare.mjs'),
      args.fullName,
      '--child-backend',
      backend,
      '--top',
      String(args.top),
      '--max-size',
      String(args.maxSize),
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
        reject(new Error(`${backend} comparison exited with ${detail}`));
        return;
      }
      if (!result) {
        reject(new Error(`${backend} comparison did not emit a result payload`));
        return;
      }
      resolve(result);
    });
  });
}

function buildSummaryLines(args, exactResult, vectorliteResult) {
  const exactHistogram = exactResult.clusterSizes.histogram;
  const vectorHistogram = vectorliteResult.clusterSizes.histogram;
  const exactThreadsRepresented = countThreadsRepresented(exactHistogram);
  const vectorThreadsRepresented = countThreadsRepresented(vectorHistogram);

  return [
    '## Cluster Population Comparison',
    '',
    `- Repo: ${exactResult.repository.fullName}`,
    `- Parameters: k=${args.k ?? 'default'} threshold=${args.threshold ?? 'default'} candidateK=${args.candidateK ?? 'default'}`,
    `- Exact clusters: ${exactResult.clusters}`,
    `- Vectorlite clusters: ${vectorliteResult.clusters}`,
    `- Exact solo clusters: ${exactResult.clusterSizes.soloClusters} (${formatPercent(exactResult.clusterSizes.soloClusters / Math.max(exactResult.clusters, 1))})`,
    `- Vectorlite solo clusters: ${vectorliteResult.clusterSizes.soloClusters} (${formatPercent(vectorliteResult.clusterSizes.soloClusters / Math.max(vectorliteResult.clusters, 1))})`,
    `- Exact max cluster size: ${exactResult.clusterSizes.maxClusterSize}`,
    `- Vectorlite max cluster size: ${vectorliteResult.clusterSizes.maxClusterSize}`,
    `- Exact threads represented: ${exactThreadsRepresented}`,
    `- Vectorlite threads represented: ${vectorThreadsRepresented}`,
    '',
  ];
}

function buildTopSizesLines(exactResult, vectorliteResult, topCount) {
  const exactTop = exactResult.clusterSizes.topClusterSizes.slice(0, topCount);
  const vectorTop = vectorliteResult.clusterSizes.topClusterSizes.slice(0, topCount);
  const lines = ['## Largest Cluster Sizes', '', 'rank  exact  vectorlite  delta', '----  -----  ----------  -----'];

  for (let index = 0; index < topCount; index += 1) {
    const exactSize = exactTop[index] ?? 0;
    const vectorSize = vectorTop[index] ?? 0;
    lines.push(
      `${String(index + 1).padStart(4)}  ${String(exactSize).padStart(5)}  ${String(vectorSize).padStart(10)}  ${formatDelta(vectorSize - exactSize).padStart(5)}`,
    );
  }

  lines.push('');
  return lines;
}

function buildHistogramLines(exactResult, vectorliteResult, maxSize) {
  const exactMap = histogramToMap(exactResult.clusterSizes.histogram);
  const vectorMap = histogramToMap(vectorliteResult.clusterSizes.histogram);
  const exactOverflow = exactResult.clusterSizes.histogram
    .filter((bucket) => bucket.size > maxSize)
    .reduce((sum, bucket) => sum + bucket.count, 0);
  const vectorOverflow = vectorliteResult.clusterSizes.histogram
    .filter((bucket) => bucket.size > maxSize)
    .reduce((sum, bucket) => sum + bucket.count, 0);

  let maxCount = 0;
  for (let size = 1; size <= maxSize; size += 1) {
    maxCount = Math.max(maxCount, exactMap.get(size) ?? 0, vectorMap.get(size) ?? 0);
  }
  maxCount = Math.max(maxCount, exactOverflow, vectorOverflow);

  const lines = ['## Histogram By Cluster Size', '', 'size  exact  vectorlite  delta  bars', '----  -----  ----------  -----  ----'];
  for (let size = 1; size <= maxSize; size += 1) {
    const exactCount = exactMap.get(size) ?? 0;
    const vectorCount = vectorMap.get(size) ?? 0;
    const exactBar = buildBar(exactCount, maxCount, 12);
    const vectorBar = buildBar(vectorCount, maxCount, 12);
    lines.push(
      `${String(size).padStart(4)}  ${String(exactCount).padStart(5)}  ${String(vectorCount).padStart(10)}  ${formatDelta(vectorCount - exactCount).padStart(5)}  E:${exactBar.padEnd(12)} V:${vectorBar.padEnd(12)}`,
    );
  }

  lines.push(
    `${`${maxSize}+`.padStart(4)}  ${String(exactOverflow).padStart(5)}  ${String(vectorOverflow).padStart(10)}  ${formatDelta(vectorOverflow - exactOverflow).padStart(5)}  E:${buildBar(exactOverflow, maxCount, 12).padEnd(12)} V:${buildBar(vectorOverflow, maxCount, 12).padEnd(12)}`,
  );
  lines.push('');
  return lines;
}

async function runParent(args) {
  process.stdout.write(`[exact] starting cluster population comparison for ${args.fullName}\n`);
  const exactResult = await runBackend('exact', args);

  process.stdout.write(`[vectorlite] starting cluster population comparison for ${args.fullName}\n`);
  const vectorliteResult = await runBackend('vectorlite', args);

  const lines = [
    ...buildSummaryLines(args, exactResult, vectorliteResult),
    ...buildTopSizesLines(exactResult, vectorliteResult, args.top),
    ...buildHistogramLines(exactResult, vectorliteResult, args.maxSize),
  ];

  process.stdout.write(`\n${lines.join('\n')}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.childBackend === 'exact' || args.childBackend === 'vectorlite') {
  await runChild(args);
} else {
  await runParent(args);
}
