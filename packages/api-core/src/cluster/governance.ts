import { humanKeyForValue } from './human-key.js';

export type ClusterMembershipState = 'active' | 'removed_by_user' | 'blocked_by_override' | 'pending_review' | 'stale';
export type ClusterMembershipRole = 'canonical' | 'duplicate' | 'related';
export type ClusterOverrideAction = 'exclude' | 'force_include' | 'force_canonical';
export type ClusterEventType = 'create_cluster' | 'add_member' | 'block_member' | 'keep_member' | 'remove_member';

export type DurableCluster = {
  id: string;
  repoId: number;
  stableKey: string;
  stableSlug: string;
  representativeThreadId: number | null;
  memberThreadIds: number[];
};

export type ClusterMembership = {
  clusterId: string;
  threadId: number;
  role: ClusterMembershipRole;
  state: ClusterMembershipState;
  scoreToRepresentative: number | null;
  addedBy: 'algo' | 'user' | 'import';
  removedBy: 'algo' | 'user' | null;
};

export type ClusterOverride = {
  clusterId: string;
  threadId: number;
  action: ClusterOverrideAction;
};

export type ClusterProposal = {
  representativeThreadId: number;
  memberThreadIds: number[];
  scoresToRepresentative: Map<number, number>;
};

export type ClusterGovernanceInput = {
  repoId: number;
  existingClusters: DurableCluster[];
  existingMemberships: ClusterMembership[];
  overrides: ClusterOverride[];
  proposals: ClusterProposal[];
};

export type ClusterGovernanceEvent = {
  clusterId: string;
  eventType: ClusterEventType;
  threadId: number | null;
  payload: Record<string, unknown>;
};

export type ClusterGovernanceResult = {
  clusters: DurableCluster[];
  memberships: ClusterMembership[];
  events: ClusterGovernanceEvent[];
};

function stableClusterIdentity(repoId: number, representativeThreadId: number): { key: string; slug: string } {
  const key = humanKeyForValue(`cluster:${repoId}:${representativeThreadId}`);
  return { key: key.hash, slug: key.slug };
}

function membershipKey(clusterId: string, threadId: number): string {
  return `${clusterId}:${threadId}`;
}

function findReusableCluster(
  proposal: ClusterProposal,
  existingClusters: DurableCluster[],
  existingMemberships: ClusterMembership[],
): DurableCluster | null {
  const activeByThread = new Map<number, string>();
  for (const membership of existingMemberships) {
    if (membership.state === 'active') {
      activeByThread.set(membership.threadId, membership.clusterId);
    }
  }

  const counts = new Map<string, number>();
  for (const threadId of proposal.memberThreadIds) {
    const clusterId = activeByThread.get(threadId);
    if (clusterId) counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
  }

  const winner = Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0];
  if (!winner) return null;
  return existingClusters.find((cluster) => cluster.id === winner) ?? null;
}

export function applyClusterGovernance(input: ClusterGovernanceInput): ClusterGovernanceResult {
  const clusters = new Map(input.existingClusters.map((cluster) => [cluster.id, { ...cluster, memberThreadIds: [...cluster.memberThreadIds] }]));
  const memberships = new Map(input.existingMemberships.map((membership) => [membershipKey(membership.clusterId, membership.threadId), { ...membership }]));
  const overrides = new Map(input.overrides.map((override) => [membershipKey(override.clusterId, override.threadId), override]));
  const events: ClusterGovernanceEvent[] = [];

  for (const proposal of input.proposals) {
    let cluster = findReusableCluster(proposal, input.existingClusters, input.existingMemberships);
    if (!cluster) {
      const identity = stableClusterIdentity(input.repoId, proposal.representativeThreadId);
      cluster = {
        id: identity.slug,
        repoId: input.repoId,
        stableKey: identity.key,
        stableSlug: identity.slug,
        representativeThreadId: proposal.representativeThreadId,
        memberThreadIds: [],
      };
      events.push({
        clusterId: cluster.id,
        eventType: 'create_cluster',
        threadId: null,
        payload: { representativeThreadId: proposal.representativeThreadId },
      });
    }
    clusters.set(cluster.id, cluster);

    const proposedMembers = new Set(proposal.memberThreadIds);
    for (const threadId of proposedMembers) {
      const key = membershipKey(cluster.id, threadId);
      const override = overrides.get(key);
      if (override?.action === 'exclude') {
        memberships.set(key, {
          clusterId: cluster.id,
          threadId,
          role: 'related',
          state: 'blocked_by_override',
          scoreToRepresentative: proposal.scoresToRepresentative.get(threadId) ?? null,
          addedBy: 'algo',
          removedBy: 'user',
        });
        events.push({
          clusterId: cluster.id,
          eventType: 'block_member',
          threadId,
          payload: { reason: 'manual_exclusion' },
        });
        continue;
      }

      const existing = memberships.get(key);
      memberships.set(key, {
        clusterId: cluster.id,
        threadId,
        role: threadId === proposal.representativeThreadId || override?.action === 'force_canonical' ? 'canonical' : 'related',
        state: 'active',
        scoreToRepresentative: proposal.scoresToRepresentative.get(threadId) ?? null,
        addedBy: existing?.addedBy ?? (override?.action === 'force_include' || override?.action === 'force_canonical' ? 'user' : 'algo'),
        removedBy: null,
      });
      events.push({
        clusterId: cluster.id,
        eventType: existing?.state === 'active' ? 'keep_member' : 'add_member',
        threadId,
        payload: { scoreToRepresentative: proposal.scoresToRepresentative.get(threadId) ?? null },
      });
    }

    const activeMembers = Array.from(memberships.values())
      .filter((membership) => membership.clusterId === cluster.id && membership.state === 'active')
      .map((membership) => membership.threadId)
      .sort((left, right) => left - right);
    clusters.set(cluster.id, {
      ...cluster,
      memberThreadIds: activeMembers,
    });
  }

  return {
    clusters: Array.from(clusters.values()),
    memberships: Array.from(memberships.values()),
    events,
  };
}
