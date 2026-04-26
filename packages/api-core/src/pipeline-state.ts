import type { GitcrawlConfig } from './config.js';
import type { SqliteDatabase } from './db/sqlite.js';
import { ACTIVE_EMBED_DIMENSIONS, ACTIVE_EMBED_PIPELINE_VERSION, SUMMARY_PROMPT_VERSION } from './service-constants.js';
import type { RepoPipelineStateRow } from './service-types.js';
import { nowIso } from './service-utils.js';

type DesiredPipelineState = Omit<RepoPipelineStateRow, 'repo_id' | 'vectors_current_at' | 'clusters_current_at' | 'updated_at'>;

export function getDesiredPipelineState(config: GitcrawlConfig): DesiredPipelineState {
  return {
    summary_model: config.summaryModel,
    summary_prompt_version: SUMMARY_PROMPT_VERSION,
    embedding_basis: config.embeddingBasis,
    embed_model: config.embedModel,
    embed_dimensions: ACTIVE_EMBED_DIMENSIONS,
    embed_pipeline_version: ACTIVE_EMBED_PIPELINE_VERSION,
    vector_backend: config.vectorBackend,
  };
}

export function getRepoPipelineState(db: SqliteDatabase, repoId: number): RepoPipelineStateRow | null {
  return (db.prepare('select * from repo_pipeline_state where repo_id = ? limit 1').get(repoId) as RepoPipelineStateRow | undefined) ?? null;
}

export function isRepoVectorStateCurrent(db: SqliteDatabase, config: GitcrawlConfig, repoId: number): boolean {
  const state = getRepoPipelineState(db, repoId);
  if (!state || !state.vectors_current_at) {
    return false;
  }
  const desired = getDesiredPipelineState(config);
  return (
    state.summary_model === desired.summary_model &&
    state.summary_prompt_version === desired.summary_prompt_version &&
    state.embedding_basis === desired.embedding_basis &&
    state.embed_model === desired.embed_model &&
    state.embed_dimensions === desired.embed_dimensions &&
    state.embed_pipeline_version === desired.embed_pipeline_version &&
    state.vector_backend === desired.vector_backend
  );
}

export function isRepoClusterStateCurrent(db: SqliteDatabase, config: GitcrawlConfig, repoId: number): boolean {
  const state = getRepoPipelineState(db, repoId);
  return isRepoVectorStateCurrent(db, config, repoId) && Boolean(state?.clusters_current_at);
}

export function hasLegacyEmbeddings(db: SqliteDatabase, embedModel: string, repoId: number): boolean {
  const row = db
    .prepare(
      `select count(*) as count
       from document_embeddings e
       join threads t on t.id = e.thread_id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and e.model = ?`,
    )
    .get(repoId, embedModel) as { count: number };
  return row.count > 0;
}

export function writeRepoPipelineState(
  db: SqliteDatabase,
  config: GitcrawlConfig,
  repoId: number,
  overrides: Partial<Pick<RepoPipelineStateRow, 'vectors_current_at' | 'clusters_current_at'>>,
): void {
  const desired = getDesiredPipelineState(config);
  const current = getRepoPipelineState(db, repoId);
  db.prepare(
    `insert into repo_pipeline_state (
        repo_id,
        summary_model,
        summary_prompt_version,
        embedding_basis,
        embed_model,
        embed_dimensions,
        embed_pipeline_version,
        vector_backend,
        vectors_current_at,
        clusters_current_at,
        updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(repo_id) do update set
       summary_model = excluded.summary_model,
       summary_prompt_version = excluded.summary_prompt_version,
       embedding_basis = excluded.embedding_basis,
       embed_model = excluded.embed_model,
       embed_dimensions = excluded.embed_dimensions,
       embed_pipeline_version = excluded.embed_pipeline_version,
       vector_backend = excluded.vector_backend,
       vectors_current_at = excluded.vectors_current_at,
       clusters_current_at = excluded.clusters_current_at,
       updated_at = excluded.updated_at`,
  ).run(
    repoId,
    desired.summary_model,
    desired.summary_prompt_version,
    desired.embedding_basis,
    desired.embed_model,
    desired.embed_dimensions,
    desired.embed_pipeline_version,
    desired.vector_backend,
    overrides.vectors_current_at ?? current?.vectors_current_at ?? null,
    overrides.clusters_current_at ?? current?.clusters_current_at ?? null,
    nowIso(),
  );
}

export function markRepoVectorsCurrent(db: SqliteDatabase, config: GitcrawlConfig, repoId: number): void {
  writeRepoPipelineState(db, config, repoId, {
    vectors_current_at: nowIso(),
    clusters_current_at: null,
  });
}

export function markRepoClustersCurrent(db: SqliteDatabase, config: GitcrawlConfig, repoId: number): void {
  const state = getRepoPipelineState(db, repoId);
  writeRepoPipelineState(db, config, repoId, {
    vectors_current_at: state?.vectors_current_at ?? nowIso(),
    clusters_current_at: nowIso(),
  });
}
