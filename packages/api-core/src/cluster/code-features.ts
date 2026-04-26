import type { SqliteDatabase } from '../db/sqlite.js';

export type LatestCodeFeatures = {
  changedFiles: string[];
  hunkSignatures: string[];
  patchIds: string[];
};

export function loadLatestCodeFeatures(db: SqliteDatabase, threadIds: number[]): Map<number, LatestCodeFeatures> {
  if (threadIds.length === 0) return new Map();
  const placeholders = threadIds.map(() => '?').join(',');
  const latestRevisions = db
    .prepare(
      `select thread_id, max(id) as revision_id
       from thread_revisions
       where thread_id in (${placeholders})
       group by thread_id`,
    )
    .all(...threadIds) as Array<{ thread_id: number; revision_id: number }>;
  if (latestRevisions.length === 0) return new Map();

  const revisionToThread = new Map(latestRevisions.map((row) => [row.revision_id, row.thread_id]));
  const revisionPlaceholders = latestRevisions.map(() => '?').join(',');
  const fileRows = db
    .prepare(
      `select cs.thread_revision_id, cf.path, cf.patch_hash
       from thread_code_snapshots cs
       join thread_changed_files cf on cf.snapshot_id = cs.id
       where cs.thread_revision_id in (${revisionPlaceholders})
       order by cf.path asc`,
    )
    .all(...latestRevisions.map((row) => row.revision_id)) as Array<{ thread_revision_id: number; path: string; patch_hash: string | null }>;
  const hunkRows = db
    .prepare(
      `select cs.thread_revision_id, hs.hunk_hash
       from thread_code_snapshots cs
       join thread_hunk_signatures hs on hs.snapshot_id = cs.id
       where cs.thread_revision_id in (${revisionPlaceholders})
       order by hs.hunk_hash asc`,
    )
    .all(...latestRevisions.map((row) => row.revision_id)) as Array<{ thread_revision_id: number; hunk_hash: string }>;

  const out = new Map<number, LatestCodeFeatures>();
  function entry(threadId: number): LatestCodeFeatures {
    const existing = out.get(threadId) ?? { changedFiles: [], hunkSignatures: [], patchIds: [] };
    out.set(threadId, existing);
    return existing;
  }
  for (const row of fileRows) {
    const threadId = revisionToThread.get(row.thread_revision_id);
    if (threadId === undefined) continue;
    const target = entry(threadId);
    target.changedFiles.push(row.path);
    if (row.patch_hash) target.patchIds.push(row.patch_hash);
  }
  for (const row of hunkRows) {
    const threadId = revisionToThread.get(row.thread_revision_id);
    if (threadId === undefined) continue;
    entry(threadId).hunkSignatures.push(row.hunk_hash);
  }

  for (const target of out.values()) {
    target.changedFiles = Array.from(new Set(target.changedFiles)).sort();
    target.hunkSignatures = Array.from(new Set(target.hunkSignatures)).sort();
    target.patchIds = Array.from(new Set(target.patchIds)).sort();
  }
  return out;
}
