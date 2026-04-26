import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeterministicThreadFingerprint,
  compareDeterministicFingerprints,
  moduleBucket,
  tokenize,
} from './thread-fingerprint.js';

test('tokenize normalizes text for deterministic fingerprints', () => {
  assert.deepEqual(tokenize('Fix: Download retry hangs!'), ['fix', 'download', 'retry', 'hangs']);
});

test('moduleBucket groups files by stable path prefix', () => {
  assert.equal(moduleBucket('packages/api-core/src/service.ts'), 'packages/api-core/*');
  assert.equal(moduleBucket('README.md'), 'README.md/*');
});

test('buildDeterministicThreadFingerprint is stable without model inputs', () => {
  const input = {
    threadId: 1,
    number: 42,
    kind: 'issue' as const,
    title: 'Download retry hangs',
    body: 'The transfer retries forever after a timeout.',
    labels: ['bug'],
    linkedRefs: ['42'],
  };

  const first = buildDeterministicThreadFingerprint(input);
  const second = buildDeterministicThreadFingerprint(input);

  assert.equal(first.fingerprintHash, second.fingerprintHash);
  assert.equal(first.fingerprintSlug, second.fingerprintSlug);
  assert.equal(first.algorithmVersion, 'thread-fingerprint-v2');
  assert.ok(first.minhashSignature.length > 0);
});

test('compareDeterministicFingerprints scores deterministic overlap features', () => {
  const first = buildDeterministicThreadFingerprint({
    threadId: 1,
    number: 42,
    kind: 'pull_request',
    title: 'Fix downloader retry loop',
    body: 'Stops retrying forever after transfer timeout.',
    labels: ['bug'],
    changedFiles: ['packages/api-core/src/download.ts'],
    linkedRefs: ['100'],
    hunkSignatures: ['h1'],
    patchIds: ['p1'],
  });
  const second = buildDeterministicThreadFingerprint({
    threadId: 2,
    number: 43,
    kind: 'pull_request',
    title: 'Fix downloader retry loop',
    body: 'Stops retrying forever after transfer timeout.',
    labels: ['bug'],
    changedFiles: ['packages/api-core/src/download.ts'],
    linkedRefs: ['100'],
    hunkSignatures: ['h1'],
    patchIds: ['p1'],
  });

  const breakdown = compareDeterministicFingerprints(first, second);

  assert.equal(breakdown.linkedRefOverlap, 1);
  assert.equal(breakdown.fileOverlap, 1);
  assert.equal(breakdown.hunkOverlap, 1);
  assert.equal(breakdown.patchOverlap, 1);
  assert.ok(Math.abs(breakdown.structure - 1) < 1e-9);
  assert.equal(breakdown.lineage, 1);
});

test('compareDeterministicFingerprints dampens broad file overlap', () => {
  const shared = 'packages/api-core/src/service.ts';
  const first = buildDeterministicThreadFingerprint({
    threadId: 1,
    number: 42,
    kind: 'pull_request',
    title: 'Fix cron missing job state',
    body: '',
    labels: [],
    changedFiles: [shared, ...Array.from({ length: 60 }, (_, index) => `packages/api-core/src/a-${index}.ts`)],
  });
  const second = buildDeterministicThreadFingerprint({
    threadId: 2,
    number: 43,
    kind: 'pull_request',
    title: 'Fix session model override',
    body: '',
    labels: [],
    changedFiles: [shared, ...Array.from({ length: 60 }, (_, index) => `packages/api-core/src/b-${index}.ts`)],
  });

  const breakdown = compareDeterministicFingerprints(first, second);

  assert.ok(breakdown.fileOverlap < 0.01);
  assert.ok(breakdown.moduleOverlap < 1);
  assert.ok(breakdown.structure < 0.3);
});
