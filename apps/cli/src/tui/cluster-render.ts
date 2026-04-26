import type { TuiClusterSortMode, TuiClusterSummary } from '@ghcrawl/api-core';

import { cycleSortMode, formatRelativeTime } from './state.js';

const CLUSTER_COUNT_WIDTH = 3;
const CLUSTER_NAME_WIDTH = 22;
const CLUSTER_TITLE_WIDTH = 56;
const CLUSTER_MIX_WIDTH = 7;
const CLUSTER_UPDATED_WIDTH = 8;
const CLUSTER_COLUMN_GAP = 2;
const CLUSTER_NAME_START = CLUSTER_COUNT_WIDTH + CLUSTER_COLUMN_GAP;
const CLUSTER_TITLE_START = CLUSTER_NAME_START + CLUSTER_NAME_WIDTH + CLUSTER_COLUMN_GAP;
const CLUSTER_MIX_START = CLUSTER_TITLE_START + CLUSTER_TITLE_WIDTH + CLUSTER_COLUMN_GAP;
const CLUSTER_UPDATED_START = CLUSTER_MIX_START + CLUSTER_MIX_WIDTH + CLUSTER_COLUMN_GAP;

export function splitClusterDisplayTitle(displayTitle: string): { name: string; title: string } {
  const match = displayTitle.match(/^([a-z]+(?:-[a-z]+){2})\s{2,}(.+)$/);
  if (match) {
    return { name: match[1] ?? 'cluster', title: match[2] ?? displayTitle };
  }
  return { name: formatClusterShortName(displayTitle), title: displayTitle || 'Untitled cluster' };
}

export function formatClusterListLabel(cluster: TuiClusterSummary): string {
  const countLabel = String(cluster.totalCount).padStart(CLUSTER_COUNT_WIDTH);
  const mixLabel = `${cluster.issueCount}I/${cluster.pullRequestCount}P`.padStart(CLUSTER_MIX_WIDTH);
  const updated = formatRelativeTime(cluster.latestUpdatedAt).padStart(CLUSTER_UPDATED_WIDTH);
  const title = splitClusterDisplayTitle(cluster.displayTitle);
  return [
    countLabel,
    title.name.padEnd(CLUSTER_NAME_WIDTH).slice(0, CLUSTER_NAME_WIDTH),
    title.title.padEnd(CLUSTER_TITLE_WIDTH).slice(0, CLUSTER_TITLE_WIDTH),
    mixLabel,
    updated,
  ].join('  ');
}

export function formatClusterListHeader(sortMode: TuiClusterSortMode): string {
  const countLabel = (sortMode === 'size' ? 'cnt*' : 'cnt').padStart(CLUSTER_COUNT_WIDTH);
  const updated = (sortMode === 'recent' ? 'updated*' : 'updated').padStart(CLUSTER_UPDATED_WIDTH);
  return [
    countLabel,
    'cluster'.padEnd(CLUSTER_NAME_WIDTH),
    'title'.padEnd(CLUSTER_TITLE_WIDTH),
    'mix'.padStart(CLUSTER_MIX_WIDTH),
    updated,
  ].join('  ');
}

export function resolveClusterHeaderSortFromClick(
  relativeX: number,
  visibleWidth: number,
  currentSortMode: TuiClusterSortMode,
): TuiClusterSortMode {
  if (relativeX < CLUSTER_NAME_START) {
    return 'size';
  }

  const visibleUpdatedStart = Math.min(CLUSTER_UPDATED_START, Math.max(CLUSTER_NAME_START, visibleWidth - CLUSTER_UPDATED_WIDTH - CLUSTER_COLUMN_GAP));
  if (relativeX >= visibleUpdatedStart) {
    return 'recent';
  }

  return cycleSortMode(currentSortMode);
}

export function formatClusterShortName(title: string, maxWords = 3): string {
  const words = title
    .replace(/[\[\]{}()<>]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .map((word) => word.replace(/^[:/#-]+|[:/#-]+$/g, ''))
    .filter((word) => word && !CLUSTER_SHORT_NAME_STOPWORDS.has(word.toLowerCase()))
    .slice(0, maxWords);
  return words.join(' ') || 'untitled';
}

export function formatClusterDateColumn(value: string | null, locales?: Intl.LocalesArgument): string {
  if (!value) return 'unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  const hour = String(parsed.getHours()).padStart(2, '0');
  const minute = String(parsed.getMinutes()).padStart(2, '0');
  const ordering = new Intl.DateTimeFormat(locales, {
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(parsed)
    .filter((part) => part.type === 'month' || part.type === 'day')
    .map((part) => part.type);
  const date = ordering[0] === 'day' ? `${day}-${month}` : `${month}-${day}`;

  return `${date} ${hour}:${minute}`;
}

const CLUSTER_SHORT_NAME_STOPWORDS = new Set([
  'ai',
  'assisted',
  'bug',
  'chore',
  'codex',
  'docs',
  'feat',
  'feature',
  'fix',
  'issue',
  'pr',
  'refactor',
  'test',
]);
