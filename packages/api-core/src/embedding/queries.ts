import type { SqliteDatabase } from '../db/sqlite.js';
import { normalizeEmbedding } from '../search/exact.js';
import type { EmbeddingSourceKind, StoredEmbeddingRow } from '../service-types.js';

export function loadStoredEmbeddingsForThreadNumber(params: {
  db: SqliteDatabase;
  repoId: number;
  threadNumber: number;
  embedModel: string;
}): StoredEmbeddingRow[] {
  return params.db
    .prepare(
      `select t.id, t.repo_id, t.number, t.kind, t.state, t.closed_at_gh, t.closed_at_local, t.close_reason_local,
              t.title, t.body, t.author_login, t.html_url, t.labels_json,
              t.updated_at_gh, t.first_pulled_at, t.last_pulled_at, e.source_kind, e.embedding_json
       from threads t
       join document_embeddings e on e.thread_id = t.id
       where t.repo_id = ?
         and t.number = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and e.model = ?
       order by e.source_kind asc`,
    )
    .all(params.repoId, params.threadNumber, params.embedModel) as StoredEmbeddingRow[];
}

export function iterateStoredEmbeddings(params: {
  db: SqliteDatabase;
  repoId: number;
  embedModel: string;
}): IterableIterator<StoredEmbeddingRow> {
  return params.db
    .prepare(
      `select t.id, t.repo_id, t.number, t.kind, t.state, t.closed_at_gh, t.closed_at_local, t.close_reason_local,
              t.title, t.body, t.author_login, t.html_url, t.labels_json,
              t.updated_at_gh, t.first_pulled_at, t.last_pulled_at, e.source_kind, e.embedding_json
       from threads t
       join document_embeddings e on e.thread_id = t.id
       where t.repo_id = ? and t.state = 'open' and t.closed_at_local is null and e.model = ?
       order by t.number asc, e.source_kind asc`,
    )
    .iterate(params.repoId, params.embedModel) as IterableIterator<StoredEmbeddingRow>;
}

export function loadNormalizedEmbeddingsForSourceKind(params: {
  db: SqliteDatabase;
  repoId: number;
  embedModel: string;
  sourceKind: EmbeddingSourceKind;
}): Array<{ id: number; normalizedEmbedding: number[] }> {
  const rows = params.db
    .prepare(
      `select t.id, e.embedding_json
       from threads t
       join document_embeddings e on e.thread_id = t.id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and e.model = ?
         and e.source_kind = ?
       order by t.number asc`,
    )
    .all(params.repoId, params.embedModel, params.sourceKind) as Array<{ id: number; embedding_json: string }>;

  return rows.map((row) => ({
    id: row.id,
    normalizedEmbedding: normalizeEmbedding(JSON.parse(row.embedding_json) as number[]).normalized,
  }));
}

export function countEmbeddingsForSourceKind(params: {
  db: SqliteDatabase;
  repoId: number;
  sourceKind: EmbeddingSourceKind;
}): number {
  const row = params.db
    .prepare(
      `select count(*) as count
       from document_embeddings e
       join threads t on t.id = e.thread_id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and e.source_kind = ?`,
    )
    .get(params.repoId, params.sourceKind) as { count: number };
  return row.count;
}
