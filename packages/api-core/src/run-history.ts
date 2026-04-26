import { runHistoryResponseSchema, type RepositoryDto, type RunHistoryResponse, type RunKind } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from './db/sqlite.js';
import type { RunTable } from './service-types.js';
import { asJson, nowIso, parseObjectJson } from './service-utils.js';

const RUN_TABLES: Array<{ kind: RunKind; table: RunTable }> = [
  { kind: 'sync', table: 'sync_runs' },
  { kind: 'summary', table: 'summary_runs' },
  { kind: 'embedding', table: 'embedding_runs' },
  { kind: 'cluster', table: 'cluster_runs' },
];

export function listRunHistoryForRepository(params: {
  db: SqliteDatabase;
  repository: RepositoryDto;
  kind?: RunKind;
  limit?: number;
}): RunHistoryResponse {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
  const selectedTables = params.kind ? RUN_TABLES.filter((entry) => entry.kind === params.kind) : RUN_TABLES;
  const sql = selectedTables
    .map(
      (entry) =>
        `select '${entry.kind}' as run_kind, id, scope, status, started_at, finished_at, stats_json, error_text from ${entry.table} where repo_id = ?`,
    )
    .join(' union all ');
  const rows = params.db
    .prepare(`select * from (${sql}) order by started_at desc, id desc limit ?`)
    .all(...selectedTables.map(() => params.repository.id), limit) as Array<{
    run_kind: RunKind;
    id: number;
    scope: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    stats_json: string | null;
    error_text: string | null;
  }>;

  return runHistoryResponseSchema.parse({
    repository: params.repository,
    runs: rows.map((row) => ({
      runId: row.id,
      runKind: row.run_kind,
      scope: row.scope,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      stats: parseObjectJson(row.stats_json),
      errorText: row.error_text,
    })),
  });
}

export function startServiceRun(db: SqliteDatabase, table: RunTable, repoId: number, scope: string): number {
  const result = db.prepare(`insert into ${table} (repo_id, scope, status, started_at) values (?, ?, 'running', ?)`).run(repoId, scope, nowIso());
  return Number(result.lastInsertRowid);
}

export function finishServiceRun(
  db: SqliteDatabase,
  table: RunTable,
  runId: number,
  status: 'completed' | 'failed',
  stats?: unknown,
  error?: unknown,
  finishedAt = nowIso(),
): void {
  db.prepare(`update ${table} set status = ?, finished_at = ?, stats_json = ?, error_text = ? where id = ?`).run(
    status,
    finishedAt,
    stats === undefined ? null : asJson(stats),
    error instanceof Error ? error.message : error ? String(error) : null,
    runId,
  );
}
