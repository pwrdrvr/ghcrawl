import test from 'node:test';
import assert from 'node:assert/strict';

import { computeTuiLayout } from './layout.js';

test('computeTuiLayout uses wide mode for large terminals', () => {
  const layout = computeTuiLayout(160, 40);
  assert.equal(layout.mode, 'wide-columns');
  assert.equal(layout.clusters.top, 1);
  assert.equal(layout.footer.top, 38);
  assert.equal(layout.footer.height, 2);
});

test('computeTuiLayout can stack members and detail on the right in wide mode', () => {
  const columnsLayout = computeTuiLayout(160, 40, 'columns');
  const layout = computeTuiLayout(160, 40, 'right-stack');
  assert.equal(layout.mode, 'wide-right-stack');
  assert.equal(layout.clusters.left, 0);
  assert.equal(layout.members.left, layout.detail.left);
  assert.equal(layout.members.top, 1);
  assert.equal(layout.detail.top > layout.members.top, true);
  assert.equal(layout.clusters.width > columnsLayout.clusters.width, true);
});

test('computeTuiLayout switches to stacked mode for narrow terminals', () => {
  const layout = computeTuiLayout(100, 30);
  assert.equal(layout.mode, 'stacked');
  assert.equal(layout.members.top > layout.clusters.top, true);
  assert.equal(layout.detail.top > layout.members.top, true);
});
