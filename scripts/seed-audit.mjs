import crypto from 'node:crypto';
import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { parseArgs } from 'node:util';

const allowedRecordKinds = new Set(['manifest', 'thread', 'edge']);
const allowedThreadKinds = new Set(['issue', 'pull_request']);
const allowedSourceKinds = new Set(['title', 'body', 'dedupe_summary']);
const allowedManifestKeys = new Set([
  'schemaVersion',
  'format',
  'snapshotId',
  'createdAt',
  'compatibleCli',
  'owner',
  'repo',
  'fullName',
  'embedModel',
  'sourceKinds',
  'cluster',
  'threadCount',
  'embeddingCount',
  'edgeCount',
]);
const allowedThreadKeys = new Set([
  'owner',
  'repo',
  'kind',
  'number',
  'githubId',
  'threadContentHash',
  'sourceKind',
  'embeddingModel',
  'dimensions',
  'embedding',
]);
const allowedEdgeKeys = new Set(['left', 'right', 'score', 'sources']);
const allowedIdentityKeys = new Set(['owner', 'repo', 'kind', 'number', 'githubId']);
const maxUniqueIssueCount = 200;

async function main() {
  const options = parseCli(process.argv.slice(2));
  const expectedFullName = `${options.owner}/${options.repo}`;
  const assetBuffer = await readAsset(options.asset);
  const sha256 = crypto.createHash('sha256').update(assetBuffer).digest('hex');
  const input = Readable.from(assetBuffer).pipe(createGunzip());
  const reader = createInterface({ input, crlfDelay: Infinity });

  const issueTracker = { counts: new Map(), order: [], omitted: 0 };
  const threadSourceCounts = new Map();
  const edgeSourceCounts = new Map();
  const uniqueThreadIdentities = new Set();
  const uniqueThreadSources = new Set();
  let manifest = null;
  let threadRowCount = 0;
  let edgeRowCount = 0;

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSON record: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      recordIssue(issueTracker, 'Record is not an object.');
      continue;
    }
    if (!allowedRecordKinds.has(record.kind)) {
      recordIssue(issueTracker, `Unexpected record kind: ${String(record.kind)}`);
      continue;
    }

    if (record.kind === 'manifest') {
      if (manifest) {
        recordIssue(issueTracker, 'Archive contains more than one manifest record.');
        continue;
      }
      manifest = validateManifest(record.payload, expectedFullName, options.expectedSources, issueTracker);
      continue;
    }

    if (!manifest) {
      recordIssue(issueTracker, `Encountered ${record.kind} record before manifest.`);
      continue;
    }

    if (record.kind === 'thread') {
      const row = validateThreadRow(record.payload, expectedFullName, options.expectedSources, issueTracker);
      if (!row) {
        continue;
      }
      threadRowCount += 1;
      const identityKey = `${row.kind}:${row.number}`;
      uniqueThreadIdentities.add(identityKey);
      uniqueThreadSources.add(`${identityKey}:${row.sourceKind}`);
      increment(threadSourceCounts, row.sourceKind);
      continue;
    }

    const row = validateEdgeRow(record.payload, expectedFullName, options.expectedSources, issueTracker);
    if (!row) {
      continue;
    }
    edgeRowCount += 1;
    for (const sourceKind of row.sources) {
      increment(edgeSourceCounts, sourceKind);
    }
  }

  if (!manifest) {
    recordIssue(issueTracker, 'Archive did not contain a manifest record.');
  } else {
    if (manifest.threadCount !== uniqueThreadIdentities.size) {
      recordIssue(
        issueTracker,
        `Manifest threadCount=${manifest.threadCount} does not match unique thread identities=${uniqueThreadIdentities.size}.`,
      );
    }
    if (manifest.embeddingCount !== threadRowCount) {
      recordIssue(issueTracker, `Manifest embeddingCount=${manifest.embeddingCount} does not match thread rows=${threadRowCount}.`);
    }
    if (manifest.edgeCount !== edgeRowCount) {
      recordIssue(issueTracker, `Manifest edgeCount=${manifest.edgeCount} does not match edge rows=${edgeRowCount}.`);
    }
    const manifestSources = normalizeSourceKinds(manifest.sourceKinds);
    const seenThreadSources = [...threadSourceCounts.keys()].sort();
    if (manifestSources.join(',') !== seenThreadSources.join(',')) {
      recordIssue(
        issueTracker,
        `Manifest sourceKinds=${manifestSources.join(',')} do not match thread row source kinds=${seenThreadSources.join(',')}.`,
      );
    }
  }

  const report = {
    ok: issueTracker.counts.size === 0 && issueTracker.omitted === 0,
    asset: options.asset,
    sha256,
    expectedRepo: expectedFullName,
    manifest: manifest
      ? {
          snapshotId: manifest.snapshotId,
          schemaVersion: manifest.schemaVersion,
          format: manifest.format,
          compatibleCli: manifest.compatibleCli,
          embedModel: manifest.embedModel,
          sourceKinds: normalizeSourceKinds(manifest.sourceKinds),
          threadCount: manifest.threadCount,
          embeddingCount: manifest.embeddingCount,
          edgeCount: manifest.edgeCount,
        }
      : null,
    observed: {
      uniqueThreadCount: uniqueThreadIdentities.size,
      embeddingRowCount: threadRowCount,
      edgeRowCount,
      threadSourceCounts: objectFromMap(threadSourceCounts),
      edgeSourceCounts: objectFromMap(edgeSourceCounts),
      uniqueThreadSourceCount: uniqueThreadSources.size,
    },
    issues: issueEntries(issueTracker),
    omittedIssueCount: issueTracker.omitted,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    writeTextReport(report);
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

function parseCli(argv) {
  const parsed = parseArgs({
    args: argv,
    options: {
      asset: { type: 'string' },
      repo: { type: 'string' },
      sources: { type: 'string' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  const asset = parsed.values.asset ?? parsed.positionals[0];
  if (typeof asset !== 'string' || asset.trim().length === 0) {
    throw new Error('Missing --asset <path-or-url>');
  }
  const repoValue = parsed.values.repo ?? 'openclaw/openclaw';
  if (typeof repoValue !== 'string' || !repoValue.includes('/')) {
    throw new Error(`Invalid --repo value: ${String(repoValue)}`);
  }
  const [owner, repo] = repoValue.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid --repo value: ${repoValue}`);
  }

  const expectedSources = parsed.values.sources ? normalizeSourceKinds(parsed.values.sources.split(',')) : null;
  return {
    asset,
    owner,
    repo,
    expectedSources,
    json: parsed.values.json === true,
  };
}

async function readAsset(asset) {
  if (/^https?:\/\//i.test(asset)) {
    const response = await fetch(asset);
    if (!response.ok) {
      throw new Error(`Failed to download seed asset: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  if (asset.startsWith('file://')) {
    return fs.readFileSync(new URL(asset));
  }

  return fs.readFileSync(asset);
}

function validateManifest(value, expectedFullName, expectedSources, issueTracker) {
  if (!isPlainObject(value)) {
    recordIssue(issueTracker, 'Manifest payload is not an object.');
    return null;
  }
  rejectUnknownKeys('manifest', value, allowedManifestKeys, issueTracker);
  const [expectedOwner, expectedRepo] = expectedFullName.split('/');
  if (value.owner !== expectedOwner || value.repo !== expectedRepo || value.fullName !== expectedFullName) {
    recordIssue(issueTracker, `Manifest targets ${String(value.fullName)} instead of ${expectedFullName}.`);
  }
  if (!Array.isArray(value.sourceKinds) || value.sourceKinds.length === 0) {
    recordIssue(issueTracker, 'Manifest sourceKinds is missing or empty.');
  } else {
    for (const sourceKind of value.sourceKinds) {
      if (!allowedSourceKinds.has(sourceKind)) {
        recordIssue(issueTracker, `Manifest contains unsupported source kind: ${String(sourceKind)}.`);
      }
    }
  }
  if (expectedSources) {
    const manifestSources = normalizeSourceKinds(Array.isArray(value.sourceKinds) ? value.sourceKinds : []);
    if (manifestSources.join(',') !== expectedSources.join(',')) {
      recordIssue(
        issueTracker,
        `Manifest sourceKinds=${manifestSources.join(',')} do not match expected sources=${expectedSources.join(',')}.`,
      );
    }
  }
  if (!isPlainObject(value.cluster)) {
    recordIssue(issueTracker, 'Manifest cluster metadata is missing.');
  }
  return value;
}

function validateThreadRow(value, expectedFullName, expectedSources, issueTracker) {
  if (!isPlainObject(value)) {
    recordIssue(issueTracker, 'Thread payload is not an object.');
    return null;
  }
  rejectUnknownKeys('thread', value, allowedThreadKeys, issueTracker);
  validateIdentity(value, 'thread', expectedFullName, issueTracker, false);
  if (!allowedSourceKinds.has(value.sourceKind)) {
    recordIssue(issueTracker, `Thread row has unsupported source kind: ${String(value.sourceKind)}.`);
  }
  if (expectedSources && !expectedSources.includes(value.sourceKind)) {
    recordIssue(
      issueTracker,
      `Thread row has source kind ${String(value.sourceKind)} outside expected sources ${expectedSources.join(',')}.`,
    );
  }
  if (!Array.isArray(value.embedding) || value.embedding.length === 0 || !value.embedding.every((item) => typeof item === 'number')) {
    recordIssue(issueTracker, `Thread ${String(value.kind)}#${String(value.number)} has an invalid embedding payload.`);
  }
  if (!Number.isInteger(value.dimensions) || value.dimensions <= 0) {
    recordIssue(issueTracker, `Thread ${String(value.kind)}#${String(value.number)} has invalid dimensions=${String(value.dimensions)}.`);
  }
  if (Array.isArray(value.embedding) && Number.isInteger(value.dimensions) && value.embedding.length !== value.dimensions) {
    recordIssue(
      issueTracker,
      `Thread ${String(value.kind)}#${String(value.number)} dimensions=${value.dimensions} does not match embedding length=${value.embedding.length}.`,
    );
  }
  return value;
}

function validateEdgeRow(value, expectedFullName, expectedSources, issueTracker) {
  if (!isPlainObject(value)) {
    recordIssue(issueTracker, 'Edge payload is not an object.');
    return null;
  }
  rejectUnknownKeys('edge', value, allowedEdgeKeys, issueTracker);
  validateIdentity(value.left, 'edge.left', expectedFullName, issueTracker);
  validateIdentity(value.right, 'edge.right', expectedFullName, issueTracker);
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    recordIssue(issueTracker, 'Edge row has no sources.');
  } else {
    for (const sourceKind of value.sources) {
      if (!allowedSourceKinds.has(sourceKind)) {
        recordIssue(issueTracker, `Edge row has unsupported source kind: ${String(sourceKind)}.`);
        continue;
      }
      if (expectedSources && !expectedSources.includes(sourceKind)) {
        recordIssue(
          issueTracker,
          `Edge row has source kind ${String(sourceKind)} outside expected sources ${expectedSources.join(',')}.`,
        );
      }
    }
  }
  if (typeof value.score !== 'number' || !Number.isFinite(value.score)) {
    recordIssue(issueTracker, `Edge row has invalid score=${String(value.score)}.`);
  }
  return value;
}

function validateIdentity(value, label, expectedFullName, issueTracker, rejectUnknown = true) {
  if (!isPlainObject(value)) {
    recordIssue(issueTracker, `${label} is not an object.`);
    return;
  }
  if (rejectUnknown) {
    rejectUnknownKeys(label, value, allowedIdentityKeys, issueTracker);
  }
  const [expectedOwner, expectedRepo] = expectedFullName.split('/');
  if (value.owner !== expectedOwner || value.repo !== expectedRepo) {
    recordIssue(issueTracker, `${label} points to ${String(value.owner)}/${String(value.repo)} instead of ${expectedFullName}.`);
  }
  if (!allowedThreadKinds.has(value.kind)) {
    recordIssue(issueTracker, `${label} has invalid kind=${String(value.kind)}.`);
  }
  if (!Number.isInteger(value.number) || value.number <= 0) {
    recordIssue(issueTracker, `${label} has invalid number=${String(value.number)}.`);
  }
  if (typeof value.githubId !== 'string' || value.githubId.length === 0) {
    recordIssue(issueTracker, `${label} has invalid githubId.`);
  }
}

function rejectUnknownKeys(label, value, allowedKeys, issueTracker) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      recordIssue(issueTracker, `${label} contains unexpected key ${key}.`);
    }
  }
}

function recordIssue(issueTracker, issue) {
  const current = issueTracker.counts.get(issue);
  if (typeof current === 'number') {
    issueTracker.counts.set(issue, current + 1);
    return;
  }
  if (issueTracker.order.length < maxUniqueIssueCount) {
    issueTracker.order.push(issue);
    issueTracker.counts.set(issue, 1);
    return;
  }
  issueTracker.omitted += 1;
}

function issueEntries(issueTracker) {
  return issueTracker.order.map((issue) => {
    const count = issueTracker.counts.get(issue) ?? 1;
    return count === 1 ? issue : `${issue} (${count} occurrences)`;
  });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSourceKinds(sourceKinds) {
  return [...new Set(sourceKinds)].sort();
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function objectFromMap(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function writeTextReport(report) {
  const lines = [
    'seed audit',
    `ok: ${report.ok ? 'yes' : 'no'}`,
    `asset: ${report.asset}`,
    `sha256: ${report.sha256}`,
    `expected repo: ${report.expectedRepo}`,
  ];

  if (report.manifest) {
    lines.push(
      '',
      'manifest',
      `  snapshot: ${report.manifest.snapshotId}`,
      `  schema: ${report.manifest.schemaVersion}`,
      `  format: ${report.manifest.format}`,
      `  compatible cli: ${report.manifest.compatibleCli}`,
      `  embed model: ${report.manifest.embedModel}`,
      `  source kinds: ${report.manifest.sourceKinds.join(', ')}`,
      `  thread count: ${report.manifest.threadCount}`,
      `  embedding count: ${report.manifest.embeddingCount}`,
      `  edge count: ${report.manifest.edgeCount}`,
    );
  }

  lines.push(
    '',
    'observed',
    `  unique threads: ${report.observed.uniqueThreadCount}`,
    `  embedding rows: ${report.observed.embeddingRowCount}`,
    `  edge rows: ${report.observed.edgeRowCount}`,
    `  thread sources: ${formatCounts(report.observed.threadSourceCounts)}`,
    `  edge sources: ${formatCounts(report.observed.edgeSourceCounts)}`,
  );

  if (report.issues.length > 0 || report.omittedIssueCount > 0) {
    lines.push('', 'issues');
    for (const issue of report.issues) {
      lines.push(`  - ${issue}`);
    }
    if (report.omittedIssueCount > 0) {
      lines.push(`  - ... ${report.omittedIssueCount} additional issues omitted`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function formatCounts(value) {
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([key, count]) => `${key}=${count}`).join(', ');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
