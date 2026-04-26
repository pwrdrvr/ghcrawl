import { readTextBlob } from '../db/blob-store.js';
import { blobStoreRoot } from '../db/raw-json-store.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import { parseStringArrayJson } from '../service-utils.js';
import { THREAD_FINGERPRINT_ALGORITHM_VERSION, type DeterministicThreadFingerprint } from './thread-fingerprint.js';

export function loadLatestDeterministicFingerprints(params: {
  db: SqliteDatabase;
  dbPath: string;
  threadIds: number[];
}): Map<number, DeterministicThreadFingerprint> {
  const { db, dbPath, threadIds } = params;
  if (threadIds.length === 0) return new Map();

  const placeholders = threadIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `select
         tr.thread_id,
         tf.fingerprint_hash,
         tf.fingerprint_slug,
         tf.title_tokens_json,
         tf.linked_refs_json,
         tf.module_buckets_json,
         tf.minhash_signature_blob_id,
         tf.simhash64,
         tf.winnow_hashes_blob_id,
         tf.feature_json
       from thread_revisions tr
       join (
         select thread_id, max(id) as revision_id
         from thread_revisions
         where thread_id in (${placeholders})
         group by thread_id
       ) latest on latest.revision_id = tr.id
       join thread_fingerprints tf on tf.thread_revision_id = tr.id
       where tf.algorithm_version = ?`,
    )
    .all(...threadIds, THREAD_FINGERPRINT_ALGORITHM_VERSION) as Array<{
    thread_id: number;
    fingerprint_hash: string;
    fingerprint_slug: string;
    title_tokens_json: string;
    linked_refs_json: string;
    module_buckets_json: string;
    minhash_signature_blob_id: number | null;
    simhash64: string;
    winnow_hashes_blob_id: number | null;
    feature_json: string;
  }>;

  const storeRoot = blobStoreRoot(dbPath);
  const fingerprints = new Map<number, DeterministicThreadFingerprint>();
  for (const row of rows) {
    const feature = parseFingerprintFeature(row.feature_json);
    const stringFeature = (key: string): string[] => {
      const value = feature[key];
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
    };
    fingerprints.set(row.thread_id, {
      algorithmVersion: THREAD_FINGERPRINT_ALGORITHM_VERSION,
      fingerprintHash: row.fingerprint_hash,
      fingerprintSlug: row.fingerprint_slug,
      titleTokens: parseStringArrayJson(row.title_tokens_json),
      salientTitleTokens: stringFeature('salientTitleTokens'),
      bodyTokens: [],
      linkedRefs: parseStringArrayJson(row.linked_refs_json),
      moduleBuckets: parseStringArrayJson(row.module_buckets_json),
      changedFiles: stringFeature('changedFiles'),
      hunkSignatures: stringFeature('hunkSignatures'),
      patchIds: stringFeature('patchIds'),
      featureHash: typeof feature.featureHash === 'string' ? feature.featureHash : '',
      minhashSignature: row.minhash_signature_blob_id ? parseStringArrayJson(readTextBlob(db, storeRoot, row.minhash_signature_blob_id)) : [],
      simhash64: row.simhash64,
      winnowHashes: row.winnow_hashes_blob_id ? parseStringArrayJson(readTextBlob(db, storeRoot, row.winnow_hashes_blob_id)) : [],
    });
  }
  return fingerprints;
}

function parseFingerprintFeature(featureJson: string): Record<string, unknown> {
  try {
    return JSON.parse(featureJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}
