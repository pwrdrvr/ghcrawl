import type { SqliteDatabase } from '../db/sqlite.js';
import type { SyncCursorState } from '../service-types.js';
import { nowIso, parseSyncRunStats } from '../service-utils.js';

export function getSyncCursorState(db: SqliteDatabase, repoId: number): SyncCursorState {
  const persisted =
    (db
      .prepare(
        `select
            last_full_open_scan_started_at,
            last_overlapping_open_scan_completed_at,
            last_non_overlapping_scan_completed_at,
            last_open_close_reconciled_at
         from repo_sync_state
         where repo_id = ?`,
      )
      .get(repoId) as
      | {
          last_full_open_scan_started_at: string | null;
          last_overlapping_open_scan_completed_at: string | null;
          last_non_overlapping_scan_completed_at: string | null;
          last_open_close_reconciled_at: string | null;
        }
      | undefined) ?? null;
  if (persisted) {
    return {
      lastFullOpenScanStartedAt: persisted.last_full_open_scan_started_at,
      lastOverlappingOpenScanCompletedAt: persisted.last_overlapping_open_scan_completed_at,
      lastNonOverlappingScanCompletedAt: persisted.last_non_overlapping_scan_completed_at,
      lastReconciledOpenCloseAt: persisted.last_open_close_reconciled_at,
    };
  }

  const rows = db
    .prepare("select finished_at, stats_json from sync_runs where repo_id = ? and status = 'completed' order by id desc")
    .all(repoId) as Array<{ finished_at: string | null; stats_json: string | null }>;
  const state: SyncCursorState = {
    lastFullOpenScanStartedAt: null,
    lastOverlappingOpenScanCompletedAt: null,
    lastNonOverlappingScanCompletedAt: null,
    lastReconciledOpenCloseAt: null,
  };

  for (const row of rows) {
    const stats = parseSyncRunStats(row.stats_json);
    if (!stats) continue;
    if (state.lastFullOpenScanStartedAt === null && stats.isFullOpenScan) {
      state.lastFullOpenScanStartedAt = stats.crawlStartedAt;
    }
    if (state.lastOverlappingOpenScanCompletedAt === null && stats.isOverlappingOpenScan && row.finished_at) {
      state.lastOverlappingOpenScanCompletedAt = row.finished_at;
    }
    if (state.lastNonOverlappingScanCompletedAt === null && !stats.isFullOpenScan && !stats.isOverlappingOpenScan && row.finished_at) {
      state.lastNonOverlappingScanCompletedAt = row.finished_at;
    }
    if (state.lastReconciledOpenCloseAt === null && stats.reconciledOpenCloseAt) {
      state.lastReconciledOpenCloseAt = stats.reconciledOpenCloseAt;
    }
  }

  if (
    state.lastFullOpenScanStartedAt !== null ||
    state.lastOverlappingOpenScanCompletedAt !== null ||
    state.lastNonOverlappingScanCompletedAt !== null ||
    state.lastReconciledOpenCloseAt !== null
  ) {
    writeSyncCursorState(db, repoId, state);
  }

  return state;
}

export function writeSyncCursorState(db: SqliteDatabase, repoId: number, state: SyncCursorState): void {
  db.prepare(
    `insert into repo_sync_state (
        repo_id,
        last_full_open_scan_started_at,
        last_overlapping_open_scan_completed_at,
        last_non_overlapping_scan_completed_at,
        last_open_close_reconciled_at,
        updated_at
     ) values (?, ?, ?, ?, ?, ?)
     on conflict(repo_id) do update set
       last_full_open_scan_started_at = excluded.last_full_open_scan_started_at,
       last_overlapping_open_scan_completed_at = excluded.last_overlapping_open_scan_completed_at,
       last_non_overlapping_scan_completed_at = excluded.last_non_overlapping_scan_completed_at,
       last_open_close_reconciled_at = excluded.last_open_close_reconciled_at,
       updated_at = excluded.updated_at`,
  ).run(
    repoId,
    state.lastFullOpenScanStartedAt,
    state.lastOverlappingOpenScanCompletedAt,
    state.lastNonOverlappingScanCompletedAt,
    state.lastReconciledOpenCloseAt,
    nowIso(),
  );
}
