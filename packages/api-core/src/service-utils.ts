import crypto from 'node:crypto';

import type { RepositoryDto, ThreadDto } from '@ghcrawl/api-contract';

import type { SyncRunStats, ThreadRow } from './service-types.js';

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function isEffectivelyClosed(row: { state: string; closed_at_local: string | null }): boolean {
  return row.state !== 'open' || row.closed_at_local !== null;
}

export function isClosedGitHubPayload(payload: Record<string, unknown>): boolean {
  const state = typeof payload.state === 'string' ? payload.state.toLowerCase() : null;
  if (state !== null && state !== 'open') return true;
  if (typeof payload.closed_at === 'string' && payload.closed_at.length > 0) return true;
  if (typeof payload.merged_at === 'string' && payload.merged_at.length > 0) return true;
  return false;
}

export function isMissingGitHubResourceError(error: unknown): boolean {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? Number((error as { status?: unknown }).status) : null;
  if (status === 404 || status === 410) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(404|410)\b/.test(message) || /Not Found|Gone/i.test(message);
}

export function deriveIncrementalSince(referenceAt: string, crawlStartedAt: string): string {
  const referenceMs = parseIso(referenceAt) ?? Date.now();
  const crawlMs = parseIso(crawlStartedAt) ?? Date.now();
  const gapMs = Math.max(0, crawlMs - referenceMs);
  const hourMs = 60 * 60 * 1000;
  const roundedHours = Math.max(2, Math.ceil(gapMs / hourMs));
  return new Date(crawlMs - roundedHours * hourMs).toISOString();
}

export function parseSyncRunStats(statsJson: string | null): SyncRunStats | null {
  if (!statsJson) return null;
  try {
    const parsed = JSON.parse(statsJson) as Partial<SyncRunStats>;
    if (typeof parsed.crawlStartedAt !== 'string') {
      return null;
    }
    return {
      threadsSynced: typeof parsed.threadsSynced === 'number' ? parsed.threadsSynced : 0,
      commentsSynced: typeof parsed.commentsSynced === 'number' ? parsed.commentsSynced : 0,
      threadsClosed: typeof parsed.threadsClosed === 'number' ? parsed.threadsClosed : 0,
      crawlStartedAt: parsed.crawlStartedAt,
      requestedSince: typeof parsed.requestedSince === 'string' ? parsed.requestedSince : null,
      effectiveSince: typeof parsed.effectiveSince === 'string' ? parsed.effectiveSince : null,
      limit: typeof parsed.limit === 'number' ? parsed.limit : null,
      includeComments: parsed.includeComments === true,
      codeFilesSynced: typeof parsed.codeFilesSynced === 'number' ? parsed.codeFilesSynced : 0,
      includeCode: parsed.includeCode === true,
      isFullOpenScan: parsed.isFullOpenScan === true,
      isOverlappingOpenScan: parsed.isOverlappingOpenScan === true,
      overlapReferenceAt: typeof parsed.overlapReferenceAt === 'string' ? parsed.overlapReferenceAt : null,
      reconciledOpenCloseAt: typeof parsed.reconciledOpenCloseAt === 'string' ? parsed.reconciledOpenCloseAt : null,
    };
  } catch {
    return null;
  }
}

export function asJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseArray(value: string): string[] {
  return JSON.parse(value) as string[];
}

export function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function parseObjectJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function userLogin(payload: Record<string, unknown>): string | null {
  const user = payload.user as Record<string, unknown> | undefined;
  const login = user?.login;
  return typeof login === 'string' ? login : null;
}

export function userType(payload: Record<string, unknown>): string | null {
  const user = payload.user as Record<string, unknown> | undefined;
  const type = user?.type;
  return typeof type === 'string' ? type : null;
}

export function isPullRequestPayload(payload: Record<string, unknown>): boolean {
  return Boolean(payload.pull_request);
}

export function parseLabels(payload: Record<string, unknown>): string[] {
  const labels = payload.labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (label && typeof label === 'object' && typeof (label as Record<string, unknown>).name === 'string') {
        return String((label as Record<string, unknown>).name);
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

export function parseAssignees(payload: Record<string, unknown>): string[] {
  const assignees = payload.assignees;
  if (!Array.isArray(assignees)) return [];
  return assignees
    .map((assignee) => {
      if (assignee && typeof assignee === 'object' && typeof (assignee as Record<string, unknown>).login === 'string') {
        return String((assignee as Record<string, unknown>).login);
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

export function stableContentHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function normalizeSummaryText(value: string): string {
  return value.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
}

export function normalizeKeySummaryDisplayText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

export function snippetText(value: string | null | undefined, maxChars: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function repositoryToDto(row: Record<string, unknown>): RepositoryDto {
  return {
    id: Number(row.id),
    owner: String(row.owner),
    name: String(row.name),
    fullName: String(row.full_name),
    githubRepoId: row.github_repo_id === null ? null : String(row.github_repo_id),
    updatedAt: String(row.updated_at),
  };
}

export function threadToDto(row: ThreadRow, clusterId?: number | null): ThreadDto {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    isClosed: isEffectivelyClosed(row),
    closedAtGh: row.closed_at_gh ?? null,
    closedAtLocal: row.closed_at_local ?? null,
    closeReasonLocal: row.close_reason_local ?? null,
    title: row.title,
    body: row.body,
    authorLogin: row.author_login,
    htmlUrl: row.html_url,
    labels: parseArray(row.labels_json),
    updatedAtGh: row.updated_at_gh,
    clusterId: clusterId ?? null,
  };
}
