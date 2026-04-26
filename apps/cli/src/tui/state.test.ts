import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyClusterFilters,
  buildMemberRows,
  cycleFocusPane,
  cycleMemberSortMode,
  cycleMinSizeFilter,
  cycleSortMode,
  findSelectableIndex,
  formatMemberListHeader,
  formatRelativeTime,
  moveSelectableIndex,
  preserveSelectedId,
  resolveMemberHeaderSortFromClick,
} from './state.js';
import type { TuiClusterDetail, TuiClusterSummary } from '@ghcrawl/api-core';

test('cycleSortMode toggles size and recent', () => {
  assert.equal(cycleSortMode('size'), 'recent');
  assert.equal(cycleSortMode('recent'), 'size');
});

test('cycleMinSizeFilter rotates through presets', () => {
  assert.equal(cycleMinSizeFilter(5), 10);
  assert.equal(cycleMinSizeFilter(10), 20);
  assert.equal(cycleMinSizeFilter(20), 50);
  assert.equal(cycleMinSizeFilter(50), 0);
  assert.equal(cycleMinSizeFilter(0), 1);
  assert.equal(cycleMinSizeFilter(1), 2);
  assert.equal(cycleMinSizeFilter(2), 5);
});

test('cycleMinSizeFilter falls back to the default 5+ view', () => {
  assert.equal(cycleMinSizeFilter(99 as never), 5);
});

test('cycleMemberSortMode rotates through member sort modes', () => {
  assert.equal(cycleMemberSortMode('kind'), 'recent');
  assert.equal(cycleMemberSortMode('recent'), 'number');
  assert.equal(cycleMemberSortMode('number'), 'state');
  assert.equal(cycleMemberSortMode('state'), 'title');
  assert.equal(cycleMemberSortMode('title'), 'kind');
});

test('cycleFocusPane moves forward and backward', () => {
  assert.equal(cycleFocusPane('clusters', 1), 'members');
  assert.equal(cycleFocusPane('clusters', -1), 'detail');
});

test('formatRelativeTime returns compact human readable ages', () => {
  const now = new Date('2026-04-24T12:00:00Z');
  assert.equal(formatRelativeTime('2026-04-24T11:58:00Z', now), '2m ago');
  assert.equal(formatRelativeTime('2026-04-24T06:00:00Z', now), '6h ago');
  assert.equal(formatRelativeTime('2026-04-18T12:00:00Z', now), '6d ago');
  assert.equal(formatRelativeTime('2026-03-12T12:00:00Z', now), '43d ago');
  assert.equal(formatRelativeTime('2026-01-12T12:00:00Z', now), '3mo ago');
});

test('applyClusterFilters sorts by recent and size and respects min size/search', () => {
  const clusters: TuiClusterSummary[] = [
    {
      clusterId: 1,
      displayTitle: 'Older larger',
      isClosed: false,
      closedAtLocal: null,
      closeReasonLocal: null,
      totalCount: 12,
      issueCount: 10,
      pullRequestCount: 2,
      latestUpdatedAt: '2026-03-09T10:00:00Z',
      representativeThreadId: 10,
      representativeNumber: 42,
      representativeKind: 'issue',
      searchText: 'older larger cluster',
    },
    {
      clusterId: 2,
      displayTitle: 'Newest smaller',
      isClosed: false,
      closedAtLocal: null,
      closeReasonLocal: null,
      totalCount: 11,
      issueCount: 8,
      pullRequestCount: 3,
      latestUpdatedAt: '2026-03-09T11:00:00Z',
      representativeThreadId: 11,
      representativeNumber: 43,
      representativeKind: 'pull_request',
      searchText: 'newest smaller cluster',
    },
  ];

  assert.deepEqual(
    applyClusterFilters(clusters, { sortMode: 'recent', minSize: 10, search: '' }).map((cluster) => cluster.clusterId),
    [2, 1],
  );
  assert.deepEqual(
    applyClusterFilters(clusters, { sortMode: 'size', minSize: 10, search: '' }).map((cluster) => cluster.clusterId),
    [1, 2],
  );
  assert.deepEqual(
    applyClusterFilters(clusters, { sortMode: 'recent', minSize: 20, search: '' }),
    [],
  );
  assert.deepEqual(
    applyClusterFilters(clusters, { sortMode: 'recent', minSize: 0, search: 'newest' }).map((cluster) => cluster.clusterId),
    [2],
  );
});

test('preserveSelectedId keeps existing selection and falls back to first', () => {
  assert.equal(preserveSelectedId([10, 11], 11), 11);
  assert.equal(preserveSelectedId([10, 11], 99), 10);
  assert.equal(preserveSelectedId([], 99), null);
});

test('buildMemberRows groups issues and pull requests and selection skips headers', () => {
  const detail: TuiClusterDetail = {
    clusterId: 1,
    displayTitle: 'Cluster 1',
    isClosed: false,
    closedAtLocal: null,
    closeReasonLocal: null,
    totalCount: 2,
    issueCount: 1,
    pullRequestCount: 1,
    latestUpdatedAt: '2026-03-09T11:00:00Z',
    representativeThreadId: 10,
    representativeNumber: 42,
    representativeKind: 'issue',
    members: [
      {
        id: 10,
        number: 42,
        kind: 'issue',
        isClosed: false,
        title: 'Issue one',
        updatedAtGh: '2026-03-09T11:00:00Z',
        htmlUrl: 'https://example.com/42',
        labels: ['bug'],
        clusterScore: null,
      },
      {
        id: 11,
        number: 43,
        kind: 'pull_request',
        isClosed: true,
        title: '[Bug]: PR one',
        updatedAtGh: '2026-03-09T10:00:00Z',
        htmlUrl: 'https://example.com/43',
        labels: ['bug'],
        clusterScore: 0.92,
      },
    ],
  };

  const rows = buildMemberRows(detail);
  assert.equal(rows[0]?.selectable, false);
  assert.match(rows[0]?.label ?? '', /number\s+state\s+updated\s+title/);
  assert.match(rows[2]?.label ?? '', /#42\s+\{green-fg\}open\{\/green-fg\}\s+\d+d ago\s+Issue one/);
  assert.match(rows[4]?.label ?? '', /\{gray-fg\}closed\{\/gray-fg\}\s+\d+d ago\s+Bug: PR one/);
  assert.equal(findSelectableIndex(rows, 10), 2);
  assert.equal(moveSelectableIndex(rows, 2, 1), 4);
});

test('formatMemberListHeader aligns the member table columns', () => {
  assert.equal(formatMemberListHeader(), 'number  state  updated title');
  assert.equal(formatMemberListHeader('recent'), 'number  state  updated*title');
});

test('buildMemberRows can sort members by recent without group headers', () => {
  const detail: TuiClusterDetail = {
    clusterId: 1,
    displayTitle: 'Cluster 1',
    isClosed: false,
    closedAtLocal: null,
    closeReasonLocal: null,
    totalCount: 3,
    issueCount: 2,
    pullRequestCount: 1,
    latestUpdatedAt: '2026-03-09T11:00:00Z',
    representativeThreadId: 10,
    representativeNumber: 42,
    representativeKind: 'issue',
    members: [
      {
        id: 10,
        number: 42,
        kind: 'issue',
        isClosed: false,
        title: 'Issue one',
        updatedAtGh: '2026-03-09T09:00:00Z',
        htmlUrl: 'https://example.com/42',
        labels: [],
        clusterScore: null,
      },
      {
        id: 11,
        number: 43,
        kind: 'pull_request',
        isClosed: false,
        title: 'PR one',
        updatedAtGh: '2026-03-09T11:00:00Z',
        htmlUrl: 'https://example.com/43',
        labels: [],
        clusterScore: null,
      },
      {
        id: 12,
        number: 44,
        kind: 'issue',
        isClosed: true,
        title: 'Issue closed',
        updatedAtGh: '2026-03-09T10:00:00Z',
        htmlUrl: 'https://example.com/44',
        labels: [],
        clusterScore: null,
      },
    ],
  };

  const rows = buildMemberRows(detail, { sortMode: 'recent' });
  assert.equal(rows.length, 4);
  assert.match(rows[1]?.label ?? '', /#43/);
  assert.match(rows[2]?.label ?? '', /#44/);
  assert.match(rows[3]?.label ?? '', /#42/);
});

test('resolveMemberHeaderSortFromClick maps member header columns to sort modes', () => {
  assert.equal(resolveMemberHeaderSortFromClick(0, 'kind'), 'number');
  assert.equal(resolveMemberHeaderSortFromClick(8, 'kind'), 'state');
  assert.equal(resolveMemberHeaderSortFromClick(15, 'kind'), 'recent');
  assert.equal(resolveMemberHeaderSortFromClick(23, 'kind'), 'title');
  assert.equal(resolveMemberHeaderSortFromClick(23, 'title'), 'kind');
});
