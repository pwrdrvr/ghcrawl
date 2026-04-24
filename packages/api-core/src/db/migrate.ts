import type { SqliteDatabase } from './sqlite.js';

const migrationStatements = [
  `
  create table if not exists repositories (
    id integer primary key,
    owner text not null,
    name text not null,
    full_name text not null unique,
    github_repo_id text,
    raw_json text not null,
    updated_at text not null
  )
  `,
  `
  create table if not exists threads (
    id integer primary key,
    repo_id integer not null references repositories(id) on delete cascade,
    github_id text not null,
    number integer not null,
    kind text not null,
    state text not null,
    title text not null,
    body text,
    author_login text,
    author_type text,
    html_url text not null,
    labels_json text not null,
    assignees_json text not null,
    raw_json text not null,
    content_hash text not null,
    is_draft integer not null default 0,
    created_at_gh text,
    updated_at_gh text,
    closed_at_gh text,
    merged_at_gh text,
    first_pulled_at text,
    last_pulled_at text,
    updated_at text not null,
    unique(repo_id, kind, number)
  )
  `,
  `
  create table if not exists comments (
    id integer primary key,
    thread_id integer not null references threads(id) on delete cascade,
    github_id text not null,
    comment_type text not null,
    author_login text,
    author_type text,
    body text not null,
    is_bot integer not null default 0,
    raw_json text not null,
    raw_json_blob_id integer references blobs(id) on delete set null,
    created_at_gh text,
    updated_at_gh text,
    unique(thread_id, comment_type, github_id)
  )
  `,
  `
  create table if not exists blobs (
    id integer primary key,
    sha256 text not null unique,
    media_type text not null,
    compression text not null default 'none',
    size_bytes integer not null,
    storage_kind text not null,
    storage_path text,
    inline_text text,
    created_at text not null
  )
  `,
  `
  create table if not exists thread_revisions (
    id integer primary key,
    thread_id integer not null references threads(id) on delete cascade,
    source_updated_at text,
    content_hash text not null,
    title_hash text not null,
    body_hash text not null,
    labels_hash text not null,
    raw_json_blob_id integer references blobs(id) on delete set null,
    created_at text not null,
    unique(thread_id, content_hash)
  )
  `,
  `
  create table if not exists thread_code_snapshots (
    id integer primary key,
    thread_revision_id integer not null unique references thread_revisions(id) on delete cascade,
    base_sha text,
    head_sha text,
    files_changed integer not null default 0,
    additions integer not null default 0,
    deletions integer not null default 0,
    patch_digest text,
    raw_diff_blob_id integer references blobs(id) on delete set null,
    created_at text not null
  )
  `,
  `
  create table if not exists thread_changed_files (
    snapshot_id integer not null references thread_code_snapshots(id) on delete cascade,
    path text not null,
    status text,
    additions integer not null default 0,
    deletions integer not null default 0,
    previous_path text,
    patch_blob_id integer references blobs(id) on delete set null,
    patch_hash text,
    primary key (snapshot_id, path)
  )
  `,
  `
  create table if not exists thread_hunk_signatures (
    id integer primary key,
    snapshot_id integer not null references thread_code_snapshots(id) on delete cascade,
    path text not null,
    hunk_hash text not null,
    context_hash text not null,
    added_token_hash text not null,
    removed_token_hash text not null,
    created_at text not null,
    unique(snapshot_id, path, hunk_hash)
  )
  `,
  `
  create table if not exists documents (
    id integer primary key,
    thread_id integer not null unique references threads(id) on delete cascade,
    title text not null,
    body text,
    raw_text text not null,
    dedupe_text text not null,
    updated_at text not null
  )
  `,
  `
  create virtual table if not exists documents_fts using fts5(
    title,
    body,
    raw_text,
    dedupe_text,
    content='documents',
    content_rowid='id'
  )
  `,
  `
  create trigger if not exists documents_ai after insert on documents begin
    insert into documents_fts(rowid, title, body, raw_text, dedupe_text)
    values (new.id, new.title, new.body, new.raw_text, new.dedupe_text);
  end
  `,
  `
  create trigger if not exists documents_ad after delete on documents begin
    insert into documents_fts(documents_fts, rowid, title, body, raw_text, dedupe_text)
    values ('delete', old.id, old.title, old.body, old.raw_text, old.dedupe_text);
  end
  `,
  `
  create trigger if not exists documents_au after update on documents begin
    insert into documents_fts(documents_fts, rowid, title, body, raw_text, dedupe_text)
    values ('delete', old.id, old.title, old.body, old.raw_text, old.dedupe_text);
    insert into documents_fts(rowid, title, body, raw_text, dedupe_text)
    values (new.id, new.title, new.body, new.raw_text, new.dedupe_text);
  end
  `,
  `
  create table if not exists document_summaries (
    id integer primary key,
    thread_id integer not null references threads(id) on delete cascade,
    summary_kind text not null,
    model text not null,
    content_hash text not null,
    summary_text text not null,
    created_at text not null,
    updated_at text not null,
    unique(thread_id, summary_kind, model)
  )
  `,
  `
  create table if not exists document_embeddings (
    id integer primary key,
    thread_id integer not null references threads(id) on delete cascade,
    source_kind text not null,
    model text not null,
    dimensions integer not null,
    content_hash text not null,
    embedding_json text not null,
    created_at text not null,
    updated_at text not null,
    unique(thread_id, source_kind, model)
  )
  `,
  `
  create table if not exists thread_vectors (
    thread_id integer primary key references threads(id) on delete cascade,
    basis text not null,
    model text not null,
    dimensions integer not null,
    content_hash text not null,
    vector_json text not null,
    vector_backend text not null,
    created_at text not null,
    updated_at text not null
  )
  `,
  `
  create table if not exists thread_fingerprints (
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
    minhash_signature_blob_id integer references blobs(id) on delete set null,
    simhash64 text not null,
    winnow_hashes_blob_id integer references blobs(id) on delete set null,
    feature_json text not null,
    created_at text not null,
    unique(thread_revision_id, algorithm_version)
  )
  `,
  `
  create table if not exists thread_key_summaries (
    id integer primary key,
    thread_revision_id integer not null references thread_revisions(id) on delete cascade,
    summary_kind text not null,
    prompt_version text not null,
    provider text not null,
    model text not null,
    input_hash text not null,
    output_hash text not null,
    output_json_blob_id integer references blobs(id) on delete set null,
    key_text text not null,
    created_at text not null,
    unique(thread_revision_id, summary_kind, prompt_version, provider, model)
  )
  `,
  `
  create table if not exists pipeline_runs (
    id integer primary key,
    repo_id integer references repositories(id) on delete cascade,
    run_kind text not null,
    algorithm_version text,
    config_hash text,
    status text not null,
    started_at text not null,
    finished_at text,
    stats_json text,
    error_text text
  )
  `,
  `
  create table if not exists repo_pipeline_state (
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
  )
  `,
  `
  create table if not exists sync_runs (
    id integer primary key,
    repo_id integer references repositories(id) on delete cascade,
    scope text not null,
    status text not null,
    started_at text not null,
    finished_at text,
    stats_json text,
    error_text text
  )
  `,
  `
  create table if not exists repo_sync_state (
    repo_id integer primary key references repositories(id) on delete cascade,
    last_full_open_scan_started_at text,
    last_overlapping_open_scan_completed_at text,
    last_non_overlapping_scan_completed_at text,
    last_open_close_reconciled_at text,
    updated_at text not null
  )
  `,
  `
  create table if not exists summary_runs (
    id integer primary key,
    repo_id integer references repositories(id) on delete cascade,
    scope text not null,
    status text not null,
    started_at text not null,
    finished_at text,
    stats_json text,
    error_text text
  )
  `,
  `
  create table if not exists embedding_runs (
    id integer primary key,
    repo_id integer references repositories(id) on delete cascade,
    scope text not null,
    status text not null,
    started_at text not null,
    finished_at text,
    stats_json text,
    error_text text
  )
  `,
  `
  create table if not exists cluster_runs (
    id integer primary key,
    repo_id integer references repositories(id) on delete cascade,
    scope text not null,
    status text not null,
    started_at text not null,
    finished_at text,
    stats_json text,
    error_text text
  )
  `,
  `
  create table if not exists similarity_edges (
    id integer primary key,
    repo_id integer not null references repositories(id) on delete cascade,
    cluster_run_id integer references cluster_runs(id) on delete cascade,
    left_thread_id integer not null references threads(id) on delete cascade,
    right_thread_id integer not null references threads(id) on delete cascade,
    method text not null,
    score real not null,
    explanation_json text not null,
    created_at text not null,
    unique(cluster_run_id, left_thread_id, right_thread_id)
  )
  `,
  `
  create table if not exists similarity_edge_evidence (
    id integer primary key,
    repo_id integer not null references repositories(id) on delete cascade,
    left_thread_id integer not null references threads(id) on delete cascade,
    right_thread_id integer not null references threads(id) on delete cascade,
    algorithm_version text not null,
    config_hash text not null,
    score real not null,
    tier text not null,
    state text not null,
    breakdown_json text not null,
    first_seen_run_id integer references pipeline_runs(id) on delete set null,
    last_seen_run_id integer references pipeline_runs(id) on delete set null,
    created_at text not null,
    updated_at text not null,
    unique(repo_id, left_thread_id, right_thread_id, algorithm_version, config_hash)
  )
  `,
  `
  create table if not exists clusters (
    id integer primary key,
    repo_id integer not null references repositories(id) on delete cascade,
    cluster_run_id integer not null references cluster_runs(id) on delete cascade,
    representative_thread_id integer references threads(id) on delete set null,
    member_count integer not null,
    created_at text not null
  )
  `,
  `
  create table if not exists cluster_members (
    cluster_id integer not null references clusters(id) on delete cascade,
    thread_id integer not null references threads(id) on delete cascade,
    score_to_representative real,
    created_at text not null,
    primary key (cluster_id, thread_id)
  )
  `,
  `
  create table if not exists cluster_groups (
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
  )
  `,
  `
  create table if not exists cluster_memberships (
    cluster_id integer not null references cluster_groups(id) on delete cascade,
    thread_id integer not null references threads(id) on delete cascade,
    role text not null,
    state text not null,
    score_to_representative real,
    first_seen_run_id integer references pipeline_runs(id) on delete set null,
    last_seen_run_id integer references pipeline_runs(id) on delete set null,
    added_by text not null,
    removed_by text,
    added_reason_json text not null,
    removed_reason_json text,
    created_at text not null,
    updated_at text not null,
    removed_at text,
    primary key (cluster_id, thread_id)
  )
  `,
  `
  create table if not exists cluster_overrides (
    id integer primary key,
    repo_id integer not null references repositories(id) on delete cascade,
    cluster_id integer not null references cluster_groups(id) on delete cascade,
    thread_id integer not null references threads(id) on delete cascade,
    action text not null,
    reason text,
    created_at text not null,
    expires_at text,
    unique(cluster_id, thread_id, action)
  )
  `,
  `
  create table if not exists cluster_events (
    id integer primary key,
    cluster_id integer not null references cluster_groups(id) on delete cascade,
    run_id integer references pipeline_runs(id) on delete set null,
    event_type text not null,
    actor_kind text not null,
    payload_json text not null,
    created_at text not null
  )
  `,
  `
  create table if not exists cluster_aliases (
    cluster_id integer not null references cluster_groups(id) on delete cascade,
    alias_slug text not null,
    reason text not null,
    created_at text not null,
    primary key (cluster_id, alias_slug)
  )
  `
];

export function migrate(db: SqliteDatabase): void {
  for (const statement of migrationStatements) {
    db.exec(statement);
  }

  const threadColumns = new Set(
    (db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>).map((column) => column.name),
  );

  if (!threadColumns.has('first_pulled_at')) {
    db.exec('alter table threads add column first_pulled_at text');
  }
  if (!threadColumns.has('last_pulled_at')) {
    db.exec('alter table threads add column last_pulled_at text');
  }
  if (!threadColumns.has('closed_at_local')) {
    db.exec('alter table threads add column closed_at_local text');
  }
  if (!threadColumns.has('close_reason_local')) {
    db.exec('alter table threads add column close_reason_local text');
  }

  const commentColumns = new Set(
    (db.prepare('pragma table_info(comments)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!commentColumns.has('raw_json_blob_id')) {
    db.exec('alter table comments add column raw_json_blob_id integer references blobs(id) on delete set null');
  }

  const clusterColumns = new Set(
    (db.prepare('pragma table_info(clusters)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!clusterColumns.has('closed_at_local')) {
    db.exec('alter table clusters add column closed_at_local text');
  }
  if (!clusterColumns.has('close_reason_local')) {
    db.exec('alter table clusters add column close_reason_local text');
  }

  const summaryColumns = new Set(
    (db.prepare('pragma table_info(document_summaries)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!summaryColumns.has('prompt_version')) {
    db.exec("alter table document_summaries add column prompt_version text default 'v1'");
  }

  const vectorColumns = new Set(
    (db.prepare('pragma table_info(thread_vectors)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!vectorColumns.has('vector_backend')) {
    db.exec("alter table thread_vectors add column vector_backend text default 'vectorlite'");
  }

  db.exec('create index if not exists idx_threads_repo_number on threads(repo_id, number)');
  db.exec('create index if not exists idx_blobs_sha256 on blobs(sha256)');
  db.exec('create index if not exists idx_thread_revisions_thread_created on thread_revisions(thread_id, created_at)');
  db.exec('create index if not exists idx_thread_fingerprints_hash on thread_fingerprints(fingerprint_hash)');
  db.exec('create index if not exists idx_thread_fingerprints_slug on thread_fingerprints(fingerprint_slug)');
  db.exec('create index if not exists idx_thread_code_snapshots_revision on thread_code_snapshots(thread_revision_id)');
  db.exec('create index if not exists idx_thread_changed_files_path on thread_changed_files(path)');
  db.exec('create index if not exists idx_thread_hunk_signatures_hash on thread_hunk_signatures(hunk_hash)');
  db.exec('create index if not exists idx_thread_key_summaries_revision_kind on thread_key_summaries(thread_revision_id, summary_kind)');
  db.exec('create index if not exists idx_document_summaries_thread_model on document_summaries(thread_id, model)');
  db.exec('create index if not exists idx_thread_vectors_basis_model on thread_vectors(basis, model)');
  db.exec('create index if not exists idx_pipeline_runs_repo_kind_id on pipeline_runs(repo_id, run_kind, id)');
  db.exec('create index if not exists idx_cluster_runs_repo_status_id on cluster_runs(repo_id, status, id)');
  db.exec('create index if not exists idx_clusters_repo_run_id on clusters(repo_id, cluster_run_id, id)');
  db.exec('create index if not exists idx_cluster_members_thread_cluster on cluster_members(thread_id, cluster_id)');
  db.exec('create index if not exists idx_similarity_edge_evidence_repo_pair on similarity_edge_evidence(repo_id, left_thread_id, right_thread_id)');
  db.exec('create index if not exists idx_similarity_edge_evidence_repo_state_score on similarity_edge_evidence(repo_id, state, tier, score)');
  db.exec('create index if not exists idx_cluster_groups_repo_status on cluster_groups(repo_id, status)');
  db.exec('create index if not exists idx_cluster_memberships_thread_state on cluster_memberships(thread_id, state)');
  db.exec('create index if not exists idx_cluster_memberships_cluster_state on cluster_memberships(cluster_id, state)');
  db.exec('create index if not exists idx_cluster_overrides_repo_target on cluster_overrides(repo_id, cluster_id, thread_id, action)');
  db.exec('create index if not exists idx_cluster_events_cluster_created on cluster_events(cluster_id, created_at)');
}
