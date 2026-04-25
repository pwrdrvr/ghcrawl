import type { SqliteDatabase } from '../db/sqlite.js';

export type LatestClusterRunRow = { id: number; finished_at: string | null };

export function getLatestClusterRun(db: SqliteDatabase, repoId: number): LatestClusterRunRow | null {
  return (
    (db
      .prepare("select id, finished_at from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1")
      .get(repoId) as LatestClusterRunRow | undefined) ?? null
  );
}

export function getLatestRunClusterIdsForThread(db: SqliteDatabase, repoId: number, threadId: number): number[] {
  const latestRun = getLatestClusterRun(db, repoId);
  if (!latestRun) {
    return [];
  }
  return (
    db
      .prepare(
        `select cm.cluster_id
         from cluster_members cm
         join clusters c on c.id = cm.cluster_id
         where c.repo_id = ? and c.cluster_run_id = ? and cm.thread_id = ?
         order by cm.cluster_id asc`,
      )
      .all(repoId, latestRun.id, threadId) as Array<{ cluster_id: number }>
  ).map((row) => row.cluster_id);
}
