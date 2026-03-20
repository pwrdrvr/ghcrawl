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
    created_at_gh text,
    updated_at_gh text,
    unique(thread_id, comment_type, github_id)
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

  const clusterColumns = new Set(
    (db.prepare('pragma table_info(clusters)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!clusterColumns.has('closed_at_local')) {
    db.exec('alter table clusters add column closed_at_local text');
  }
  if (!clusterColumns.has('close_reason_local')) {
    db.exec('alter table clusters add column close_reason_local text');
  }

  db.exec('create index if not exists idx_threads_repo_number on threads(repo_id, number)');
  db.exec('create index if not exists idx_document_summaries_thread_model on document_summaries(thread_id, model)');
  db.exec('create index if not exists idx_cluster_runs_repo_status_id on cluster_runs(repo_id, status, id)');
  db.exec('create index if not exists idx_clusters_repo_run_id on clusters(repo_id, cluster_run_id, id)');
  db.exec('create index if not exists idx_cluster_members_thread_cluster on cluster_members(thread_id, cluster_id)');

  // Snapshot-then-merge tables: store per-run cluster snapshots and track
  // active/previous run pointers per repo (see docs/designs/cluster-storage-cleanup.md)
  db.exec(`
    create table if not exists repo_cluster_state (
      repo_id integer primary key references repositories(id) on delete cascade,
      active_cluster_run_id integer references cluster_runs(id) on delete set null,
      previous_cluster_run_id integer references cluster_runs(id) on delete set null,
      updated_at text not null
    )
  `);
  db.exec(`
    create table if not exists cluster_snapshots (
      id integer primary key autoincrement,
      repo_id integer not null references repositories(id) on delete cascade,
      cluster_run_id integer not null references cluster_runs(id) on delete cascade,
      cluster_id integer not null references clusters(id) on delete cascade,
      representative_thread_id integer,
      member_thread_ids text not null,
      member_count integer not null,
      created_at text not null default (datetime('now'))
    )
  `);
  db.exec(
    'create index if not exists idx_cluster_snapshots_repo_run on cluster_snapshots(repo_id, cluster_run_id)',
  );
}
