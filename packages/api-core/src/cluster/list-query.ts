import { clustersResponseSchema, type ClusterDto, type ClustersResponse, type RepositoryDto } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';
import { isEffectivelyClosed } from '../service-utils.js';

export function listStoredClusters(
  db: SqliteDatabase,
  repository: RepositoryDto,
  params: { includeClosed?: boolean } = {},
): ClustersResponse {
  const latestRun = db
    .prepare("select id from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1")
    .get(repository.id) as { id: number } | undefined;

  if (!latestRun) {
    return clustersResponseSchema.parse({ repository, clusters: [] });
  }

  const rows = db
    .prepare(
      `select c.id, c.repo_id, c.representative_thread_id, c.member_count,
              c.closed_at_local, c.close_reason_local,
              cm.thread_id, cm.score_to_representative, t.number, t.kind, t.title, t.state, t.closed_at_local as thread_closed_at_local
       from clusters c
       left join cluster_members cm on cm.cluster_id = c.id
       left join threads t on t.id = cm.thread_id
       where c.cluster_run_id = ?
       order by c.member_count desc, c.id asc, t.number asc`,
    )
    .all(latestRun.id) as Array<{
    id: number;
    repo_id: number;
    representative_thread_id: number | null;
    member_count: number;
    closed_at_local: string | null;
    close_reason_local: string | null;
    thread_id: number | null;
    score_to_representative: number | null;
    number: number | null;
    kind: 'issue' | 'pull_request' | null;
    title: string | null;
    state: string | null;
    thread_closed_at_local: string | null;
  }>;

  const clusters = new Map<number, ClusterDto>();
  for (const row of rows) {
    const cluster = clusters.get(row.id) ?? {
      id: row.id,
      repoId: row.repo_id,
      isClosed: row.close_reason_local !== null,
      closedAtLocal: row.closed_at_local,
      closeReasonLocal: row.close_reason_local,
      representativeThreadId: row.representative_thread_id,
      memberCount: row.member_count,
      members: [],
    };
    if (row.thread_id !== null && row.number !== null && row.kind !== null && row.title !== null) {
      cluster.members.push({
        threadId: row.thread_id,
        number: row.number,
        kind: row.kind,
        isClosed: row.state !== null && isEffectivelyClosed({ state: row.state, closed_at_local: row.thread_closed_at_local }),
        title: row.title,
        scoreToRepresentative: row.score_to_representative,
      });
    }
    clusters.set(row.id, cluster);
  }

  const clusterValues = Array.from(clusters.values()).map((cluster) => ({
    ...cluster,
    isClosed: cluster.isClosed || (cluster.memberCount > 0 && cluster.members.every((member) => member.isClosed)),
  }));

  return clustersResponseSchema.parse({
    repository,
    clusters: clusterValues.filter((cluster) => (params.includeClosed ?? true ? true : !cluster.isClosed)),
  });
}
