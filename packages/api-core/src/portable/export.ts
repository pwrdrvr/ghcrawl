import fs from 'node:fs';
import path from 'node:path';

import { checkpointWal, openDb, type SqliteDatabase } from '../db/sqlite.js';
import { validatePortableSyncDatabase } from './inspect.js';
import { createPortableSyncSchema } from './schema.js';
import { attachedTableHasColumn, countRows, fileSize, nowIso, sha256File, sqlStringLiteral } from './sqlite-utils.js';
import {
  DEFAULT_PORTABLE_BODY_CHARS,
  PORTABLE_SYNC_EXCLUDED_TABLES,
  PORTABLE_SYNC_SCHEMA_VERSION,
  PORTABLE_SYNC_TABLES,
  type PortableSyncExportOptions,
  type PortableSyncExportResponse,
  type PortableSyncManifest,
  type PortableSyncProfile,
} from './types.js';

export function exportPortableSyncDatabase(params: PortableSyncExportOptions): PortableSyncExportResponse {
  const profile: PortableSyncProfile | 'default' = params.profile ?? 'default';
  const bodyChars = params.bodyChars ?? bodyCharsForProfile(params.profile);
  if (!Number.isSafeInteger(bodyChars) || bodyChars < 0) {
    throw new Error('bodyChars must be a non-negative integer');
  }

  const sourcePath = path.resolve(params.sourcePath);
  const outputPath = path.resolve(params.outputPath);
  if (outputPath === sourcePath) {
    throw new Error('Refusing to export portable sync database over the source database');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tmpPath, { force: true });
  fs.rmSync(`${tmpPath}-wal`, { force: true });
  fs.rmSync(`${tmpPath}-shm`, { force: true });

  checkpointWal(params.sourceDb);
  const out = openDb(tmpPath);
  try {
    out.pragma('journal_mode = DELETE');
    out.exec('pragma foreign_keys = OFF');
    createPortableSyncSchema(out);
    out.exec(`attach database ${sqlStringLiteral(sourcePath)} as source`);
    populatePortableSyncDb(out, {
      repoId: params.repository.id,
      sourcePath,
      bodyChars,
    });
    out.exec('detach database source');
    out.exec('pragma foreign_keys = ON');
    out.exec('analyze');
    out.exec('pragma optimize');
    out.exec('vacuum');
  } catch (error) {
    try {
      out.close();
    } catch {
      // Ignore cleanup close errors after an export failure.
    }
    fs.rmSync(tmpPath, { force: true });
    fs.rmSync(`${tmpPath}-wal`, { force: true });
    fs.rmSync(`${tmpPath}-shm`, { force: true });
    throw error;
  }
  out.close();

  removeSqliteSidecars(outputPath);
  fs.renameSync(tmpPath, outputPath);
  removeSqliteSidecars(tmpPath);
  removeSqliteSidecars(outputPath);

  const outputBytes = fs.statSync(outputPath).size;
  const sourceBytes = fs.statSync(sourcePath).size + fileSize(`${sourcePath}-wal`) + fileSize(`${sourcePath}-shm`);
  const verify = openDb(outputPath);
  try {
    verify.pragma('journal_mode = DELETE');
    const tables = PORTABLE_SYNC_TABLES.map((name) => ({ name, rows: countRows(verify, name) }));
    const responseBase: Omit<PortableSyncExportResponse, 'manifest' | 'manifestPath'> = {
      ok: true,
      repository: {
        id: params.repository.id,
        owner: params.repository.owner,
        name: params.repository.name,
        fullName: params.repository.fullName,
      },
      outputPath,
      sourcePath,
      sourceBytes,
      outputBytes,
      compressionRatio: sourceBytes > 0 ? outputBytes / sourceBytes : 0,
      bodyChars,
      profile,
      tables,
      excluded: [...PORTABLE_SYNC_EXCLUDED_TABLES],
    };
    const validation = validatePortableSyncDatabase(outputPath);
    const manifest = buildPortableSyncManifest(responseBase, validation.ok);
    const manifestPath = params.writeManifest ? writePortableSyncManifest(outputPath, manifest) : null;

    return {
      ...responseBase,
      manifestPath,
      manifest,
    };
  } finally {
    verify.close();
  }
}

export function populatePortableSyncDb(db: SqliteDatabase, params: { repoId: number; sourcePath: string; bodyChars: number }): void {
  const exportedAt = nowIso();
  const insertMetadata = db.prepare('insert into portable_metadata (key, value) values (?, ?)');
  insertMetadata.run('schema', PORTABLE_SYNC_SCHEMA_VERSION);
  insertMetadata.run('exported_at', exportedAt);
  insertMetadata.run('source_path', params.sourcePath);
  insertMetadata.run('body_chars', String(params.bodyChars));
  insertMetadata.run('excluded', 'raw_json,comments,documents,fts,vectors,code_snapshots,cluster_events,run_history,similarity_edges,blobs');

  db.prepare(
    `insert into repositories (id, owner, name, full_name, github_repo_id, updated_at)
     select id, owner, name, full_name, github_repo_id, updated_at
     from source.repositories
     where id = ?`,
  ).run(params.repoId);

  db.prepare(
    `insert into threads (
      id, repo_id, github_id, number, kind, state, title, body_excerpt, body_length, author_login, author_type, html_url,
      labels_json, assignees_json, content_hash, is_draft, created_at_gh, updated_at_gh, closed_at_gh,
      merged_at_gh, first_pulled_at, last_pulled_at, updated_at, closed_at_local, close_reason_local
    )
    select
      id, repo_id, github_id, number, kind, state, title,
      case
        when body is null then null
        when ? = 0 then ''
        when length(body) <= ? then body
        else substr(body, 1, ?)
      end,
      case when body is null then 0 else length(body) end,
      author_login, author_type, html_url, labels_json, assignees_json, content_hash, is_draft,
      created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at,
      updated_at, closed_at_local, close_reason_local
    from source.threads
    where repo_id = ?`,
  ).run(params.bodyChars, params.bodyChars, params.bodyChars, params.repoId);

  db.prepare(
    `insert into thread_revisions (id, thread_id, source_updated_at, content_hash, title_hash, body_hash, labels_hash, created_at)
     select tr.id, tr.thread_id, tr.source_updated_at, tr.content_hash, tr.title_hash, tr.body_hash, tr.labels_hash, tr.created_at
     from source.thread_revisions tr
     join threads t on t.id = tr.thread_id`,
  ).run();

  db.prepare(
    `insert into thread_fingerprints (
      id, thread_revision_id, algorithm_version, fingerprint_hash, fingerprint_slug, title_tokens_json, body_token_hash,
      linked_refs_json, file_set_hash, module_buckets_json, simhash64, feature_json, created_at
    )
    select
      tf.id, tf.thread_revision_id, tf.algorithm_version, tf.fingerprint_hash, tf.fingerprint_slug, tf.title_tokens_json,
      tf.body_token_hash, tf.linked_refs_json, tf.file_set_hash, tf.module_buckets_json, tf.simhash64, tf.feature_json, tf.created_at
    from source.thread_fingerprints tf
    join thread_revisions tr on tr.id = tf.thread_revision_id`,
  ).run();

  db.prepare(
    `insert into thread_key_summaries (
      id, thread_revision_id, summary_kind, prompt_version, provider, model, input_hash, output_hash, key_text, created_at
    )
    select
      tks.id, tks.thread_revision_id, tks.summary_kind, tks.prompt_version, tks.provider, tks.model,
      tks.input_hash, tks.output_hash, tks.key_text, tks.created_at
    from source.thread_key_summaries tks
    join thread_revisions tr on tr.id = tks.thread_revision_id`,
  ).run();

  db.prepare('insert into repo_sync_state select * from source.repo_sync_state where repo_id = ?').run(params.repoId);
  db.prepare('insert into repo_pipeline_state select * from source.repo_pipeline_state where repo_id = ?').run(params.repoId);
  db.prepare('insert into cluster_groups select * from source.cluster_groups where repo_id = ?').run(params.repoId);
  db.prepare(
    `insert into cluster_memberships
     select cm.*
     from source.cluster_memberships cm
     join cluster_groups cg on cg.id = cm.cluster_id
     join threads t on t.id = cm.thread_id`,
  ).run();
  const overrideActorExpr = attachedTableHasColumn(db, 'source', 'cluster_overrides', 'actor_id') ? 'co.actor_id' : 'null';
  db.prepare(
    `insert into cluster_overrides (
      id, repo_id, cluster_id, thread_id, action, actor_id, reason, created_at, expires_at
    )
     select co.id, co.repo_id, co.cluster_id, co.thread_id, co.action, ${overrideActorExpr}, co.reason, co.created_at, co.expires_at
     from source.cluster_overrides co
     join cluster_groups cg on cg.id = co.cluster_id
     join threads t on t.id = co.thread_id
     where co.repo_id = ?`,
  ).run(params.repoId);
  db.prepare(
    `insert into cluster_aliases
     select ca.*
     from source.cluster_aliases ca
     join cluster_groups cg on cg.id = ca.cluster_id`,
  ).run();
  db.prepare(
    `insert into cluster_closures
     select cc.*
     from source.cluster_closures cc
     join cluster_groups cg on cg.id = cc.cluster_id`,
  ).run();
}

function bodyCharsForProfile(profile: PortableSyncProfile | undefined): number {
  if (profile === 'lean') return 256;
  if (profile === 'review') return 1024;
  return DEFAULT_PORTABLE_BODY_CHARS;
}

function buildPortableSyncManifest(
  response: Omit<PortableSyncExportResponse, 'manifest' | 'manifestPath'>,
  validationOk: boolean,
): PortableSyncManifest {
  return {
    schema: PORTABLE_SYNC_SCHEMA_VERSION,
    profile: response.profile,
    exportedAt: nowIso(),
    outputPath: response.outputPath,
    outputBytes: response.outputBytes,
    sha256: sha256File(response.outputPath),
    repository: response.repository,
    bodyChars: response.bodyChars,
    tables: response.tables,
    excluded: response.excluded,
    validationOk,
  };
}

function writePortableSyncManifest(outputPath: string, manifest: PortableSyncManifest): string {
  const manifestPath = `${outputPath}.manifest.json`;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

function removeSqliteSidecars(dbPath: string): void {
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}
