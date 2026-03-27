import type { ClusterSummaryDto, RepoStatsDto, RepositoryDto } from '@ghcrawl/api-contract';

export type TriageAction = {
  action: 'review_duplicate_candidates' | 'investigate_growth' | 'stale_cluster';
  clusterId: number;
  displayTitle: string;
  reason: string;
};

export type TriageReport = {
  repository: RepositoryDto;
  generatedAt: string;
  stats: RepoStatsDto;
  topClusters: ClusterSummaryDto[];
  suggestedActions: TriageAction[];
};

export function generateSuggestedActions(clusters: ClusterSummaryDto[]): TriageAction[] {
  const actions: TriageAction[] = [];
  const now = new Date();

  for (const cluster of clusters) {
    if (cluster.totalCount >= 5 && cluster.pullRequestCount === 0) {
      actions.push({
        action: 'review_duplicate_candidates',
        clusterId: cluster.clusterId,
        displayTitle: cluster.displayTitle,
        reason: `${cluster.totalCount} clustered reports with similar content`,
      });
    }

    if (cluster.latestUpdatedAt && cluster.totalCount >= 6) {
      const lastUpdated = new Date(cluster.latestUpdatedAt);
      const daysSince = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince <= 7) {
        actions.push({
          action: 'investigate_growth',
          clusterId: cluster.clusterId,
          displayTitle: cluster.displayTitle,
          reason: `${cluster.totalCount} clustered items with activity in the last ${Math.max(0, Math.floor(daysSince))} days`,
        });
      }
    }

    if (cluster.latestUpdatedAt && cluster.totalCount >= 3) {
      const lastUpdated = new Date(cluster.latestUpdatedAt);
      const daysSince = (now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) {
        actions.push({
          action: 'stale_cluster',
          clusterId: cluster.clusterId,
          displayTitle: cluster.displayTitle,
          reason: `last updated ${Math.floor(daysSince)} days ago with ${cluster.totalCount} clustered items`,
        });
      }
    }
  }

  return actions;
}

export function formatTriageMarkdown(report: TriageReport): string {
  const lines: string[] = [];

  lines.push(`# Triage Report: ${report.repository.fullName}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);

  const lastSync = report.stats.lastGithubReconciliationAt ?? 'never';
  const lastEmbed = report.stats.lastEmbedRefreshAt ?? 'never';
  const lastCluster = report.stats.latestClusterRunFinishedAt ?? 'never';
  lines.push(`Data freshness: last sync ${lastSync}, last embed ${lastEmbed}, last cluster ${lastCluster}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Open issues: ${report.stats.openIssueCount} | Open PRs: ${report.stats.openPullRequestCount}`);
  lines.push(`- Clusters: ${report.topClusters.length} shown`);
  lines.push(`- Stale embeddings: ${report.stats.staleEmbedThreadCount} threads need re-embedding`);
  lines.push('');

  lines.push('## Top Clusters by Size');
  lines.push('');
  lines.push('| # | Cluster | Representative | Members | Issues | PRs | Last Updated |');
  lines.push('|---|---------|---------------|---------|--------|-----|-------------|');

  for (let index = 0; index < report.topClusters.length; index += 1) {
    const cluster = report.topClusters[index];
    const representative = cluster.representativeNumber
      ? `#${cluster.representativeNumber} (${cluster.representativeKind ?? 'unknown'})`
      : '-';
    const updatedAt = cluster.latestUpdatedAt ? cluster.latestUpdatedAt.split('T')[0] : '-';
    lines.push(
      `| ${index + 1} | ${cluster.displayTitle} | ${representative} | ${cluster.totalCount} | ${cluster.issueCount} | ${cluster.pullRequestCount} | ${updatedAt} |`,
    );
  }

  lines.push('');

  if (report.suggestedActions.length > 0) {
    lines.push('## Suggested Actions');
    lines.push('');

    for (const action of report.suggestedActions) {
      const prefix =
        action.action === 'review_duplicate_candidates'
          ? 'Review candidates in'
          : action.action === 'investigate_growth'
            ? 'Investigate'
            : 'Stale:';
      lines.push(`- **${prefix} Cluster ${action.clusterId}** - ${action.reason}: "${action.displayTitle}"`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
