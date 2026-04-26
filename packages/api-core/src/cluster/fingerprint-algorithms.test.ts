import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildShingles,
  jaccard,
  minhashSignature,
  minhashSimilarity,
  simhash64,
  simhashSimilarity,
  winnowingFingerprints,
} from './fingerprint-algorithms.js';

test('buildShingles creates stable token shingles', () => {
  assert.deepEqual(buildShingles(['a', 'b', 'c', 'd'], 3), ['a b c', 'b c d']);
  assert.deepEqual(buildShingles(['a', 'b'], 3), ['a b']);
});

test('minhash signatures are deterministic and comparable', () => {
  const first = minhashSignature(['cache', 'key', 'collision', 'fix'], { permutations: 16, shingleSize: 2 });
  const second = minhashSignature(['cache', 'key', 'collision', 'fix'], { permutations: 16, shingleSize: 2 });
  const different = minhashSignature(['ui', 'button', 'color', 'fix'], { permutations: 16, shingleSize: 2 });

  assert.deepEqual(first, second);
  assert.equal(minhashSimilarity(first, second), 1);
  assert.ok(minhashSimilarity(first, different) < 1);
});

test('simhash similarity reflects token distance', () => {
  const first = simhash64(['download', 'retry', 'timeout', 'hangs']);
  const second = simhash64(['download', 'retry', 'timeout', 'stalls']);
  const different = simhash64(['theme', 'button', 'contrast', 'color']);

  assert.ok(simhashSimilarity(first, second) > simhashSimilarity(first, different));
});

test('winnowing fingerprints are deterministic selected hashes', () => {
  const first = winnowingFingerprints(['a', 'b', 'c', 'd', 'e', 'f'], { kgram: 3, window: 2 });
  const second = winnowingFingerprints(['a', 'b', 'c', 'd', 'e', 'f'], { kgram: 3, window: 2 });

  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
});

test('jaccard scores set overlap', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
});
