import { buildShingles, jaccard, minhashSignature, minhashSimilarity, simhash64, simhashSimilarity, winnowingFingerprints } from './fingerprint-algorithms.js';
import { humanKeyForValue, stableHash } from './human-key.js';

const TOKEN_RE = /[a-zA-Z0-9_]+/g;
const TITLE_STOPWORDS = new Set([
  'fix',
  'bug',
  'feat',
  'feature',
  'docs',
  'chore',
  'refactor',
  'test',
  'add',
  'update',
  'improve',
  'support',
  'allow',
  'enable',
  'with',
  'from',
  'when',
  'after',
  'before',
  'into',
  'for',
  'the',
  'and',
  'or',
]);

export type FingerprintInput = {
  threadId: number;
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  body: string | null;
  labels: string[];
  changedFiles?: string[];
  linkedRefs?: string[];
  hunkSignatures?: string[];
  patchIds?: string[];
};

export type DeterministicThreadFingerprint = {
  algorithmVersion: string;
  fingerprintHash: string;
  fingerprintSlug: string;
  titleTokens: string[];
  salientTitleTokens: string[];
  bodyTokens: string[];
  linkedRefs: string[];
  moduleBuckets: string[];
  changedFiles: string[];
  hunkSignatures: string[];
  patchIds: string[];
  featureHash: string;
  minhashSignature: string[];
  simhash64: string;
  winnowHashes: string[];
};

export type FingerprintPairBreakdown = {
  linkedRefOverlap: number;
  titleOverlap: number;
  tokenMinhash: number;
  tokenSimhash: number;
  tokenWinnow: number;
  fileOverlap: number;
  moduleOverlap: number;
  hunkOverlap: number;
  patchOverlap: number;
  structure: number;
  lineage: number;
};

export const THREAD_FINGERPRINT_ALGORITHM_VERSION = 'thread-fingerprint-v2';

export function tokenize(value: string | null | undefined): string[] {
  return Array.from(value?.toLowerCase().matchAll(TOKEN_RE) ?? []).map((match) => match[0]);
}

export function moduleBucket(path: string, depth = 2): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return 'root/*';
  return `${parts.slice(0, depth).join('/')}/*`;
}

export function fingerprintFeatureHash(input: {
  linkedRefs: string[];
  changedFiles: string[];
  moduleBuckets?: string[];
  hunkSignatures: string[];
  patchIds: string[];
}): string {
  const changedFiles = uniqueSorted(input.changedFiles);
  const moduleBuckets = uniqueSorted(input.moduleBuckets ?? changedFiles.map((path) => moduleBucket(path)));
  return stableHash(
    JSON.stringify({
      linkedRefs: uniqueSorted(input.linkedRefs),
      changedFiles,
      moduleBuckets,
      hunkSignatures: uniqueSorted(input.hunkSignatures),
      patchIds: uniqueSorted(input.patchIds),
    }),
  );
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function overlapMin(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / Math.min(left.size, right.size);
}

export function buildDeterministicThreadFingerprint(input: FingerprintInput): DeterministicThreadFingerprint {
  const titleTokens = tokenize(input.title);
  const bodyTokens = tokenize(input.body);
  const changedFiles = uniqueSorted(input.changedFiles ?? []);
  const linkedRefs = uniqueSorted(input.linkedRefs ?? []);
  const hunkSignatures = uniqueSorted(input.hunkSignatures ?? []);
  const patchIds = uniqueSorted(input.patchIds ?? []);
  const moduleBuckets = uniqueSorted(changedFiles.map((path) => moduleBucket(path)));
  const salientTitleTokens = uniqueSorted(titleTokens.filter((token) => token.length >= 4 && !TITLE_STOPWORDS.has(token)));
  const featureHash = fingerprintFeatureHash({ linkedRefs, changedFiles, moduleBuckets, hunkSignatures, patchIds });
  const materialTokens = [
    ...titleTokens,
    ...bodyTokens,
    ...linkedRefs,
    ...changedFiles,
    ...hunkSignatures,
    ...patchIds,
  ];
  const minhash = minhashSignature(materialTokens);
  const simhash = simhash64(materialTokens);
  const winnow = winnowingFingerprints(materialTokens);
  const hashMaterial = JSON.stringify({
    algorithmVersion: THREAD_FINGERPRINT_ALGORITHM_VERSION,
    kind: input.kind,
    titleTokens,
    bodyTokens,
    labels: uniqueSorted(input.labels),
    linkedRefs,
    changedFiles,
    hunkSignatures,
    patchIds,
    minhash,
    simhash,
    winnow,
  });
  const key = humanKeyForValue(hashMaterial);

  return {
    algorithmVersion: THREAD_FINGERPRINT_ALGORITHM_VERSION,
    fingerprintHash: key.hash,
    fingerprintSlug: key.slug,
    titleTokens,
    salientTitleTokens,
    bodyTokens,
    linkedRefs,
    moduleBuckets,
    changedFiles,
    hunkSignatures,
    patchIds,
    featureHash,
    minhashSignature: minhash,
    simhash64: simhash,
    winnowHashes: winnow,
  };
}

export function compareDeterministicFingerprints(
  left: DeterministicThreadFingerprint,
  right: DeterministicThreadFingerprint,
): FingerprintPairBreakdown {
  const linkedRefOverlap = Math.max(
    jaccard(new Set(left.linkedRefs), new Set(right.linkedRefs)),
    overlapMin(new Set(left.linkedRefs), new Set(right.linkedRefs)),
  );
  const titleOverlap = jaccard(new Set(left.salientTitleTokens), new Set(right.salientTitleTokens));
  const maxChangedFiles = Math.max(left.changedFiles.length, right.changedFiles.length);
  const fileBreadthPenalty = breadthPenalty(maxChangedFiles, 40);
  const moduleBreadthPenalty = breadthPenalty(maxChangedFiles, 12);
  const fileOverlap = jaccard(new Set(left.changedFiles), new Set(right.changedFiles)) * fileBreadthPenalty;
  const moduleOverlap = jaccard(new Set(left.moduleBuckets), new Set(right.moduleBuckets)) * moduleBreadthPenalty;
  const hunkOverlap = jaccard(new Set(left.hunkSignatures), new Set(right.hunkSignatures));
  const patchOverlap = overlapMin(new Set(left.patchIds), new Set(right.patchIds));
  return {
    linkedRefOverlap,
    titleOverlap,
    tokenMinhash: minhashSimilarity(left.minhashSignature, right.minhashSignature),
    tokenSimhash: simhashSimilarity(left.simhash64, right.simhash64),
    tokenWinnow: jaccard(new Set(left.winnowHashes), new Set(right.winnowHashes)),
    fileOverlap,
    moduleOverlap,
    hunkOverlap,
    patchOverlap,
    structure: Math.max(hunkOverlap, patchOverlap, fileOverlap, 0.25 * moduleOverlap),
    lineage: patchOverlap,
  };
}

function breadthPenalty(count: number, freeCount: number): number {
  if (count <= freeCount) return 1;
  return freeCount / count;
}

export function tokenShinglesForDebug(tokens: string[], size = 3): string[] {
  return buildShingles(tokens, size);
}
