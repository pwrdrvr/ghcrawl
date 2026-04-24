import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate } from '../db/migrate.js';
import { openDb } from '../db/sqlite.js';
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
