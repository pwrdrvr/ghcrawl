import type { SqliteDatabase } from '../db/sqlite.js';
import { extractDeterministicRefs } from './deterministic-engine.js';
import type { DeterministicClusterableThreadMeta } from './deterministic-thread-loader.js';
import { upsertThreadFingerprint, upsertThreadRevision } from './persistent-store.js';
import {
  buildDeterministicThreadFingerprint,
  fingerprintFeatureHash,
  THREAD_FINGERPRINT_ALGORITHM_VERSION,
} from './thread-fingerprint.js';

export function materializeLatestDeterministicFingerprints(
  db: SqliteDatabase,
  items: DeterministicClusterableThreadMeta[],
  onProgress?: (message: string) => void,
): { computed: number; skipped: number } {
  let computed = 0;
  let skipped = 0;
  for (const item of items) {
    const revisionId = upsertThreadRevision(db, {
      threadId: item.id,
      sourceUpdatedAt: item.updatedAtGh,
      title: item.title,
      body: item.body,
      labels: item.labels,
      rawJson: item.rawJson,
    });
    const inferredRefs = extractDeterministicRefs(`${item.title}\n${item.body ?? ''}`);
    const featureHash = fingerprintFeatureHash({
      linkedRefs: inferredRefs,
      changedFiles: item.changedFiles,
      hunkSignatures: item.hunkSignatures,
      patchIds: item.patchIds,
    });
    const existing = db
      .prepare(
        `select id, feature_json
         from thread_fingerprints
         where thread_revision_id = ?
           and algorithm_version = ?
         limit 1`,
      )
      .get(revisionId, THREAD_FINGERPRINT_ALGORITHM_VERSION) as { id: number; feature_json: string } | undefined;
    if (existing) {
      const existingFeatureHash = (() => {
        try {
          const feature = JSON.parse(existing.feature_json) as Record<string, unknown>;
          return typeof feature.featureHash === 'string' ? feature.featureHash : null;
        } catch {
          return null;
        }
      })();
      if (existingFeatureHash === featureHash) {
        skipped += 1;
        continue;
      }
    }

    const fingerprint = buildDeterministicThreadFingerprint({
      threadId: item.id,
      number: item.number,
      kind: item.kind,
      title: item.title,
      body: item.body,
      labels: item.labels,
      linkedRefs: inferredRefs,
      changedFiles: item.changedFiles,
      hunkSignatures: item.hunkSignatures,
      patchIds: item.patchIds,
    });
    upsertThreadFingerprint(db, { threadRevisionId: revisionId, fingerprint });
    computed += 1;
  }
  onProgress?.(`[fingerprint] latest revisions computed=${computed} skipped=${skipped}`);
  return { computed, skipped };
}
