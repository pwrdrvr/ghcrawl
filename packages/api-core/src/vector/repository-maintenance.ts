import type { GitcrawlConfig } from '../config.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import { writeRepoPipelineState } from '../pipeline-state.js';
import { nowIso } from '../service-utils.js';
import { vectorBlob } from './encoding.js';
import { isCorruptedVectorIndexError, repositoryVectorStorePath } from './repository-store.js';
import type { VectorNeighbor, VectorQueryParams, VectorStore } from './store.js';

export type ActiveVectorMeta = {
  id: number;
  embedding: number[];
};

export function queryNearestWithRecovery(params: {
  vectorStore: VectorStore;
  configDir: string;
  repoFullName: string;
  dimensions: number;
  query: Omit<VectorQueryParams, 'storePath' | 'dimensions'>;
  rebuild: () => void;
}): VectorNeighbor[] {
  const storePath = repositoryVectorStorePath(params.configDir, params.repoFullName);
  try {
    return params.vectorStore.queryNearest({
      ...params.query,
      storePath,
      dimensions: params.dimensions,
    });
  } catch (error) {
    if (!isCorruptedVectorIndexError(error)) {
      throw error;
    }
    params.rebuild();
    return params.vectorStore.queryNearest({
      ...params.query,
      storePath,
      dimensions: params.dimensions,
    });
  }
}

export function rebuildRepositoryVectorStore(params: {
  vectorStore: VectorStore;
  configDir: string;
  repoFullName: string;
  dimensions: number;
  vectors: ActiveVectorMeta[];
}): void {
  const storePath = repositoryVectorStorePath(params.configDir, params.repoFullName);
  params.vectorStore.resetRepository({
    storePath,
    dimensions: params.dimensions,
  });
  for (const row of params.vectors) {
    params.vectorStore.upsertVector({
      storePath,
      dimensions: params.dimensions,
      threadId: row.id,
      vector: row.embedding,
    });
  }
}

export function resetRepositoryVectors(params: {
  db: SqliteDatabase;
  vectorStore: VectorStore;
  config: GitcrawlConfig;
  repoId: number;
  repoFullName: string;
  dimensions: number;
}): void {
  params.db
    .prepare(
      `delete from thread_vectors
       where thread_id in (select id from threads where repo_id = ?)`,
    )
    .run(params.repoId);
  params.vectorStore.resetRepository({
    storePath: repositoryVectorStorePath(params.config.configDir, params.repoFullName),
    dimensions: params.dimensions,
  });
  writeRepoPipelineState(params.db, params.config, params.repoId, {
    vectors_current_at: null,
    clusters_current_at: null,
  });
}

export function pruneInactiveRepositoryVectors(params: {
  db: SqliteDatabase;
  vectorStore: VectorStore;
  configDir: string;
  repoId: number;
  repoFullName: string;
  dimensions: number;
  rebuild: () => void;
}): number {
  const rows = params.db
    .prepare(
      `select tv.thread_id
       from thread_vectors tv
       join threads t on t.id = tv.thread_id
       where t.repo_id = ?
         and (t.state != 'open' or t.closed_at_local is not null)`,
    )
    .all(params.repoId) as Array<{ thread_id: number }>;
  if (rows.length === 0) {
    return 0;
  }

  const storePath = repositoryVectorStorePath(params.configDir, params.repoFullName);
  const deleteVectorRow = params.db.prepare('delete from thread_vectors where thread_id = ?');
  let shouldRebuildVectorStore = false;
  params.db.transaction(() => {
    for (const row of rows) {
      deleteVectorRow.run(row.thread_id);
      try {
        params.vectorStore.deleteVector({
          storePath,
          dimensions: params.dimensions,
          threadId: row.thread_id,
        });
      } catch (error) {
        if (!isCorruptedVectorIndexError(error)) {
          throw error;
        }
        shouldRebuildVectorStore = true;
      }
    }
  })();
  if (shouldRebuildVectorStore) {
    params.rebuild();
  }
  return rows.length;
}

export function cleanupMigratedRepositoryArtifacts(params: {
  db: SqliteDatabase;
  dbPath: string;
  repoId: number;
  repoFullName: string;
  onProgress?: (message: string) => void;
}): void {
  const legacyEmbeddingCount = countLegacyEmbeddings(params.db, params.repoId);
  const inlineJsonVectorCount = countInlineJsonThreadVectors(params.db, params.repoId);
  if (legacyEmbeddingCount === 0 && inlineJsonVectorCount === 0) {
    return;
  }

  if (legacyEmbeddingCount > 0) {
    params.db
      .prepare(
        `delete from document_embeddings
         where thread_id in (select id from threads where repo_id = ?)`,
      )
      .run(params.repoId);
    params.onProgress?.(`[cleanup] removed ${legacyEmbeddingCount} legacy document embedding row(s) after vector migration`);
  }

  if (inlineJsonVectorCount > 0) {
    const rows = params.db
      .prepare(
        `select tv.thread_id, tv.vector_json
         from thread_vectors tv
         join threads t on t.id = tv.thread_id
         where t.repo_id = ?
           and typeof(tv.vector_json) = 'text'
           and tv.vector_json != ''`,
      )
      .all(params.repoId) as Array<{ thread_id: number; vector_json: string }>;
    const update = params.db.prepare('update thread_vectors set vector_json = ?, updated_at = ? where thread_id = ?');
    params.db.transaction(() => {
      for (const row of rows) {
        update.run(vectorBlob(JSON.parse(row.vector_json) as number[]), nowIso(), row.thread_id);
      }
    })();
    params.onProgress?.(`[cleanup] compacted ${inlineJsonVectorCount} inline SQLite vector payload(s) from JSON to binary blobs`);
  }

  if (params.dbPath !== ':memory:') {
    params.onProgress?.(`[cleanup] checkpointing WAL and vacuuming ${params.repoFullName} migration changes`);
    params.db.pragma('wal_checkpoint(TRUNCATE)');
    params.db.exec('VACUUM');
    params.db.pragma('wal_checkpoint(TRUNCATE)');
  }
}

function countLegacyEmbeddings(db: SqliteDatabase, repoId: number): number {
  const row = db
    .prepare(
      `select count(*) as count
       from document_embeddings
       where thread_id in (select id from threads where repo_id = ?)`,
    )
    .get(repoId) as { count: number };
  return row.count;
}

function countInlineJsonThreadVectors(db: SqliteDatabase, repoId: number): number {
  const row = db
    .prepare(
      `select count(*) as count
       from thread_vectors
       where thread_id in (select id from threads where repo_id = ?)
         and typeof(vector_json) = 'text'
         and vector_json != ''`,
    )
    .get(repoId) as { count: number };
  return row.count;
}
