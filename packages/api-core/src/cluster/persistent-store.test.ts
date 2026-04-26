import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '../db/migrate.js';
import { openDb } from '../db/sqlite.js';
import { buildCodeSnapshotSignature } from './code-signature.js';
import { scoreSimilarityEvidence } from './evidence-score.js';
import {
  createPipelineRun,
  finishPipelineRun,
  recordClusterEvent,
  upsertClusterGroup,
  upsertClusterMembership,
  upsertSimilarityEdgeEvidence,
  upsertThreadFingerprint,
  upsertThreadRevision,
  upsertThreadCodeSnapshot,
  upsertThreadKeySummary,
} from './persistent-store.js';
import { buildDeterministicThreadFingerprint } from './thread-fingerprint.js';

function seedRepoAndThreads(db: ReturnType<typeof openDb>): void {
  db.prepare(
    `insert into repositories (id, owner, name, full_name, github_repo_id, raw_json, updated_at)
     values (1, 'openclaw', 'openclaw', 'openclaw/openclaw', '1', '{}', '2026-01-01T00:00:00Z')`,
  ).run();
  const insertThread = db.prepare(
    `insert into threads (
      id, repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
      labels_json, assignees_json, raw_json, content_hash, is_draft, created_at_gh, updated_at_gh, updated_at
    ) values (?, 1, ?, ?, 'pull_request', 'open', ?, '', 'alice', 'User', ?, '[]', '[]', '{}', ?, 0, ?, ?, ?)`,
  );
  insertThread.run(10, '10', 10, 'Fix cache collision', 'https://github.com/openclaw/openclaw/pull/10', 'h10', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  insertThread.run(11, '11', 11, 'Fix cache collision', 'https://github.com/openclaw/openclaw/pull/11', 'h11', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

test('persistent cluster store upserts edge evidence and governed memberships', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    seedRepoAndThreads(db);
    const runId = createPipelineRun(db, {
      repoId: 1,
      runKind: 'cluster',
      algorithmVersion: 'test-v1',
      configHash: 'cfg',
    });
    const left = buildDeterministicThreadFingerprint({
      threadId: 10,
      number: 10,
      kind: 'pull_request',
      title: 'Fix cache collision',
      body: '',
      labels: [],
      changedFiles: ['packages/api-core/src/cache.ts'],
      linkedRefs: ['123'],
      hunkSignatures: ['h1'],
      patchIds: ['p1'],
    });
    const right = buildDeterministicThreadFingerprint({
      threadId: 11,
      number: 11,
      kind: 'pull_request',
      title: 'Fix cache collision',
      body: '',
      labels: [],
      changedFiles: ['packages/api-core/src/cache.ts'],
      linkedRefs: ['123'],
      hunkSignatures: ['h1'],
      patchIds: ['p1'],
    });
    const evidence = scoreSimilarityEvidence(left, right);
    assert.notEqual(evidence.tier, 'none');

    upsertSimilarityEdgeEvidence(db, {
      repoId: 1,
      leftThreadId: 10,
      rightThreadId: 11,
      algorithmVersion: 'test-v1',
      configHash: 'cfg',
      score: evidence.score,
      tier: evidence.tier === 'strong' ? 'strong' : 'weak',
      breakdown: evidence,
      runId,
    });
    const clusterId = upsertClusterGroup(db, {
      repoId: 1,
      stableKey: 'cluster-hash',
      stableSlug: 'focus-bridge-signal-9m',
      representativeThreadId: 10,
      title: 'Fix cache collision',
    });
    upsertClusterMembership(db, {
      clusterId,
      threadId: 10,
      role: 'canonical',
      state: 'active',
      scoreToRepresentative: 1,
      runId,
      addedBy: 'algo',
    });
    upsertClusterMembership(db, {
      clusterId,
      threadId: 11,
      role: 'related',
      state: 'active',
      scoreToRepresentative: evidence.score,
      runId,
      addedBy: 'algo',
    });
    recordClusterEvent(db, {
      clusterId,
      runId,
      eventType: 'add_member',
      actorKind: 'algo',
      payload: { threadId: 11 },
    });
    finishPipelineRun(db, runId, { status: 'completed', stats: { edges: 1, clusters: 1 } });

    const edgeCount = db.prepare('select count(*) as count from similarity_edge_evidence').get() as { count: number };
    const membershipCount = db.prepare('select count(*) as count from cluster_memberships').get() as { count: number };
    const eventCount = db.prepare('select count(*) as count from cluster_events').get() as { count: number };
    const run = db.prepare('select status from pipeline_runs where id = ?').get(runId) as { status: string };

    assert.equal(edgeCount.count, 1);
    assert.equal(membershipCount.count, 2);
    assert.equal(eventCount.count, 1);
    assert.equal(run.status, 'completed');
  } finally {
    db.close();
  }
});

test('persistent cluster store records thread revisions and deterministic fingerprints', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    seedRepoAndThreads(db);
    const fingerprint = buildDeterministicThreadFingerprint({
      threadId: 10,
      number: 10,
      kind: 'pull_request',
      title: 'Fix cache collision',
      body: 'Cache keys collide across repos.',
      labels: ['bug'],
      changedFiles: ['packages/api-core/src/cache.ts'],
      linkedRefs: ['123'],
      hunkSignatures: ['h1'],
      patchIds: ['p1'],
    });
    const revisionId = upsertThreadRevision(db, {
      threadId: 10,
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
      title: 'Fix cache collision',
      body: 'Cache keys collide across repos.',
      labels: ['bug'],
      rawJson: '{"number":10}',
    });

    upsertThreadFingerprint(db, { threadRevisionId: revisionId, fingerprint });
    upsertThreadFingerprint(db, { threadRevisionId: revisionId, fingerprint });

    const revisionCount = db.prepare('select count(*) as count from thread_revisions').get() as { count: number };
    const fingerprintRow = db
      .prepare(
        `select fingerprint_hash, fingerprint_slug, simhash64, minhash_signature_blob_id, winnow_hashes_blob_id
         from thread_fingerprints
         where thread_revision_id = ?`,
      )
      .get(revisionId) as {
      fingerprint_hash: string;
      fingerprint_slug: string;
      simhash64: string;
      minhash_signature_blob_id: number;
      winnow_hashes_blob_id: number;
    };
    const blobCount = db.prepare('select count(*) as count from blobs').get() as { count: number };

    assert.equal(revisionCount.count, 1);
    assert.equal(fingerprintRow.fingerprint_hash, fingerprint.fingerprintHash);
    assert.equal(fingerprintRow.fingerprint_slug, fingerprint.fingerprintSlug);
    assert.equal(fingerprintRow.simhash64, fingerprint.simhash64);
    assert.ok(fingerprintRow.minhash_signature_blob_id > 0);
    assert.ok(fingerprintRow.winnow_hashes_blob_id > 0);
    assert.equal(blobCount.count, 3);
  } finally {
    db.close();
  }
});

test('persistent cluster store records code snapshots, changed files, and hunk signatures', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    seedRepoAndThreads(db);
    const revisionId = upsertThreadRevision(db, {
      threadId: 10,
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
      title: 'Fix cache collision',
      body: '',
      labels: [],
      rawJson: '{}',
    });
    const signature = buildCodeSnapshotSignature([
      {
        filename: 'packages/api-core/src/cache.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: '@@ -1 +1 @@\n-oldKey\n+newKey',
      },
    ]);

    const snapshotId = upsertThreadCodeSnapshot(db, {
      threadRevisionId: revisionId,
      baseSha: 'base',
      headSha: 'head',
      signature,
    });

    const snapshot = db.prepare('select files_changed, additions, deletions, patch_digest, raw_diff_blob_id from thread_code_snapshots where id = ?').get(snapshotId) as {
      files_changed: number;
      additions: number;
      deletions: number;
      patch_digest: string;
      raw_diff_blob_id: number;
    };
    const file = db.prepare('select path, patch_blob_id from thread_changed_files where snapshot_id = ?').get(snapshotId) as {
      path: string;
      patch_blob_id: number;
    };
    const hunkCount = db.prepare('select count(*) as count from thread_hunk_signatures where snapshot_id = ?').get(snapshotId) as { count: number };

    assert.equal(snapshot.files_changed, 1);
    assert.equal(snapshot.additions, 1);
    assert.equal(snapshot.deletions, 1);
    assert.equal(snapshot.patch_digest, signature.patchDigest);
    assert.ok(snapshot.raw_diff_blob_id > 0);
    assert.equal(file.path, 'packages/api-core/src/cache.ts');
    assert.ok(file.patch_blob_id > 0);
    assert.equal(hunkCount.count, 1);
  } finally {
    db.close();
  }
});

test('persistent cluster store keeps large code patches out of SQLite', () => {
  const db = openDb(':memory:');
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-code-blob-'));
  try {
    migrate(db);
    seedRepoAndThreads(db);
    const revisionId = upsertThreadRevision(db, {
      threadId: 10,
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
      title: 'Fix cache collision',
      body: '',
      labels: [],
      rawJson: '{}',
    });
    const largePatch = `@@ -1 +1 @@\n-${'oldKey\n'.repeat(800)}+${'newKey\n'.repeat(800)}`;
    const signature = buildCodeSnapshotSignature([
      {
        filename: 'packages/api-core/src/cache.ts',
        status: 'modified',
        additions: 800,
        deletions: 800,
        changes: 1600,
        patch: largePatch,
      },
    ]);

    const snapshotId = upsertThreadCodeSnapshot(db, {
      threadRevisionId: revisionId,
      signature,
      storeRoot,
    });

    const blob = db
      .prepare(
        `select b.storage_kind, b.storage_path, b.inline_text
         from thread_changed_files f
         join blobs b on b.id = f.patch_blob_id
         where f.snapshot_id = ?`,
      )
      .get(snapshotId) as { storage_kind: string; storage_path: string | null; inline_text: string | null };

    assert.equal(blob.storage_kind, 'file');
    assert.equal(blob.inline_text, null);
    assert.ok(blob.storage_path);
    assert.ok(fs.existsSync(path.join(storeRoot, blob.storage_path)));
    const rawDiffBlob = db
      .prepare(
        `select b.storage_kind, b.storage_path, b.inline_text
         from thread_code_snapshots s
         join blobs b on b.id = s.raw_diff_blob_id
         where s.id = ?`,
      )
      .get(snapshotId) as { storage_kind: string; storage_path: string | null; inline_text: string | null };
    assert.equal(rawDiffBlob.storage_kind, 'file');
    assert.equal(rawDiffBlob.inline_text, null);
    assert.ok(rawDiffBlob.storage_path);
    assert.ok(fs.existsSync(path.join(storeRoot, rawDiffBlob.storage_path)));
  } finally {
    db.close();
    fs.rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('persistent cluster store records structured key summaries', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    seedRepoAndThreads(db);
    const revisionId = upsertThreadRevision(db, {
      threadId: 10,
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
      title: 'Fix cache collision',
      body: '',
      labels: [],
      rawJson: '{}',
    });

    upsertThreadKeySummary(db, {
      threadRevisionId: revisionId,
      summaryKind: 'llm_key_3line',
      promptVersion: 'llm-key-summary-v1',
      provider: 'openai',
      model: 'gpt-5.4',
      inputHash: 'input-hash',
      summary: {
        purpose: 'Keep cache entries distinct for repeated API reads.',
        intent: 'Fix cache collision.',
        surface: 'API core cache.',
        mechanism: 'Changes cache key derivation.',
      },
    });

    const row = db.prepare('select input_hash, key_text from thread_key_summaries where thread_revision_id = ?').get(revisionId) as {
      input_hash: string;
      key_text: string;
    };
    assert.equal(row.input_hash, 'input-hash');
    assert.match(row.key_text, /purpose: Keep cache entries distinct/);
    assert.match(row.key_text, /intent: Fix cache collision\./);
    assert.match(row.key_text, /surface: API core cache\./);
  } finally {
    db.close();
  }
});
