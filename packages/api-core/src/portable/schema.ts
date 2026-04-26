import type { SqliteDatabase } from '../db/sqlite.js';

export function createPortableSyncSchema(db: SqliteDatabase): void {
  db.exec(`
    create table portable_metadata (key text primary key, value text not null);
    create table repositories (
      id integer primary key,
      owner text not null,
      name text not null,
      full_name text not null unique,
      github_repo_id text,
      updated_at text not null
    );
    create table threads (
      id integer primary key,
      repo_id integer not null references repositories(id) on delete cascade,
      github_id text not null,
      number integer not null,
      kind text not null,
      state text not null,
      title text not null,
      body_excerpt text,
      body_length integer not null default 0,
      author_login text,
      author_type text,
      html_url text not null,
      labels_json text not null,
      assignees_json text not null,
      content_hash text not null,
      is_draft integer not null default 0,
      created_at_gh text,
      updated_at_gh text,
      closed_at_gh text,
      merged_at_gh text,
      first_pulled_at text,
      last_pulled_at text,
      updated_at text not null,
      closed_at_local text,
      close_reason_local text,
      unique(repo_id, kind, number)
    );
    create table thread_revisions (
      id integer primary key,
      thread_id integer not null references threads(id) on delete cascade,
      source_updated_at text,
      content_hash text not null,
      title_hash text not null,
      body_hash text not null,
      labels_hash text not null,
      created_at text not null,
      unique(thread_id, content_hash)
    );
    create table thread_fingerprints (
      id integer primary key,
      thread_revision_id integer not null references thread_revisions(id) on delete cascade,
      algorithm_version text not null,
      fingerprint_hash text not null,
      fingerprint_slug text not null,
      title_tokens_json text not null,
      body_token_hash text not null,
      linked_refs_json text not null,
      file_set_hash text not null,
      module_buckets_json text not null,
      simhash64 text not null,
      feature_json text not null,
      created_at text not null,
      unique(thread_revision_id, algorithm_version)
    );
    create table thread_key_summaries (
      id integer primary key,
      thread_revision_id integer not null references thread_revisions(id) on delete cascade,
      summary_kind text not null,
      prompt_version text not null,
      provider text not null,
      model text not null,
      input_hash text not null,
      output_hash text not null,
      key_text text not null,
      created_at text not null,
      unique(thread_revision_id, summary_kind, prompt_version, provider, model)
    );
    create table repo_sync_state (
      repo_id integer primary key references repositories(id) on delete cascade,
      last_full_open_scan_started_at text,
      last_overlapping_open_scan_completed_at text,
      last_non_overlapping_scan_completed_at text,
      last_open_close_reconciled_at text,
      updated_at text not null
    );
    create table repo_pipeline_state (
      repo_id integer primary key references repositories(id) on delete cascade,
      summary_model text not null,
      summary_prompt_version text not null,
      embedding_basis text not null,
      embed_model text not null,
      embed_dimensions integer not null,
      embed_pipeline_version text not null,
      vector_backend text not null,
      vectors_current_at text,
      clusters_current_at text,
      updated_at text not null
    );
    create table cluster_groups (
      id integer primary key,
      repo_id integer not null references repositories(id) on delete cascade,
      stable_key text not null,
      stable_slug text not null,
      status text not null,
      cluster_type text,
      representative_thread_id integer references threads(id) on delete set null,
      title text,
      created_at text not null,
      updated_at text not null,
      closed_at text,
      unique(repo_id, stable_key),
      unique(repo_id, stable_slug)
    );
    create table cluster_memberships (
      cluster_id integer not null references cluster_groups(id) on delete cascade,
      thread_id integer not null references threads(id) on delete cascade,
      role text not null,
      state text not null,
      score_to_representative real,
      first_seen_run_id integer,
      last_seen_run_id integer,
      added_by text not null,
      removed_by text,
      added_reason_json text not null,
      removed_reason_json text,
      created_at text not null,
      updated_at text not null,
      removed_at text,
      primary key (cluster_id, thread_id)
    );
    create table cluster_overrides (
      id integer primary key,
      repo_id integer not null references repositories(id) on delete cascade,
      cluster_id integer not null references cluster_groups(id) on delete cascade,
      thread_id integer not null references threads(id) on delete cascade,
      action text not null,
      actor_id integer,
      reason text,
      created_at text not null,
      expires_at text,
      unique(cluster_id, thread_id, action)
    );
    create table cluster_aliases (
      cluster_id integer not null references cluster_groups(id) on delete cascade,
      alias_slug text not null,
      reason text not null,
      created_at text not null,
      primary key (cluster_id, alias_slug)
    );
    create table cluster_closures (
      cluster_id integer primary key references cluster_groups(id) on delete cascade,
      reason text not null,
      actor_kind text not null,
      created_at text not null,
      updated_at text not null
    );
    create index idx_threads_repo_number on threads(repo_id, number);
    create index idx_threads_repo_state_closed on threads(repo_id, state, closed_at_local);
    create index idx_thread_fingerprints_hash on thread_fingerprints(fingerprint_hash);
    create index idx_thread_fingerprints_slug on thread_fingerprints(fingerprint_slug);
    create index idx_cluster_groups_repo_status on cluster_groups(repo_id, status);
    create index idx_cluster_memberships_thread_state on cluster_memberships(thread_id, state);
    create index idx_cluster_memberships_cluster_state on cluster_memberships(cluster_id, state);
  `);
}
