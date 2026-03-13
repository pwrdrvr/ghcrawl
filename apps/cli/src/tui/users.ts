import type { GHCrawlService, RepoUserExplorerMode } from '@ghcrawl/api-core';

export type RepoUsersPayload = ReturnType<GHCrawlService['listRepoUsers']>;
export type RepoUserDetailPayload = ReturnType<GHCrawlService['getRepoUserDetail']>;

export type UserListRow = {
  login: string;
  label: string;
};

export type UserThreadRow =
  | { key: string; label: string; selectable: false }
  | { key: string; label: string; selectable: true; threadId: number };

export function buildRepoUserListRows(response: RepoUsersPayload): UserListRow[] {
  return response.users.map((user) => {
    const badges = [
      user.reputationTier.toUpperCase(),
      user.likelyHiddenActivity ? 'HIDDEN?' : null,
      user.isStale ? 'STALE' : null,
      user.lastRefreshError ? 'ERR' : null,
    ]
      .filter((value): value is string => value !== null)
      .join(' ');

    const countLead =
      response.mode === 'trusted_prs'
        ? `${String(user.waitingPullRequestCount).padStart(2, ' ')} waiting`
        : `${String(user.openIssueCount).padStart(2, ' ')}I ${String(user.openPullRequestCount).padStart(2, ' ')}P`;

    return {
      login: user.login,
      label: `${countLead}  @${escapeUserText(user.login)}  ${escapeUserText(badges || 'UNCLASSIFIED')}`,
    };
  });
}

export function buildRepoUserThreadRows(detail: RepoUserDetailPayload | null, mode: RepoUserExplorerMode): UserThreadRow[] {
  if (!detail) return [];
  const rows: UserThreadRow[] = [];
  const issueRows = detail.issues;
  const pullRequestRows = detail.pullRequests;
  const firstSection = mode === 'trusted_prs' ? pullRequestRows : issueRows;
  const secondSection = mode === 'trusted_prs' ? issueRows : pullRequestRows;
  const firstLabel = mode === 'trusted_prs' ? `PULL REQUESTS (${pullRequestRows.length})` : `ISSUES (${issueRows.length})`;
  const secondLabel = mode === 'trusted_prs' ? `ISSUES (${issueRows.length})` : `PULL REQUESTS (${pullRequestRows.length})`;

  pushThreadSection(rows, firstLabel, firstSection);
  pushThreadSection(rows, secondLabel, secondSection);
  return rows;
}

export function renderRepoUserDetail(detail: RepoUserDetailPayload | null, selectedThreadId: number | null): string {
  if (!detail) {
    return 'No user selected.\n\nUse the left pane to choose a contributor.';
  }

  const selected =
    detail.issues.find((thread) => thread.threadId === selectedThreadId) ??
    detail.pullRequests.find((thread) => thread.threadId === selectedThreadId) ??
    null;
  const profile = detail.profile;
  const metrics = [
    `public repos: ${profile.publicRepoCount ?? 'unknown'}`,
    `followers: ${profile.followers ?? 'unknown'}`,
    `events: ${profile.recentPublicEventCount ?? 'unknown'}`,
  ].join('  ');
  const badges = [
    profile.reputationTier.toUpperCase(),
    profile.likelyHiddenActivity ? 'likely hidden/sparse public activity' : null,
    profile.isStale ? 'stale cache' : null,
    profile.lastRefreshError ? `refresh error: ${profile.lastRefreshError}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join('\n');
  const selectedText = selected
    ? [
        '',
        `{bold}${selected.kind === 'pull_request' ? 'PR' : 'Issue'} #${selected.number}{/bold}  ${escapeUserText(selected.title)}`,
        `{bold}State:{/bold} ${escapeUserText(selected.state)}${selected.isDraft ? ' (draft)' : ''}`,
        `{bold}Age:{/bold} ${selected.ageDays ?? 'unknown'}d`,
        `{bold}Size:{/bold} ${selected.filesChanged ?? 'n/a'} files  +${selected.additions ?? 'n/a'} / -${selected.deletions ?? 'n/a'}`,
        `{bold}URL:{/bold} ${escapeUserText(selected.htmlUrl)}`,
      ].join('\n')
    : '\n\nSelect an issue or PR in the middle pane for more detail.';

  return [
    `{bold}@${escapeUserText(profile.login)}{/bold}`,
    '',
    badges || 'No profile flags.',
    '',
    `{bold}Profile{/bold}`,
    metrics,
    `{bold}Account age:{/bold} ${profile.accountAgeDays ?? 'unknown'}d`,
    `{bold}Last refresh:{/bold} ${escapeUserText(profile.lastGlobalRefreshAt ?? 'never')}`,
    `{bold}First seen in repo:{/bold} ${escapeUserText(profile.firstSeenAt ?? 'unknown')}`,
    '',
    `{bold}Reasons{/bold}`,
    profile.reasons.length > 0 ? escapeUserText(profile.reasons.join('; ')) : 'No reasons available.',
    selectedText,
  ].join('\n');
}

export function describeRepoUserMode(mode: RepoUserExplorerMode): string {
  return mode === 'trusted_prs' ? 'Trusted PRs' : 'Flagged contributors';
}

function pushThreadSection(rows: UserThreadRow[], label: string, items: RepoUserDetailPayload['issues']): void {
  if (items.length === 0) return;
  rows.push({ key: `${label}-header`, label, selectable: false });
  for (const item of items) {
    const hasKnownSize =
      item.kind === 'pull_request' &&
      (item.filesChanged !== null || item.additions !== null || item.deletions !== null);
    const size = hasKnownSize
      ? `  ${String(item.filesChanged ?? 0).padStart(2, ' ')}f +${String(item.additions ?? 0).padStart(4, ' ')} -${String(item.deletions ?? 0).padStart(4, ' ')}`
      : '';
    rows.push({
      key: `thread-${item.threadId}`,
      label: `#${item.number}  ${String(item.ageDays ?? 0).padStart(3, ' ')}d${size}  ${escapeUserText(item.title)}`,
      selectable: true,
      threadId: item.threadId,
    });
  }
}

function escapeUserText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}
