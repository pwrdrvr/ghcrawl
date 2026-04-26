import path from 'node:path';

import { RAW_JSON_INLINE_THRESHOLD_BYTES } from '../service-constants.js';
import type { SqliteDatabase } from './sqlite.js';
import { storeTextBlob } from './blob-store.js';

export function blobStoreRoot(dbPath: string): string {
  return path.join(path.dirname(dbPath), '.ghcrawl-store');
}

export function rawJsonStorage(
  db: SqliteDatabase,
  dbPath: string,
  rawJson: string,
  mediaType: string,
): { inlineJson: string; blobId: number | null } {
  if (Buffer.byteLength(rawJson, 'utf8') <= RAW_JSON_INLINE_THRESHOLD_BYTES) {
    return { inlineJson: rawJson, blobId: null };
  }
  const blob = storeTextBlob(db, blobStoreRoot(dbPath), rawJson, {
    mediaType,
    inlineThresholdBytes: RAW_JSON_INLINE_THRESHOLD_BYTES,
  });
  return { inlineJson: '{}', blobId: blob.id };
}
