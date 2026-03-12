import test from 'node:test';
import assert from 'node:assert/strict';

import { boundedLevenshteinDistance, findExactTemplateOffset, normalizePrTemplateText } from './pr-template.js';

test('normalizePrTemplateText trims outer whitespace, strips bom, and normalizes newlines', () => {
  assert.equal(normalizePrTemplateText('\uFEFF\r\n## Checklist\r\n- [ ] item\r\n'), '## Checklist\n- [ ] item');
});

test('findExactTemplateOffset returns the first offset for exact template containment', () => {
  assert.equal(findExactTemplateOffset('before\nTEMPLATE\nafter', 'TEMPLATE'), 7);
  assert.equal(findExactTemplateOffset('body only', 'missing'), null);
});

test('boundedLevenshteinDistance returns a distance within the threshold', () => {
  assert.equal(boundedLevenshteinDistance('template body', 'template xody', 2), 1);
});

test('boundedLevenshteinDistance returns null when the threshold is exceeded', () => {
  assert.equal(boundedLevenshteinDistance('template body', 'totally different text', 3), null);
});
