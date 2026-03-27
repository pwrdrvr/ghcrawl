import test from 'node:test';
import assert from 'node:assert/strict';

import { formatMemoryUsage } from './heap-diagnostics.js';

test('formatMemoryUsage renders the major memory counters', () => {
  const rendered = formatMemoryUsage({
    rss: 1024 * 1024 * 512,
    heapTotal: 1024 * 1024 * 256,
    heapUsed: 1024 * 1024 * 128,
    external: 1024 * 1024 * 64,
    arrayBuffers: 1024 * 1024 * 32,
  });

  assert.match(rendered, /rss=512 MB/);
  assert.match(rendered, /heap_used=128 MB/);
  assert.match(rendered, /heap_total=256 MB/);
  assert.match(rendered, /external=64 MB/);
  assert.match(rendered, /array_buffers=32 MB/);
});
