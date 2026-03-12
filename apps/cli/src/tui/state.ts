import type { TuiClusterDetail, TuiClusterSortMode, TuiClusterSummary } from '@ghcrawl/api-core';

export type TuiScreenId = 'clusters' | 'users';
export type TuiFocusPane = 'clusters' | 'members' | 'detail';
export type TuiMinSizeFilter = 0 | 1 | 10 | 20 | 50;
export type TuiScreenDefinition = {
  id: TuiScreenId;
  label: string;
  description: string;
  focusOrder: readonly TuiFocusPane[];
};

export type MemberListRow =
  | { key: string; label: string; selectable: false }
  | { key: string; label: string; selectable: true; threadId: number };

export const SORT_MODE_ORDER: TuiClusterSortMode[] = ['recent', 'size'];
export const MIN_SIZE_FILTER_ORDER: TuiMinSizeFilter[] = [1, 10, 20, 50, 0];
export const FOCUS_PANE_ORDER: TuiFocusPane[] = ['clusters', 'members', 'detail'];
export const TUI_SCREEN_DEFINITIONS: Record<TuiScreenId, TuiScreenDefinition> = {
  clusters: {
    id: 'clusters',
    label: 'Clusters Explorer',
    description: 'Issue and PR similarity clusters.',
    focusOrder: FOCUS_PANE_ORDER,
  },
  users: {
    id: 'users',
    label: 'User Explorer',
    description: 'Author-centric explorer for future user workflows.',
    focusOrder: ['detail'],
  },
};

export function getScreenDefinition(screen: TuiScreenId): TuiScreenDefinition {
  return TUI_SCREEN_DEFINITIONS[screen];
}

export function getScreenFocusOrder(screen: TuiScreenId): readonly TuiFocusPane[] {
  return getScreenDefinition(screen).focusOrder;
}

export function cycleSortMode(current: TuiClusterSortMode): TuiClusterSortMode {
  const index = SORT_MODE_ORDER.indexOf(current);
  return SORT_MODE_ORDER[(index + 1) % SORT_MODE_ORDER.length] ?? 'recent';
}

export function cycleMinSizeFilter(current: TuiMinSizeFilter): TuiMinSizeFilter {
  const index = MIN_SIZE_FILTER_ORDER.indexOf(current);
  return MIN_SIZE_FILTER_ORDER[(index + 1) % MIN_SIZE_FILTER_ORDER.length] ?? 10;
}

export function cycleFocusPane(current: TuiFocusPane, direction: 1 | -1 = 1, order: readonly TuiFocusPane[] = FOCUS_PANE_ORDER): TuiFocusPane {
  const index = order.indexOf(current);
  const baseIndex = index >= 0 ? index : 0;
  const next = (baseIndex + direction + order.length) % order.length;
  return order[next] ?? order[0] ?? 'detail';
}

export function applyClusterFilters(
  clusters: TuiClusterSummary[],
  params: { sortMode: TuiClusterSortMode; minSize: TuiMinSizeFilter; search: string },
): TuiClusterSummary[] {
  const normalizedSearch = params.search.trim().toLowerCase();
  return clusters
    .filter((cluster) => cluster.totalCount >= params.minSize)
    .filter((cluster) => (normalizedSearch ? cluster.searchText.includes(normalizedSearch) : true))
    .slice()
    .sort((left, right) => compareClusters(left, right, params.sortMode));
}

export function preserveSelectedId(ids: number[], selectedId: number | null): number | null {
  if (selectedId !== null && ids.includes(selectedId)) {
    return selectedId;
  }
  return ids[0] ?? null;
}

export function buildMemberRows(detail: TuiClusterDetail | null, options?: { includeClosedMembers?: boolean }): MemberListRow[] {
  if (!detail) return [];
  const includeClosedMembers = options?.includeClosedMembers ?? true;
  const visibleMembers = includeClosedMembers ? detail.members : detail.members.filter((member: TuiClusterDetail['members'][number]) => !member.isClosed);
  const issues = visibleMembers.filter((member: TuiClusterDetail['members'][number]) => member.kind === 'issue');
  const pullRequests = visibleMembers.filter((member: TuiClusterDetail['members'][number]) => member.kind === 'pull_request');
  const rows: MemberListRow[] = [];

  if (issues.length > 0) {
    rows.push({ key: 'issues-header', label: `ISSUES (${issues.length})`, selectable: false });
    for (const issue of issues) {
      rows.push({
        key: `thread-${issue.id}`,
        label: formatMemberLabel(issue.number, issue.title, issue.updatedAtGh, issue.isClosed),
        selectable: true,
        threadId: issue.id,
      });
    }
  }

  if (pullRequests.length > 0) {
    rows.push({ key: 'pulls-header', label: `PULL REQUESTS (${pullRequests.length})`, selectable: false });
    for (const pullRequest of pullRequests) {
      rows.push({
        key: `thread-${pullRequest.id}`,
        label: formatMemberLabel(pullRequest.number, pullRequest.title, pullRequest.updatedAtGh, pullRequest.isClosed),
        selectable: true,
        threadId: pullRequest.id,
      });
    }
  }

  return rows;
}

export function findSelectableIndex(rows: MemberListRow[], threadId: number | null): number {
  if (threadId !== null) {
    const index = rows.findIndex((row) => row.selectable && row.threadId === threadId);
    if (index >= 0) return index;
  }
  return rows.findIndex((row) => row.selectable);
}

export function moveSelectableIndex(rows: MemberListRow[], currentIndex: number, delta: -1 | 1): number {
  if (rows.length === 0) return -1;
  let index = currentIndex;
  for (let attempts = 0; attempts < rows.length; attempts += 1) {
    index += delta;
    if (index < 0) index = rows.length - 1;
    if (index >= rows.length) index = 0;
    if (rows[index]?.selectable) {
      return index;
    }
  }
  return currentIndex;
}

export function selectedThreadIdFromRow(rows: MemberListRow[], index: number): number | null {
  const row = rows[index];
  return row && row.selectable ? row.threadId : null;
}

function compareClusters(left: TuiClusterSummary, right: TuiClusterSummary, sortMode: TuiClusterSortMode): number {
  const leftTime = left.latestUpdatedAt ? Date.parse(left.latestUpdatedAt) : 0;
  const rightTime = right.latestUpdatedAt ? Date.parse(right.latestUpdatedAt) : 0;
  if (sortMode === 'size') {
    return right.totalCount - left.totalCount || rightTime - leftTime || left.clusterId - right.clusterId;
  }
  return rightTime - leftTime || right.totalCount - left.totalCount || left.clusterId - right.clusterId;
}

function formatMemberLabel(number: number, title: string, updatedAtGh: string | null, isClosed: boolean): string {
  const updated = updatedAtGh ? updatedAtGh.slice(5, 16).replace('T', ' ') : 'unknown';
  const label = escapeBlessedInline(`#${number}  ${updated}  ${title}`);
  return isClosed ? `{gray-fg}${label}{/gray-fg}` : label;
}

function escapeBlessedInline(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
