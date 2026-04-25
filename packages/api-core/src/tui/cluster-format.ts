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
