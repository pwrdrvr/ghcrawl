import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreSimilarityEvidence } from './evidence-score.js';
import { buildDeterministicThreadFingerprint } from './thread-fingerprint.js';

function fp(params: {
  id: number;
  title: string;
  body?: string;
  files?: string[];
  refs?: string[];
  hunks?: string[];
  patches?: string[];
}) {
  return buildDeterministicThreadFingerprint({
    threadId: params.id,
    number: params.id,
    kind: 'pull_request',
    title: params.title,
    body: params.body ?? '',
    labels: [],
    changedFiles: params.files ?? [],
    linkedRefs: params.refs ?? [],
    hunkSignatures: params.hunks ?? [],
    patchIds: params.patches ?? [],
  });
}

test('scoreSimilarityEvidence emits strong evidence from deterministic code overlap', () => {
  const left = fp({
    id: 1,
    title: 'Fix cache key collision',
    files: ['packages/api-core/src/cache.ts'],
    refs: ['123'],
    hunks: ['h1'],
    patches: ['p1'],
  });
  const right = fp({
    id: 2,
    title: 'Fix cache key collision',
    files: ['packages/api-core/src/cache.ts'],
    refs: ['123'],
    hunks: ['h1'],
    patches: ['p1'],
  });

  const evidence = scoreSimilarityEvidence(left, right);

  assert.equal(evidence.tier, 'strong');
  assert.ok(evidence.score > 0.7);
  assert.equal(evidence.embeddingSimilarity, null);
  assert.equal(evidence.llmKeySimilarity, null);
});

test('scoreSimilarityEvidence can improve confidence with optional enrichment', () => {
  const left = fp({ id: 1, title: 'Fix flaky download retry', body: 'Retries forever after timeout.' });
  const right = fp({ id: 2, title: 'Handle stalled download timeout', body: 'Retry loop never exits.' });

  const base = scoreSimilarityEvidence(left, right);
  const enriched = scoreSimilarityEvidence(left, right, { embeddingSimilarity: 0.95, llmKeySimilarity: 0.95 });

  assert.ok(enriched.score > base.score);
});

test('scoreSimilarityEvidence treats exact hunk overlap as strong evidence without prose similarity', () => {
  const left = fp({ id: 1, title: 'Replace queue scheduler', body: 'Internal refactor.', hunks: ['same-hunk'] });
  const right = fp({ id: 2, title: 'Patch database migrator', body: 'Unrelated words.', hunks: ['same-hunk'] });

  const evidence = scoreSimilarityEvidence(left, right);

  assert.equal(evidence.tier, 'strong');
  assert.equal(evidence.hunkOverlap, 1);
});

test('scoreSimilarityEvidence rejects unrelated deterministic fingerprints', () => {
  const left = fp({ id: 1, title: 'Fix cache key collision', files: ['packages/api-core/src/cache.ts'] });
  const right = fp({ id: 2, title: 'Update docs typography', files: ['docs/design.md'] });

  const evidence = scoreSimilarityEvidence(left, right);

  assert.equal(evidence.tier, 'none');
});

test('scoreSimilarityEvidence rejects broad same-module maintenance without close title evidence', () => {
  const left = fp({
    id: 1,
    title: 'Fix cron missing job state',
    files: Array.from({ length: 30 }, (_, index) => `packages/api-core/src/cron-${index}.ts`),
  });
  const right = fp({
    id: 2,
    title: 'Clear session model override',
    files: Array.from({ length: 30 }, (_, index) => `packages/api-core/src/session-${index}.ts`),
  });

  const evidence = scoreSimilarityEvidence(left, right);

  assert.equal(evidence.tier, 'none');
});
