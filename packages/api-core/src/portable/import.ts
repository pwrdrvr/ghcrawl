import path from 'node:path';

import type { SqliteDatabase } from '../db/sqlite.js';
import { validatePortableSyncDatabase } from './inspect.js';
import { openReadonlyDb } from './sqlite-utils.js';
import type { PortableSyncImportResponse } from './types.js';

export function importPortableSyncDatabase(params: { liveDb: SqliteDatabase; portablePath: string }): PortableSyncImportResponse {
  const resolvedPath = path.resolve(params.portablePath);
  const validation = validatePortableSyncDatabase(resolvedPath);
  if (!validation.ok) {
    throw new Error(`Portable sync validation failed: ${validation.errors.join('; ')}`);
  }

  const portableDb = openReadonlyDb(resolvedPath);
  try {
    const portableRepo = portableDb.prepare('select * from repositories order by id limit 1').get() as PortableRepositoryRow | undefined;
    if (!portableRepo) {
      throw new Error('Portable sync database has no repository row');
    }

    const imported = emptyImportCounts();
    const threadIdMap = new Map<number, number>();
    const revisionIdMap = new Map<number, number>();
    const clusterIdMap = new Map<number, number>();

    const runImport = params.liveDb.transaction(() => {
      const repoId = upsertImportedRepository(params.liveDb, portableRepo);
      imported.repositories = 1;

      for (const thread of readPortableThreads(portableDb, portableRepo.id)) {
        threadIdMap.set(thread.id, upsertImportedThread(params.liveDb, repoId, thread));
        imported.threads += 1;
      }

      for (const revision of readPortableThreadRevisions(portableDb)) {
        const liveThreadId = threadIdMap.get(revision.thread_id);
        if (!liveThreadId) continue;
        revisionIdMap.set(revision.id, upsertImportedThreadRevision(params.liveDb, liveThreadId, revision));
        imported.threadRevisions += 1;
      }

      for (const fingerprint of readPortableThreadFingerprints(portableDb)) {
        const liveRevisionId = revisionIdMap.get(fingerprint.thread_revision_id);
        if (!liveRevisionId) continue;
        upsertImportedThreadFingerprint(params.liveDb, liveRevisionId, fingerprint);
        imported.threadFingerprints += 1;
      }

      for (const summary of readPortableThreadKeySummaries(portableDb)) {
        const liveRevisionId = revisionIdMap.get(summary.thread_revision_id);
        if (!liveRevisionId) continue;
        upsertImportedThreadKeySummary(params.liveDb, liveRevisionId, summary);
        imported.threadKeySummaries += 1;
      }

      if (upsertImportedRepoSyncState(params.liveDb, repoId, portableDb, portableRepo.id)) imported.repoSyncState = 1;
      if (upsertImportedRepoPipelineState(params.liveDb, repoId, portableDb, portableRepo.id)) imported.repoPipelineState = 1;

      for (const cluster of readPortableClusterGroups(portableDb, portableRepo.id)) {
        const representativeThreadId = cluster.representative_thread_id ? (threadIdMap.get(cluster.representative_thread_id) ?? null) : null;
        clusterIdMap.set(cluster.id, upsertImportedClusterGroup(params.liveDb, repoId, representativeThreadId, cluster));
        imported.clusterGroups += 1;
      }

      for (const membership of readPortableClusterMemberships(portableDb)) {
        const liveClusterId = clusterIdMap.get(membership.cluster_id);
        const liveThreadId = threadIdMap.get(membership.thread_id);
        if (!liveClusterId || !liveThreadId) continue;
        upsertImportedClusterMembership(params.liveDb, liveClusterId, liveThreadId, membership);
        imported.clusterMemberships += 1;
      }

      for (const override of readPortableClusterOverrides(portableDb, portableRepo.id)) {
        const liveClusterId = clusterIdMap.get(override.cluster_id);
        const liveThreadId = threadIdMap.get(override.thread_id);
        if (!liveClusterId || !liveThreadId) continue;
        upsertImportedClusterOverride(params.liveDb, repoId, liveClusterId, liveThreadId, override);
        imported.clusterOverrides += 1;
      }

      for (const alias of readPortableClusterAliases(portableDb)) {
        const liveClusterId = clusterIdMap.get(alias.cluster_id);
        if (!liveClusterId) continue;
        upsertImportedClusterAlias(params.liveDb, liveClusterId, alias);
        imported.clusterAliases += 1;
      }

      for (const closure of readPortableClusterClosures(portableDb)) {
        const liveClusterId = clusterIdMap.get(closure.cluster_id);
        if (!liveClusterId) continue;
        upsertImportedClusterClosure(params.liveDb, liveClusterId, closure);
        imported.clusterClosures += 1;
      }

      return repoId;
    });

    const repoId = runImport();
    return {
      ok: true,
      path: resolvedPath,
      repository: {
        id: repoId,
        owner: portableRepo.owner,
        name: portableRepo.name,
        fullName: portableRepo.full_name,
      },
      validationOk: validation.ok,
      imported,
    };
  } finally {
    portableDb.close();
  }
}

type PortableRepositoryRow = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  github_repo_id: string | null;
  updated_at: string;
};

type PortableThreadRow = {
  id: number;
  github_id: string;
  number: number;
  kind: string;
  state: string;
  title: string;
  body_excerpt: string | null;
  author_login: string | null;
  author_type: string | null;
  html_url: string;
  labels_json: string;
  assignees_json: string;
  content_hash: string;
  is_draft: number;
  created_at_gh: string | null;
  updated_at_gh: string | null;
  closed_at_gh: string | null;
  merged_at_gh: string | null;
  first_pulled_at: string | null;
  last_pulled_at: string | null;
  updated_at: string;
  closed_at_local: string | null;
  close_reason_local: string | null;
};

type PortableThreadRevisionRow = {
  id: number;
  thread_id: number;
  source_updated_at: string | null;
  content_hash: string;
  title_hash: string;
  body_hash: string;
  labels_hash: string;
  created_at: string;
};

type PortableThreadFingerprintRow = Record<string, unknown> & {
  thread_revision_id: number;
};

type PortableThreadKeySummaryRow = Record<string, unknown> & {
  thread_revision_id: number;
};

type PortableClusterGroupRow = Record<string, unknown> & {
  id: number;
  representative_thread_id: number | null;
};

type PortableClusterMembershipRow = Record<string, unknown> & {
  cluster_id: number;
  thread_id: number;
};

type PortableClusterOverrideRow = Record<string, unknown> & {
  cluster_id: number;
  thread_id: number;
};

type PortableClusterAliasRow = Record<string, unknown> & {
  cluster_id: number;
};

type PortableClusterClosureRow = Record<string, unknown> & {
  cluster_id: number;
};

function emptyImportCounts(): PortableSyncImportResponse['imported'] {
  return {
    repositories: 0,
    threads: 0,
    threadRevisions: 0,
    threadFingerprints: 0,
    threadKeySummaries: 0,
    repoSyncState: 0,
    repoPipelineState: 0,
    clusterGroups: 0,
    clusterMemberships: 0,
    clusterOverrides: 0,
    clusterAliases: 0,
    clusterClosures: 0,
  };
}

function readPortableThreads(db: SqliteDatabase, repoId: number): PortableThreadRow[] {
  return db.prepare('select * from threads where repo_id = ? order by id').all(repoId) as PortableThreadRow[];
}

function readPortableThreadRevisions(db: SqliteDatabase): PortableThreadRevisionRow[] {
  return db.prepare('select * from thread_revisions order by id').all() as PortableThreadRevisionRow[];
}

function readPortableThreadFingerprints(db: SqliteDatabase): PortableThreadFingerprintRow[] {
  return db.prepare('select * from thread_fingerprints order by id').all() as PortableThreadFingerprintRow[];
}

function readPortableThreadKeySummaries(db: SqliteDatabase): PortableThreadKeySummaryRow[] {
  return db.prepare('select * from thread_key_summaries order by id').all() as PortableThreadKeySummaryRow[];
}

function readPortableClusterGroups(db: SqliteDatabase, repoId: number): PortableClusterGroupRow[] {
  return db.prepare('select * from cluster_groups where repo_id = ? order by id').all(repoId) as PortableClusterGroupRow[];
}

function readPortableClusterMemberships(db: SqliteDatabase): PortableClusterMembershipRow[] {
  return db.prepare('select * from cluster_memberships order by cluster_id, thread_id').all() as PortableClusterMembershipRow[];
}

function readPortableClusterOverrides(db: SqliteDatabase, repoId: number): PortableClusterOverrideRow[] {
  return db.prepare('select * from cluster_overrides where repo_id = ? order by id').all(repoId) as PortableClusterOverrideRow[];
}

function readPortableClusterAliases(db: SqliteDatabase): PortableClusterAliasRow[] {
  return db.prepare('select * from cluster_aliases order by cluster_id, alias_slug').all() as PortableClusterAliasRow[];
}

function readPortableClusterClosures(db: SqliteDatabase): PortableClusterClosureRow[] {
  return db.prepare('select * from cluster_closures order by cluster_id').all() as PortableClusterClosureRow[];
}

function upsertImportedRepository(db: SqliteDatabase, row: PortableRepositoryRow): number {
  db.prepare(
    `insert into repositories (owner, name, full_name, github_repo_id, raw_json, updated_at)
     values (?, ?, ?, ?, '{}', ?)
     on conflict(full_name) do update set
       owner = excluded.owner,
       name = excluded.name,
       github_repo_id = excluded.github_repo_id,
       updated_at = excluded.updated_at`,
  ).run(row.owner, row.name, row.full_name, row.github_repo_id, row.updated_at);
  const live = db.prepare('select id from repositories where full_name = ?').get(row.full_name) as { id: number };
  return live.id;
}

function upsertImportedThread(db: SqliteDatabase, repoId: number, row: PortableThreadRow): number {
  db.prepare(
    `insert into threads (
       repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
       labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh,
       closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, updated_at, closed_at_local, close_reason_local
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(repo_id, kind, number) do update set
       github_id = excluded.github_id,
       state = excluded.state,
       title = excluded.title,
       body = coalesce(threads.body, excluded.body),
       author_login = excluded.author_login,
       author_type = excluded.author_type,
       html_url = excluded.html_url,
       labels_json = excluded.labels_json,
       assignees_json = excluded.assignees_json,
       content_hash = excluded.content_hash,
       is_draft = excluded.is_draft,
       created_at_gh = excluded.created_at_gh,
       updated_at_gh = excluded.updated_at_gh,
       closed_at_gh = excluded.closed_at_gh,
       merged_at_gh = excluded.merged_at_gh,
       first_pulled_at = coalesce(threads.first_pulled_at, excluded.first_pulled_at),
       last_pulled_at = excluded.last_pulled_at,
       updated_at = excluded.updated_at,
       closed_at_local = excluded.closed_at_local,
       close_reason_local = excluded.close_reason_local`,
  ).run(
    repoId,
    row.github_id,
    row.number,
    row.kind,
    row.state,
    row.title,
    row.body_excerpt,
    row.author_login,
    row.author_type,
    row.html_url,
    row.labels_json,
    row.assignees_json,
    row.content_hash,
    row.is_draft,
    row.created_at_gh,
    row.updated_at_gh,
    row.closed_at_gh,
    row.merged_at_gh,
    row.first_pulled_at,
    row.last_pulled_at,
    row.updated_at,
    row.closed_at_local,
    row.close_reason_local,
  );
  const live = db.prepare('select id from threads where repo_id = ? and kind = ? and number = ?').get(repoId, row.kind, row.number) as { id: number };
  return live.id;
}

function upsertImportedThreadRevision(db: SqliteDatabase, liveThreadId: number, row: PortableThreadRevisionRow): number {
  db.prepare(
    `insert into thread_revisions (thread_id, source_updated_at, content_hash, title_hash, body_hash, labels_hash, created_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(thread_id, content_hash) do update set
       source_updated_at = excluded.source_updated_at,
       title_hash = excluded.title_hash,
       body_hash = excluded.body_hash,
       labels_hash = excluded.labels_hash`,
  ).run(liveThreadId, row.source_updated_at, row.content_hash, row.title_hash, row.body_hash, row.labels_hash, row.created_at);
  const live = db.prepare('select id from thread_revisions where thread_id = ? and content_hash = ?').get(liveThreadId, row.content_hash) as {
    id: number;
  };
  return live.id;
}

function upsertImportedThreadFingerprint(db: SqliteDatabase, liveRevisionId: number, row: PortableThreadFingerprintRow): void {
  db.prepare(
    `insert into thread_fingerprints (
       thread_revision_id, algorithm_version, fingerprint_hash, fingerprint_slug, title_tokens_json, body_token_hash,
       linked_refs_json, file_set_hash, module_buckets_json, simhash64, feature_json, created_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(thread_revision_id, algorithm_version) do update set
       fingerprint_hash = excluded.fingerprint_hash,
       fingerprint_slug = excluded.fingerprint_slug,
       title_tokens_json = excluded.title_tokens_json,
       body_token_hash = excluded.body_token_hash,
       linked_refs_json = excluded.linked_refs_json,
       file_set_hash = excluded.file_set_hash,
       module_buckets_json = excluded.module_buckets_json,
       simhash64 = excluded.simhash64,
       feature_json = excluded.feature_json`,
  ).run(
    liveRevisionId,
    row.algorithm_version,
    row.fingerprint_hash,
    row.fingerprint_slug,
    row.title_tokens_json,
    row.body_token_hash,
    row.linked_refs_json,
    row.file_set_hash,
    row.module_buckets_json,
    row.simhash64,
    row.feature_json,
    row.created_at,
  );
}

function upsertImportedThreadKeySummary(db: SqliteDatabase, liveRevisionId: number, row: PortableThreadKeySummaryRow): void {
  db.prepare(
    `insert into thread_key_summaries (
       thread_revision_id, summary_kind, prompt_version, provider, model, input_hash, output_hash, key_text, created_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(thread_revision_id, summary_kind, prompt_version, provider, model) do update set
       input_hash = excluded.input_hash,
       output_hash = excluded.output_hash,
       key_text = excluded.key_text,
       created_at = excluded.created_at`,
  ).run(
    liveRevisionId,
    row.summary_kind,
    row.prompt_version,
    row.provider,
    row.model,
    row.input_hash,
    row.output_hash,
    row.key_text,
    row.created_at,
  );
}

function upsertImportedRepoSyncState(db: SqliteDatabase, repoId: number, portableDb: SqliteDatabase, portableRepoId: number): boolean {
  const row = portableDb.prepare('select * from repo_sync_state where repo_id = ?').get(portableRepoId) as Record<string, unknown> | undefined;
  if (!row) return false;
  db.prepare(
    `insert into repo_sync_state (
       repo_id, last_full_open_scan_started_at, last_overlapping_open_scan_completed_at,
       last_non_overlapping_scan_completed_at, last_open_close_reconciled_at, updated_at
     )
     values (?, ?, ?, ?, ?, ?)
     on conflict(repo_id) do update set
       last_full_open_scan_started_at = excluded.last_full_open_scan_started_at,
       last_overlapping_open_scan_completed_at = excluded.last_overlapping_open_scan_completed_at,
       last_non_overlapping_scan_completed_at = excluded.last_non_overlapping_scan_completed_at,
       last_open_close_reconciled_at = excluded.last_open_close_reconciled_at,
       updated_at = excluded.updated_at`,
  ).run(
    repoId,
    row.last_full_open_scan_started_at,
    row.last_overlapping_open_scan_completed_at,
    row.last_non_overlapping_scan_completed_at,
    row.last_open_close_reconciled_at,
    row.updated_at,
  );
  return true;
}

function upsertImportedRepoPipelineState(db: SqliteDatabase, repoId: number, portableDb: SqliteDatabase, portableRepoId: number): boolean {
  const row = portableDb.prepare('select * from repo_pipeline_state where repo_id = ?').get(portableRepoId) as Record<string, unknown> | undefined;
  if (!row) return false;
  db.prepare(
    `insert into repo_pipeline_state (
       repo_id, summary_model, summary_prompt_version, embedding_basis, embed_model, embed_dimensions,
       embed_pipeline_version, vector_backend, vectors_current_at, clusters_current_at, updated_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    row.summary_model,
    row.summary_prompt_version,
    row.embedding_basis,
    row.embed_model,
    row.embed_dimensions,
    row.embed_pipeline_version,
    row.vector_backend,
    row.vectors_current_at,
    row.clusters_current_at,
    row.updated_at,
  );
  return true;
}

function upsertImportedClusterGroup(
  db: SqliteDatabase,
  repoId: number,
  representativeThreadId: number | null,
  row: PortableClusterGroupRow,
): number {
  db.prepare(
    `insert into cluster_groups (
       repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at, closed_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(repo_id, stable_key) do update set
       stable_slug = excluded.stable_slug,
       status = excluded.status,
       cluster_type = excluded.cluster_type,
       representative_thread_id = excluded.representative_thread_id,
       title = excluded.title,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at`,
  ).run(
    repoId,
    row.stable_key,
    row.stable_slug,
    row.status,
    row.cluster_type,
    representativeThreadId,
    row.title,
    row.created_at,
    row.updated_at,
    row.closed_at,
  );
  const live = db.prepare('select id from cluster_groups where repo_id = ? and stable_key = ?').get(repoId, row.stable_key) as { id: number };
  return live.id;
}

function upsertImportedClusterMembership(
  db: SqliteDatabase,
  liveClusterId: number,
  liveThreadId: number,
  row: PortableClusterMembershipRow,
): void {
  db.prepare(
    `insert into cluster_memberships (
       cluster_id, thread_id, role, state, score_to_representative, first_seen_run_id, last_seen_run_id,
       added_by, removed_by, added_reason_json, removed_reason_json, created_at, updated_at, removed_at
     )
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(cluster_id, thread_id) do update set
       role = excluded.role,
       state = excluded.state,
       score_to_representative = excluded.score_to_representative,
       last_seen_run_id = excluded.last_seen_run_id,
       added_by = excluded.added_by,
       removed_by = excluded.removed_by,
       added_reason_json = excluded.added_reason_json,
       removed_reason_json = excluded.removed_reason_json,
       updated_at = excluded.updated_at,
       removed_at = excluded.removed_at`,
  ).run(
    liveClusterId,
    liveThreadId,
    row.role,
    row.state,
    row.score_to_representative,
    row.first_seen_run_id,
    row.last_seen_run_id,
    row.added_by,
    row.removed_by,
    row.added_reason_json,
    row.removed_reason_json,
    row.created_at,
    row.updated_at,
    row.removed_at,
  );
}

function upsertImportedClusterOverride(
  db: SqliteDatabase,
  repoId: number,
  liveClusterId: number,
  liveThreadId: number,
  row: PortableClusterOverrideRow,
): void {
  db.prepare(
    `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, actor_id, reason, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(cluster_id, thread_id, action) do update set
       reason = excluded.reason,
       actor_id = excluded.actor_id,
       expires_at = excluded.expires_at`,
  ).run(repoId, liveClusterId, liveThreadId, row.action, row.actor_id, row.reason, row.created_at, row.expires_at);
}

function upsertImportedClusterAlias(db: SqliteDatabase, liveClusterId: number, row: PortableClusterAliasRow): void {
  db.prepare(
    `insert into cluster_aliases (cluster_id, alias_slug, reason, created_at)
     values (?, ?, ?, ?)
     on conflict(cluster_id, alias_slug) do update set reason = excluded.reason`,
  ).run(liveClusterId, row.alias_slug, row.reason, row.created_at);
}

function upsertImportedClusterClosure(db: SqliteDatabase, liveClusterId: number, row: PortableClusterClosureRow): void {
  db.prepare(
    `insert into cluster_closures (cluster_id, reason, actor_kind, created_at, updated_at)
     values (?, ?, ?, ?, ?)
     on conflict(cluster_id) do update set
       reason = excluded.reason,
       actor_kind = excluded.actor_kind,
       updated_at = excluded.updated_at`,
  ).run(liveClusterId, row.reason, row.actor_kind, row.created_at, row.updated_at);
}
