import type { DurableTuiClosure, TuiClusterSortMode, TuiClusterSummary } from '../service-types.js';

export function durableClosureReason(closure: DurableTuiClosure): string | null {
  if (closure.reason) return closure.reason;
  return closure.status === 'merged' || closure.status === 'split' ? closure.status : null;
}

export function parseMemberThreadIdSet(value: string | null): Set<number> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((part) => Number(part))
      .filter((memberId) => Number.isSafeInteger(memberId) && memberId > 0),
  );
}

export function clusterDisplayTitle(clusterName: string, representativeTitle: string | null, clusterId: number): string {
  return `${clusterName}  ${representativeTitle ?? `Cluster ${clusterId}`}`;
}

export function compareTuiClusterSummary(left: TuiClusterSummary, right: TuiClusterSummary, sort: TuiClusterSortMode): number {
  const leftTime = left.latestUpdatedAt ? Date.parse(left.latestUpdatedAt) : 0;
  const rightTime = right.latestUpdatedAt ? Date.parse(right.latestUpdatedAt) : 0;
  if (sort === 'size') {
    return right.totalCount - left.totalCount || rightTime - leftTime || left.clusterId - right.clusterId;
  }
  return rightTime - leftTime || right.totalCount - left.totalCount || left.clusterId - right.clusterId;
}

export function collapseOverlappingClosedDurableRows<
  T extends {
    cluster_id: number;
    member_count: number;
    latest_updated_at: string | null;
    member_thread_ids: string | null;
  },
>(rows: T[]): T[] {
  const sortedRows = [...rows].sort((left, right) => {
    const leftTime = left.latest_updated_at ? Date.parse(left.latest_updated_at) : 0;
    const rightTime = right.latest_updated_at ? Date.parse(right.latest_updated_at) : 0;
    return right.member_count - left.member_count || rightTime - leftTime || left.cluster_id - right.cluster_id;
  });
  const selected: Array<{ row: T; memberIds: Set<number> }> = [];

  for (const row of sortedRows) {
    const memberIds = parseMemberThreadIdSet(row.member_thread_ids);
    const duplicate = selected.some((entry) => {
      const smallerSize = Math.min(memberIds.size, entry.memberIds.size);
      if (smallerSize === 0) return false;
      let overlap = 0;
      for (const memberId of memberIds) {
        if (entry.memberIds.has(memberId)) overlap += 1;
      }
      return overlap / smallerSize >= 0.8;
    });
    if (!duplicate) {
      selected.push({ row, memberIds });
    }
  }

  return selected.map((entry) => entry.row);
}

export function durableTuiSummaryFromRow(row: {
  cluster_id: number;
  stable_slug: string;
  status: 'active' | 'closed' | 'merged' | 'split';
  closed_at: string | null;
  closure_reason?: string | null;
  representative_thread_id: number | null;
  representative_number: number | null;
  representative_kind: 'issue' | 'pull_request' | null;
  representative_title: string | null;
  member_count: number;
  latest_updated_at: string | null;
  issue_count: number;
  pull_request_count: number;
  closed_member_count: number;
  search_text: string | null;
}): TuiClusterSummary {
  const closure: DurableTuiClosure = {
    clusterId: row.cluster_id,
    status: row.status,
    closedAt: row.closed_at,
    reason: row.closure_reason ?? null,
  };
  const lifecycleClosed = row.status === 'merged' || row.status === 'split';
  const manuallyClosed = row.closure_reason !== undefined && row.closure_reason !== null;
  const isClosed = manuallyClosed || lifecycleClosed || row.closed_member_count >= row.member_count;
  const closeReasonLocal =
    manuallyClosed || lifecycleClosed
      ? durableClosureReason(closure)
      : row.closed_member_count >= row.member_count
        ? 'all_members_closed'
        : null;
  return {
    clusterId: row.cluster_id,
    displayTitle: clusterDisplayTitle(row.stable_slug, row.representative_title, row.cluster_id),
    isClosed,
    closedAtLocal: manuallyClosed || lifecycleClosed ? row.closed_at : null,
    closeReasonLocal,
    totalCount: row.member_count,
    issueCount: row.issue_count,
    pullRequestCount: row.pull_request_count,
    latestUpdatedAt: row.latest_updated_at,
    representativeThreadId: row.representative_thread_id,
    representativeNumber: row.representative_number,
    representativeKind: row.representative_kind,
    searchText: `${row.stable_slug} ${(row.representative_title ?? '').toLowerCase()} ${row.search_text ?? ''}`.trim(),
  };
}
