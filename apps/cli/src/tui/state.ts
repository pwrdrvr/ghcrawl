import type { TuiClusterDetail, TuiClusterSortMode, TuiClusterSummary, TuiMemberSortPreference } from '@ghcrawl/api-core';

export type TuiFocusPane = 'clusters' | 'members' | 'detail';
export type TuiMinSizeFilter = 0 | 1 | 2 | 5 | 10 | 20 | 50;
export type TuiMemberSortMode = TuiMemberSortPreference;

export type MemberListRow =
  | { key: string; label: string; selectable: false }
  | { key: string; label: string; selectable: true; threadId: number; isClosed: boolean; kind: 'issue' | 'pull_request' };

export const SORT_MODE_ORDER: TuiClusterSortMode[] = ['size', 'recent'];
export const MEMBER_SORT_MODE_ORDER: TuiMemberSortMode[] = ['kind', 'recent', 'number', 'state', 'title'];
export const MIN_SIZE_FILTER_ORDER: TuiMinSizeFilter[] = [5, 10, 20, 50, 0, 1, 2];
export const FOCUS_PANE_ORDER: TuiFocusPane[] = ['clusters', 'members', 'detail'];

const MEMBER_NUMBER_WIDTH = 8;
const MEMBER_STATE_WIDTH = 7;
const MEMBER_UPDATED_WIDTH = 8;
const MEMBER_STATE_START = MEMBER_NUMBER_WIDTH;
const MEMBER_UPDATED_START = MEMBER_STATE_START + MEMBER_STATE_WIDTH;
const MEMBER_TITLE_START = MEMBER_UPDATED_START + MEMBER_UPDATED_WIDTH;

export function cycleSortMode(current: TuiClusterSortMode): TuiClusterSortMode {
  const index = SORT_MODE_ORDER.indexOf(current);
  return SORT_MODE_ORDER[(index + 1) % SORT_MODE_ORDER.length] ?? 'size';
}

export function cycleMinSizeFilter(current: TuiMinSizeFilter): TuiMinSizeFilter {
  const index = MIN_SIZE_FILTER_ORDER.indexOf(current);
  return MIN_SIZE_FILTER_ORDER[(index + 1) % MIN_SIZE_FILTER_ORDER.length] ?? 5;
}

export function cycleMemberSortMode(current: TuiMemberSortMode): TuiMemberSortMode {
  const index = MEMBER_SORT_MODE_ORDER.indexOf(current);
  return MEMBER_SORT_MODE_ORDER[(index + 1) % MEMBER_SORT_MODE_ORDER.length] ?? 'kind';
}

export function cycleFocusPane(current: TuiFocusPane, direction: 1 | -1 = 1): TuiFocusPane {
  const index = FOCUS_PANE_ORDER.indexOf(current);
  const next = (index + direction + FOCUS_PANE_ORDER.length) % FOCUS_PANE_ORDER.length;
  return FOCUS_PANE_ORDER[next] ?? 'clusters';
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

export function buildMemberRows(detail: TuiClusterDetail | null, options?: { includeClosedMembers?: boolean; sortMode?: TuiMemberSortMode }): MemberListRow[] {
  if (!detail) return [];
  const includeClosedMembers = options?.includeClosedMembers ?? true;
  const sortMode = options?.sortMode ?? 'kind';
  const visibleMembers = includeClosedMembers ? detail.members : detail.members.filter((member) => !member.isClosed);
  const rows: MemberListRow[] = [{ key: 'members-table-header', label: `{bold}${formatMemberListHeader(sortMode)}{/bold}`, selectable: false }];

  if (sortMode !== 'kind') {
    appendMemberRows(rows, sortMembers(visibleMembers, sortMode));
    return rows;
  }

  const issues = visibleMembers.filter((member) => member.kind === 'issue');
  const pullRequests = visibleMembers.filter((member) => member.kind === 'pull_request');
  if (issues.length > 0) {
    rows.push({ key: 'issues-header', label: `ISSUES (${issues.length})`, selectable: false });
    appendMemberRows(rows, issues);
  }

  if (pullRequests.length > 0) {
    rows.push({ key: 'pulls-header', label: `PULL REQUESTS (${pullRequests.length})`, selectable: false });
    appendMemberRows(rows, pullRequests);
  }

  return rows;
}

type TuiMember = TuiClusterDetail['members'][number];

function appendMemberRows(rows: MemberListRow[], members: TuiMember[]): void {
  for (const member of members) {
    rows.push({
      key: `thread-${member.id}`,
      label: formatMemberLabel(member.number, member.title, member.updatedAtGh, member.isClosed),
      selectable: true,
      threadId: member.id,
      isClosed: member.isClosed,
      kind: member.kind,
    });
  }
}

function sortMembers(members: TuiMember[], sortMode: TuiMemberSortMode): TuiMember[] {
  return members.slice().sort((left, right) => {
    const leftTime = left.updatedAtGh ? Date.parse(left.updatedAtGh) : 0;
    const rightTime = right.updatedAtGh ? Date.parse(right.updatedAtGh) : 0;
    if (sortMode === 'recent') {
      return rightTime - leftTime || right.number - left.number;
    }
    if (sortMode === 'number') {
      return left.number - right.number;
    }
    if (sortMode === 'state') {
      return Number(left.isClosed) - Number(right.isClosed) || rightTime - leftTime || left.number - right.number;
    }
    return normalizeMemberTitle(left.title).localeCompare(normalizeMemberTitle(right.title)) || left.number - right.number;
  });
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

function compareClusters(left: TuiClusterSummary, right: TuiClusterSummary, sortMode: TuiClusterSortMode): number {
  const leftTime = left.latestUpdatedAt ? Date.parse(left.latestUpdatedAt) : 0;
  const rightTime = right.latestUpdatedAt ? Date.parse(right.latestUpdatedAt) : 0;
  if (sortMode === 'size') {
    return right.totalCount - left.totalCount || rightTime - leftTime || left.clusterId - right.clusterId;
  }
  return rightTime - leftTime || right.totalCount - left.totalCount || left.clusterId - right.clusterId;
}

function formatMemberLabel(number: number, title: string, updatedAtGh: string | null, isClosed: boolean): string {
  const updated = formatRelativeTime(updatedAtGh);
  const numberLabel = `#${number}`.padEnd(MEMBER_NUMBER_WIDTH).slice(0, MEMBER_NUMBER_WIDTH);
  const status = isClosed ? '{gray-fg}closed{/gray-fg} ' : '{green-fg}open{/green-fg}   ';
  const age = updated.padEnd(MEMBER_UPDATED_WIDTH).slice(0, MEMBER_UPDATED_WIDTH);
  const titleLabel = escapeBlessedInline(normalizeMemberTitle(title));
  const prefix = `${escapeBlessedInline(numberLabel)}${status}${escapeBlessedInline(age)}`;
  return isClosed ? `{gray-fg}${prefix}${titleLabel}{/gray-fg}` : `${prefix}${titleLabel}`;
}

export function formatMemberListHeader(sortMode: TuiMemberSortMode = 'kind'): string {
  const number = (sortMode === 'number' ? 'number*' : 'number').padEnd(MEMBER_NUMBER_WIDTH);
  const state = (sortMode === 'state' ? 'state*' : 'state').padEnd(MEMBER_STATE_WIDTH);
  const updated = (sortMode === 'recent' ? 'updated*' : 'updated').padEnd(MEMBER_UPDATED_WIDTH);
  const title = sortMode === 'title' ? 'title*' : 'title';
  return `${number}${state}${updated}${title}`;
}

export function resolveMemberHeaderSortFromClick(relativeX: number, currentSortMode: TuiMemberSortMode): TuiMemberSortMode {
  if (relativeX < MEMBER_STATE_START) return 'number';
  if (relativeX < MEMBER_UPDATED_START) return 'state';
  if (relativeX < MEMBER_TITLE_START) return 'recent';
  if (currentSortMode === 'title') return 'kind';
  return 'title';
}

export function formatRelativeTime(value: string | null, now: Date = new Date()): string {
  if (!value) return 'never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const diffMs = Math.max(0, now.getTime() - parsed.getTime());
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (diffMs < minuteMs) return 'now';
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${minutes}m ago`;
  }
  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)}h ago`;
  }
  if (diffMs < 60 * dayMs) {
    return `${Math.floor(diffMs / dayMs)}d ago`;
  }
  const monthMs = 30 * dayMs;
  const yearMs = 365 * dayMs;
  if (diffMs < 2 * yearMs) {
    return `${Math.max(1, Math.floor(diffMs / monthMs))}mo ago`;
  }
  return `${Math.max(1, Math.floor(diffMs / yearMs))}y ago`;
}

function normalizeMemberTitle(title: string): string {
  return title.replace(/^\[([^\]]{1,30})\]:?\s+/, '$1: ');
}

function escapeBlessedInline(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
