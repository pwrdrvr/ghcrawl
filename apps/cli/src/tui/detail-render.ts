import type { TuiClusterDetail, TuiClusterSummary, TuiSnapshot, TuiThreadDetail } from '@ghcrawl/api-core';

import { formatRelativeTime, type TuiFocusPane } from './state.js';
import { splitClusterDisplayTitle } from './cluster-render.js';

export type ThreadContextAction =
  | 'open'
  | 'copy-url'
  | 'copy-title'
  | 'copy-markdown-link'
  | 'open-first-link'
  | 'copy-first-link'
  | 'open-link-picker'
  | 'copy-link-picker'
  | 'load-neighbors'
  | 'close';

export type ThreadContextMenuItem = {
  label: string;
  action: ThreadContextAction;
};

export type DetailMode = 'full' | 'compact';

export function renderDetailPane(
  threadDetail: TuiThreadDetail | null,
  clusterDetail: TuiClusterDetail | null,
  focusPane: TuiFocusPane,
  snapshot?: TuiSnapshot | null,
  detailMode: DetailMode = 'full',
): string {
  if (!clusterDetail) {
    const repoLabel = snapshot?.repository.fullName ?? 'No repository selected';
    const clusterCount = snapshot?.clusters.length ?? 0;
    return [
      `{bold}${escapeBlessedText(repoLabel)}{/bold}`,
      '',
      clusterCount > 0 ? `${clusterCount} clusters loaded. Click a cluster or press Enter to inspect members.` : 'No clusters visible in this view.',
      '',
      `{bold}Controls{/bold}`,
      's sort  f min size  / filter  x closed  r refresh',
      'right-click any pane for actions',
    ].join('\n');
  }
  const clusterTitle = splitClusterDisplayTitle(clusterDetail.displayTitle);
  if (!threadDetail) {
    const representativeLabel =
      clusterDetail.representativeNumber !== null && clusterDetail.representativeKind !== null
        ? ` (#${clusterDetail.representativeNumber} representative ${clusterDetail.representativeKind === 'pull_request' ? 'pr' : 'issue'})`
        : '';
    return [
      `{bold}Cluster ${clusterDetail.clusterId}${escapeBlessedText(representativeLabel)}{/bold}`,
      `{cyan-fg}${escapeBlessedText(clusterTitle.name)}{/cyan-fg}`,
      escapeBlessedText(clusterTitle.title),
      '',
      'Select a member to inspect thread details.',
    ].join('\n');
  }

  const thread = threadDetail.thread;
  const representativeLabel =
    clusterDetail.representativeNumber !== null && clusterDetail.representativeKind !== null
      ? ` (#${clusterDetail.representativeNumber} representative ${clusterDetail.representativeKind === 'pull_request' ? 'pr' : 'issue'})`
      : '';
  const labels = thread.labels.length > 0 ? thread.labels.map((label) => `{cyan-fg}${escapeBlessedText(label)}{/cyan-fg}`).join(' ') : 'none';
  const closedLabel = thread.isClosed
    ? `{bold}Closed:{/bold} ${escapeBlessedText(thread.closedAtLocal ?? thread.closedAtGh ?? 'yes')} ${thread.closeReasonLocal ? `(${escapeBlessedText(thread.closeReasonLocal)})` : ''}`.trimEnd()
    : '{bold}Closed:{/bold} no';
  const summaryBlock = renderThreadSummaryBlock(threadDetail);
  const topFiles = renderTopFiles(threadDetail.topFiles);
  const neighbors =
    threadDetail.neighbors.length > 0
      ? threadDetail.neighbors
          .map((neighbor) => `#${neighbor.number} ${neighbor.kind} ${(neighbor.score * 100).toFixed(1)}%  ${escapeBlessedText(neighbor.title)}`)
          .join('\n')
      : focusPane === 'detail'
        ? 'No neighbors available.'
        : 'Neighbors load when the detail pane is focused.';
  const body = limitRenderedLines(renderMarkdownForTerminal(thread.body ?? '(no body)'), detailMode === 'compact' ? 18 : 240);
  const referenceLinks = getThreadReferenceLinks(threadDetail);
  const linksSection =
    referenceLinks.length > 0 ? `\n\n{bold}Links{/bold}\n${referenceLinks.map((url, index) => `${index + 1}. ${escapeBlessedText(url)}`).join('\n')}` : '';
  return [
    `{bold}${thread.kind === 'pull_request' ? 'PR' : 'Issue'} #${thread.number}{/bold}  ${escapeBlessedText(thread.title)}`,
    `{cyan-fg}${escapeBlessedText(clusterTitle.name)}{/cyan-fg}  C${clusterDetail.clusterId}${escapeBlessedText(representativeLabel)}`,
    '{gray-fg}' + '-'.repeat(72) + '{/gray-fg}',
    summaryBlock ? `{bold}LLM Summary{/bold}\n${summaryBlock}` : '',
    summaryBlock ? '{gray-fg}' + '-'.repeat(72) + '{/gray-fg}' : '',
    `${closedLabel}  {bold}Updated:{/bold} ${escapeBlessedText(formatRelativeTime(thread.updatedAtGh))}  {bold}Author:{/bold} ${escapeBlessedText(thread.authorLogin ?? 'unknown')}`,
    `{bold}Labels:{/bold} ${labels}`,
    `{bold}URL:{/bold} ${formatTerminalLink(thread.htmlUrl, thread.htmlUrl)}`,
    topFiles ? `\n{bold}Top files{/bold}\n${topFiles}` : '',
    '',
    '{gray-fg}' + '-'.repeat(72) + '{/gray-fg}',
    `{bold}Main Preview{/bold}`,
    body,
    linksSection,
    `\n\n{bold}Neighbors{/bold}\n${neighbors}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function escapeBlessedText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

export function renderMarkdownForTerminal(markdown: string): string {
  let inFence = false;
  const rendered = markdown.split(/\r?\n/).map((line) => {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      return '{gray-fg}--- code ---{/gray-fg}';
    }
    if (inFence) {
      return `{gray-fg}${escapeBlessedText(line)}{/gray-fg}`;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      return `{bold}${escapeBlessedText(heading[2] ?? '')}{/bold}`;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      return `{gray-fg}> ${renderInlineMarkdown(quote[1] ?? '')}{/gray-fg}`;
    }
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      const indent = listItem[1] ?? '';
      return `${indent}- ${renderInlineMarkdown(listItem[3] ?? '')}`;
    }
    return renderInlineMarkdown(line);
  });
  return rendered.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd();
}

export function limitRenderedLines(value: string, maxLines: number): string {
  const lines = value.split('\n');
  if (lines.length <= maxLines) {
    return value;
  }
  const omitted = lines.length - maxLines;
  return `${lines.slice(0, maxLines).join('\n')}\n{gray-fg}... ${omitted} more line(s). Use full detail or copy body to inspect all content.{/gray-fg}`;
}

export function getThreadReferenceLinks(threadDetail: TuiThreadDetail | null): string[] {
  if (!threadDetail) return [];
  return uniqueStrings([
    ...extractMarkdownLinks(threadDetail.thread.body ?? ''),
    ...Object.values(threadDetail.summaries).flatMap((summary) => extractMarkdownLinks(summary ?? '')),
  ]).filter((url) => url !== threadDetail.thread.htmlUrl);
}

export function formatLinkChoiceLabel(url: string, index: number): string {
  return `${String(index + 1).padStart(2)}  ${url}`;
}

export function renderSummarySections(summaries: TuiThreadDetail['summaries']): string {
  return SUMMARY_SECTION_ORDER.flatMap((key) => {
    const value = summaries[key];
    if (!value) return [];
    return [`{bold}${formatSummaryLabel(key)}:{/bold}\n${renderMarkdownForTerminal(value)}`];
  }).join('\n\n');
}

export function renderThreadSummaryBlock(threadDetail: TuiThreadDetail): string {
  const sections = [
    threadDetail.keySummary
      ? `{bold}Key summary{/bold} {gray-fg}${escapeBlessedText(threadDetail.keySummary.model)}{/gray-fg}\n${renderMarkdownForTerminal(threadDetail.keySummary.text)}`
      : '',
    renderSummarySections(threadDetail.summaries),
  ];
  return sections.filter((section) => section.trim()).join('\n\n');
}

export function renderTopFiles(files: TuiThreadDetail['topFiles']): string {
  if (files.length === 0) return '';
  return files
    .slice(0, 5)
    .map((file) => {
      const churn = file.additions + file.deletions;
      const status = file.status ? `${file.status} ` : '';
      return `- ${escapeBlessedText(file.path)}  {gray-fg}${escapeBlessedText(status)}+${file.additions}/-${file.deletions} (${churn}){/gray-fg}`;
    })
    .join('\n');
}

export function formatSummariesForClipboard(summaries: TuiThreadDetail['summaries']): string {
  return SUMMARY_SECTION_ORDER.flatMap((key) => {
    const value = summaries[key];
    if (!value) return [];
    return [`${formatSummaryLabel(key)}:\n${value}`];
  }).join('\n\n');
}

export function formatThreadDetailForClipboard(threadDetail: TuiThreadDetail, clusterDetail: TuiClusterDetail | null): string {
  const thread = threadDetail.thread;
  const clusterTitle = clusterDetail ? splitClusterDisplayTitle(clusterDetail.displayTitle) : null;
  const sections = [
    `${thread.kind === 'pull_request' ? 'PR' : 'Issue'} #${thread.number}: ${thread.title}`,
    clusterDetail && clusterTitle ? `Cluster ${clusterDetail.clusterId}: ${clusterTitle.name} | ${clusterTitle.title}` : '',
    `State: ${thread.isClosed ? 'closed' : 'open'}`,
    `Updated: ${thread.updatedAtGh ?? 'unknown'}`,
    `Author: ${thread.authorLogin ?? 'unknown'}`,
    `Labels: ${thread.labels.join(', ') || 'none'}`,
    `URL: ${thread.htmlUrl}`,
    threadDetail.keySummary ? `Key summary (${threadDetail.keySummary.model}):\n${threadDetail.keySummary.text}` : '',
    formatSummariesForClipboard(threadDetail.summaries) ? `LLM Summary:\n${formatSummariesForClipboard(threadDetail.summaries)}` : '',
    threadDetail.topFiles.length > 0 ? `Top files:\n${formatTopFilesForClipboard(threadDetail.topFiles)}` : '',
    `Body:\n${thread.body ?? ''}`,
    getThreadReferenceLinks(threadDetail).length > 0 ? `Links:\n${getThreadReferenceLinks(threadDetail).join('\n')}` : '',
  ];
  return sections.filter((section) => section.trim()).join('\n\n');
}

export function formatClusterForClipboard(cluster: TuiClusterDetail): string {
  const title = splitClusterDisplayTitle(cluster.displayTitle);
  return [
    `Cluster ${cluster.clusterId}`,
    `Name: ${title.name}`,
    `Title: ${title.title}`,
    `State: ${cluster.isClosed ? 'closed' : 'open'}`,
    `Members: ${cluster.totalCount} (${cluster.issueCount} issues, ${cluster.pullRequestCount} PRs)`,
    `Updated: ${cluster.latestUpdatedAt ?? 'unknown'}`,
    cluster.representativeNumber !== null ? `Representative: #${cluster.representativeNumber} ${cluster.representativeKind ?? ''}`.trimEnd() : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatClusterMembersForClipboard(cluster: TuiClusterDetail): string {
  return cluster.members
    .map((member) => {
      const state = member.isClosed ? 'closed' : 'open';
      const kind = member.kind === 'pull_request' ? 'PR' : 'Issue';
      return `${kind} #${member.number} [${state}] ${member.title} ${member.htmlUrl}`;
    })
    .join('\n');
}

export function formatVisibleClustersForClipboard(clusters: TuiClusterSummary[]): string {
  return clusters
    .map((cluster) => {
      const title = splitClusterDisplayTitle(cluster.displayTitle);
      const state = cluster.isClosed ? 'closed' : 'open';
      return `C${cluster.clusterId} [${state}] ${cluster.totalCount} items ${title.name} | ${title.title}`;
    })
    .join('\n');
}

export function buildThreadContextMenuItems(threadDetail: TuiThreadDetail | null): ThreadContextMenuItem[] {
  if (!threadDetail) {
    return [{ label: 'Close', action: 'close' }];
  }
  const referenceLinks = getThreadReferenceLinks(threadDetail);
  return [
    { label: 'Open in browser', action: 'open' },
    { label: 'Copy URL', action: 'copy-url' },
    { label: 'Copy title', action: 'copy-title' },
    { label: 'Copy Markdown link', action: 'copy-markdown-link' },
    ...(referenceLinks.length > 0
      ? [
          { label: 'Open first body link', action: 'open-first-link' as const },
          { label: 'Copy first body link', action: 'copy-first-link' as const },
          ...(referenceLinks.length > 1
            ? [
                { label: 'Open body link...', action: 'open-link-picker' as const },
                { label: 'Copy body link...', action: 'copy-link-picker' as const },
              ]
            : []),
        ]
      : []),
    { label: 'Load neighbors', action: 'load-neighbors' },
    { label: 'Close', action: 'close' },
  ];
}

function extractMarkdownLinks(markdown: string): string[] {
  const urls: string[] = [];
  for (const match of markdown.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)) {
    urls.push(stripTrailingUrlPunctuation(match[1] ?? ''));
  }
  for (const match of markdown.matchAll(/(^|[\s(<])(https?:\/\/[^\s<>)]+)/g)) {
    urls.push(stripTrailingUrlPunctuation(match[2] ?? ''));
  }
  return urls.filter(Boolean);
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/g, '');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

type SummaryKey = NonNullable<keyof TuiThreadDetail['summaries']>;

const SUMMARY_SECTION_ORDER: SummaryKey[] = ['problem_summary', 'solution_summary', 'maintainer_signal_summary', 'dedupe_summary'];

function formatSummaryLabel(key: SummaryKey): string {
  if (key === 'problem_summary') return 'Purpose';
  if (key === 'solution_summary') return 'Solution';
  if (key === 'maintainer_signal_summary') return 'Maintainer signal';
  return 'Cluster signal';
}

function formatTopFilesForClipboard(files: TuiThreadDetail['topFiles']): string {
  return files
    .slice(0, 5)
    .map((file) => `${file.path} ${file.status ? `${file.status} ` : ''}+${file.additions}/-${file.deletions}`)
    .join('\n');
}

type InlineMarkdownSegment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; label: string; url: string };

function renderInlineMarkdown(value: string): string {
  const segments: InlineMarkdownSegment[] = [];
  const markdownLinkPattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let cursor = 0;

  for (const match of value.matchAll(markdownLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      pushBareLinkSegments(value.slice(cursor, index), segments);
    }
    segments.push({ kind: 'link', label: match[1] ?? '', url: match[2] ?? '' });
    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    pushBareLinkSegments(value.slice(cursor), segments);
  }

  return segments.map((segment) => (segment.kind === 'link' ? formatTerminalLink(segment.url, segment.label) : renderInlineText(segment.value))).join('');
}

function pushBareLinkSegments(value: string, segments: InlineMarkdownSegment[]): void {
  const bareLinkPattern = /https?:\/\/[^\s)]+/g;
  let cursor = 0;
  for (const match of value.matchAll(bareLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ kind: 'text', value: value.slice(cursor, index) });
    }
    const url = match[0];
    segments.push({ kind: 'link', label: url, url });
    cursor = index + url.length;
  }
  if (cursor < value.length) {
    segments.push({ kind: 'text', value: value.slice(cursor) });
  }
}

function renderInlineText(value: string): string {
  return escapeBlessedText(value)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '{bold}$1{/bold}');
}

function formatTerminalLink(url: string, label: string): string {
  const safeUrl = stripTerminalControls(url);
  const safeLabel = stripTerminalControls(label);
  const visibleLink = safeLabel && safeLabel !== safeUrl ? `${safeLabel} <${safeUrl}>` : safeUrl;
  return escapeBlessedText(visibleLink);
}

function stripTerminalControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}
