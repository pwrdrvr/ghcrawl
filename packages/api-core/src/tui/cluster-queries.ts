import { humanKeyForValue } from '../cluster/human-key.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import type { DurableTuiClosure, TuiClusterDetail, TuiClusterSummary } from '../service-types.js';
import { isEffectivelyClosed, parseArray } from '../service-utils.js';
import {
  clusterDisplayTitle,
  collapseOverlappingClosedDurableRows,
  durableClosureReason,
  durableTuiSummaryFromRow,
} from './cluster-format.js';

export function clusterHumanName(repoId: number, representativeThreadId: number | null, clusterId: number): string {
  return humanKeyForValue(
    representativeThreadId === null
      ? `repo:${repoId}:cluster:${clusterId}`
      : `repo:${repoId}:cluster-representative:${representativeThreadId}`,
  ).slug;
}

export function getDurableClosuresByRepresentative(
  db: SqliteDatabase,
  repoId: number,
  representativeThreadIds: number[],
): Map<number, DurableTuiClosure> {
  const uniqueThreadIds = Array.from(new Set(representativeThreadIds));
  if (uniqueThreadIds.length === 0) {
    return new Map();
  }

  const identities = uniqueThreadIds.map((threadId) => ({
    threadId,
    stableKey: humanKeyForValue(`repo:${repoId}:cluster-representative:${threadId}`).hash,
  }));
  const placeholders = identities.map(() => '?').join(',');
  const rows = db
    .prepare(
      `select cg.id, cg.stable_key, cg.status, coalesce(cc.updated_at, cg.closed_at) as closed_at, cc.reason
       from cluster_groups cg
       left join cluster_closures cc on cc.cluster_id = cg.id
       where cg.repo_id = ?
         and cg.stable_key in (${placeholders})
         and (cc.cluster_id is not null or cg.status in ('merged', 'split'))`,
    )
    .all(repoId, ...identities.map((identity) => identity.stableKey)) as Array<{
    id: number;
    stable_key: string;
    status: 'active' | 'closed' | 'merged' | 'split';
    closed_at: string | null;
    reason: string | null;
  }>;
  const threadIdByStableKey = new Map(identities.map((identity) => [identity.stableKey, identity.threadId]));
  const closures = new Map<number, DurableTuiClosure>();
  for (const row of rows) {
    const threadId = threadIdByStableKey.get(row.stable_key);
    if (threadId === undefined) continue;
    closures.set(threadId, {
      clusterId: row.id,
      status: row.status,
      closedAt: row.closed_at,
      reason: row.reason,
    });
  }
  return closures;
}

export function listClosedDurableTuiClusters(
  db: SqliteDatabase,
  repoId: number,
  representedThreadIds: Set<number>,
  minSize: number,
): TuiClusterSummary[] {
  const rows = db
    .prepare(
      `select
          cg.id as cluster_id,
          cg.stable_slug,
          cg.status,
          coalesce(cc.updated_at, cg.closed_at) as closed_at,
          cc.reason as closure_reason,
          cg.representative_thread_id,
          cg.title,
          rt.number as representative_number,
          rt.kind as representative_kind,
          rt.title as representative_title,
          count(*) as member_count,
          max(coalesce(t.updated_at_gh, t.updated_at)) as latest_updated_at,
          sum(case when t.kind = 'issue' then 1 else 0 end) as issue_count,
          sum(case when t.kind = 'pull_request' then 1 else 0 end) as pull_request_count,
          sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count,
          group_concat(t.id, ',') as member_thread_ids,
          group_concat(lower(coalesce(t.title, '')), ' ') as search_text
       from cluster_groups cg
       left join cluster_closures cc on cc.cluster_id = cg.id
       left join threads rt on rt.id = cg.representative_thread_id
       join cluster_memberships cm on cm.cluster_id = cg.id and cm.state <> 'removed_by_user'
       join threads t on t.id = cm.thread_id
       where cg.repo_id = ?
       group by
         cg.id,
         cg.stable_slug,
         cg.status,
         cg.closed_at,
         cc.updated_at,
         cc.reason,
         cg.representative_thread_id,
         cg.title,
         rt.number,
         rt.kind,
         rt.title
       having member_count >= ?
          and (cc.cluster_id is not null
           or cg.status in ('merged', 'split')
           or closed_member_count >= member_count)`,
    )
    .all(repoId, minSize) as Array<{
    cluster_id: number;
    stable_slug: string;
    status: 'active' | 'closed' | 'merged' | 'split';
    closed_at: string | null;
    closure_reason: string | null;
    representative_thread_id: number | null;
    title: string | null;
    representative_number: number | null;
    representative_kind: 'issue' | 'pull_request' | null;
    representative_title: string | null;
    member_count: number;
    latest_updated_at: string | null;
    issue_count: number;
    pull_request_count: number;
    closed_member_count: number;
    member_thread_ids: string | null;
    search_text: string | null;
  }>;

  return collapseOverlappingClosedDurableRows(
    rows.filter((row) => row.representative_thread_id === null || !representedThreadIds.has(row.representative_thread_id)),
  )
    .map((row) =>
      durableTuiSummaryFromRow({
        ...row,
        representative_title: row.representative_title ?? row.title,
      }),
    );
}

export function getDurableTuiClusterSummary(db: SqliteDatabase, repoId: number, clusterId: number): TuiClusterSummary | null {
  const row = db
    .prepare(
      `select
          cg.id as cluster_id,
          cg.stable_slug,
          cg.status,
          coalesce(cc.updated_at, cg.closed_at) as closed_at,
          cc.reason as closure_reason,
          cg.representative_thread_id,
          cg.title,
          rt.number as representative_number,
          rt.kind as representative_kind,
          rt.title as representative_title,
          count(*) as member_count,
          max(coalesce(t.updated_at_gh, t.updated_at)) as latest_updated_at,
          sum(case when t.kind = 'issue' then 1 else 0 end) as issue_count,
          sum(case when t.kind = 'pull_request' then 1 else 0 end) as pull_request_count,
          sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count,
          group_concat(lower(coalesce(t.title, '')), ' ') as search_text
       from cluster_groups cg
       left join cluster_closures cc on cc.cluster_id = cg.id
       left join threads rt on rt.id = cg.representative_thread_id
       join cluster_memberships cm on cm.cluster_id = cg.id and cm.state <> 'removed_by_user'
       join threads t on t.id = cm.thread_id
       where cg.repo_id = ?
         and cg.id = ?
       group by
         cg.id,
         cg.stable_slug,
         cg.status,
         cg.closed_at,
         cc.updated_at,
         cc.reason,
         cg.representative_thread_id,
         cg.title,
         rt.number,
         rt.kind,
         rt.title`,
    )
    .get(repoId, clusterId) as DurableTuiClusterSummaryRow | undefined;
  if (!row) return null;
  return durableTuiSummaryFromRow({
    ...row,
    representative_title: row.representative_title ?? row.title,
  });
}

export function listRawTuiClusters(db: SqliteDatabase, repoId: number, clusterRunId: number, minSize: number): TuiClusterSummary[] {
  const rows = db
    .prepare(
      `select
          c.id as cluster_id,
          c.member_count,
          c.closed_at_local,
          c.close_reason_local,
          c.representative_thread_id,
          rt.number as representative_number,
          rt.kind as representative_kind,
          rt.title as representative_title,
          max(coalesce(t.updated_at_gh, t.updated_at)) as latest_updated_at,
          sum(case when t.kind = 'issue' then 1 else 0 end) as issue_count,
          sum(case when t.kind = 'pull_request' then 1 else 0 end) as pull_request_count,
          sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count,
          group_concat(lower(coalesce(t.title, '')), ' ') as search_text
       from clusters c
       left join threads rt on rt.id = c.representative_thread_id
       join cluster_members cm on cm.cluster_id = c.id
       join threads t on t.id = cm.thread_id
       where c.repo_id = ? and c.cluster_run_id = ?
       group by
         c.id,
         c.member_count,
         c.closed_at_local,
         c.close_reason_local,
         c.representative_thread_id,
         rt.number,
         rt.kind,
         rt.title
       having c.member_count >= ?`,
    )
    .all(repoId, clusterRunId, minSize) as RawTuiClusterSummaryRow[];
  const durableClosures = getDurableClosuresByRepresentative(
    db,
    repoId,
    rows
      .map((row) => row.representative_thread_id)
      .filter((threadId): threadId is number => threadId !== null),
  );

  return rows.map((row) => rawTuiSummaryFromRow(repoId, row, durableClosures.get(row.representative_thread_id ?? -1) ?? null));
}

export function getRawTuiClusterSummary(
  db: SqliteDatabase,
  repoId: number,
  clusterRunId: number,
  clusterId: number,
): TuiClusterSummary | null {
  const row = db
    .prepare(
      `select
          c.id as cluster_id,
          c.member_count,
          c.closed_at_local,
          c.close_reason_local,
          c.representative_thread_id,
          rt.number as representative_number,
          rt.kind as representative_kind,
          rt.title as representative_title,
          max(coalesce(t.updated_at_gh, t.updated_at)) as latest_updated_at,
          sum(case when t.kind = 'issue' then 1 else 0 end) as issue_count,
          sum(case when t.kind = 'pull_request' then 1 else 0 end) as pull_request_count,
          sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count,
          group_concat(lower(coalesce(t.title, '')), ' ') as search_text
       from clusters c
       left join threads rt on rt.id = c.representative_thread_id
       join cluster_members cm on cm.cluster_id = c.id
       join threads t on t.id = cm.thread_id
       where c.repo_id = ? and c.cluster_run_id = ? and c.id = ?
       group by
         c.id,
         c.member_count,
         c.closed_at_local,
         c.close_reason_local,
         c.representative_thread_id,
         rt.number,
         rt.kind,
         rt.title`,
    )
    .get(repoId, clusterRunId, clusterId) as RawTuiClusterSummaryRow | undefined;

  if (!row) {
    return null;
  }

  const durableClosure =
    row.representative_thread_id === null
      ? null
      : (getDurableClosuresByRepresentative(db, repoId, [row.representative_thread_id]).get(row.representative_thread_id) ?? null);
  return rawTuiSummaryFromRow(repoId, row, durableClosure);
}

export function listTuiClusterMembers(
  db: SqliteDatabase,
  clusterId: number,
  source: 'run_cluster' | 'durable_cluster',
): TuiClusterDetail['members'] {
  const rows =
    source === 'run_cluster'
      ? (db
          .prepare(
            `select t.id, t.number, t.kind, t.state, t.closed_at_local, t.title, t.updated_at_gh, t.html_url, t.labels_json, cm.score_to_representative
             from cluster_members cm
             join threads t on t.id = cm.thread_id
             where cm.cluster_id = ?
             order by
               case t.kind when 'issue' then 0 else 1 end asc,
               coalesce(t.updated_at_gh, t.updated_at) desc,
               t.number desc`,
          )
          .all(clusterId) as TuiClusterMemberRow[])
      : (db
          .prepare(
            `select t.id, t.number, t.kind, t.state, t.closed_at_local, t.title, t.updated_at_gh, t.html_url, t.labels_json, cm.score_to_representative
             from cluster_memberships cm
             join threads t on t.id = cm.thread_id
             where cm.cluster_id = ?
               and cm.state <> 'removed_by_user'
             order by
               case cm.role when 'canonical' then 0 else 1 end asc,
               case t.kind when 'issue' then 0 else 1 end asc,
               coalesce(t.updated_at_gh, t.updated_at) desc,
               t.number desc`,
          )
          .all(clusterId) as TuiClusterMemberRow[]);

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    kind: row.kind,
    isClosed: isEffectivelyClosed(row),
    title: row.title,
    updatedAtGh: row.updated_at_gh,
    htmlUrl: row.html_url,
    labels: parseArray(row.labels_json),
    clusterScore: row.score_to_representative,
  }));
}

type DurableTuiClusterSummaryRow = {
  cluster_id: number;
  stable_slug: string;
  status: 'active' | 'closed' | 'merged' | 'split';
  closed_at: string | null;
  closure_reason: string | null;
  representative_thread_id: number | null;
  title: string | null;
  representative_number: number | null;
  representative_kind: 'issue' | 'pull_request' | null;
  representative_title: string | null;
  member_count: number;
  latest_updated_at: string | null;
  issue_count: number;
  pull_request_count: number;
  closed_member_count: number;
  search_text: string | null;
};

type RawTuiClusterSummaryRow = {
  cluster_id: number;
  member_count: number;
  closed_at_local: string | null;
  close_reason_local: string | null;
  representative_thread_id: number | null;
  representative_number: number | null;
  representative_kind: 'issue' | 'pull_request' | null;
  representative_title: string | null;
  latest_updated_at: string | null;
  issue_count: number;
  pull_request_count: number;
  closed_member_count: number;
  search_text: string | null;
};

type TuiClusterMemberRow = {
  id: number;
  number: number;
  kind: 'issue' | 'pull_request';
  state: string;
  closed_at_local: string | null;
  title: string;
  updated_at_gh: string | null;
  html_url: string;
  labels_json: string;
  score_to_representative: number | null;
};

function rawTuiSummaryFromRow(repoId: number, row: RawTuiClusterSummaryRow, durableClosure: DurableTuiClosure | null): TuiClusterSummary {
  const clusterName = clusterHumanName(repoId, row.representative_thread_id, row.cluster_id);
  return {
    clusterId: row.cluster_id,
    displayTitle: clusterDisplayTitle(clusterName, row.representative_title, row.cluster_id),
    isClosed: row.close_reason_local !== null || durableClosure !== null || row.closed_member_count >= row.member_count,
    closedAtLocal: row.closed_at_local ?? durableClosure?.closedAt ?? null,
    closeReasonLocal: row.close_reason_local ?? (durableClosure ? durableClosureReason(durableClosure) : null),
    totalCount: row.member_count,
    issueCount: row.issue_count,
    pullRequestCount: row.pull_request_count,
    latestUpdatedAt: row.latest_updated_at,
    representativeThreadId: row.representative_thread_id,
    representativeNumber: row.representative_number,
    representativeKind: row.representative_kind,
    searchText: `${clusterName} ${(row.representative_title ?? '').toLowerCase()} ${row.search_text ?? ''}`.trim(),
  };
}
