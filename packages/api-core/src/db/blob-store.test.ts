import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { blobObjectPath, readTextBlob, storeTextBlob } from './blob-store.js';
import { migrate } from './migrate.js';
import { openDb } from './sqlite.js';

test('storeTextBlob keeps small payloads inline and deduplicates by hash', () => {
  const db = openDb(':memory:');
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-blob-store-'));
  try {
    migrate(db);
    const first = storeTextBlob(db, storeRoot, '{"ok":true}', { mediaType: 'application/json' });
    const second = storeTextBlob(db, storeRoot, '{"ok":true}', { mediaType: 'application/json' });

    assert.equal(first.id, second.id);
    assert.equal(first.storageKind, 'inline');
    assert.equal(readTextBlob(db, storeRoot, first.id), '{"ok":true}');
  } finally {
    db.close();
  }
});

test('storeTextBlob writes large payloads to content-addressed files', () => {
  const db = openDb(':memory:');
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-blob-store-'));
  try {
    migrate(db);
    const payload = 'x'.repeat(128);
    const stored = storeTextBlob(db, storeRoot, payload, {
      mediaType: 'text/plain',
      inlineThresholdBytes: 8,
    });

    assert.equal(stored.storageKind, 'file');
    assert.equal(stored.storagePath, path.relative(storeRoot, blobObjectPath(storeRoot, stored.sha256, 'gzip')));
    assert.ok(fs.existsSync(path.join(storeRoot, stored.storagePath ?? '')));
    assert.equal(readTextBlob(db, storeRoot, stored.id), payload);
  } finally {
    db.close();
  }
});
