import type { SqliteDatabase } from '../db/sqlite.js';
import type { GitHubClient, GitHubReporter } from '../github/client.js';
import { STALE_CLOSED_SWEEP_LIMIT, SYNC_BATCH_DELAY_MS, SYNC_BATCH_SIZE } from '../service-constants.js';
import { asJson, isMissingGitHubResourceError, nowIso } from '../service-utils.js';

type StaleThreadRow = {
  id: number;
  number: number;
  kind: 'issue' | 'pull_request';
};

export async function applyClosedOverlapSweep(params: {
  db: SqliteDatabase;
  github: GitHubClient;
  repoId: number;
  owner: string;
  repo: string;
  crawlStartedAt: string;
  closedSweepSince?: string;
  closedSweepLimit?: number;
  sweepLabel?: string;
  reporter?: GitHubReporter;
  onProgress?: (message: string) => void;
}): Promise<number> {
  const staleRows = params.db
    .prepare(
      `select id, number, kind
       from threads
       where repo_id = ?
         and state = 'open'
         and closed_at_local is null
         and (last_pulled_at is null or last_pulled_at < ?)
       order by number asc`,
    )
    .all(params.repoId, params.crawlStartedAt) as StaleThreadRow[];

  if (staleRows.length === 0) {
    return 0;
  }

  const sweepLabel = params.sweepLabel ?? 'recent closed sweep';
  const sweepWindow = params.closedSweepSince
    ? `since ${params.closedSweepSince}`
    : `from the latest ${params.closedSweepLimit ?? STALE_CLOSED_SWEEP_LIMIT} closed items`;
  params.onProgress?.(`[sync] ${sweepLabel}: scanning ${staleRows.length} unseen previously-open thread(s) against closed items ${sweepWindow}`);

  const staleByNumber = new Map<number, StaleThreadRow>(staleRows.map((row) => [row.number, row]));
  const recentlyClosed = await params.github.listRepositoryIssues(
    params.owner,
    params.repo,
    params.closedSweepSince,
    params.closedSweepLimit ?? STALE_CLOSED_SWEEP_LIMIT,
    params.reporter,
    'closed',
  );

  let threadsClosed = 0;
  for (const payload of recentlyClosed) {
    const number = Number(payload.number);
    const staleRow = staleByNumber.get(number);
    if (!staleRow) continue;
    const state = String(payload.state ?? 'closed');
    if (state === 'open') continue;
    const pulledAt = nowIso();
    params.db
      .prepare(
        `update threads
         set state = ?,
             raw_json = ?,
             updated_at_gh = ?,
             closed_at_gh = ?,
             merged_at_gh = ?,
             last_pulled_at = ?,
             updated_at = ?
         where id = ?`,
      )
      .run(
        state,
        asJson(payload),
        typeof payload.updated_at === 'string' ? payload.updated_at : null,
        typeof payload.closed_at === 'string' ? payload.closed_at : null,
        typeof payload.merged_at === 'string' ? payload.merged_at : null,
        pulledAt,
        pulledAt,
        staleRow.id,
      );
    staleByNumber.delete(number);
    threadsClosed += 1;
  }

  params.onProgress?.(`[sync] ${sweepLabel} matched ${threadsClosed} stale thread(s); ${staleByNumber.size} remain open locally`);

  return threadsClosed;
}

export function countStaleOpenThreads(db: SqliteDatabase, repoId: number, crawlStartedAt: string): number {
  const row = db
    .prepare(
      `select count(*) as count
       from threads
       where repo_id = ?
         and state = 'open'
         and closed_at_local is null
         and (last_pulled_at is null or last_pulled_at < ?)`,
    )
    .get(repoId, crawlStartedAt) as { count: number };
  return row.count;
}

export async function reconcileMissingOpenThreads(params: {
  db: SqliteDatabase;
  github: GitHubClient;
  repoId: number;
  owner: string;
  repo: string;
  crawlStartedAt: string;
  reporter?: GitHubReporter;
  onProgress?: (message: string) => void;
}): Promise<number> {
  const staleRows = params.db
    .prepare(
      `select id, number, kind
       from threads
       where repo_id = ?
         and state = 'open'
         and closed_at_local is null
         and (last_pulled_at is null or last_pulled_at < ?)
       order by number asc`,
    )
    .all(params.repoId, params.crawlStartedAt) as StaleThreadRow[];

  if (staleRows.length === 0) {
    return 0;
  }

  params.onProgress?.(
    `[sync] full reconciliation requested; directly checking ${staleRows.length} previously-open thread(s) not seen in the open crawl`,
  );

  let threadsClosed = 0;
  for (const [index, row] of staleRows.entries()) {
    if (index > 0 && index % SYNC_BATCH_SIZE === 0) {
      params.onProgress?.(`[sync] stale reconciliation batch boundary reached at ${index} threads; sleeping 5s before continuing`);
      await new Promise((resolve) => setTimeout(resolve, SYNC_BATCH_DELAY_MS));
    }
    params.onProgress?.(`[sync] reconciling stale ${row.kind} #${row.number}`);
    const pulledAt = nowIso();
    let payload: Record<string, unknown> | null = null;
    let state = 'closed';

    try {
      payload =
        row.kind === 'pull_request'
          ? await params.github.getPull(params.owner, params.repo, row.number, params.reporter)
          : await params.github.getIssue(params.owner, params.repo, row.number, params.reporter);
      state = String(payload.state ?? 'open');
    } catch (error) {
      if (!isMissingGitHubResourceError(error)) {
        throw error;
      }
      params.onProgress?.(
        `[sync] stale ${row.kind} #${row.number} is missing on GitHub; marking it closed locally and continuing`,
      );
    }

    if (payload) {
      params.db
        .prepare(
          `update threads
           set state = ?,
               raw_json = ?,
               updated_at_gh = ?,
               closed_at_gh = ?,
               merged_at_gh = ?,
               last_pulled_at = ?,
               updated_at = ?
           where id = ?`,
        )
        .run(
          state,
          asJson(payload),
          typeof payload.updated_at === 'string' ? payload.updated_at : null,
          typeof payload.closed_at === 'string' ? payload.closed_at : null,
          typeof payload.merged_at === 'string' ? payload.merged_at : null,
          pulledAt,
          pulledAt,
          row.id,
        );
    } else {
      params.db
        .prepare(
          `update threads
           set state = 'closed',
               closed_at_gh = coalesce(closed_at_gh, ?),
               last_pulled_at = ?,
               updated_at = ?
           where id = ?`,
        )
        .run(pulledAt, pulledAt, pulledAt, row.id);
    }

    if (state !== 'open') {
      threadsClosed += 1;
    }
  }

  if (threadsClosed > 0) {
    params.onProgress?.(`[sync] marked ${threadsClosed} stale thread(s) as closed after GitHub confirmation`);
  }

  return threadsClosed;
}
