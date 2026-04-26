import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import type { SqliteDatabase } from './sqlite.js';

export type StoredBlob = {
  id: number;
  sha256: string;
  storageKind: 'inline' | 'file';
  storagePath: string | null;
  sizeBytes: number;
};

export type StoreBlobOptions = {
  mediaType: string;
  inlineThresholdBytes?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function blobObjectPath(storeRoot: string, sha256: string, compression: string): string {
  const extension = compression === 'gzip' ? '.gz' : '';
  return path.join(storeRoot, 'objects', 'sha256', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${extension}`);
}

export function storeTextBlob(
  db: SqliteDatabase,
  storeRoot: string,
  value: string,
  options: StoreBlobOptions,
): StoredBlob {
  const raw = Buffer.from(value, 'utf8');
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  const existing = db.prepare('select * from blobs where sha256 = ? limit 1').get(sha256) as
    | {
        id: number;
        sha256: string;
        storage_kind: 'inline' | 'file';
        storage_path: string | null;
        size_bytes: number;
      }
    | undefined;
  if (existing) {
    return {
      id: existing.id,
      sha256: existing.sha256,
      storageKind: existing.storage_kind,
      storagePath: existing.storage_path,
      sizeBytes: existing.size_bytes,
    };
  }

  const inlineThresholdBytes = options.inlineThresholdBytes ?? 4096;
  const createdAt = nowIso();
  if (raw.byteLength <= inlineThresholdBytes) {
    const result = db
      .prepare(
        `insert into blobs (sha256, media_type, compression, size_bytes, storage_kind, storage_path, inline_text, created_at)
         values (?, ?, 'none', ?, 'inline', null, ?, ?)`,
      )
      .run(sha256, options.mediaType, raw.byteLength, value, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      sha256,
      storageKind: 'inline',
      storagePath: null,
      sizeBytes: raw.byteLength,
    };
  }

  const objectPath = blobObjectPath(storeRoot, sha256, 'gzip');
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  if (!fs.existsSync(objectPath)) {
    fs.writeFileSync(objectPath, zlib.gzipSync(raw));
  }
  const result = db
    .prepare(
      `insert into blobs (sha256, media_type, compression, size_bytes, storage_kind, storage_path, inline_text, created_at)
       values (?, ?, 'gzip', ?, 'file', ?, null, ?)`,
    )
    .run(sha256, options.mediaType, raw.byteLength, path.relative(storeRoot, objectPath), createdAt);

  return {
    id: Number(result.lastInsertRowid),
    sha256,
    storageKind: 'file',
    storagePath: path.relative(storeRoot, objectPath),
    sizeBytes: raw.byteLength,
  };
}

export function readTextBlob(db: SqliteDatabase, storeRoot: string, blobId: number): string {
  const row = db.prepare('select * from blobs where id = ? limit 1').get(blobId) as
    | {
        compression: string;
        storage_kind: 'inline' | 'file';
        storage_path: string | null;
        inline_text: string | null;
      }
    | undefined;
  if (!row) {
    throw new Error(`Blob ${blobId} not found`);
  }
  if (row.storage_kind === 'inline') {
    return row.inline_text ?? '';
  }
  if (!row.storage_path) {
    throw new Error(`Blob ${blobId} has no storage path`);
  }
  const stored = fs.readFileSync(path.join(storeRoot, row.storage_path));
  return (row.compression === 'gzip' ? zlib.gunzipSync(stored) : stored).toString('utf8');
}
