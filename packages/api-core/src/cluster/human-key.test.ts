import test from 'node:test';
import assert from 'node:assert/strict';

import { humanKeyForValue, humanKeyFromHash, humanKeyStableSlug, stableHash } from './human-key.js';

test('humanKeyForValue returns a stable operator slug and machine hash', () => {
  const first = humanKeyForValue('repo:openclaw/openclaw thread:42 title:download stalls');
  const second = humanKeyForValue('repo:openclaw/openclaw thread:42 title:download stalls');

  assert.equal(first.hash, second.hash);
  assert.equal(first.slug, second.slug);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.match(first.slug, /^[a-z]+-[a-z]+-[a-z]+$/);
  assert.match(first.checksum, /^[a-z0-9]{4}$/);
  assert.match(humanKeyStableSlug(first), /^[a-z]+-[a-z]+-[a-z]+-[a-z0-9]{4}$/);
});

test('humanKeyFromHash rejects non-SHA256 input', () => {
  assert.throws(() => humanKeyFromHash('not-a-hash'), /SHA-256/);
});

test('stableHash changes when source material changes', () => {
  assert.notEqual(stableHash('thread a'), stableHash('thread b'));
});
