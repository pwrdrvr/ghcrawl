import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip, gzipSync } from 'node:zlib';

import { z } from 'zod';

const seedThreadKindSchema = z.enum(['issue', 'pull_request']);
export const seedEmbeddingSourceKindSchema = z.enum(['title', 'body', 'dedupe_summary']);

export const seedSidecarSchemaVersion = 1;
export const seedSidecarFormat = 'ghcrawl-seed-sidecar-gzip-v1';

const semverSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const compatibleRangeSchema = z.string().regex(/^>=\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? <\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

export const seedThreadIdentitySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  kind: seedThreadKindSchema,
  number: z.number().int().positive(),
  githubId: z.string().min(1),
});

export const seedThreadSidecarRowSchema = seedThreadIdentitySchema.extend({
  threadContentHash: z.string().min(1),
  sourceKind: seedEmbeddingSourceKindSchema,
  embeddingModel: z.string().min(1),
  dimensions: z.number().int().positive(),
  embedding: z.array(z.number()),
});

export const seedEdgeSidecarRowSchema = z.object({
  left: seedThreadIdentitySchema,
  right: seedThreadIdentitySchema,
  score: z.number(),
  sources: z.array(seedEmbeddingSourceKindSchema).default(['title']),
});

export const seedSidecarManifestSchema = z.object({
  schemaVersion: z.literal(seedSidecarSchemaVersion),
  format: z.literal(seedSidecarFormat),
  snapshotId: z.string().min(1),
  createdAt: z.string().datetime(),
  compatibleCli: compatibleRangeSchema,
  owner: z.string().min(1),
  repo: z.string().min(1),
  fullName: z.string().min(1),
  embedModel: z.string().min(1),
  sourceKinds: z.array(seedEmbeddingSourceKindSchema).min(1),
  cluster: z.object({
    k: z.number().int().positive(),
    minScore: z.number(),
  }),
  threadCount: z.number().int().nonnegative(),
  embeddingCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
});

export const seedSidecarArchiveSchema = z.object({
  manifest: seedSidecarManifestSchema,
  threads: z.array(seedThreadSidecarRowSchema),
  edges: z.array(seedEdgeSidecarRowSchema),
});

export const knownSeedManifestEntrySchema = seedSidecarManifestSchema.extend({
  downloadUrl: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export type SeedThreadIdentity = z.infer<typeof seedThreadIdentitySchema>;
export type SeedThreadSidecarRow = z.infer<typeof seedThreadSidecarRowSchema>;
export type SeedEdgeSidecarRow = z.infer<typeof seedEdgeSidecarRowSchema>;
export type SeedSidecarManifest = z.infer<typeof seedSidecarManifestSchema>;
export type SeedSidecarArchive = z.infer<typeof seedSidecarArchiveSchema>;
export type KnownSeedManifestEntry = z.infer<typeof knownSeedManifestEntrySchema>;
export type SeedSidecarArchiveWriterInput = {
  manifest: SeedSidecarManifest;
  threads: Iterable<SeedThreadSidecarRow>;
  edges: Iterable<SeedEdgeSidecarRow>;
};

const knownSeedManifest: Record<string, KnownSeedManifestEntry> = {
  'openclaw/openclaw': {
    schemaVersion: seedSidecarSchemaVersion,
    format: seedSidecarFormat,
    snapshotId: 'replace-with-real-openclaw-seed',
    createdAt: '2026-03-12T00:00:00.000Z',
    compatibleCli: '>=0.0.0 <1.0.0',
    owner: 'openclaw',
    repo: 'openclaw',
    fullName: 'openclaw/openclaw',
    embedModel: 'text-embedding-3-large',
    sourceKinds: ['title', 'body'],
    cluster: {
      k: 6,
      minScore: 0.82,
    },
    threadCount: 0,
    embeddingCount: 0,
    edgeCount: 0,
    downloadUrl: 'https://example.invalid/replace-with-real-openclaw-seed.seed.json.gz',
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  },
};

export function getKnownSeedManifestEntry(owner: string, repo: string): KnownSeedManifestEntry | null {
  const entry = knownSeedManifest[`${owner}/${repo}`];
  return entry ? knownSeedManifestEntrySchema.parse(entry) : null;
}

export function serializeSeedSidecarArchive(value: SeedSidecarArchive): Buffer {
  const archive = seedSidecarArchiveSchema.parse(value);
  const lines = [
    JSON.stringify({ kind: 'manifest', payload: archive.manifest }),
    ...archive.threads.map((row) => JSON.stringify({ kind: 'thread', payload: row })),
    ...archive.edges.map((row) => JSON.stringify({ kind: 'edge', payload: row })),
  ];
  return gzipSync(Buffer.from(lines.join('\n'), 'utf8'));
}

export async function parseSeedSidecarArchive(buffer: Buffer): Promise<SeedSidecarArchive> {
  const archive: Partial<SeedSidecarArchive> & {
    threads: SeedThreadSidecarRow[];
    edges: SeedEdgeSidecarRow[];
  } = {
    threads: [],
    edges: [],
  };
  const input = Readable.from(buffer).pipe(createGunzip());
  const reader = createInterface({ input, crlfDelay: Infinity });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed) as { kind?: unknown; payload?: unknown };
    if (record.kind === 'manifest') {
      archive.manifest = seedSidecarManifestSchema.parse(record.payload);
      continue;
    }
    if (record.kind === 'thread') {
      archive.threads.push(seedThreadSidecarRowSchema.parse(record.payload));
      continue;
    }
    if (record.kind === 'edge') {
      archive.edges.push(seedEdgeSidecarRowSchema.parse(record.payload));
      continue;
    }
    throw new Error(`Unknown seed sidecar record kind: ${String(record.kind)}`);
  }

  return seedSidecarArchiveSchema.parse(archive);
}

export async function writeSeedSidecarArchive(
  outputPath: string,
  value: SeedSidecarArchive | SeedSidecarArchiveWriterInput,
): Promise<{ sha256: string }> {
  const manifest = seedSidecarManifestSchema.parse(value.manifest);
  const gzip = createGzip();
  const output = fs.createWriteStream(outputPath);
  const hash = crypto.createHash('sha256');
  gzip.on('data', (chunk) => hash.update(chunk));
  gzip.pipe(output);

  await writeGzipLine(gzip, JSON.stringify({ kind: 'manifest', payload: manifest }));
  for (const row of value.threads) {
    await writeGzipLine(gzip, JSON.stringify({ kind: 'thread', payload: seedThreadSidecarRowSchema.parse(row) }));
  }
  for (const row of value.edges) {
    await writeGzipLine(gzip, JSON.stringify({ kind: 'edge', payload: seedEdgeSidecarRowSchema.parse(row) }));
  }
  gzip.end();

  await finished(output);
  return { sha256: hash.digest('hex') };
}

async function writeGzipLine(stream: ReturnType<typeof createGzip>, line: string): Promise<void> {
  if (stream.write(`${line}\n`)) {
    return;
  }
  await once(stream, 'drain');
}

export function sha256Hex(buffer: Uint8Array): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function readSeedAsset(assetUrl: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(assetUrl)) {
    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(`Failed to download seed asset: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  if (assetUrl.startsWith('file://')) {
    return fs.readFileSync(new URL(assetUrl));
  }

  return fs.readFileSync(assetUrl);
}

export function isCliVersionCompatible(version: string, range: string): boolean {
  const parsedVersion = parseSemver(semverSchema.parse(version));
  const [minimum, maximum] = compatibleRangeSchema
    .parse(range)
    .split(' ')
    .map((part) => parseSemver(part.replace(/^(>=|<)/, '')));
  return compareSemver(parsedVersion, minimum) >= 0 && compareSemver(parsedVersion, maximum) < 0;
}

function parseSemver(value: string): [number, number, number, string] {
  const match = semverSchema.parse(value).match(/^(\d+)\.(\d+)\.(\d+)(?:([-+].+))?$/);
  if (!match) {
    throw new Error(`Invalid semver: ${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
}

function compareSemver(left: [number, number, number, string], right: [number, number, number, string]): number {
  const majorDelta = left[0] - right[0];
  if (majorDelta !== 0) return majorDelta;
  const minorDelta = left[1] - right[1];
  if (minorDelta !== 0) return minorDelta;
  const patchDelta = left[2] - right[2];
  if (patchDelta !== 0) return patchDelta;
  if (left[3] === right[3]) {
    return 0;
  }
  if (!left[3]) {
    return 1;
  }
  if (!right[3]) {
    return -1;
  }
  return left[3].localeCompare(right[3]);
}
