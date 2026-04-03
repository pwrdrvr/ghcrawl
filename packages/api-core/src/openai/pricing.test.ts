import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCost } from './pricing.js';

test('computeCost returns correct cost for text-embedding-3-large', () => {
  const cost = computeCost('text-embedding-3-large', { promptTokens: 1_000_000, completionTokens: 0 });
  assert.notEqual(cost, null);
  assert.equal(cost!.estimatedCostUsd, 0.13);
});

test('computeCost returns correct cost for text-embedding-3-small', () => {
  const cost = computeCost('text-embedding-3-small', { promptTokens: 1_000_000, completionTokens: 0 });
  assert.notEqual(cost, null);
  assert.equal(cost!.estimatedCostUsd, 0.02);
});

test('computeCost handles fractional token counts', () => {
  const cost = computeCost('text-embedding-3-large', { promptTokens: 285_000, completionTokens: 0 });
  assert.notEqual(cost, null);
  assert.ok(Math.abs(cost!.estimatedCostUsd - 0.03705) < 0.00001);
});

test('computeCost returns correct cost for gpt-5-mini with input and output', () => {
  const cost = computeCost('gpt-5-mini', { promptTokens: 5_000, completionTokens: 1_000 });
  assert.notEqual(cost, null);
  // (5000 * 0.40 / 1M) + (1000 * 1.60 / 1M) = 0.002 + 0.0016 = 0.0036
  assert.ok(Math.abs(cost!.estimatedCostUsd - 0.0036) < 0.00001);
});

test('computeCost applies cached input pricing when available', () => {
  const cost = computeCost('gpt-5-mini', {
    promptTokens: 5_000,
    completionTokens: 1_000,
    cachedPromptTokens: 3_000,
  });
  assert.notEqual(cost, null);
  // non-cached: (5000-3000) * 0.40/1M = 0.0008
  // cached:     3000 * 0.10/1M         = 0.0003
  // output:     1000 * 1.60/1M         = 0.0016
  // total: 0.0027
  assert.ok(Math.abs(cost!.estimatedCostUsd - 0.0027) < 0.00001);
});

test('computeCost returns null for unknown model', () => {
  const cost = computeCost('unknown-model-v9', { promptTokens: 1_000, completionTokens: 0 });
  assert.equal(cost, null);
});

test('computeCost returns zero for zero tokens', () => {
  const cost = computeCost('text-embedding-3-large', { promptTokens: 0, completionTokens: 0 });
  assert.notEqual(cost, null);
  assert.equal(cost!.estimatedCostUsd, 0);
});
