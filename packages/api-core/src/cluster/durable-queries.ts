import {
  clusterExplainResponseSchema,
  durableClustersResponseSchema,
  type ClusterExplainResponse,
  type DurableClustersResponse,
  type RepositoryDto,
} from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';
import type { ThreadRow } from '../service-types.js';
import { parseObjectJson, threadToDto } from '../service-utils.js';

type DurableClusterStatus = 'active' | 'closed' | 'merged' | 'split';
type DurableMemberRole = 'canonical' | 'duplicate' | 'related';
type DurableMemberState = 'active' | 'removed_by_user' | 'blocked_by_override' | 'pending_review' | 'stale';

type DurableClusterRow = {
  id: number;
  stable_key: string;
  stable_slug: string;
  status: DurableClusterStatus;
  cluster_type: string | null;
  representative_thread_id: number | null;
  title: string | null;
};

type DurableMemberRow = ThreadRow & {
  membership_role: DurableMemberRole;
  membership_state: DurableMemberState;
  membership_score: number | null;
};

export function listStoredDurableClusters(
  db: SqliteDatabase,
  repository: RepositoryDto,
  params: { includeInactive?: boolean; memberLimit?: number } = {},
): DurableClustersResponse {
  const clusterRows = db
    .prepare(
      `select id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title
       from cluster_groups
       where repo_id = ?
         and (? = 1 or status = 'active')
       order by updated_at desc, id asc`,
    )
    .all(repository.id, params.includeInactive ? 1 : 0) as DurableClusterRow[];
  if (clusterRows.length === 0) {
    return durableClustersResponseSchema.parse({ repository, clusters: [] });
  }

  const clusterIds = clusterRows.map((row) => row.id);
  const placeholders = clusterIds.map(() => '?').join(',');
  const memberRows = db
    .prepare(
      `select
         cm.cluster_id,
         cm.role as membership_role,
         cm.state as membership_state,
         cm.score_to_representative as membership_score,
         t.*
       from cluster_memberships cm
       join threads t on t.id = cm.thread_id
       where cm.cluster_id in (${placeholders})
       order by
         case cm.role when 'canonical' then 0 else 1 end,
         case cm.state when 'active' then 0 when 'pending_review' then 1 else 2 end,
         t.number asc`,
    )
    .all(...clusterIds) as Array<DurableMemberRow & { cluster_id: number }>;
  const membersByCluster = new Map<number, Array<DurableMemberRow & { cluster_id: number }>>();
  for (const row of memberRows) {
    const members = membersByCluster.get(row.cluster_id) ?? [];
    members.push(row);
    membersByCluster.set(row.cluster_id, members);
  }

  return durableClustersResponseSchema.parse({
    repository,
    clusters: clusterRows.map((cluster) => {
      const rows = membersByCluster.get(cluster.id) ?? [];
      const visibleRows = params.memberLimit === undefined ? rows : rows.slice(0, params.memberLimit);
      return {
        clusterId: cluster.id,
        stableKey: cluster.stable_key,
        stableSlug: cluster.stable_slug,
        status: cluster.status,
        clusterType: cluster.cluster_type,
        title: cluster.title,
        representativeThreadId: cluster.representative_thread_id,
        activeCount: rows.filter((row) => row.membership_state === 'active').length,
        removedCount: rows.filter((row) => row.membership_state === 'removed_by_user').length,
        blockedCount: rows.filter((row) => row.membership_state === 'blocked_by_override').length,
        members: visibleRows.map((row) => ({
          thread: threadToDto(row),
          role: row.membership_role,
          state: row.membership_state,
          scoreToRepresentative: row.membership_score,
        })),
      };
    }),
  });
}

export function explainStoredDurableCluster(
  db: SqliteDatabase,
  repository: RepositoryDto,
  params: { clusterId: number; memberLimit?: number; eventLimit?: number },
): ClusterExplainResponse {
  const cluster = db
    .prepare(
      `select id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title
       from cluster_groups
       where repo_id = ?
         and id = ?
       limit 1`,
    )
    .get(repository.id, params.clusterId) as DurableClusterRow | undefined;
  if (!cluster) {
    throw new Error(`Durable cluster ${params.clusterId} was not found for ${repository.fullName}.`);
  }

  const allMembers = db
    .prepare(
      `select
         cm.role as membership_role,
         cm.state as membership_state,
         cm.score_to_representative as membership_score,
         t.*
       from cluster_memberships cm
       join threads t on t.id = cm.thread_id
       where cm.cluster_id = ?
       order by
         case cm.role when 'canonical' then 0 else 1 end,
         case cm.state when 'active' then 0 when 'pending_review' then 1 else 2 end,
         t.number asc`,
    )
    .all(cluster.id) as DurableMemberRow[];
  const visibleMembers = allMembers.slice(0, params.memberLimit ?? 50);
  const visibleThreadIds = visibleMembers.map((row) => row.id);

  const aliases = db
    .prepare(
      `select alias_slug, reason, created_at
       from cluster_aliases
       where cluster_id = ?
       order by created_at desc, alias_slug asc`,
    )
    .all(cluster.id) as Array<{ alias_slug: string; reason: string; created_at: string }>;
  const overrides = db
    .prepare(
      `select t.number, co.action, co.reason, co.created_at, co.expires_at
       from cluster_overrides co
       join threads t on t.id = co.thread_id
       where co.cluster_id = ?
       order by co.created_at desc, t.number asc`,
    )
    .all(cluster.id) as Array<{
    number: number;
    action: 'exclude' | 'force_include' | 'force_canonical';
    reason: string | null;
    created_at: string;
    expires_at: string | null;
  }>;
  const events = db
    .prepare(
      `select event_type, actor_kind, payload_json, created_at
       from cluster_events
       where cluster_id = ?
       order by created_at desc, id desc
       limit ?`,
    )
    .all(cluster.id, params.eventLimit ?? 25) as Array<{ event_type: string; actor_kind: string; payload_json: string; created_at: string }>;

  let evidence: Array<{
    leftThreadNumber: number;
    rightThreadNumber: number;
    score: number;
    tier: 'strong' | 'weak';
    state: 'active' | 'stale' | 'rejected';
    sources: string[];
    breakdown: Record<string, unknown>;
    lastSeenRunId: number | null;
    updatedAt: string;
  }> = [];
  if (visibleThreadIds.length >= 2) {
    const placeholders = visibleThreadIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `select
           le.number as left_number,
           re.number as right_number,
           e.score,
           e.tier,
           e.state,
           e.breakdown_json,
           e.last_seen_run_id,
           e.updated_at
         from similarity_edge_evidence e
         join threads le on le.id = e.left_thread_id
         join threads re on re.id = e.right_thread_id
         where e.repo_id = ?
           and e.left_thread_id in (${placeholders})
           and e.right_thread_id in (${placeholders})
         order by e.score desc, le.number asc, re.number asc`,
      )
      .all(repository.id, ...visibleThreadIds, ...visibleThreadIds) as Array<{
      left_number: number;
      right_number: number;
      score: number;
      tier: 'strong' | 'weak';
      state: 'active' | 'stale' | 'rejected';
      breakdown_json: string;
      last_seen_run_id: number | null;
      updated_at: string;
    }>;
    evidence = rows.map((row) => {
      const breakdown = parseObjectJson(row.breakdown_json) ?? {};
      const rawSources = breakdown.sources;
      return {
        leftThreadNumber: row.left_number,
        rightThreadNumber: row.right_number,
        score: row.score,
        tier: row.tier,
        state: row.state,
        sources: Array.isArray(rawSources) ? rawSources.filter((source): source is string => typeof source === 'string') : [],
        breakdown,
        lastSeenRunId: row.last_seen_run_id,
        updatedAt: row.updated_at,
      };
    });
  }

  return clusterExplainResponseSchema.parse({
    repository,
    cluster: {
      clusterId: cluster.id,
      stableKey: cluster.stable_key,
      stableSlug: cluster.stable_slug,
      status: cluster.status,
      clusterType: cluster.cluster_type,
      title: cluster.title,
      representativeThreadId: cluster.representative_thread_id,
      activeCount: allMembers.filter((row) => row.membership_state === 'active').length,
      removedCount: allMembers.filter((row) => row.membership_state === 'removed_by_user').length,
      blockedCount: allMembers.filter((row) => row.membership_state === 'blocked_by_override').length,
      members: visibleMembers.map((row) => ({
        thread: threadToDto(row),
        role: row.membership_role,
        state: row.membership_state,
        scoreToRepresentative: row.membership_score,
      })),
    },
    aliases: aliases.map((alias) => ({
      aliasSlug: alias.alias_slug,
      reason: alias.reason,
      createdAt: alias.created_at,
    })),
    overrides: overrides.map((override) => ({
      threadNumber: override.number,
      action: override.action,
      reason: override.reason,
      createdAt: override.created_at,
      expiresAt: override.expires_at,
    })),
    events: events.map((event) => ({
      eventType: event.event_type,
      actorKind: event.actor_kind,
      payload: parseObjectJson(event.payload_json),
      createdAt: event.created_at,
    })),
    evidence,
  });
}
