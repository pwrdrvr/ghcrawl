import type { GitcrawlConfig } from '../config.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import { normalizeEmbedding } from '../search/exact.js';
import { ACTIVE_EMBED_DIMENSIONS } from '../service-constants.js';
import type { EmbeddingSourceKind } from '../service-types.js';
import { parseStoredVector } from '../vector/encoding.js';

export function loadClusterableThreadMeta(params: {
  db: SqliteDatabase;
  repoId: number;
}): {
  items: Array<{ id: number; number: number; title: string }>;
  sourceKinds: EmbeddingSourceKind[];
} {
  const rows = params.db
    .prepare(
      `select t.id, t.number, t.title, e.source_kind
       from threads t
       join document_embeddings e on e.thread_id = t.id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and not exists (
           select 1
           from cluster_closures cc
           join cluster_memberships cm on cm.cluster_id = cc.cluster_id
           where cm.thread_id = t.id
             and cm.state <> 'removed_by_user'
         )`,
    )
    .all(params.repoId) as Array<{ id: number; number: number; title: string; source_kind: EmbeddingSourceKind }>;

  const itemsById = new Map<number, { id: number; number: number; title: string }>();
  const sourceKinds = new Set<EmbeddingSourceKind>();
  for (const row of rows) {
    itemsById.set(row.id, { id: row.id, number: row.number, title: row.title });
    sourceKinds.add(row.source_kind);
  }

  return {
    items: Array.from(itemsById.values()),
    sourceKinds: Array.from(sourceKinds.values()),
  };
}

export function loadClusterableActiveVectorMeta(params: {
  db: SqliteDatabase;
  config: GitcrawlConfig;
  repoId: number;
}): Array<{ id: number; number: number; title: string; embedding: number[] }> {
  const rows = params.db
    .prepare(
      `select t.id, t.number, t.title, tv.vector_json
       from threads t
       join thread_vectors tv on tv.thread_id = t.id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and not exists (
           select 1
           from cluster_closures cc
           join cluster_memberships cm on cm.cluster_id = cc.cluster_id
           where cm.thread_id = t.id
             and cm.state <> 'removed_by_user'
         )
         and tv.model = ?
         and tv.basis = ?
         and tv.dimensions = ?
       order by t.number asc`,
    )
    .all(params.repoId, params.config.embedModel, params.config.embeddingBasis, ACTIVE_EMBED_DIMENSIONS) as Array<{
    id: number;
    number: number;
    title: string;
    vector_json: Buffer | string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    embedding: parseStoredVector(row.vector_json),
  }));
}

export function loadNormalizedActiveVectors(params: {
  db: SqliteDatabase;
  config: GitcrawlConfig;
  repoId: number;
}): Array<{ id: number; number: number; title: string; embedding: number[] }> {
  return loadClusterableActiveVectorMeta(params).map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    embedding: normalizeEmbedding(row.embedding).normalized,
  }));
}
