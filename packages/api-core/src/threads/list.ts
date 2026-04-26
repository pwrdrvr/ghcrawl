import { threadsResponseSchema, type RepositoryDto, type ThreadsResponse } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';
import type { ThreadRow } from '../service-types.js';
import { threadToDto } from '../service-utils.js';

export function listRepositoryThreads(
  db: SqliteDatabase,
  params: {
    repository: RepositoryDto;
    kind?: 'issue' | 'pull_request';
    numbers?: number[];
    includeClosed?: boolean;
  },
): ThreadsResponse {
  const clusterIds = loadLatestClusterIds(db, params.repository.id);
  let sql = 'select * from threads where repo_id = ?';
  const args: Array<string | number> = [params.repository.id];
  if (!params.includeClosed) {
    sql += " and state = 'open' and closed_at_local is null";
  }
  if (params.kind) {
    sql += ' and kind = ?';
    args.push(params.kind);
  }
  if (params.numbers && params.numbers.length > 0) {
    const uniqueNumbers = Array.from(new Set(params.numbers.filter((value) => Number.isSafeInteger(value) && value > 0)));
    if (uniqueNumbers.length === 0) {
      return threadsResponseSchema.parse({
        repository: params.repository,
        threads: [],
      });
    }
    sql += ` and number in (${uniqueNumbers.map(() => '?').join(', ')})`;
    args.push(...uniqueNumbers);
  }
  sql += ' order by updated_at_gh desc, number desc';

  const rows = db.prepare(sql).all(...args) as ThreadRow[];
  const orderedRows = orderRowsByRequestedNumbers(rows, params.numbers);
  return threadsResponseSchema.parse({
    repository: params.repository,
    threads: orderedRows.map((row) => threadToDto(row, clusterIds.get(row.id) ?? null)),
  });
}

function loadLatestClusterIds(db: SqliteDatabase, repoId: number): Map<number, number> {
  const clusterIds = new Map<number, number>();
  const rows = db
    .prepare(
      `select cm.thread_id, cm.cluster_id
       from cluster_members cm
       join clusters c on c.id = cm.cluster_id
       where c.repo_id = ? and c.cluster_run_id = (
         select id from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1
       )`,
    )
    .all(repoId, repoId) as Array<{ thread_id: number; cluster_id: number }>;
  for (const row of rows) {
    clusterIds.set(row.thread_id, row.cluster_id);
  }
  return clusterIds;
}

function orderRowsByRequestedNumbers(rows: ThreadRow[], numbers: number[] | undefined): ThreadRow[] {
  if (!numbers || numbers.length === 0) {
    return rows;
  }
  const byNumber = new Map(rows.map((row) => [row.number, row] as const));
  return Array.from(new Set(numbers))
    .map((number) => byNumber.get(number))
    .filter((row): row is ThreadRow => row !== undefined);
}
