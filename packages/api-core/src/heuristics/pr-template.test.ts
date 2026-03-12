import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boundedLevenshteinDistance,
  extractPrTemplateSection,
  findExactTemplateOffset,
  normalizePrTemplateText,
} from './pr-template.js';

test('normalizePrTemplateText trims outer whitespace, strips bom, and normalizes newlines', () => {
  assert.equal(normalizePrTemplateText('\uFEFF\r\n## Checklist\r\n- [ ] item\r\n'), '## Checklist\n- [ ] item');
});

test('findExactTemplateOffset returns the first offset for exact template containment', () => {
  assert.equal(findExactTemplateOffset('before\nTEMPLATE\nafter', 'TEMPLATE'), 7);
  assert.equal(findExactTemplateOffset('body only', 'missing'), null);
});

test('extractPrTemplateSection slices the summary-through-risks chunk when both anchors are present', () => {
  const template =
    'Intro\n\n## Summary\n\n- Problem:\n\n## Risks and Mitigations\n\nList only real risks.\n\n- Risk:\n  - Mitigation:';
  const body =
    'Preamble\n\n## Summary\n\n- Problem: changed\n\n## Risks and Mitigations\n\nList only real risks.\n\n- Risk:\n  - Mitigation:\n\nFooter';
  const section = extractPrTemplateSection(body, template);

  assert.equal(section.startOffset, 10);
  assert.equal(section.endOffset, 114);
  assert.equal(
    section.bodySection,
    '## Summary\n\n- Problem: changed\n\n## Risks and Mitigations\n\nList only real risks.\n\n- Risk:\n  - Mitigation:',
  );
});

test('extractPrTemplateSection returns no body section when the ending anchor is missing', () => {
  const template =
    '## Summary\n\n- Problem:\n\n## Risks and Mitigations\n\nList only real risks.\n\n- Risk:\n  - Mitigation:';
  const body = '## Summary\n\n- Problem:\n\n## Risks and Mitigations\n\nChanged tail';
  const section = extractPrTemplateSection(body, template);

  assert.equal(section.startOffset, 0);
  assert.equal(section.endOffset, null);
  assert.equal(section.bodySection, null);
});

test('boundedLevenshteinDistance returns a distance within the threshold', () => {
  assert.equal(boundedLevenshteinDistance('template body', 'template xody', 2), 1);
});

test('boundedLevenshteinDistance returns null when the threshold is exceeded', () => {
  assert.equal(boundedLevenshteinDistance('template body', 'totally different text', 3), null);
});
