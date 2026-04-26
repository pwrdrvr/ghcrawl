import { buildCodeSnapshotSignature } from '../cluster/code-signature.js';
import { upsertThreadCodeSnapshot, upsertThreadRevision } from '../cluster/persistent-store.js';
import { blobStoreRoot } from '../db/raw-json-store.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import {
  asJson,
  nowIso,
  parseAssignees,
  parseLabels,
  stableContentHash,
  userLogin,
  userType,
} from '../service-utils.js';

export function upsertRepository(params: {
  db: SqliteDatabase;
  owner: string;
  repo: string;
  payload: Record<string, unknown>;
}): number {
  const fullName = `${params.owner}/${params.repo}`;
  params.db
    .prepare(
      `insert into repositories (owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(full_name) do update set
         github_repo_id = excluded.github_repo_id,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
    )
    .run(params.owner, params.repo, fullName, params.payload.id ? String(params.payload.id) : null, asJson(params.payload), nowIso());
  const row = params.db.prepare('select id from repositories where full_name = ?').get(fullName) as { id: number };
  return row.id;
}

export function upsertThread(params: {
  db: SqliteDatabase;
  repoId: number;
  kind: 'issue' | 'pull_request';
  payload: Record<string, unknown>;
  pulledAt: string;
}): number {
  const title = String(params.payload.title ?? `#${params.payload.number}`);
  const body = typeof params.payload.body === 'string' ? params.payload.body : null;
  const labels = parseLabels(params.payload);
  const assignees = parseAssignees(params.payload);
  const contentHash = stableContentHash(`${title}\n${body ?? ''}`);
  params.db
    .prepare(
      `insert into threads (
          repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
          labels_json, assignees_json, raw_json, content_hash, is_draft,
          created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(repo_id, kind, number) do update set
          github_id = excluded.github_id,
          state = excluded.state,
          title = excluded.title,
          body = excluded.body,
          author_login = excluded.author_login,
          author_type = excluded.author_type,
          html_url = excluded.html_url,
          labels_json = excluded.labels_json,
          assignees_json = excluded.assignees_json,
          raw_json = excluded.raw_json,
          content_hash = excluded.content_hash,
          is_draft = excluded.is_draft,
          created_at_gh = excluded.created_at_gh,
          updated_at_gh = excluded.updated_at_gh,
          closed_at_gh = excluded.closed_at_gh,
          merged_at_gh = excluded.merged_at_gh,
          last_pulled_at = excluded.last_pulled_at,
          updated_at = excluded.updated_at`,
    )
    .run(
      params.repoId,
      String(params.payload.id),
      Number(params.payload.number),
      params.kind,
      String(params.payload.state ?? 'open'),
      title,
      body,
      userLogin(params.payload),
      userType(params.payload),
      String(params.payload.html_url),
      asJson(labels),
      asJson(assignees),
      asJson(params.payload),
      contentHash,
      params.payload.draft ? 1 : 0,
      typeof params.payload.created_at === 'string' ? params.payload.created_at : null,
      typeof params.payload.updated_at === 'string' ? params.payload.updated_at : null,
      typeof params.payload.closed_at === 'string' ? params.payload.closed_at : null,
      typeof params.payload.merged_at === 'string' ? params.payload.merged_at : null,
      params.pulledAt,
      params.pulledAt,
      nowIso(),
    );
  const row = params.db
    .prepare('select id from threads where repo_id = ? and kind = ? and number = ?')
    .get(params.repoId, params.kind, Number(params.payload.number)) as { id: number };
  return row.id;
}

export function persistThreadCodeSnapshot(params: {
  db: SqliteDatabase;
  dbPath: string;
  threadId: number;
  threadPayload: Record<string, unknown>;
  files: Array<Record<string, unknown>>;
}): void {
  const title = String(params.threadPayload.title ?? `#${params.threadPayload.number}`);
  const body = typeof params.threadPayload.body === 'string' ? params.threadPayload.body : null;
  const revisionId = upsertThreadRevision(params.db, {
    threadId: params.threadId,
    sourceUpdatedAt: typeof params.threadPayload.updated_at === 'string' ? params.threadPayload.updated_at : null,
    title,
    body,
    labels: parseLabels(params.threadPayload),
    rawJson: asJson(params.threadPayload),
  });
  const base = params.threadPayload.base as Record<string, unknown> | undefined;
  const head = params.threadPayload.head as Record<string, unknown> | undefined;
  upsertThreadCodeSnapshot(params.db, {
    threadRevisionId: revisionId,
    baseSha: typeof base?.sha === 'string' ? base.sha : null,
    headSha: typeof head?.sha === 'string' ? head.sha : null,
    signature: buildCodeSnapshotSignature(params.files),
    storeRoot: blobStoreRoot(params.dbPath),
  });
}
