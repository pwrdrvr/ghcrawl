import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_KEY_SUMMARY_PROMPT_VERSION,
  LLM_KEY_SUMMARY_SYSTEM_PROMPT,
  llmKeyEmbeddingText,
  llmKeyInputHash,
  parseLlmKeySummary,
} from './llm-key-summary.js';

test('parseLlmKeySummary accepts the strict key-summary contract', () => {
  const summary = parseLlmKeySummary({
    purpose: 'Prevent stalled downloads from blocking repository sync.',
    intent: 'Stop downloads from retrying forever after timeout.',
    surface: 'CLI sync downloader and retry loop.',
    mechanism: 'Exit retry loop when timeout state is terminal.',
  });

  assert.equal(summary.purpose, 'Prevent stalled downloads from blocking repository sync.');
  assert.equal(summary.intent, 'Stop downloads from retrying forever after timeout.');
  assert.equal(
    llmKeyEmbeddingText(summary),
    [
      'purpose: Prevent stalled downloads from blocking repository sync.',
      'intent: Stop downloads from retrying forever after timeout.',
      'surface: CLI sync downloader and retry loop.',
      'mechanism: Exit retry loop when timeout state is terminal.',
    ].join('\n'),
  );
});

test('parseLlmKeySummary rejects missing fields', () => {
  assert.throws(
    () =>
      parseLlmKeySummary({
        purpose: 'Keep sync reliable.',
        intent: '',
        surface: 'CLI',
        mechanism: 'Patch retry loop.',
      }),
    /Too small/,
  );
});

test('parseLlmKeySummary clamps oversized fields deterministically', () => {
  const summary = parseLlmKeySummary({
    purpose: 'w'.repeat(180),
    intent: 'x'.repeat(140),
    surface: 'y'.repeat(140),
    mechanism: 'z'.repeat(180),
  });

  assert.equal(summary.purpose.length, 160);
  assert.equal(summary.intent.length, 120);
  assert.equal(summary.surface.length, 120);
  assert.equal(summary.mechanism.length, 160);
  assert.equal(summary.intent.at(-1), '.');
});

test('llmKeyInputHash is deterministic and prompt-version scoped', () => {
  const first = llmKeyInputHash({ title: 'Fix retry', body: 'Retry forever' });
  const second = llmKeyInputHash({ title: 'Fix retry', body: 'Retry forever' });
  const third = llmKeyInputHash({
    promptVersion: `${LLM_KEY_SUMMARY_PROMPT_VERSION}-next`,
    title: 'Fix retry',
    body: 'Retry forever',
  });

  assert.equal(first, second);
  assert.notEqual(first, third);
});

test('LLM_KEY_SUMMARY_SYSTEM_PROMPT requires strict JSON fields', () => {
  assert.match(LLM_KEY_SUMMARY_SYSTEM_PROMPT, /Return only strict JSON/);
  assert.match(LLM_KEY_SUMMARY_SYSTEM_PROMPT, /purpose/);
  assert.match(LLM_KEY_SUMMARY_SYSTEM_PROMPT, /intent/);
  assert.match(LLM_KEY_SUMMARY_SYSTEM_PROMPT, /surface/);
  assert.match(LLM_KEY_SUMMARY_SYSTEM_PROMPT, /mechanism/);
});
