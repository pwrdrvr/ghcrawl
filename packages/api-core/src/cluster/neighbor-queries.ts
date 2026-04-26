import type { SearchHitDto } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';
import { getLatestClusterRun } from './run-queries.js';

export function listStoredClusterNeighbors(params: {
  db: SqliteDatabase;
  repoId: number;
  threadId: number;
  limit: number;
}): SearchHitDto['neighbors'] {
  const latestRun = getLatestClusterRun(params.db, params.repoId);
  if (!latestRun) {
    return [];
  }

  const rows = params.db
    .prepare(
      `select
          case
            when se.left_thread_id = ? then se.right_thread_id
            else se.left_thread_id
          end as neighbor_thread_id,
          case
            when se.left_thread_id = ? then t2.number
            else t1.number
          end as neighbor_number,
          case
            when se.left_thread_id = ? then t2.kind
            else t1.kind
          end as neighbor_kind,
          case
            when se.left_thread_id = ? then t2.title
            else t1.title
          end as neighbor_title,
          se.score
       from similarity_edges se
       join threads t1 on t1.id = se.left_thread_id
       join threads t2 on t2.id = se.right_thread_id
       where se.repo_id = ?
         and se.cluster_run_id = ?
         and (se.left_thread_id = ? or se.right_thread_id = ?)
         and t1.state = 'open'
         and t1.closed_at_local is null
         and t2.state = 'open'
         and t2.closed_at_local is null
       order by se.score desc
       limit ?`,
    )
    .all(
      params.threadId,
      params.threadId,
      params.threadId,
      params.threadId,
      params.repoId,
      latestRun.id,
      params.threadId,
      params.threadId,
      params.limit,
    ) as Array<{
    neighbor_thread_id: number;
    neighbor_number: number;
    neighbor_kind: 'issue' | 'pull_request';
    neighbor_title: string;
    score: number;
  }>;

  return rows.map((row) => ({
    threadId: row.neighbor_thread_id,
    number: row.neighbor_number,
    kind: row.neighbor_kind,
    title: row.neighbor_title,
    score: row.score,
  }));
}
