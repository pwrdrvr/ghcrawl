import type { SqliteDatabase } from '../db/sqlite.js';
import { nowIso } from '../service-utils.js';
import { getLatestClusterRun } from './run-queries.js';

export function reconcileClusterCloseState(db: SqliteDatabase, repoId: number, clusterIds?: number[]): number {
  const latestRun = getLatestClusterRun(db, repoId);
  if (!latestRun) {
    return 0;
  }

  const resolvedClusterIds =
    clusterIds && clusterIds.length > 0
      ? Array.from(new Set(clusterIds))
      : (
          db
            .prepare('select id from clusters where repo_id = ? and cluster_run_id = ? order by id asc')
            .all(repoId, latestRun.id) as Array<{ id: number }>
        ).map((row) => row.id);
  if (resolvedClusterIds.length === 0) {
    return 0;
  }

  const summarize = db.prepare(
    `select
        c.id,
        c.close_reason_local,
        count(*) as member_count,
        sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count
     from clusters c
     join cluster_members cm on cm.cluster_id = c.id
     join threads t on t.id = cm.thread_id
     where c.id = ?
     group by c.id, c.close_reason_local`,
  );
  const markClosed = db.prepare(
    `update clusters
     set closed_at_local = coalesce(closed_at_local, ?),
         close_reason_local = 'all_members_closed'
     where id = ?`,
  );
  const clearClosed = db.prepare(
    `update clusters
     set closed_at_local = null,
         close_reason_local = null
     where id = ? and close_reason_local = 'all_members_closed'`,
  );

  let changed = 0;
  for (const clusterId of resolvedClusterIds) {
    const row = summarize.get(clusterId) as
      | {
          id: number;
          close_reason_local: string | null;
          member_count: number;
          closed_member_count: number;
        }
      | undefined;
    if (!row || row.close_reason_local === 'manual') {
      continue;
    }
    if (row.member_count > 0 && row.closed_member_count >= row.member_count) {
      const result = markClosed.run(nowIso(), clusterId);
      changed += result.changes;
      continue;
    }
    const cleared = clearClosed.run(clusterId);
    changed += cleared.changes;
  }

  return changed;
}
