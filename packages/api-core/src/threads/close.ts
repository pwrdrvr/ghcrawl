import { closeResponseSchema, type CloseResponse, type RepositoryDto } from '@ghcrawl/api-contract';

import { reconcileClusterCloseState } from '../cluster/close-state.js';
import { getLatestRunClusterIdsForThread } from '../cluster/run-queries.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import type { ThreadRow } from '../service-types.js';
import { nowIso, threadToDto } from '../service-utils.js';

export function closeRepositoryThreadLocally(db: SqliteDatabase, repository: RepositoryDto, threadNumber: number): CloseResponse {
  const row = db
    .prepare('select * from threads where repo_id = ? and number = ? limit 1')
    .get(repository.id, threadNumber) as ThreadRow | undefined;
  if (!row) {
    throw new Error(`Thread #${threadNumber} was not found for ${repository.fullName}.`);
  }

  const closedAt = nowIso();
  db.prepare(
    `update threads
     set closed_at_local = ?,
         close_reason_local = 'manual',
         updated_at = ?
     where id = ?`,
  ).run(closedAt, closedAt, row.id);
  const clusterIds = getLatestRunClusterIdsForThread(db, repository.id, row.id);
  const clusterClosed = reconcileClusterCloseState(db, repository.id, clusterIds) > 0;
  const updated = db.prepare('select * from threads where id = ? limit 1').get(row.id) as ThreadRow;

  return closeResponseSchema.parse({
    ok: true,
    repository,
    thread: threadToDto(updated),
    clusterId: clusterIds[0] ?? null,
    clusterClosed,
    message: `Marked ${updated.kind} #${updated.number} closed locally.`,
  });
}
