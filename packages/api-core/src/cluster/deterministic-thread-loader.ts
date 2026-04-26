import type { SqliteDatabase } from '../db/sqlite.js';
import { parseArray } from '../service-utils.js';
import { loadLatestCodeFeatures } from './code-features.js';

export type DeterministicClusterableThreadMeta = {
  id: number;
  number: number;
  kind: 'issue' | 'pull_request';
  title: string;
  body: string | null;
  labels: string[];
  rawJson: string;
  updatedAtGh: string | null;
  changedFiles: string[];
  hunkSignatures: string[];
  patchIds: string[];
};

export function loadDeterministicClusterableThreadMeta(
  db: SqliteDatabase,
  repoId: number,
  threadIds?: number[],
): DeterministicClusterableThreadMeta[] {
  let sql =
    `select id, number, kind, title, body, labels_json, raw_json, updated_at_gh
     from threads
     where repo_id = ?
       and state = 'open'
       and closed_at_local is null
       and not exists (
         select 1
         from cluster_closures cc
         join cluster_memberships cm on cm.cluster_id = cc.cluster_id
         where cm.thread_id = threads.id
           and cm.state <> 'removed_by_user'
       )`;
  const args: Array<number> = [repoId];
  if (threadIds && threadIds.length > 0) {
    sql += ` and id in (${threadIds.map(() => '?').join(',')})`;
    args.push(...threadIds);
  }
  sql += ' order by number asc';

  const rows = db.prepare(sql).all(...args) as Array<{
    id: number;
    number: number;
    kind: 'issue' | 'pull_request';
    title: string;
    body: string | null;
    labels_json: string;
    raw_json: string;
    updated_at_gh: string | null;
  }>;
  const codeFeaturesByThread = loadLatestCodeFeatures(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    kind: row.kind,
    title: row.title,
    body: row.body,
    labels: parseArray(row.labels_json),
    rawJson: row.raw_json,
    updatedAtGh: row.updated_at_gh,
    changedFiles: codeFeaturesByThread.get(row.id)?.changedFiles ?? [],
    hunkSignatures: codeFeaturesByThread.get(row.id)?.hunkSignatures ?? [],
    patchIds: codeFeaturesByThread.get(row.id)?.patchIds ?? [],
  }));
}
