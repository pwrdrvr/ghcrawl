import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate } from './migrate.js';
import { openDb } from './sqlite.js';

test('migrate creates core tables', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const rows = db
      .prepare("select name from sqlite_master where type in ('table', 'view') order by name asc")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);

    assert.ok(names.includes('repositories'));
    assert.ok(names.includes('threads'));
    assert.ok(names.includes('documents'));
    assert.ok(names.includes('document_embeddings'));
    assert.ok(names.includes('cluster_runs'));
    assert.ok(names.includes('repo_sync_state'));
    assert.ok(names.includes('users'));
    assert.ok(names.includes('repo_user_state'));

    const threadColumns = db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>;
    const threadColumnNames = threadColumns.map((column) => column.name);
    assert.ok(threadColumnNames.includes('first_pulled_at'));
    assert.ok(threadColumnNames.includes('last_pulled_at'));
    assert.ok(threadColumnNames.includes('files_changed'));
    assert.ok(threadColumnNames.includes('additions'));
    assert.ok(threadColumnNames.includes('deletions'));
  } finally {
    db.close();
  }
});

test('migrate backfills open pull request size columns from raw_json', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`
      create table repositories (
        id integer primary key,
        owner text not null,
        name text not null,
        full_name text not null unique,
        github_repo_id text,
        raw_json text not null,
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
      );
    `);
    db.prepare(
      `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', '2026-03-12T00:00:00Z');
    db.prepare(
      `insert into threads (
        id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
        labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh,
        closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      10,
      1,
      '100',
      43,
      'pull_request',
      'open',
      'Fix downloader',
      'body',
      'alice',
      'User',
      'https://github.com/openclaw/openclaw/pull/43',
      '[]',
      '[]',
      JSON.stringify({ changed_files: 7, additions: 120, deletions: 30 }),
      'hash-10',
      0,
      '2026-03-01T00:00:00Z',
      '2026-03-12T00:00:00Z',
      null,
      null,
      '2026-03-12T00:00:00Z',
      '2026-03-12T00:00:00Z',
      '2026-03-12T00:00:00Z',
    );

    migrate(db);

    const row = db
      .prepare('select files_changed, additions, deletions from threads where id = 10')
      .get() as { files_changed: number | null; additions: number | null; deletions: number | null };
    assert.deepEqual(row, {
      files_changed: 7,
      additions: 120,
      deletions: 30,
    });
  } finally {
    db.close();
  }
});
