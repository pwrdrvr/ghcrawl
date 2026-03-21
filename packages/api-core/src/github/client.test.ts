import assert from 'node:assert/strict';
import test from 'node:test';

import { mapDiscussionToRecord } from './client.js';

function makeDiscussionNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 42,
    title: 'Discussion title',
    body: 'Discussion body',
    author: { login: 'alice' },
    labels: { nodes: [{ name: 'help wanted' }, { name: 'good first discussion' }] },
    createdAt: '2026-03-09T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    closed: false,
    url: 'https://github.com/openclaw/openclaw/discussions/42',
    category: { name: 'Ideas' },
    ...overrides,
  };
}

test('mapDiscussionToRecord maps a normal discussion node correctly', () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode());
  assert.equal(mapped.number, 42);
  assert.equal(mapped.title, 'Discussion title');
  assert.equal(mapped.body, 'Discussion body');
  assert.deepEqual(mapped.user, { login: 'alice', type: 'User' });
  assert.equal(mapped.html_url, 'https://github.com/openclaw/openclaw/discussions/42');
  assert.equal(mapped.state, 'open');
  assert.equal(mapped.created_at, '2026-03-09T00:00:00Z');
  assert.equal(mapped.updated_at, '2026-03-10T00:00:00Z');
  assert.equal(mapped._ghcrawl_kind, 'discussion');
  assert.deepEqual(mapped.labels, [{ name: 'Ideas' }, { name: 'help wanted' }, { name: 'good first discussion' }]);
});

test('mapDiscussionToRecord handles null author', () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode({ author: null }));
  assert.deepEqual(mapped.user, { login: null, type: 'User' });
});

test('mapDiscussionToRecord handles null body', () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode({ body: null }));
  assert.equal(mapped.body, '');
});

test('mapDiscussionToRecord handles null category', () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode({ category: null }));
  assert.deepEqual(mapped.labels, [{ name: 'discussion' }, { name: 'help wanted' }, { name: 'good first discussion' }]);
});

test("mapDiscussionToRecord maps closed discussions to state 'closed'", () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode({ closed: true }));
  assert.equal(mapped.state, 'closed');
});

test("mapDiscussionToRecord maps open discussions to state 'open'", () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode({ closed: false }));
  assert.equal(mapped.state, 'open');
});

test('mapDiscussionToRecord includes category as first label', () => {
  const mapped = mapDiscussionToRecord(makeDiscussionNode({ category: { name: 'Q&A' } }));
  const labels = mapped.labels as Array<{ name: string }>;
  assert.equal(labels[0]?.name, 'Q&A');
});
