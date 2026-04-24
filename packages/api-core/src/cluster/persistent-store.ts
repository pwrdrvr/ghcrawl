import crypto from 'node:crypto';

import type { SqliteDatabase } from '../db/sqlite.js';
import type { EvidenceTier, SimilarityEvidenceBreakdown } from './evidence-score.js';
import type { DeterministicThreadFingerprint } from './thread-fingerprint.js';

function nowIso(): string {
  return new Date().toISOString();
}

function stableHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function jsonHash(value: unknown): string {
  return stableHash(JSON.stringify(value));
}

function upsertInlineBlob(
  db: SqliteDatabase,
  params: {
    text: string;
    mediaType: string;
  },
): number {
  const sha256 = stableHash(params.text);
  db.prepare(
    `insert into blobs (sha256, media_type, compression, size_bytes, storage_kind, storage_path, inline_text, created_at)
     values (?, ?, 'none', ?, 'inline', null, ?, ?)
     on conflict(sha256) do nothing`,
  ).run(sha256, params.mediaType, Buffer.byteLength(params.text), params.text, nowIso());
  const row = db.prepare('select id from blobs where sha256 = ? limit 1').get(sha256) as { id: number };
  return row.id;
}

export type PipelineRunKind = 'sync' | 'fingerprint' | 'enrich' | 'edge' | 'cluster';

export function upsertThreadRevision(
  db: SqliteDatabase,
  params: {
    threadId: number;
    sourceUpdatedAt?: string | null;
    title: string;
    body?: string | null;
    labels: string[];
    rawJson?: string | null;
  },
): number {
  const labels = Array.from(new Set(params.labels)).sort();
  const contentHash = jsonHash({
    title: params.title,
    body: params.body ?? '',
    labels,
    rawJson: params.rawJson ?? null,
  });
  const rawJsonBlobId =
    params.rawJson && params.rawJson !== '{}'
      ? upsertInlineBlob(db, {
          text: params.rawJson,
          mediaType: 'application/vnd.ghcrawl.thread.raw+json',
        })
      : null;
  db.prepare(
    `insert into thread_revisions (
       thread_id, source_updated_at, content_hash, title_hash, body_hash, labels_hash, raw_json_blob_id, created_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(thread_id, content_hash) do update set
       source_updated_at = excluded.source_updated_at,
       raw_json_blob_id = excluded.raw_json_blob_id`,
  ).run(
    params.threadId,
    params.sourceUpdatedAt ?? null,
    contentHash,
    stableHash(params.title),
    stableHash(params.body ?? ''),
    jsonHash(labels),
    rawJsonBlobId,
    nowIso(),
  );
  const row = db
    .prepare('select id from thread_revisions where thread_id = ? and content_hash = ? limit 1')
    .get(params.threadId, contentHash) as { id: number };
  return row.id;
}

export function upsertThreadFingerprint(
  db: SqliteDatabase,
  params: {
    threadRevisionId: number;
    fingerprint: DeterministicThreadFingerprint;
  },
): void {
  const minhashBlobId = upsertInlineBlob(db, {
    text: JSON.stringify(params.fingerprint.minhashSignature),
    mediaType: 'application/vnd.ghcrawl.minhash+json',
  });
  const winnowBlobId = upsertInlineBlob(db, {
    text: JSON.stringify(params.fingerprint.winnowHashes),
    mediaType: 'application/vnd.ghcrawl.winnow+json',
  });
  const featureJson = JSON.stringify({
    salientTitleTokens: params.fingerprint.salientTitleTokens,
    hunkSignatures: params.fingerprint.hunkSignatures,
    patchIds: params.fingerprint.patchIds,
  });
  db.prepare(
    `insert into thread_fingerprints (
       thread_revision_id, algorithm_version, fingerprint_hash, fingerprint_slug,
       title_tokens_json, body_token_hash, linked_refs_json, file_set_hash, module_buckets_json,
       minhash_signature_blob_id, simhash64, winnow_hashes_blob_id, feature_json, created_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(thread_revision_id, algorithm_version) do update set
       fingerprint_hash = excluded.fingerprint_hash,
       fingerprint_slug = excluded.fingerprint_slug,
       title_tokens_json = excluded.title_tokens_json,
       body_token_hash = excluded.body_token_hash,
       linked_refs_json = excluded.linked_refs_json,
       file_set_hash = excluded.file_set_hash,
       module_buckets_json = excluded.module_buckets_json,
       minhash_signature_blob_id = excluded.minhash_signature_blob_id,
       simhash64 = excluded.simhash64,
       winnow_hashes_blob_id = excluded.winnow_hashes_blob_id,
       feature_json = excluded.feature_json`,
  ).run(
    params.threadRevisionId,
    params.fingerprint.algorithmVersion,
    params.fingerprint.fingerprintHash,
    params.fingerprint.fingerprintSlug,
    JSON.stringify(params.fingerprint.titleTokens),
    jsonHash(params.fingerprint.bodyTokens),
    JSON.stringify(params.fingerprint.linkedRefs),
    jsonHash(params.fingerprint.changedFiles),
    JSON.stringify(params.fingerprint.moduleBuckets),
    minhashBlobId,
    params.fingerprint.simhash64,
    winnowBlobId,
    featureJson,
    nowIso(),
  );
}

export function createPipelineRun(
  db: SqliteDatabase,
  params: {
    repoId: number;
    runKind: PipelineRunKind;
    algorithmVersion?: string | null;
    configHash?: string | null;
  },
): number {
  const result = db
    .prepare(
      `insert into pipeline_runs (repo_id, run_kind, algorithm_version, config_hash, status, started_at)
       values (?, ?, ?, ?, 'running', ?)`,
    )
    .run(params.repoId, params.runKind, params.algorithmVersion ?? null, params.configHash ?? null, nowIso());
  return Number(result.lastInsertRowid);
}

export function finishPipelineRun(
  db: SqliteDatabase,
  runId: number,
  params: { status: 'completed' | 'failed'; stats?: unknown; errorText?: string | null },
): void {
  db.prepare('update pipeline_runs set status = ?, finished_at = ?, stats_json = ?, error_text = ? where id = ?').run(
    params.status,
    nowIso(),
    JSON.stringify(params.stats ?? null),
    params.errorText ?? null,
    runId,
  );
}

export function upsertSimilarityEdgeEvidence(
  db: SqliteDatabase,
  params: {
    repoId: number;
    leftThreadId: number;
    rightThreadId: number;
    algorithmVersion: string;
    configHash: string;
    score: number;
    tier: Exclude<EvidenceTier, 'none'>;
    state?: 'active' | 'stale' | 'rejected';
    breakdown: SimilarityEvidenceBreakdown | unknown;
    runId: number;
  },
): void {
  const left = Math.min(params.leftThreadId, params.rightThreadId);
  const right = Math.max(params.leftThreadId, params.rightThreadId);
  const createdAt = nowIso();
  db.prepare(
    `insert into similarity_edge_evidence (
       repo_id, left_thread_id, right_thread_id, algorithm_version, config_hash,
       score, tier, state, breakdown_json, first_seen_run_id, last_seen_run_id, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(repo_id, left_thread_id, right_thread_id, algorithm_version, config_hash) do update set
       score = excluded.score,
       tier = excluded.tier,
       state = excluded.state,
       breakdown_json = excluded.breakdown_json,
       last_seen_run_id = excluded.last_seen_run_id,
       updated_at = excluded.updated_at`,
  ).run(
    params.repoId,
    left,
    right,
    params.algorithmVersion,
    params.configHash,
    params.score,
    params.tier,
    params.state ?? 'active',
    JSON.stringify(params.breakdown),
    params.runId,
    params.runId,
    createdAt,
    createdAt,
  );
}

export function upsertClusterGroup(
  db: SqliteDatabase,
  params: {
    repoId: number;
    stableKey: string;
    stableSlug: string;
    status?: 'active' | 'closed' | 'merged' | 'split';
    clusterType?: string | null;
    representativeThreadId?: number | null;
    title?: string | null;
  },
): number {
  const timestamp = nowIso();
  db.prepare(
    `insert into cluster_groups (
       repo_id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title, created_at, updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(repo_id, stable_key) do update set
       stable_slug = excluded.stable_slug,
       status = excluded.status,
       cluster_type = excluded.cluster_type,
       representative_thread_id = excluded.representative_thread_id,
       title = excluded.title,
       updated_at = excluded.updated_at`,
  ).run(
    params.repoId,
    params.stableKey,
    params.stableSlug,
    params.status ?? 'active',
    params.clusterType ?? null,
    params.representativeThreadId ?? null,
    params.title ?? null,
    timestamp,
    timestamp,
  );
  const row = db
    .prepare('select id from cluster_groups where repo_id = ? and stable_key = ? limit 1')
    .get(params.repoId, params.stableKey) as { id: number };
  return row.id;
}

export function upsertClusterMembership(
  db: SqliteDatabase,
  params: {
    clusterId: number;
    threadId: number;
    role: 'canonical' | 'duplicate' | 'related';
    state: 'active' | 'removed_by_user' | 'blocked_by_override' | 'pending_review' | 'stale';
    scoreToRepresentative?: number | null;
    runId?: number | null;
    addedBy: 'algo' | 'user' | 'import';
    removedBy?: 'algo' | 'user' | null;
    addedReason?: unknown;
    removedReason?: unknown;
  },
): void {
  const timestamp = nowIso();
  db.prepare(
    `insert into cluster_memberships (
       cluster_id, thread_id, role, state, score_to_representative,
       first_seen_run_id, last_seen_run_id, added_by, removed_by,
       added_reason_json, removed_reason_json, created_at, updated_at, removed_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(cluster_id, thread_id) do update set
       role = excluded.role,
       state = excluded.state,
       score_to_representative = excluded.score_to_representative,
       last_seen_run_id = excluded.last_seen_run_id,
       removed_by = excluded.removed_by,
       removed_reason_json = excluded.removed_reason_json,
       updated_at = excluded.updated_at,
       removed_at = excluded.removed_at`,
  ).run(
    params.clusterId,
    params.threadId,
    params.role,
    params.state,
    params.scoreToRepresentative ?? null,
    params.runId ?? null,
    params.runId ?? null,
    params.addedBy,
    params.removedBy ?? null,
    JSON.stringify(params.addedReason ?? null),
    JSON.stringify(params.removedReason ?? null),
    timestamp,
    timestamp,
    params.state === 'active' ? null : timestamp,
  );
}

export function recordClusterEvent(
  db: SqliteDatabase,
  params: {
    clusterId: number;
    runId?: number | null;
    eventType: string;
    actorKind: 'algo' | 'user' | 'import';
    actorId?: number | null;
    payload: unknown;
  },
): void {
  db.prepare(
    `insert into cluster_events (cluster_id, run_id, event_type, actor_kind, actor_id, payload_json, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(params.clusterId, params.runId ?? null, params.eventType, params.actorKind, params.actorId ?? null, JSON.stringify(params.payload), nowIso());
}
