import type { GitcrawlConfig } from '../config.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import { writeRepoPipelineState } from '../pipeline-state.js';
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
