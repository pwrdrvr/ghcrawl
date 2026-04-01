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
    assert.ok(names.includes('thread_vectors'));
    assert.ok(names.includes('cluster_runs'));
    assert.ok(names.includes('repo_sync_state'));
    assert.ok(names.includes('repo_pipeline_state'));

    const threadColumns = db.prepare('pragma table_info(threads)').all() as Array<{ name: string }>;
    const threadColumnNames = threadColumns.map((column) => column.name);
    assert.ok(threadColumnNames.includes('first_pulled_at'));
    assert.ok(threadColumnNames.includes('last_pulled_at'));

    const summaryColumns = db.prepare('pragma table_info(document_summaries)').all() as Array<{ name: string }>;
    assert.ok(summaryColumns.map((column) => column.name).includes('prompt_version'));
  } finally {
    db.close();
  }
});
