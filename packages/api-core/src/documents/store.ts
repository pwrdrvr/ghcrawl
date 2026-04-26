import { rawJsonStorage } from '../db/raw-json-store.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import type { CommentSeed, ThreadRow } from '../service-types.js';
import { nowIso, parseArray } from '../service-utils.js';
import { buildCanonicalDocument } from './normalize.js';

export function replaceComments(params: {
  db: SqliteDatabase;
  dbPath: string;
  threadId: number;
  comments: CommentSeed[];
}): void {
  const insert = params.db.prepare(
    `insert into comments (
      thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, raw_json_blob_id, created_at_gh, updated_at_gh
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = params.db.transaction((commentRows: CommentSeed[]) => {
    params.db.prepare('delete from comments where thread_id = ?').run(params.threadId);
    for (const comment of commentRows) {
      const raw = rawJsonStorage(params.db, params.dbPath, comment.rawJson, `application/vnd.ghcrawl.${comment.commentType}.raw+json`);
      insert.run(
        params.threadId,
        comment.githubId,
        comment.commentType,
        comment.authorLogin,
        comment.authorType,
        comment.body,
        comment.isBot ? 1 : 0,
        raw.inlineJson,
        raw.blobId,
        comment.createdAtGh,
        comment.updatedAtGh,
      );
    }
  });
  tx(params.comments);
}

export function refreshThreadDocument(db: SqliteDatabase, threadId: number): void {
  const thread = db.prepare('select * from threads where id = ?').get(threadId) as ThreadRow;
  const comments = db
    .prepare(
      'select body, author_login, author_type, is_bot from comments where thread_id = ? order by coalesce(created_at_gh, updated_at_gh) asc, id asc',
    )
    .all(threadId) as Array<{ body: string; author_login: string | null; author_type: string | null; is_bot: number }>;

  const canonical = buildCanonicalDocument({
    title: thread.title,
    body: thread.body,
    labels: parseArray(thread.labels_json),
    comments: comments.map((comment) => ({
      body: comment.body,
      authorLogin: comment.author_login,
      authorType: comment.author_type,
      isBot: comment.is_bot === 1,
    })),
  });

  db.prepare(
    `insert into documents (thread_id, title, body, raw_text, dedupe_text, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(thread_id) do update set
       title = excluded.title,
       body = excluded.body,
       raw_text = excluded.raw_text,
       dedupe_text = excluded.dedupe_text,
       updated_at = excluded.updated_at`,
  ).run(threadId, thread.title, thread.body, canonical.rawText, canonical.dedupeText, nowIso());

  db.prepare('update threads set content_hash = ?, updated_at = ? where id = ?').run(canonical.contentHash, nowIso(), threadId);
}
