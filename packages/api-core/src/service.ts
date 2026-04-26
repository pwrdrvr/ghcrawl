import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { IterableMapper } from '@shutterstock/p-map-iterable';
import {
  actionResponseSchema,
  closeResponseSchema,
  clusterOverrideResponseSchema,
  clusterMergeResponseSchema,
  clusterSplitResponseSchema,
  clusterDetailResponseSchema,
  clusterResultSchema,
  clusterSummariesResponseSchema,
  embedResultSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  refreshResponseSchema,
  searchResponseSchema,
  syncResultSchema,
  type ActionRequest,
  type ActionResponse,
  type CloseResponse,
  type ClusterMergeResponse,
  type ClusterOverrideResponse,
  type ClusterSplitResponse,
  type ClusterDetailResponse,
  type ClusterExplainResponse,
  type ClusterResultDto,
  type ClusterSummariesResponse,
  type ClustersResponse,
  type DurableClustersResponse,
  type ExcludeClusterMemberRequest,
  type EmbedResultDto,
  type HealthResponse,
  type IncludeClusterMemberRequest,
  type MergeClustersRequest,
  type NeighborsResponse,
  type OptimizeResponse,
  type RefreshResponse,
  type RepositoriesResponse,
  type RepositoryDto,
  type RunHistoryResponse,
  type RunKind,
  type SearchHitDto,
  type SearchMode,
  type SearchResponse,
  type SetClusterCanonicalRequest,
  type SplitClusterRequest,
  type SyncResultDto,
  type ThreadsResponse,
} from '@ghcrawl/api-contract';

import { buildClusters, buildRefinedClusters, buildSizeBoundedClusters } from './cluster/build.js';
import { reconcileClusterCloseState } from './cluster/close-state.js';
import { buildDeterministicClusterGraphFromFingerprints } from './cluster/deterministic-engine.js';
import { loadDeterministicClusterableThreadMeta } from './cluster/deterministic-thread-loader.js';
import { explainStoredDurableCluster, listStoredDurableClusters } from './cluster/durable-queries.js';
import {
  collectSourceKindScores,
  edgeKey,
  finalizeEdgeScores,
  mergeSourceKindEdges,
  pruneWeakCrossKindEdges,
  type PerSourceScoreEntry,
} from './cluster/edge-aggregation.js';
import { resolveEdgeWorkerRuntime } from './cluster/edge-worker-runtime.js';
import { buildSourceKindEdges } from './cluster/exact-edges.js';
import { loadLatestDeterministicFingerprints } from './cluster/fingerprint-loader.js';
import { materializeLatestDeterministicFingerprints } from './cluster/fingerprint-materializer.js';
import { humanKeyForValue, humanKeyStableSlug } from './cluster/human-key.js';
import { listStoredClusters } from './cluster/list-query.js';
import { LLM_KEY_SUMMARY_PROMPT_VERSION, llmKeyInputHash } from './cluster/llm-key-summary.js';
import { listStoredClusterNeighbors } from './cluster/neighbor-queries.js';
import { summarizeClusterQuality, summarizeClusterSizes } from './cluster/quality.js';
import { getLatestClusterRun } from './cluster/run-queries.js';
import {
  createPipelineRun,
  finishPipelineRun,
  recordClusterEvent,
  upsertClusterGroup,
  upsertClusterMembership,
  upsertSimilarityEdgeEvidence,
  upsertThreadRevision,
  upsertThreadKeySummary,
} from './cluster/persistent-store.js';
import {
  ensureRuntimeDirs,
  loadConfig,
  requireGithubToken,
  requireOpenAiKey,
  type EmbeddingBasis,
  type ConfigValueSource,
  type GitcrawlConfig,
} from './config.js';
import { migrate } from './db/migrate.js';
import { checkpointWal, openDb, type SqliteDatabase } from './db/sqlite.js';
import { replaceComments, refreshThreadDocument } from './documents/store.js';
import { buildDoctorResult } from './doctor.js';
import { embedBatchWithRecovery } from './embedding/batch-runner.js';
import { chunkEmbeddingTasks } from './embedding/chunks.js';
import { loadClusterableActiveVectorMeta, loadClusterableThreadMeta, loadNormalizedActiveVectors } from './embedding/clusterable.js';
import {
  countEmbeddingsForSourceKind,
  iterateStoredEmbeddings,
  loadNormalizedEmbeddingsForSourceKind,
  loadStoredEmbeddingsForThreadNumber,
} from './embedding/queries.js';
import { activeVectorSourceKind } from './embedding/tasks.js';
import { getEmbeddingWorkset } from './embedding/workset.js';
import { makeGitHubClient, type GitHubClient } from './github/client.js';
import { OpenAiProvider, type AiProvider } from './openai/provider.js';
import {
  hasLegacyEmbeddings,
  isRepoVectorStateCurrent,
  markRepoClustersCurrent,
  markRepoVectorsCurrent,
} from './pipeline-state.js';
import {
  exportPortableSyncDatabase,
  importPortableSyncDatabase,
  portableSyncSizeReport,
  portableSyncStatusReport,
  validatePortableSyncDatabase,
  type PortableSyncExportResponse,
  type PortableSyncImportResponse,
  type PortableSyncSizeResponse,
  type PortableSyncStatusResponse,
  type PortableSyncValidationResponse,
} from './portable/sync-store.js';
import { finishServiceRun, listRunHistoryForRepository, startServiceRun } from './run-history.js';
import { listStoredRepositories } from './repositories/list.js';
import { cosineSimilarity, dotProduct, rankNearestNeighbors, rankNearestNeighborsByScore } from './search/exact.js';
import { optimizeStorageStores } from './storage-maintenance.js';
import { fetchThreadComments } from './sync/comments.js';
import { getSyncCursorState, writeSyncCursorState } from './sync/cursor.js';
import { persistThreadCodeSnapshot, upsertRepository, upsertThread } from './sync/persistence.js';
import { applyClosedOverlapSweep, countStaleOpenThreads, reconcileMissingOpenThreads } from './sync/reconcile.js';
import { buildKeySummaryInputText, buildSummarySource } from './summary/source.js';
import { compareTuiClusterSummary } from './tui/cluster-format.js';
import { closeRepositoryThreadLocally } from './threads/close.js';
import { listRepositoryThreads } from './threads/list.js';
import {
  getDurableTuiClusterSummary,
  getRawTuiClusterSummary,
  listTuiClusterMembers,
  listClosedDurableTuiClusters,
  listRawTuiClusters,
} from './tui/cluster-queries.js';
import { getTuiRepoStats, getTuiRepositoryRefreshState } from './tui/repo-stats.js';
import {
  getLatestTuiKeySummary,
  getLatestTuiThreadClusterId,
  getTopChangedFiles,
  getTuiThreadRow,
  getTuiThreadSummaries,
} from './tui/thread-detail.js';
import {
  ACTIVE_EMBED_DIMENSIONS,
  ACTIVE_EMBED_PIPELINE_VERSION,
  CLUSTER_PARALLEL_MIN_EMBEDDINGS,
  CLUSTER_PROGRESS_INTERVAL_MS,
  DEFAULT_CLUSTER_MAX_SIZE,
  DEFAULT_CLUSTER_MIN_SCORE,
  DEFAULT_CROSS_KIND_CLUSTER_MIN_SCORE,
  DEFAULT_DETERMINISTIC_CLUSTER_MIN_SCORE,
  DURABLE_CLUSTER_REUSE_MIN_OVERLAP,
  EMBED_MAX_BATCH_TOKENS,
  KEY_SUMMARY_CONCURRENCY,
  KEY_SUMMARY_MAX_BODY_CHARS,
  KEY_SUMMARY_MAX_UNREAD,
  MAX_DIRECT_RECONCILE_THREADS,
  requireFromHere,
  STALE_CLOSED_BACKFILL_LIMIT,
  SUMMARY_MODEL_PRICING,
  SUMMARY_PROMPT_VERSION,
  SYNC_BATCH_DELAY_MS,
  SYNC_BATCH_SIZE,
} from './service-constants.js';
import type {
  ActiveVectorRow,
  ActiveVectorTask,
  AggregatedClusterEdge,
  ClusterExperimentResult,
  DoctorResult,
  EmbeddingSourceKind,
  KeySummaryTask,
  NeighborsResultInternal,
  PortableSyncExportOptions,
  SearchResultInternal,
  SyncCursorState,
  SyncOptions,
  SyncRunStats,
  ThreadRow,
  TuiClusterDetail,
  TuiClusterSortMode,
  TuiRefreshState,
  TuiSnapshot,
  TuiThreadDetail,
} from './service-types.js';
import {
  asJson,
  deriveIncrementalSince,
  isClosedGitHubPayload,
  isPullRequestPayload,
  nowIso,
  parseArray,
  parseIso,
  repositoryToDto,
  snippetText,
  stableContentHash,
  threadToDto,
} from './service-utils.js';
import type { VectorNeighbor, VectorQueryParams, VectorStore } from './vector/store.js';
import { getVectorliteClusterQuery, normalizedDistanceToScore, normalizedEmbeddingBuffer, parseStoredVector, vectorBlob } from './vector/encoding.js';
import {
  cleanupMigratedRepositoryArtifacts,
  pruneInactiveRepositoryVectors,
  queryNearestWithRecovery,
  rebuildRepositoryVectorStore,
  resetRepositoryVectors,
} from './vector/repository-maintenance.js';
import { isCorruptedVectorIndexError, repositoryVectorStorePath } from './vector/repository-store.js';
import { VectorliteStore } from './vector/vectorlite-store.js';

export type { DoctorResult, TuiClusterDetail, TuiClusterMember, TuiClusterSortMode, TuiClusterSummary, TuiRefreshState, TuiRepoStats, TuiSnapshot, TuiThreadDetail } from './service-types.js';
export { parseRepoParams } from './api/params.js';

export class GHCrawlService {
  readonly config: GitcrawlConfig;
  readonly db: SqliteDatabase;
  readonly github?: GitHubClient;
  readonly ai?: AiProvider;
  readonly vectorStore: VectorStore;

  constructor(options: {
    config?: GitcrawlConfig;
    db?: SqliteDatabase;
    github?: GitHubClient;
    ai?: AiProvider;
    vectorStore?: VectorStore;
  } = {}) {
    this.config = options.config ?? loadConfig();
    ensureRuntimeDirs(this.config);
    this.db = options.db ?? openDb(this.config.dbPath);
    migrate(this.db);
    this.github = options.github ?? (this.config.githubToken ? makeGitHubClient({ token: this.config.githubToken }) : undefined);
    this.ai = options.ai ?? (this.config.openaiApiKey ? new OpenAiProvider(this.config.openaiApiKey) : undefined);
    this.vectorStore = options.vectorStore ?? new VectorliteStore();
  }

  close(): void {
    this.vectorStore.close();
    checkpointWal(this.db);
    this.db.close();
  }

  init(): HealthResponse {
    ensureRuntimeDirs(this.config);
    migrate(this.db);
    const response = {
      ok: true,
      configPath: this.config.configPath,
      configFileExists: this.config.configFileExists,
      dbPath: this.config.dbPath,
      apiPort: this.config.apiPort,
      githubConfigured: Boolean(this.config.githubToken),
      openaiConfigured: Boolean(this.config.openaiApiKey),
    };
    return healthResponseSchema.parse(response);
  }

  async doctor(): Promise<DoctorResult> {
    return buildDoctorResult({
      health: this.init(),
      config: this.config,
      vectorStore: this.vectorStore,
    });
  }

  listRepositories(): RepositoriesResponse {
    return listStoredRepositories(this.db);
  }

  listRunHistory(params: { owner: string; repo: string; kind?: RunKind; limit?: number }): RunHistoryResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return listRunHistoryForRepository({
      db: this.db,
      repository,
      kind: params.kind,
      limit: params.limit,
    });
  }

  listThreads(params: { owner: string; repo: string; kind?: 'issue' | 'pull_request'; numbers?: number[]; includeClosed?: boolean }): ThreadsResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return listRepositoryThreads(this.db, {
      repository,
      kind: params.kind,
      numbers: params.numbers,
      includeClosed: params.includeClosed,
    });
  }

  closeThreadLocally(params: { owner: string; repo: string; threadNumber: number }): CloseResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return closeRepositoryThreadLocally(this.db, repository, params.threadNumber);
  }

  closeClusterLocally(params: { owner: string; repo: string; clusterId: number }): CloseResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const latestRun = getLatestClusterRun(this.db, repository.id);
    if (!latestRun) {
      throw new Error(`No completed cluster run found for ${repository.fullName}.`);
    }

    const row = this.db
      .prepare('select id, representative_thread_id from clusters where repo_id = ? and cluster_run_id = ? and id = ? limit 1')
      .get(repository.id, latestRun.id, params.clusterId) as { id: number; representative_thread_id: number | null } | undefined;
    if (!row) {
      throw new Error(`Cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const closedAt = nowIso();
    let durableClusterId = 0;
    this.db.transaction(() => {
      durableClusterId = this.ensureDurableClusterForRunCluster(repository.id, row.id, row.representative_thread_id);
      this.db
        .prepare(
          `update clusters
           set closed_at_local = ?,
               close_reason_local = 'manual'
           where id = ?`,
        )
        .run(closedAt, row.id);
      this.db
        .prepare(
          `insert into cluster_closures (cluster_id, reason, actor_kind, created_at, updated_at)
           values (?, 'manual', 'user', ?, ?)
           on conflict(cluster_id) do update set
             reason = excluded.reason,
             actor_kind = excluded.actor_kind,
             updated_at = excluded.updated_at`,
        )
        .run(durableClusterId, closedAt, closedAt);
      recordClusterEvent(this.db, {
        clusterId: durableClusterId,
        eventType: 'manual_close_cluster',
        actorKind: 'user',
        payload: {
          runClusterId: row.id,
          reason: 'manual',
        },
      });
    })();

    return closeResponseSchema.parse({
      ok: true,
      repository,
      clusterId: row.id,
      clusterClosed: true,
      message: `Marked cluster ${row.id} closed locally.`,
    });
  }

  excludeThreadFromCluster(params: ExcludeClusterMemberRequest): ClusterOverrideResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const cluster = this.db
      .prepare('select id from cluster_groups where repo_id = ? and id = ? limit 1')
      .get(repository.id, params.clusterId) as { id: number } | undefined;
    if (!cluster) {
      throw new Error(`Durable cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const thread = this.db
      .prepare('select * from threads where repo_id = ? and number = ? limit 1')
      .get(repository.id, params.threadNumber) as ThreadRow | undefined;
    if (!thread) {
      throw new Error(`Thread #${params.threadNumber} was not found for ${repository.fullName}.`);
    }

    const existingMembership = this.db
      .prepare('select role, score_to_representative from cluster_memberships where cluster_id = ? and thread_id = ? limit 1')
      .get(cluster.id, thread.id) as { role: 'canonical' | 'duplicate' | 'related'; score_to_representative: number | null } | undefined;
    const timestamp = nowIso();
    this.db
      .prepare(
        `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at)
         values (?, ?, ?, 'exclude', ?, ?, null)
         on conflict(cluster_id, thread_id, action) do update set
           reason = excluded.reason,
           created_at = excluded.created_at,
           expires_at = null`,
      )
      .run(repository.id, cluster.id, thread.id, params.reason ?? null, timestamp);

    upsertClusterMembership(this.db, {
      clusterId: cluster.id,
      threadId: thread.id,
      role: existingMembership?.role ?? 'related',
      state: 'removed_by_user',
      scoreToRepresentative: existingMembership?.score_to_representative ?? null,
      addedBy: 'user',
      removedBy: 'user',
      addedReason: {
        source: 'excludeThreadFromCluster',
      },
      removedReason: {
        source: 'cluster_overrides',
        action: 'exclude',
        reason: params.reason ?? null,
      },
    });
    recordClusterEvent(this.db, {
      clusterId: cluster.id,
      eventType: 'manual_exclude_member',
      actorKind: 'user',
      payload: {
        threadId: thread.id,
        threadNumber: thread.number,
        reason: params.reason ?? null,
      },
    });

    return clusterOverrideResponseSchema.parse({
      ok: true,
      repository,
      clusterId: cluster.id,
      thread: threadToDto(thread),
      action: 'exclude',
      state: 'removed_by_user',
      message: `Removed ${thread.kind} #${thread.number} from durable cluster ${cluster.id}.`,
    });
  }

  includeThreadInCluster(params: IncludeClusterMemberRequest): ClusterOverrideResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const cluster = this.db
      .prepare('select id from cluster_groups where repo_id = ? and id = ? limit 1')
      .get(repository.id, params.clusterId) as { id: number } | undefined;
    if (!cluster) {
      throw new Error(`Durable cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const thread = this.db
      .prepare('select * from threads where repo_id = ? and number = ? limit 1')
      .get(repository.id, params.threadNumber) as ThreadRow | undefined;
    if (!thread) {
      throw new Error(`Thread #${params.threadNumber} was not found for ${repository.fullName}.`);
    }

    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare("delete from cluster_overrides where cluster_id = ? and thread_id = ? and action = 'exclude'")
        .run(cluster.id, thread.id);
      this.db
        .prepare(
          `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at)
           values (?, ?, ?, 'force_include', ?, ?, null)
           on conflict(cluster_id, thread_id, action) do update set
             reason = excluded.reason,
             created_at = excluded.created_at,
             expires_at = null`,
        )
        .run(repository.id, cluster.id, thread.id, params.reason ?? null, timestamp);
      upsertClusterMembership(this.db, {
        clusterId: cluster.id,
        threadId: thread.id,
        role: 'related',
        state: 'active',
        scoreToRepresentative: null,
        addedBy: 'user',
        addedReason: {
          source: 'includeThreadInCluster',
          reason: params.reason ?? null,
        },
      });
      this.db
        .prepare("update cluster_memberships set added_by = 'user', updated_at = ? where cluster_id = ? and thread_id = ?")
        .run(timestamp, cluster.id, thread.id);
      recordClusterEvent(this.db, {
        clusterId: cluster.id,
        eventType: 'manual_force_include',
        actorKind: 'user',
        payload: {
          threadId: thread.id,
          threadNumber: thread.number,
          reason: params.reason ?? null,
        },
      });
    })();

    return clusterOverrideResponseSchema.parse({
      ok: true,
      repository,
      clusterId: cluster.id,
      thread: threadToDto(thread),
      action: 'force_include',
      state: 'active',
      message: `Included ${thread.kind} #${thread.number} in durable cluster ${cluster.id}.`,
    });
  }

  setClusterCanonicalThread(params: SetClusterCanonicalRequest): ClusterOverrideResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const cluster = this.db
      .prepare('select id from cluster_groups where repo_id = ? and id = ? limit 1')
      .get(repository.id, params.clusterId) as { id: number } | undefined;
    if (!cluster) {
      throw new Error(`Durable cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const thread = this.db
      .prepare('select * from threads where repo_id = ? and number = ? limit 1')
      .get(repository.id, params.threadNumber) as ThreadRow | undefined;
    if (!thread) {
      throw new Error(`Thread #${params.threadNumber} was not found for ${repository.fullName}.`);
    }

    const membership = this.db
      .prepare('select score_to_representative from cluster_memberships where cluster_id = ? and thread_id = ? limit 1')
      .get(cluster.id, thread.id) as { score_to_representative: number | null } | undefined;
    if (!membership) {
      throw new Error(`Thread #${params.threadNumber} is not a member of durable cluster ${cluster.id}.`);
    }

    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `delete from cluster_overrides
           where cluster_id = ?
             and action = 'force_canonical'
             and thread_id <> ?`,
        )
        .run(cluster.id, thread.id);
      this.db
        .prepare(
          `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at)
           values (?, ?, ?, 'force_canonical', ?, ?, null)
           on conflict(cluster_id, thread_id, action) do update set
             reason = excluded.reason,
             created_at = excluded.created_at,
             expires_at = null`,
        )
        .run(repository.id, cluster.id, thread.id, params.reason ?? null, timestamp);
      this.db
        .prepare("update cluster_groups set representative_thread_id = ?, updated_at = ? where id = ?")
        .run(thread.id, timestamp, cluster.id);
      this.db
        .prepare("update cluster_memberships set role = 'related', updated_at = ? where cluster_id = ? and role = 'canonical'")
        .run(timestamp, cluster.id);
      upsertClusterMembership(this.db, {
        clusterId: cluster.id,
        threadId: thread.id,
        role: 'canonical',
        state: 'active',
        scoreToRepresentative: 1,
        addedBy: 'user',
        addedReason: {
          source: 'setClusterCanonicalThread',
          reason: params.reason ?? null,
        },
      });
      this.db
        .prepare("update cluster_memberships set added_by = 'user', updated_at = ? where cluster_id = ? and thread_id = ?")
        .run(timestamp, cluster.id, thread.id);
      recordClusterEvent(this.db, {
        clusterId: cluster.id,
        eventType: 'manual_force_canonical',
        actorKind: 'user',
        payload: {
          threadId: thread.id,
          threadNumber: thread.number,
          reason: params.reason ?? null,
        },
      });
    })();

    return clusterOverrideResponseSchema.parse({
      ok: true,
      repository,
      clusterId: cluster.id,
      thread: threadToDto(thread),
      action: 'force_canonical',
      state: 'active',
      message: `Set ${thread.kind} #${thread.number} as canonical for durable cluster ${cluster.id}.`,
    });
  }

  mergeDurableClusters(params: MergeClustersRequest): ClusterMergeResponse {
    if (params.sourceClusterId === params.targetClusterId) {
      throw new Error('Source and target cluster ids must differ.');
    }
    const repository = this.requireRepository(params.owner, params.repo);
    const clusters = this.db
      .prepare(
        `select id, stable_slug
         from cluster_groups cg
         where repo_id = ?
           and id in (?, ?)`,
      )
      .all(repository.id, params.sourceClusterId, params.targetClusterId) as Array<{ id: number; stable_slug: string }>;
    const source = clusters.find((cluster) => cluster.id === params.sourceClusterId);
    const target = clusters.find((cluster) => cluster.id === params.targetClusterId);
    if (!source) {
      throw new Error(`Durable source cluster ${params.sourceClusterId} was not found for ${repository.fullName}.`);
    }
    if (!target) {
      throw new Error(`Durable target cluster ${params.targetClusterId} was not found for ${repository.fullName}.`);
    }

    const timestamp = nowIso();
    const members = this.db
      .prepare(
        `select thread_id, score_to_representative
         from cluster_memberships
         where cluster_id = ?
           and state = 'active'`,
      )
      .all(source.id) as Array<{ thread_id: number; score_to_representative: number | null }>;
    const sourceAliases = this.db
      .prepare('select alias_slug, reason from cluster_aliases where cluster_id = ?')
      .all(source.id) as Array<{ alias_slug: string; reason: string }>;

    this.db.transaction(() => {
      const upsertAlias = this.db.prepare(
        `insert into cluster_aliases (cluster_id, alias_slug, reason, created_at)
         values (?, ?, ?, ?)
         on conflict(cluster_id, alias_slug) do update set
           reason = excluded.reason`,
      );
      upsertAlias.run(target.id, source.stable_slug, `merged_from:${source.id}`, timestamp);
      for (const alias of sourceAliases) {
        upsertAlias.run(target.id, alias.alias_slug, alias.reason, timestamp);
      }

      for (const member of members) {
        this.db
          .prepare("delete from cluster_overrides where cluster_id = ? and thread_id = ? and action = 'exclude'")
          .run(target.id, member.thread_id);
        this.db
          .prepare(
            `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at)
             values (?, ?, ?, 'force_include', ?, ?, null)
             on conflict(cluster_id, thread_id, action) do update set
               reason = excluded.reason,
               created_at = excluded.created_at,
               expires_at = null`,
          )
          .run(repository.id, target.id, member.thread_id, params.reason ?? `merged from cluster ${source.id}`, timestamp);
        upsertClusterMembership(this.db, {
          clusterId: target.id,
          threadId: member.thread_id,
          role: 'related',
          state: 'active',
          scoreToRepresentative: member.score_to_representative,
          addedBy: 'user',
          addedReason: {
            source: 'mergeDurableClusters',
            sourceClusterId: source.id,
            reason: params.reason ?? null,
          },
        });
        this.db
          .prepare("update cluster_memberships set added_by = 'user', updated_at = ? where cluster_id = ? and thread_id = ?")
          .run(timestamp, target.id, member.thread_id);
      }

      this.db
        .prepare("update cluster_groups set status = 'merged', closed_at = ?, updated_at = ? where id = ?")
        .run(timestamp, timestamp, source.id);
      this.db
        .prepare("update cluster_groups set updated_at = ? where id = ?")
        .run(timestamp, target.id);
      recordClusterEvent(this.db, {
        clusterId: source.id,
        eventType: 'manual_merge_source',
        actorKind: 'user',
        payload: {
          targetClusterId: target.id,
          reason: params.reason ?? null,
        },
      });
      recordClusterEvent(this.db, {
        clusterId: target.id,
        eventType: 'manual_merge_target',
        actorKind: 'user',
        payload: {
          sourceClusterId: source.id,
          sourceSlug: source.stable_slug,
          movedMemberCount: members.length,
          reason: params.reason ?? null,
        },
      });
    })();

    return clusterMergeResponseSchema.parse({
      ok: true,
      repository,
      sourceClusterId: source.id,
      targetClusterId: target.id,
      message: `Merged durable cluster ${source.id} into ${target.id}.`,
    });
  }

  splitDurableCluster(params: SplitClusterRequest): ClusterSplitResponse {
    const threadNumbers = Array.from(new Set(params.threadNumbers)).sort((left, right) => left - right);
    const repository = this.requireRepository(params.owner, params.repo);
    const source = this.db
      .prepare(
        `select id, stable_slug
         from cluster_groups cg
         where repo_id = ?
           and id = ?
         limit 1`,
      )
      .get(repository.id, params.sourceClusterId) as { id: number; stable_slug: string } | undefined;
    if (!source) {
      throw new Error(`Durable source cluster ${params.sourceClusterId} was not found for ${repository.fullName}.`);
    }

    const placeholders = threadNumbers.map(() => '?').join(', ');
    const requestedThreads = this.db
      .prepare(`select id, number, title from threads where repo_id = ? and number in (${placeholders})`)
      .all(repository.id, ...threadNumbers) as Array<{ id: number; number: number; title: string }>;
    const requestedByNumber = new Map(requestedThreads.map((thread) => [thread.number, thread]));
    const missingNumbers = threadNumbers.filter((number) => !requestedByNumber.has(number));
    if (missingNumbers.length > 0) {
      throw new Error(`Thread(s) ${missingNumbers.map((number) => `#${number}`).join(', ')} were not found for ${repository.fullName}.`);
    }

    const activeMembers = this.db
      .prepare(
        `select cm.thread_id, cm.role, cm.score_to_representative, t.number, t.title
         from cluster_memberships cm
         join threads t on t.id = cm.thread_id
         where cm.cluster_id = ?
           and cm.state = 'active'
         order by t.number asc`,
      )
      .all(source.id) as Array<{
        thread_id: number;
        role: 'canonical' | 'duplicate' | 'related';
        score_to_representative: number | null;
        number: number;
        title: string;
      }>;
    const selectedThreadIds = new Set(requestedThreads.map((thread) => thread.id));
    const selectedMembers = activeMembers.filter((member) => selectedThreadIds.has(member.thread_id));
    const missingActiveNumbers = threadNumbers.filter((number) => !selectedMembers.some((member) => member.number === number));
    if (missingActiveNumbers.length > 0) {
      throw new Error(`Thread(s) ${missingActiveNumbers.map((number) => `#${number}`).join(', ')} are not active members of durable cluster ${source.id}.`);
    }

    const remainingMembers = activeMembers.filter((member) => !selectedThreadIds.has(member.thread_id));
    if (remainingMembers.length === 0) {
      throw new Error('Split must leave at least one active member in the source cluster.');
    }

    const selectedCanonical = selectedMembers.find((member) => member.role === 'canonical') ?? selectedMembers[0];
    const remainingCanonical = remainingMembers.find((member) => member.role === 'canonical') ?? remainingMembers[0];
    if (!selectedCanonical || !remainingCanonical) {
      throw new Error('Split requires selected and remaining active members.');
    }

    const identity = humanKeyForValue(`cluster-split:${repository.id}:${source.id}:${selectedMembers.map((member) => member.thread_id).join(',')}`);
    const timestamp = nowIso();
    let newClusterId = 0;
    this.db.transaction(() => {
      newClusterId = upsertClusterGroup(this.db, {
        repoId: repository.id,
        stableKey: identity.hash,
        stableSlug: humanKeyStableSlug(identity),
        status: 'active',
        clusterType: 'duplicate_candidate',
        representativeThreadId: selectedCanonical.thread_id,
        title: `Split from ${source.stable_slug}`,
      });

      this.db
        .prepare('update cluster_groups set representative_thread_id = ?, updated_at = ? where id = ?')
        .run(remainingCanonical.thread_id, timestamp, source.id);
      this.db
        .prepare("update cluster_memberships set role = 'canonical', updated_at = ? where cluster_id = ? and thread_id = ?")
        .run(timestamp, source.id, remainingCanonical.thread_id);

      for (const member of selectedMembers) {
        const reason = params.reason ?? `split into cluster ${newClusterId}`;
        this.db
          .prepare(
            `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at)
             values (?, ?, ?, 'exclude', ?, ?, null)
             on conflict(cluster_id, thread_id, action) do update set
               reason = excluded.reason,
               created_at = excluded.created_at,
               expires_at = null`,
          )
          .run(repository.id, source.id, member.thread_id, reason, timestamp);
        upsertClusterMembership(this.db, {
          clusterId: source.id,
          threadId: member.thread_id,
          role: member.role,
          state: 'removed_by_user',
          scoreToRepresentative: member.score_to_representative,
          addedBy: 'user',
          removedBy: 'user',
          addedReason: {
            source: 'splitDurableCluster',
            newClusterId,
          },
          removedReason: {
            source: 'cluster_overrides',
            action: 'exclude',
            reason: params.reason ?? null,
          },
        });

        this.db
          .prepare(
            `insert into cluster_overrides (repo_id, cluster_id, thread_id, action, reason, created_at, expires_at)
             values (?, ?, ?, 'force_include', ?, ?, null)
             on conflict(cluster_id, thread_id, action) do update set
               reason = excluded.reason,
               created_at = excluded.created_at,
               expires_at = null`,
          )
          .run(repository.id, newClusterId, member.thread_id, reason, timestamp);
        upsertClusterMembership(this.db, {
          clusterId: newClusterId,
          threadId: member.thread_id,
          role: member.thread_id === selectedCanonical.thread_id ? 'canonical' : 'related',
          state: 'active',
          scoreToRepresentative: member.thread_id === selectedCanonical.thread_id ? 1 : member.score_to_representative,
          addedBy: 'user',
          addedReason: {
            source: 'splitDurableCluster',
            sourceClusterId: source.id,
            reason: params.reason ?? null,
          },
        });
        this.db
          .prepare("update cluster_memberships set added_by = 'user', updated_at = ? where cluster_id = ? and thread_id = ?")
          .run(timestamp, newClusterId, member.thread_id);
      }

      recordClusterEvent(this.db, {
        clusterId: source.id,
        eventType: 'manual_split_source',
        actorKind: 'user',
        payload: {
          newClusterId,
          movedThreadNumbers: selectedMembers.map((member) => member.number),
          reason: params.reason ?? null,
        },
      });
      recordClusterEvent(this.db, {
        clusterId: newClusterId,
        eventType: 'manual_split_target',
        actorKind: 'user',
        payload: {
          sourceClusterId: source.id,
          sourceSlug: source.stable_slug,
          movedThreadNumbers: selectedMembers.map((member) => member.number),
          reason: params.reason ?? null,
        },
      });
    })();

    return clusterSplitResponseSchema.parse({
      ok: true,
      repository,
      sourceClusterId: source.id,
      newClusterId,
      movedCount: selectedMembers.length,
      message: `Split ${selectedMembers.length} member(s) from durable cluster ${source.id} into ${newClusterId}.`,
    });
  }

  async syncRepository(
    params: SyncOptions,
  ): Promise<SyncResultDto> {
    const crawlStartedAt = params.startedAt ?? nowIso();
    const includeComments = params.includeComments ?? false;
    const includeCode = params.includeCode ?? false;
    const github = this.requireGithub();
    params.onProgress?.(`[sync] fetching repository metadata for ${params.owner}/${params.repo}`);
    const reporter = params.onProgress ? (message: string) => params.onProgress?.(message.replace(/^\[github\]/, '[sync/github]')) : undefined;
    const repoData = await github.getRepo(params.owner, params.repo, reporter);
    const repoId = upsertRepository({
      db: this.db,
      owner: params.owner,
      repo: params.repo,
      payload: repoData,
    });
    const runId = startServiceRun(this.db, 'sync_runs', repoId, `${params.owner}/${params.repo}`);
    const syncCursor = getSyncCursorState(this.db, repoId);
    const overlapReferenceAt = syncCursor.lastOverlappingOpenScanCompletedAt ?? syncCursor.lastFullOpenScanStartedAt;
    const effectiveSince =
      params.since ??
      (params.limit === undefined && overlapReferenceAt ? deriveIncrementalSince(overlapReferenceAt, crawlStartedAt) : undefined);
    const isFullOpenScan = params.limit === undefined && params.since === undefined && overlapReferenceAt === null;
    const isOverlappingOpenScan =
      params.limit === undefined &&
      overlapReferenceAt !== null &&
      effectiveSince !== undefined &&
      (parseIso(effectiveSince) ?? Number.POSITIVE_INFINITY) <= (parseIso(overlapReferenceAt) ?? Number.NEGATIVE_INFINITY);

    try {
      params.onProgress?.(`[sync] listing issues and pull requests for ${params.owner}/${params.repo}`);
      params.onProgress?.(
        includeComments
          ? '[sync] comment hydration enabled; fetching issue comments, reviews, and review comments'
          : '[sync] metadata-only mode; skipping comment, review, and review-comment fetches',
      );
      params.onProgress?.(
        includeCode
          ? '[sync] code hydration enabled; fetching pull request file metadata and patch signatures'
          : '[sync] code hydration disabled; skipping pull request file fetches',
      );
      if (isFullOpenScan) {
        params.onProgress?.('[sync] full open scan; no prior completed overlap/full cursor was found for this repository');
      } else if (params.since === undefined && effectiveSince && overlapReferenceAt) {
        params.onProgress?.(
          `[sync] derived incremental window since=${effectiveSince} from overlap reference ${overlapReferenceAt}`,
        );
      } else if (params.since !== undefined) {
        params.onProgress?.(`[sync] using requested since=${params.since}`);
      }
      const items = await github.listRepositoryIssues(params.owner, params.repo, effectiveSince, params.limit, reporter);
      params.onProgress?.(`[sync] discovered ${items.length} threads to process`);
      let threadsSynced = 0;
      let commentsSynced = 0;
      let codeFilesSynced = 0;
      const fingerprintThreadIds: number[] = [];

      for (const [index, item] of items.entries()) {
        if ((includeComments || includeCode) && index > 0 && index % SYNC_BATCH_SIZE === 0) {
          params.onProgress?.(`[sync] batch boundary reached at ${index} threads; sleeping 5s before continuing`);
          await new Promise((resolve) => setTimeout(resolve, SYNC_BATCH_DELAY_MS));
        }
        const number = Number(item.number);
        const isPr = isPullRequestPayload(item);
        const kind = isPr ? 'pull_request' : 'issue';
        params.onProgress?.(`[sync] ${index + 1}/${items.length} ${kind} #${number}`);
        try {
          const itemIsClosed = isClosedGitHubPayload(item);
          const shouldFetchPullPayload = isPr && includeCode && !itemIsClosed;
          const threadPayload = shouldFetchPullPayload ? await github.getPull(params.owner, params.repo, number, reporter) : item;
          const threadIsClosed = isClosedGitHubPayload(threadPayload);
          const threadId = upsertThread({
            db: this.db,
            repoId,
            kind,
            payload: threadPayload,
            pulledAt: crawlStartedAt,
          });
          if (threadIsClosed && (includeComments || includeCode)) {
            params.onProgress?.(
              `[sync] ${kind} #${number} is closed; metadata-only update, skipping comment/code hydration and fingerprint refresh`,
            );
          }
          if (includeCode && isPr && !threadIsClosed) {
            const files = await github.listPullFiles(params.owner, params.repo, number, reporter);
            persistThreadCodeSnapshot({
              db: this.db,
              dbPath: this.config.dbPath,
              threadId,
              threadPayload,
              files,
            });
            codeFilesSynced += files.length;
          }
          if (includeComments && !threadIsClosed) {
            const comments = await fetchThreadComments({
              github,
              owner: params.owner,
              repo: params.repo,
              number,
              isPr,
              reporter,
            });
            replaceComments({ db: this.db, dbPath: this.config.dbPath, threadId, comments });
            commentsSynced += comments.length;
          }
          refreshThreadDocument(this.db, threadId);
          if (!threadIsClosed) {
            fingerprintThreadIds.push(threadId);
          }
          threadsSynced += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`sync failed while processing ${kind} #${number}: ${message}`);
        }
      }

      const shouldSweepClosedOverlap = params.limit === undefined && effectiveSince !== undefined;
      if (!shouldSweepClosedOverlap) {
        params.onProgress?.('[sync] skipping closed overlap sweep because this scan has no overlap window');
      }
      const threadsClosedFromClosedSweep = shouldSweepClosedOverlap
        ? await applyClosedOverlapSweep({
            db: this.db,
            github,
            repoId,
            owner: params.owner,
            repo: params.repo,
            crawlStartedAt,
            closedSweepSince: effectiveSince,
            reporter,
            onProgress: params.onProgress,
          })
        : 0;
      const canFullReconcile = params.fullReconcile === true && params.limit === undefined && (isFullOpenScan || isOverlappingOpenScan);
      const threadsClosedFromClosedBackfill = canFullReconcile
        ? await applyClosedOverlapSweep({
            db: this.db,
            github,
            repoId,
            owner: params.owner,
            repo: params.repo,
            crawlStartedAt,
            closedSweepSince: undefined,
            closedSweepLimit: STALE_CLOSED_BACKFILL_LIMIT,
            sweepLabel: 'closed backfill',
            reporter,
            onProgress: params.onProgress,
          })
        : 0;
      const staleOpenThreadCountForDirectReconcile = canFullReconcile
        ? countStaleOpenThreads(this.db, repoId, crawlStartedAt)
        : 0;
      const shouldReconcileMissingOpenThreads =
        canFullReconcile && staleOpenThreadCountForDirectReconcile <= MAX_DIRECT_RECONCILE_THREADS;
      if (!canFullReconcile && params.fullReconcile !== true) {
        params.onProgress?.('[sync] skipping full stale-open reconciliation by default; use --full-reconcile to force direct checks of all unseen open items');
      } else if (!canFullReconcile) {
        params.onProgress?.('[sync] skipping full stale-open reconciliation because this scan did not overlap a confirmed full/overlap cursor');
      } else if (!shouldReconcileMissingOpenThreads) {
        params.onProgress?.(
          `[sync] skipping direct stale-open reconciliation because ${staleOpenThreadCountForDirectReconcile} thread(s) remain; closed backfill already checked the latest ${STALE_CLOSED_BACKFILL_LIMIT} closed items`,
        );
      }
      const threadsClosedFromDirectReconcile = shouldReconcileMissingOpenThreads
        ? await reconcileMissingOpenThreads({
            db: this.db,
            github,
            repoId,
            owner: params.owner,
            repo: params.repo,
            crawlStartedAt,
            reporter,
            onProgress: params.onProgress,
          })
        : 0;
      const threadsClosed = threadsClosedFromClosedSweep + threadsClosedFromClosedBackfill + threadsClosedFromDirectReconcile;
      if (threadsClosed > 0) {
        reconcileClusterCloseState(this.db, repoId);
      }
      if (fingerprintThreadIds.length > 0) {
        const fingerprintItems = loadDeterministicClusterableThreadMeta(
          this.db,
          repoId,
          Array.from(new Set(fingerprintThreadIds)),
        );
        materializeLatestDeterministicFingerprints(this.db, fingerprintItems, params.onProgress);
      }
      const finishedAt = nowIso();
      const reconciledOpenCloseAt = shouldSweepClosedOverlap || shouldReconcileMissingOpenThreads ? finishedAt : null;
      const nextSyncCursor: SyncCursorState = {
        lastFullOpenScanStartedAt: isFullOpenScan ? crawlStartedAt : syncCursor.lastFullOpenScanStartedAt,
        lastOverlappingOpenScanCompletedAt: isOverlappingOpenScan ? finishedAt : syncCursor.lastOverlappingOpenScanCompletedAt,
        lastNonOverlappingScanCompletedAt:
          !isFullOpenScan && !isOverlappingOpenScan ? finishedAt : syncCursor.lastNonOverlappingScanCompletedAt,
        lastReconciledOpenCloseAt: reconciledOpenCloseAt ?? syncCursor.lastReconciledOpenCloseAt,
      };
      writeSyncCursorState(this.db, repoId, nextSyncCursor);
      finishServiceRun(this.db, 'sync_runs', runId, 'completed', {
        threadsSynced,
        commentsSynced,
        codeFilesSynced,
        threadsClosed,
        crawlStartedAt,
        requestedSince: params.since ?? null,
        effectiveSince: effectiveSince ?? null,
        limit: params.limit ?? null,
        includeComments,
        includeCode,
        fullReconcile: params.fullReconcile ?? false,
        isFullOpenScan,
        isOverlappingOpenScan,
        overlapReferenceAt,
        threadsClosedFromClosedSweep,
        threadsClosedFromClosedBackfill,
        threadsClosedFromDirectReconcile,
        directReconcileSkippedStaleThreadCount: canFullReconcile && !shouldReconcileMissingOpenThreads
          ? staleOpenThreadCountForDirectReconcile
          : 0,
        reconciledOpenCloseAt,
      } satisfies SyncRunStats, undefined, finishedAt);
      return syncResultSchema.parse({ runId, threadsSynced, commentsSynced, codeFilesSynced, threadsClosed });
    } catch (error) {
      finishServiceRun(this.db, 'sync_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  async summarizeRepository(params: {
    owner: string;
    repo: string;
    threadNumber?: number;
    includeComments?: boolean;
    onProgress?: (message: string) => void;
  }): Promise<{ runId: number; summarized: number; inputTokens: number; outputTokens: number; totalTokens: number }> {
    const ai = this.requireAi();
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = startServiceRun(this.db, 'summary_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);
    const includeComments = params.includeComments ?? false;

    try {
      let sql =
        `select t.id, t.number, t.title, t.body, t.labels_json
         from threads t
         where t.repo_id = ? and t.state = 'open'`;
      const args: Array<number> = [repository.id];
      if (params.threadNumber) {
        sql += ' and t.number = ?';
        args.push(params.threadNumber);
      }
      sql += ' order by t.number asc';

      const rows = this.db.prepare(sql).all(...args) as Array<{
        id: number;
        number: number;
        title: string;
        body: string | null;
        labels_json: string;
      }>;

      params.onProgress?.(`[summarize] loaded ${rows.length} candidate thread(s) for ${repository.fullName}`);
      params.onProgress?.(
        includeComments
          ? '[summarize] include-comments enabled; hydrated human comments may be included in the summary input'
          : '[summarize] metadata-only mode; comments are excluded from the summary input',
      );

      const sources = rows.map((row) => ({
        ...row,
        ...buildSummarySource(this.db, {
          threadId: row.id,
          title: row.title,
          body: row.body,
          labels: parseArray(row.labels_json),
          includeComments,
        }),
      }));

      const pending = sources.filter((row) => {
        const latest = this.db
          .prepare(
            'select content_hash, prompt_version from document_summaries where thread_id = ? and summary_kind = ? and model = ? limit 1',
          )
          .get(row.id, 'dedupe_summary', this.config.summaryModel) as
          | { content_hash: string; prompt_version: string | null }
          | undefined;
        return latest?.content_hash !== row.summaryContentHash || latest?.prompt_version !== SUMMARY_PROMPT_VERSION;
      });

      params.onProgress?.(
        `[summarize] pending=${pending.length} skipped=${rows.length - pending.length} model=${this.config.summaryModel}`,
      );

      let summarized = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      let cachedInputTokens = 0;
      const startTime = Date.now();

      const pricing = SUMMARY_MODEL_PRICING[this.config.summaryModel] ?? null;

      // Stage 1: concurrent API calls
      const fetcher = new IterableMapper(
        pending,
        async (row) => {
          const result = await ai.summarizeThread({
            model: this.config.summaryModel,
            text: row.summaryInput,
          });
          return { row, result };
        },
        { concurrency: 5 },
      );

      // Stage 2: sequential DB writes — consumes from fetcher without blocking API completions
      const writer = new IterableMapper(
        fetcher,
        async ({ row, result }) => {
          const summary = result.summary;
          this.upsertSummary(row.id, row.summaryContentHash, 'problem_summary', summary.problemSummary);
          this.upsertSummary(row.id, row.summaryContentHash, 'solution_summary', summary.solutionSummary);
          this.upsertSummary(row.id, row.summaryContentHash, 'maintainer_signal_summary', summary.maintainerSignalSummary);
          this.upsertSummary(row.id, row.summaryContentHash, 'dedupe_summary', summary.dedupeSummary);
          return { row, usage: result.usage };
        },
        { concurrency: 1 },
      );

      let index = 0;
      for await (const { row, usage } of writer) {
        index += 1;
        if (usage) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          totalTokens += usage.totalTokens;
          cachedInputTokens += usage.cachedInputTokens;
        }

        // Compute cost and ETA every 10 items or on the last item
        if (index % 10 === 0 || index === pending.length) {
          const remaining = pending.length - index;
          const avgIn = inputTokens / index;
          const avgOut = outputTokens / index;
          const avgCachedIn = cachedInputTokens / index;

          const elapsedSec = (Date.now() - startTime) / 1000;
          const secPerItem = elapsedSec / index;
          const etaSec = remaining * secPerItem;
          const etaMin = Math.round(etaSec / 60);
          const etaStr = etaMin >= 60 ? `${Math.floor(etaMin / 60)}h${etaMin % 60}m` : `${etaMin}m`;

          if (pricing) {
            const uncachedInput = inputTokens - cachedInputTokens;
            const costSoFar =
              (uncachedInput / 1_000_000) * pricing.inputCostPerM +
              (cachedInputTokens / 1_000_000) * pricing.cachedInputCostPerM +
              (outputTokens / 1_000_000) * pricing.outputCostPerM;
            const estTotalCost =
              costSoFar +
              ((remaining * (avgIn - avgCachedIn)) / 1_000_000) * pricing.inputCostPerM +
              ((remaining * avgCachedIn) / 1_000_000) * pricing.cachedInputCostPerM +
              ((remaining * avgOut) / 1_000_000) * pricing.outputCostPerM;
            params.onProgress?.(
              `[summarize] ${index}/${pending.length} thread #${row.number} | cost=$${costSoFar.toFixed(2)} est_total=$${estTotalCost.toFixed(2)} | avg_in=${Math.round(avgIn)} avg_out=${Math.round(avgOut)} | ETA ${etaStr}`,
            );
          } else {
            params.onProgress?.(
              `[summarize] ${index}/${pending.length} thread #${row.number} | avg_in=${Math.round(avgIn)} avg_out=${Math.round(avgOut)} | ETA ${etaStr}`,
            );
          }
        }
        summarized += 1;
      }

      finishServiceRun(this.db, 'summary_runs', runId, 'completed', { summarized, inputTokens, outputTokens, totalTokens });
      return { runId, summarized, inputTokens, outputTokens, totalTokens };
    } catch (error) {
      finishServiceRun(this.db, 'summary_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  async generateKeySummaries(params: {
    owner: string;
    repo: string;
    threadNumber?: number;
    limit?: number;
    onProgress?: (message: string) => void;
  }): Promise<{
    runId: number;
    generated: number;
    skipped: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    errorSamples: Array<{ number: number; error: string }>;
  }> {
    const ai = this.requireAi();
    if (!ai.generateKeySummary) {
      throw new Error('Configured AI provider does not support key summary generation.');
    }
    const generateKeySummary = ai.generateKeySummary.bind(ai);
    const providerName = ai.providerName ?? 'custom';
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = startServiceRun(this.db, 'summary_runs', repository.id, params.threadNumber ? `key-summary:${params.threadNumber}` : `key-summary:${repository.fullName}`);

    try {
      let sql =
        `select id, number, title, body, labels_json, raw_json, updated_at_gh
         from threads
         where repo_id = ? and state = 'open'`;
      const args: number[] = [repository.id];
      if (params.threadNumber) {
        sql += ' and number = ?';
        args.push(params.threadNumber);
      }
      sql += ' order by datetime(coalesce(updated_at_gh, updated_at)) desc, number desc';
      if (params.limit) {
        sql += ' limit ?';
        args.push(params.limit);
      }

      const rows = this.db.prepare(sql).all(...args) as Array<{
        id: number;
        number: number;
        title: string;
        body: string | null;
        labels_json: string;
        raw_json: string;
        updated_at_gh: string | null;
      }>;
      params.onProgress?.(`[key-summary] loaded ${rows.length} candidate thread(s) for ${repository.fullName}`);

      let generated = 0;
      let skipped = 0;
      let failed = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      const errorSamples: Array<{ number: number; error: string }> = [];
      const tasks: KeySummaryTask[] = [];

      for (const row of rows) {
        const labels = parseArray(row.labels_json);
        const text = buildKeySummaryInputText({
          title: row.title,
          labels,
          body: row.body,
        });
        const inputHash = llmKeyInputHash({
          title: row.title,
          body: text,
          commentsText: null,
          diffText: null,
        });
        const revisionId = upsertThreadRevision(this.db, {
          threadId: row.id,
          sourceUpdatedAt: row.updated_at_gh,
          title: row.title,
          body: row.body,
          labels,
          rawJson: row.raw_json,
        });
        const existing = this.db
          .prepare(
            `select input_hash
             from thread_key_summaries
             where thread_revision_id = ?
               and summary_kind = 'llm_key_3line'
               and prompt_version = ?
               and provider = ?
               and model = ?
             limit 1`,
          )
          .get(revisionId, LLM_KEY_SUMMARY_PROMPT_VERSION, providerName, this.config.summaryModel) as { input_hash: string } | undefined;
        if (existing?.input_hash === inputHash) {
          skipped += 1;
          continue;
        }

        tasks.push({
          threadId: row.id,
          threadNumber: row.number,
          revisionId,
          inputHash,
          text,
        });
      }

      params.onProgress?.(
        `[key-summary] pending=${tasks.length} skipped=${skipped} concurrency=${KEY_SUMMARY_CONCURRENCY} max_body_chars=${KEY_SUMMARY_MAX_BODY_CHARS}`,
      );

      const mapper = new IterableMapper(
        tasks,
        async (task: KeySummaryTask) => {
          try {
            const result = await generateKeySummary({
              model: this.config.summaryModel,
              text: task.text,
            });
            return { task, result, error: null };
          } catch (error) {
            return {
              task,
              result: null,
              error: error instanceof Error ? error : new Error(String(error)),
            };
          }
        },
        {
          concurrency: KEY_SUMMARY_CONCURRENCY,
          maxUnread: KEY_SUMMARY_MAX_UNREAD,
        },
      );

      for await (const item of mapper) {
        const { task } = item;
        if (item.error) {
          failed += 1;
          const message = item.error.message;
          if (errorSamples.length < 10) {
            errorSamples.push({ number: task.threadNumber, error: message });
          }
          params.onProgress?.(`[key-summary] failed thread #${task.threadNumber}: ${message}`);
          continue;
        }

        const result = item.result;
        if (!result) {
          failed += 1;
          const message = 'AI provider returned no key summary result';
          if (errorSamples.length < 10) {
            errorSamples.push({ number: task.threadNumber, error: message });
          }
          params.onProgress?.(`[key-summary] failed thread #${task.threadNumber}: ${message}`);
          continue;
        }

        upsertThreadKeySummary(this.db, {
          threadRevisionId: task.revisionId,
          summaryKind: 'llm_key_3line',
          promptVersion: LLM_KEY_SUMMARY_PROMPT_VERSION,
          provider: providerName,
          model: this.config.summaryModel,
          inputHash: task.inputHash,
          summary: result.summary,
        });
        generated += 1;
        if (result.usage) {
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
          totalTokens += result.usage.totalTokens;
        }
        const completed = generated + failed;
        params.onProgress?.(
          `[key-summary] generated ${generated}/${tasks.length} failed=${failed} completed=${completed}/${tasks.length} thread #${task.threadNumber}`,
        );
      }

      const payload = { runId, generated, skipped, failed, inputTokens, outputTokens, totalTokens, errorSamples };
      finishServiceRun(this.db, 'summary_runs', runId, 'completed', payload);
      return payload;
    } catch (error) {
      finishServiceRun(this.db, 'summary_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  purgeComments(params: {
    owner: string;
    repo: string;
    threadNumber?: number;
    onProgress?: (message: string) => void;
  }): { purgedComments: number; refreshedThreads: number } {
    const repository = this.requireRepository(params.owner, params.repo);

    let sql = 'select id, number from threads where repo_id = ?';
    const args: Array<number> = [repository.id];
    if (params.threadNumber) {
      sql += ' and number = ?';
      args.push(params.threadNumber);
    }
    sql += ' order by number asc';

    const threads = this.db.prepare(sql).all(...args) as Array<{ id: number; number: number }>;
    if (threads.length === 0) {
      return { purgedComments: 0, refreshedThreads: 0 };
    }

    params.onProgress?.(`[purge-comments] removing hydrated comments from ${threads.length} thread(s) in ${repository.fullName}`);

    const deleteComments = this.db.prepare('delete from comments where thread_id = ?');
    let purgedComments = 0;
    for (const thread of threads) {
      const row = this.db.prepare('select count(*) as count from comments where thread_id = ?').get(thread.id) as { count: number };
      if (row.count > 0) {
        deleteComments.run(thread.id);
        purgedComments += row.count;
      }
      refreshThreadDocument(this.db, thread.id);
    }

    params.onProgress?.(
      `[purge-comments] removed ${purgedComments} comment(s) and refreshed ${threads.length} document(s) for ${repository.fullName}`,
    );

    return { purgedComments, refreshedThreads: threads.length };
  }

  async embedRepository(params: {
    owner: string;
    repo: string;
    threadNumber?: number;
    onProgress?: (message: string) => void;
  }): Promise<EmbedResultDto> {
    const ai = this.requireAi();
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = startServiceRun(this.db, 'embedding_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);

    try {
      if (params.threadNumber === undefined) {
        if (!isRepoVectorStateCurrent(this.db, this.config, repository.id)) {
          this.resetRepositoryVectors(repository.id, repository.fullName);
        } else {
          const pruned = this.pruneInactiveRepositoryVectors(repository.id, repository.fullName);
          if (pruned > 0) {
            params.onProgress?.(`[embed] pruned ${pruned} closed or inactive vector(s) before refresh`);
          }
        }
      }

      const { rows, tasks, pending, missingSummaryThreadNumbers } = getEmbeddingWorkset({
        db: this.db,
        config: this.config,
        repoId: repository.id,
        threadNumber: params.threadNumber,
      });
      const skipped = tasks.length - pending.length;
      const truncated = tasks.filter((task) => task.wasTruncated).length;

      if (missingSummaryThreadNumbers.length > 0) {
        throw new Error(
          `Embedding basis ${this.config.embeddingBasis} requires summaries before embedding. Missing summaries for thread(s): ${missingSummaryThreadNumbers.slice(0, 10).join(', ')}${missingSummaryThreadNumbers.length > 10 ? ', …' : ''}.`,
        );
      }

      params.onProgress?.(
        `[embed] loaded ${rows.length} open thread(s) and ${tasks.length} active vector task(s) for ${repository.fullName}`,
      );
      params.onProgress?.(
        `[embed] pending=${pending.length} skipped=${skipped} truncated=${truncated} model=${this.config.embedModel} dimensions=${ACTIVE_EMBED_DIMENSIONS} basis=${this.config.embeddingBasis} batch_size=${this.config.embedBatchSize} concurrency=${this.config.embedConcurrency} max_unread=${this.config.embedMaxUnread} max_batch_tokens=${EMBED_MAX_BATCH_TOKENS}`,
      );

      let embedded = 0;
      const batches = chunkEmbeddingTasks(pending, this.config.embedBatchSize, EMBED_MAX_BATCH_TOKENS);
      const mapper = new IterableMapper(
        batches,
        async (batch: ActiveVectorTask[]) => {
          return embedBatchWithRecovery({
            ai,
            embedModel: this.config.embedModel,
            batch,
            onProgress: params.onProgress,
          });
        },
        {
          concurrency: this.config.embedConcurrency,
          maxUnread: this.config.embedMaxUnread,
        },
      );

      let completedBatches = 0;
      for await (const batchResult of mapper) {
        completedBatches += 1;
        const numbers = batchResult.map(({ task }) => `#${task.threadNumber}:${task.basis}`);
        const estimatedTokens = batchResult.reduce((sum, { task }) => sum + task.estimatedTokens, 0);
        params.onProgress?.(
          `[embed] batch ${completedBatches}/${Math.max(batches.length, 1)} size=${batchResult.length} est_tokens=${estimatedTokens} items=${numbers.join(',')}`,
        );
        for (const { task, embedding } of batchResult) {
          this.upsertActiveVector(repository.id, repository.fullName, task.threadId, task.basis, task.contentHash, embedding);
          embedded += 1;
        }
      }

      markRepoVectorsCurrent(this.db, this.config, repository.id);
      finishServiceRun(this.db, 'embedding_runs', runId, 'completed', { embedded });
      return embedResultSchema.parse({ runId, embedded });
    } catch (error) {
      finishServiceRun(this.db, 'embedding_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  async clusterRepository(params: {
    owner: string;
    repo: string;
    threadNumber?: number;
    minScore?: number;
    maxClusterSize?: number;
    k?: number;
    onProgress?: (message: string) => void;
  }): Promise<ClusterResultDto> {
    const repository = this.requireRepository(params.owner, params.repo);
    const runSubject = params.threadNumber ? `${repository.fullName}#${params.threadNumber}` : repository.fullName;
    const runId = startServiceRun(this.db, 'cluster_runs', repository.id, runSubject);
    const pipelineRunId = createPipelineRun(this.db, {
      repoId: repository.id,
      runKind: params.threadNumber ? 'cluster_incremental' : 'cluster',
      algorithmVersion: 'persistent-cluster-v1',
      configHash: stableContentHash(
        JSON.stringify({
          threadNumber: params.threadNumber ?? null,
          minScore: params.minScore ?? DEFAULT_CLUSTER_MIN_SCORE,
          maxClusterSize: params.maxClusterSize ?? DEFAULT_CLUSTER_MAX_SIZE,
          clusterMode: 'size_bounded',
          crossKindMinScore: Math.max(params.minScore ?? DEFAULT_CLUSTER_MIN_SCORE, DEFAULT_CROSS_KIND_CLUSTER_MIN_SCORE),
          k: params.k ?? 16,
          embedModel: this.config.embedModel,
          embeddingBasis: this.config.embeddingBasis,
        }),
      ),
    });
    const minScore = params.minScore ?? DEFAULT_CLUSTER_MIN_SCORE;
    const deterministicMinScore = Math.min(minScore, DEFAULT_DETERMINISTIC_CLUSTER_MIN_SCORE);
    const crossKindMinScore = Math.max(minScore, DEFAULT_CROSS_KIND_CLUSTER_MIN_SCORE);
    const maxClusterSize = params.maxClusterSize ?? DEFAULT_CLUSTER_MAX_SIZE;
    const k = params.k ?? 16;

    try {
      const seedThread = params.threadNumber
        ? (this.db
            .prepare(
              `select id, number
               from threads
               where repo_id = ?
                 and number = ?
                 and state = 'open'
                 and closed_at_local is null
               limit 1`,
            )
            .get(repository.id, params.threadNumber) as { id: number; number: number } | undefined)
        : undefined;
      if (params.threadNumber && !seedThread) {
        throw new Error(`Open thread #${params.threadNumber} was not found for ${repository.fullName}.`);
      }
      const seedThreadIds = seedThread ? [seedThread.id] : undefined;
      const deterministicItems = loadDeterministicClusterableThreadMeta(this.db, repository.id);
      const fingerprintItems = seedThreadIds ? deterministicItems.filter((item) => seedThreadIds.includes(item.id)) : deterministicItems;
      materializeLatestDeterministicFingerprints(this.db, fingerprintItems, params.onProgress);
      const persistedFingerprints = loadLatestDeterministicFingerprints({
        db: this.db,
        dbPath: this.config.dbPath,
        threadIds: deterministicItems.map((item) => item.id),
      });
      const deterministic = buildDeterministicClusterGraphFromFingerprints(
        deterministicItems.map((item) => ({ id: item.id, number: item.number, title: item.title })),
        persistedFingerprints,
        {
          maxBucketSize: seedThreadIds ? 500 : 200,
          topK: seedThreadIds ? Math.max(k * 8, 64) : 32,
          seedThreadIds,
        },
      );
      const aggregatedEdges = new Map<string, AggregatedClusterEdge>();
      mergeSourceKindEdges(
        aggregatedEdges,
        deterministic.edges
          .filter((edge) => edge.tier === 'strong' || edge.score >= deterministicMinScore)
          .map((edge) => ({
            ...edge,
            score: Math.max(edge.score, edge.tier === 'strong' ? 0.94 : Math.min(0.86, minScore + 0.04)),
          })),
        'deterministic_fingerprint',
      );
      params.onProgress?.(
        `[cluster] built ${aggregatedEdges.size} deterministic similarity edge(s) for ${runSubject}`,
      );

      const vectorStateCurrent = isRepoVectorStateCurrent(this.db, this.config, repository.id);
      const vectorItems = loadClusterableActiveVectorMeta({ db: this.db, config: this.config, repoId: repository.id });
      if (vectorItems.length > 0) {
        const queryVectorItems = seedThreadIds ? vectorItems.filter((item) => seedThreadIds.includes(item.id)) : vectorItems;
        const activeSourceKind = activeVectorSourceKind(this.config.embeddingBasis);
        const activeIds = new Set(vectorItems.map((item) => item.id));
        const annQuery = getVectorliteClusterQuery(vectorItems.length, k);
        let processed = 0;
        let lastProgressAt = Date.now();

        params.onProgress?.(
          `[cluster] loaded ${vectorItems.length} ${vectorStateCurrent ? 'current' : 'stale'} active vector(s), querying ${queryVectorItems.length} for ${runSubject} backend=${this.config.vectorBackend} k=${k} query_limit=${annQuery.limit} candidateK=${annQuery.candidateK} efSearch=${annQuery.efSearch ?? 'default'} minScore=${minScore}`,
        );
        for (const item of queryVectorItems) {
          const neighbors = this.queryNearestWithRecovery(repository.id, repository.fullName, {
            vector: item.embedding,
            limit: annQuery.limit,
            candidateK: annQuery.candidateK + 1,
            efSearch: annQuery.efSearch,
            excludeThreadId: item.id,
          });
          for (const neighbor of neighbors) {
            if (!activeIds.has(neighbor.threadId)) continue;
            if (neighbor.score < minScore) continue;
            mergeSourceKindEdges(
              aggregatedEdges,
              [
                {
                  leftThreadId: Math.min(item.id, neighbor.threadId),
                  rightThreadId: Math.max(item.id, neighbor.threadId),
                  score: neighbor.score,
                },
              ],
              activeSourceKind,
            );
          }
          processed += 1;
          const now = Date.now();
          if (params.onProgress && now - lastProgressAt >= CLUSTER_PROGRESS_INTERVAL_MS) {
            params.onProgress(`[cluster] queried ${processed}/${queryVectorItems.length} vectors current_edges=${aggregatedEdges.size}`);
            lastProgressAt = now;
          }
        }
      } else if (!seedThreadIds && hasLegacyEmbeddings(this.db, this.config.embedModel, repository.id)) {
        const legacy = loadClusterableThreadMeta({ db: this.db, repoId: repository.id });
        params.onProgress?.(
          `[cluster] loaded ${legacy.items.length} legacy embedded thread(s) across ${legacy.sourceKinds.length} source kind(s) for ${repository.fullName} k=${k} minScore=${minScore}`,
        );
        const legacyEdges = await this.aggregateRepositoryEdges(repository.id, legacy.sourceKinds, {
          limit: k,
          minScore,
          onProgress: params.onProgress,
        });
        for (const legacyEdge of legacyEdges.values()) {
          for (const sourceKind of legacyEdge.sourceKinds) {
            mergeSourceKindEdges(
              aggregatedEdges,
              [{ leftThreadId: legacyEdge.leftThreadId, rightThreadId: legacyEdge.rightThreadId, score: legacyEdge.score }],
              sourceKind,
            );
          }
        }
      }

      const threadKinds = new Map(deterministicItems.map((item) => [item.id, item.kind]));
      const droppedCrossKindEdges = pruneWeakCrossKindEdges(aggregatedEdges, threadKinds, crossKindMinScore);
      if (droppedCrossKindEdges > 0) {
        params.onProgress?.(
          `[cluster] dropped ${droppedCrossKindEdges} weak issue/pr edge(s) below cross_kind_min_score=${crossKindMinScore}`,
        );
      }

      const edges = Array.from(aggregatedEdges.values()).map((entry) => ({
        leftThreadId: entry.leftThreadId,
        rightThreadId: entry.rightThreadId,
        score: entry.score,
      }));

      params.onProgress?.(`[cluster] built ${edges.length} similarity edge(s)`);

      const involvedIds = new Set<number>();
      if (seedThreadIds) {
        for (const id of seedThreadIds) involvedIds.add(id);
        for (const edge of aggregatedEdges.values()) {
          involvedIds.add(edge.leftThreadId);
          involvedIds.add(edge.rightThreadId);
        }
      }
      const clusterItems = seedThreadIds ? deterministicItems.filter((item) => involvedIds.has(item.id)) : deterministicItems;
      const clusters = buildSizeBoundedClusters(
        clusterItems.map((item) => ({ threadId: item.id, number: item.number, title: item.title })),
        edges,
        { maxClusterSize },
      );
      const clusterQuality = summarizeClusterQuality(clusters, threadKinds, maxClusterSize);
      if (!seedThreadIds) {
        this.persistClusterRun(repository.id, runId, aggregatedEdges, clusters);
      }
      this.persistDurableClusterState(repository.id, pipelineRunId, aggregatedEdges, clusters);
      if (!seedThreadIds) {
        this.pruneOldClusterRuns(repository.id, runId);
      }
      if (!seedThreadIds && vectorStateCurrent) {
        markRepoClustersCurrent(this.db, this.config, repository.id);
        this.cleanupMigratedRepositoryArtifacts(repository.id, repository.fullName, params.onProgress);
      }

      params.onProgress?.(
        seedThreadIds
          ? `[cluster] persisted ${clusters.length} durable neighborhood cluster(s) without replacing the full cluster snapshot`
          : `[cluster] persisted ${clusters.length} cluster(s) and pruned older cluster runs`,
      );

      const stats = {
        edges: edges.length,
        clusters: clusters.length,
        threadNumber: params.threadNumber ?? null,
        droppedCrossKindEdges,
        crossKindMinScore,
        ...clusterQuality,
      };
      finishServiceRun(this.db, 'cluster_runs', runId, 'completed', stats);
      finishPipelineRun(this.db, pipelineRunId, { status: 'completed', stats });
      return clusterResultSchema.parse({ runId, edges: edges.length, clusters: clusters.length });
    } catch (error) {
      finishServiceRun(this.db, 'cluster_runs', runId, 'failed', null, error);
      finishPipelineRun(this.db, pipelineRunId, { status: 'failed', errorText: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  clusterExperiment(params: {
    owner: string;
    repo: string;
    backend?: 'exact' | 'vectorlite';
    minScore?: number;
    k?: number;
    candidateK?: number;
    efSearch?: number;
    maxClusterSize?: number;
    refineStep?: number;
    clusterMode?: 'basic' | 'refine' | 'bounded';
    includeClusters?: boolean;
    sourceKinds?: EmbeddingSourceKind[];
    aggregation?: 'max' | 'mean' | 'weighted' | 'min-of-2' | 'boost';
    aggregationWeights?: Partial<Record<EmbeddingSourceKind, number>>;
    onProgress?: (message: string) => void;
  }): ClusterExperimentResult {
    const backend = params.backend ?? 'vectorlite';
    const repository = this.requireRepository(params.owner, params.repo);
    const loaded = loadClusterableThreadMeta({ db: this.db, repoId: repository.id });
    const activeVectors = isRepoVectorStateCurrent(this.db, this.config, repository.id)
      ? loadNormalizedActiveVectors({ db: this.db, config: this.config, repoId: repository.id })
      : [];
    const activeSourceKind = activeVectorSourceKind(this.config.embeddingBasis);
    const useActiveVectors = activeVectors.length > 0 && (params.sourceKinds === undefined || loaded.items.length === 0);
    const sourceKinds = useActiveVectors ? [activeSourceKind] : (params.sourceKinds ?? loaded.sourceKinds);
    const items = useActiveVectors
      ? activeVectors.map((item) => ({ id: item.id, number: item.number, title: item.title }))
      : loaded.items;
    const aggregation = params.aggregation ?? 'max';
    const minScore = params.minScore ?? DEFAULT_CLUSTER_MIN_SCORE;
    const k = params.k ?? 6;
    const candidateK = Math.max(k, params.candidateK ?? Math.max(k * 16, 64));
    const efSearch = params.efSearch;
    const startedAt = Date.now();
    const memoryBefore = process.memoryUsage();
    let peakRssBytes = memoryBefore.rss;
    let peakHeapUsedBytes = memoryBefore.heapUsed;
    const recordMemory = (): void => {
      const usage = process.memoryUsage();
      peakRssBytes = Math.max(peakRssBytes, usage.rss);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
    };
    recordMemory();

    if (useActiveVectors && params.sourceKinds && loaded.items.length === 0) {
      params.onProgress?.(
        `[cluster-experiment] legacy source embeddings are unavailable for ${repository.fullName}; falling back to active ${this.config.embeddingBasis} vectors`,
      );
    }

    params.onProgress?.(
      `[cluster-experiment] loaded ${items.length} embedded thread(s) across ${sourceKinds.length} source kind(s) for ${repository.fullName} backend=${backend} k=${k} candidateK=${candidateK} minScore=${minScore} aggregation=${aggregation}`,
    );

    const perSourceScores = new Map<string, PerSourceScoreEntry>();
    let loadMs = 0;
    let setupMs = 0;
    let edgeBuildMs = 0;
    let indexBuildMs = 0;
    let queryMs = 0;
    let clusterBuildMs = 0;
    let tempDbPath: string | null = null;
    let tempDb: SqliteDatabase | null = null;
    let tempDir: string | null = null;

    try {
      if (backend === 'exact') {
        if (useActiveVectors) {
          const loadStartedAt = Date.now();
          const normalizedRows = activeVectors.map(({ id, embedding }) => ({ id, normalizedEmbedding: embedding }));
          loadMs += Date.now() - loadStartedAt;
          recordMemory();

          const edgesStartedAt = Date.now();
          const edges = buildSourceKindEdges(normalizedRows, {
            limit: k,
            minScore,
            progressIntervalMs: CLUSTER_PROGRESS_INTERVAL_MS,
            onProgress: (progress) => {
              recordMemory();
              if (!params.onProgress) return;
              params.onProgress(
                `[cluster-experiment] exact ${progress.processedItems}/${normalizedRows.length} active vectors processed current_edges~=${perSourceScores.size + progress.currentEdgeEstimate}`,
              );
            },
          });
          edgeBuildMs += Date.now() - edgesStartedAt;
          collectSourceKindScores(perSourceScores, edges, activeSourceKind);
          recordMemory();
        } else {
          const totalItems = sourceKinds.reduce(
            (sum, sourceKind) => sum + countEmbeddingsForSourceKind({ db: this.db, repoId: repository.id, sourceKind }),
            0,
          );
          let processedItems = 0;

          for (const sourceKind of sourceKinds) {
            const loadStartedAt = Date.now();
            const normalizedRows = loadNormalizedEmbeddingsForSourceKind({
              db: this.db,
              repoId: repository.id,
              embedModel: this.config.embedModel,
              sourceKind,
            });
            loadMs += Date.now() - loadStartedAt;
            recordMemory();

            const edgesStartedAt = Date.now();
            const edges = buildSourceKindEdges(normalizedRows, {
              limit: k,
              minScore,
              progressIntervalMs: CLUSTER_PROGRESS_INTERVAL_MS,
              onProgress: (progress) => {
                recordMemory();
                if (!params.onProgress) return;
                params.onProgress(
                  `[cluster-experiment] exact ${processedItems + progress.processedItems}/${totalItems} source embeddings processed current_edges~=${perSourceScores.size + progress.currentEdgeEstimate}`,
                );
              },
            });
            edgeBuildMs += Date.now() - edgesStartedAt;
            processedItems += normalizedRows.length;
            collectSourceKindScores(perSourceScores, edges, sourceKind);
            recordMemory();
          }
        }
      } else {
        const setupStartedAt = Date.now();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-vectorlite-'));
        tempDbPath = path.join(tempDir, 'cluster-experiment.db');
        tempDb = openDb(tempDbPath);
        tempDb.pragma('journal_mode = MEMORY');
        tempDb.pragma('synchronous = OFF');
        tempDb.pragma('temp_store = MEMORY');
        const vectorlite = requireFromHere('vectorlite') as { vectorlitePath: () => string };
        (tempDb as SqliteDatabase & { loadExtension: (extensionPath: string) => void }).loadExtension(vectorlite.vectorlitePath());
        setupMs += Date.now() - setupStartedAt;
        recordMemory();

        const vectorSources = useActiveVectors
          ? [
              {
                sourceKind: activeSourceKind,
                rows: activeVectors.map(({ id, embedding }) => ({ id, normalizedEmbedding: embedding })),
              },
            ]
          : sourceKinds.map((sourceKind) => ({
              sourceKind,
              rows: loadNormalizedEmbeddingsForSourceKind({
                db: this.db,
                repoId: repository.id,
                embedModel: this.config.embedModel,
                sourceKind,
              }).map((row) => ({
                id: row.id,
                normalizedEmbedding: row.normalizedEmbedding,
              })),
            }));

        for (const source of vectorSources) {
          const sourceRowCount = source.rows.length;
          if (sourceRowCount === 0) {
            continue;
          }

          const dimension = source.rows[0]!.normalizedEmbedding.length;
          const safeCandidateK = Math.min(candidateK, Math.max(1, sourceRowCount - 1));
          const tableName = `vector_${source.sourceKind}`;

          params.onProgress?.(
            `[cluster-experiment] building ${source.sourceKind} HNSW index with ${sourceRowCount} vector(s)`,
          );
          const indexStartedAt = Date.now();
          tempDb.exec(
            `create virtual table ${tableName} using vectorlite(vec float32[${dimension}], hnsw(max_elements=${sourceRowCount}));`,
          );
          const insert = tempDb.prepare(`insert into ${tableName}(rowid, vec) values (?, ?)`);
          tempDb.transaction(() => {
            const loadStartedAt = Date.now();
            for (const row of source.rows) {
              insert.run(row.id, normalizedEmbeddingBuffer(row.normalizedEmbedding));
            }
            loadMs += Date.now() - loadStartedAt;
          })();
          indexBuildMs += Date.now() - indexStartedAt;
          recordMemory();

          const queryStartedAt = Date.now();
          const querySql =
            efSearch !== undefined
              ? `select rowid, distance from ${tableName} where knn_search(vec, knn_param(?, ${safeCandidateK + 1}, ${efSearch}))`
              : `select rowid, distance from ${tableName} where knn_search(vec, knn_param(?, ${safeCandidateK + 1}))`;
          const query = tempDb.prepare(querySql);
          let processed = 0;
          let lastProgressAt = Date.now();
          const queryLoadStartedAt = Date.now();
          for (const row of source.rows) {
            const candidates = query.all(normalizedEmbeddingBuffer(row.normalizedEmbedding)) as Array<{
              rowid: number;
              distance: number;
            }>;
            const ranked = rankNearestNeighborsByScore(candidates, {
              limit: k,
              minScore,
              score: (candidate) => {
                if (candidate.rowid === row.id) {
                  return -1;
                }
                return normalizedDistanceToScore(candidate.distance);
              },
            });
            let addedThisRow = 0;
            for (const candidate of ranked) {
              const score = candidate.score;
              const key = edgeKey(row.id, candidate.item.rowid);
              const existing = perSourceScores.get(key);
              if (existing) {
                existing.scores.set(source.sourceKind, Math.max(existing.scores.get(source.sourceKind) ?? -1, score));
                continue;
              }
              const scores = new Map<EmbeddingSourceKind, number>();
              scores.set(source.sourceKind, score);
              perSourceScores.set(key, {
                leftThreadId: Math.min(row.id, candidate.item.rowid),
                rightThreadId: Math.max(row.id, candidate.item.rowid),
                scores,
              });
              addedThisRow += 1;
            }
            processed += 1;
            const now = Date.now();
            if (params.onProgress && now - lastProgressAt >= CLUSTER_PROGRESS_INTERVAL_MS) {
              recordMemory();
              params.onProgress(
                `[cluster-experiment] querying ${source.sourceKind} index ${processed}/${sourceRowCount} current_edges=${perSourceScores.size} added_this_step=${addedThisRow}`,
              );
              lastProgressAt = now;
            }
          }
          loadMs += Date.now() - queryLoadStartedAt;
          queryMs += Date.now() - queryStartedAt;
          tempDb.exec(`drop table ${tableName}`);
          recordMemory();
        }
      }

      // Finalize edge scores using the configured aggregation method
      const defaultWeights: Record<EmbeddingSourceKind, number> = { dedupe_summary: 0.5, llm_key_summary: 0.5, title: 0.3, body: 0.2 };
      const weights = { ...defaultWeights, ...(params.aggregationWeights ?? {}) };
      const aggregated = finalizeEdgeScores(perSourceScores, aggregation, weights, minScore);

      params.onProgress?.(
        `[cluster-experiment] finalized ${aggregated.length} edges from ${perSourceScores.size} candidate pairs using ${aggregation} aggregation`,
      );

      const clusterStartedAt = Date.now();
      const clusterNodes = items.map((item) => ({ threadId: item.id, number: item.number, title: item.title }));
      const clusterEdges = aggregated;
      const clusterMode = params.clusterMode ?? (params.maxClusterSize !== undefined ? 'refine' : 'basic');
      const clusters = clusterMode === 'bounded'
        ? buildSizeBoundedClusters(clusterNodes, clusterEdges, {
            maxClusterSize: params.maxClusterSize ?? 200,
          })
        : clusterMode === 'refine'
          ? buildRefinedClusters(clusterNodes, clusterEdges, {
              maxClusterSize: params.maxClusterSize ?? 200,
              refineStep: params.refineStep ?? 0.02,
            })
          : buildClusters(clusterNodes, clusterEdges);
      clusterBuildMs += Date.now() - clusterStartedAt;
      recordMemory();
      const memoryAfter = process.memoryUsage();
      const durationMs =
        backend === 'vectorlite'
          ? indexBuildMs + queryMs + clusterBuildMs
          : edgeBuildMs + clusterBuildMs;
      const totalDurationMs = Date.now() - startedAt;

      return {
        backend,
        repository,
        tempDbPath,
        threads: items.length,
        sourceKinds: sourceKinds.length,
        edges: aggregated.length,
        clusters: clusters.length,
        timingBasis: 'cluster-only',
        durationMs,
        totalDurationMs,
        loadMs,
        setupMs,
        edgeBuildMs,
        indexBuildMs,
        queryMs,
        clusterBuildMs,
        candidateK,
        memory: {
          rssBeforeBytes: memoryBefore.rss,
          rssAfterBytes: memoryAfter.rss,
          peakRssBytes,
          heapUsedBeforeBytes: memoryBefore.heapUsed,
          heapUsedAfterBytes: memoryAfter.heapUsed,
          peakHeapUsedBytes,
        },
        clusterSizes: summarizeClusterSizes(clusters),
        clustersDetail: params.includeClusters
          ? clusters.map((cluster) => ({
              representativeThreadId: cluster.representativeThreadId,
              memberThreadIds: [...cluster.members],
            }))
          : null,
      };
    } finally {
      tempDb?.close();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  async searchRepository(params: {
    owner: string;
    repo: string;
    query: string;
    mode?: SearchMode;
    limit?: number;
  }): Promise<SearchResultInternal> {
    const mode = params.mode ?? 'hybrid';
    const repository = this.requireRepository(params.owner, params.repo);
    const limit = params.limit ?? 20;
    const keywordScores = new Map<number, number>();
    const semanticScores = new Map<number, number>();

    if (mode !== 'semantic') {
      const rows = this.db
        .prepare(
          `select d.thread_id, bm25(documents_fts) as rank
           from documents_fts
           join documents d on d.id = documents_fts.rowid
           join threads t on t.id = d.thread_id
         where t.repo_id = ? and t.state = 'open' and t.closed_at_local is null and documents_fts match ?
           order by rank
           limit ?`,
        )
        .all(repository.id, params.query, limit * 2) as Array<{ thread_id: number; rank: number }>;
      for (const row of rows) {
        keywordScores.set(row.thread_id, 1 / (1 + Math.abs(row.rank)));
      }
    }

    if (mode !== 'keyword' && this.ai) {
      if (isRepoVectorStateCurrent(this.db, this.config, repository.id)) {
        const [queryEmbedding] = await this.ai.embedTexts({
          model: this.config.embedModel,
          texts: [params.query],
          dimensions: ACTIVE_EMBED_DIMENSIONS,
        });
        const neighbors = this.queryNearestWithRecovery(repository.id, repository.fullName, {
          vector: queryEmbedding,
          limit: limit * 2,
          candidateK: Math.max(limit * 8, 64),
        });
        for (const neighbor of neighbors) {
          if (neighbor.score < 0.2) continue;
          semanticScores.set(neighbor.threadId, Math.max(semanticScores.get(neighbor.threadId) ?? -1, neighbor.score));
        }
      } else if (hasLegacyEmbeddings(this.db, this.config.embedModel, repository.id)) {
        const [queryEmbedding] = await this.ai.embedTexts({ model: this.config.embedModel, texts: [params.query] });
        for (const row of iterateStoredEmbeddings({ db: this.db, repoId: repository.id, embedModel: this.config.embedModel })) {
          const score = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding_json) as number[]);
          if (score < 0.2) continue;
          semanticScores.set(row.id, Math.max(semanticScores.get(row.id) ?? -1, score));
        }
      }
    }

    const candidateIds = new Set<number>([...keywordScores.keys(), ...semanticScores.keys()]);
    const threadRows = candidateIds.size
      ? (this.db
          .prepare(
            `select * from threads
             where repo_id = ? and state = 'open' and closed_at_local is null and id in (${[...candidateIds].map(() => '?').join(',')})
             order by updated_at_gh desc, number desc`,
          )
          .all(repository.id, ...candidateIds) as ThreadRow[])
      : [];

    const neighborRows = this.db
      .prepare(
        `select se.left_thread_id, se.right_thread_id, se.score, t1.number as left_number, t2.number as right_number,
                t1.kind as left_kind, t2.kind as right_kind, t1.title as left_title, t2.title as right_title
         from similarity_edges se
         join threads t1 on t1.id = se.left_thread_id
         join threads t2 on t2.id = se.right_thread_id
         where se.repo_id = ? and se.cluster_run_id = (
           select id from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1
         )`,
      )
      .all(repository.id, repository.id) as Array<{
        left_thread_id: number;
        right_thread_id: number;
        score: number;
        left_number: number;
        right_number: number;
        left_kind: 'issue' | 'pull_request';
        right_kind: 'issue' | 'pull_request';
        left_title: string;
        right_title: string;
      }>;

    const neighborsByThread = new Map<number, SearchHitDto['neighbors']>();
    for (const edge of neighborRows) {
      const leftList = neighborsByThread.get(edge.left_thread_id) ?? [];
      leftList.push({
        threadId: edge.right_thread_id,
        number: edge.right_number,
        kind: edge.right_kind,
        title: edge.right_title,
        score: edge.score,
      });
      neighborsByThread.set(edge.left_thread_id, leftList);

      const rightList = neighborsByThread.get(edge.right_thread_id) ?? [];
      rightList.push({
        threadId: edge.left_thread_id,
        number: edge.left_number,
        kind: edge.left_kind,
        title: edge.left_title,
        score: edge.score,
      });
      neighborsByThread.set(edge.right_thread_id, rightList);
    }

    const hits = threadRows
      .map((row) => {
        const keywordScore = keywordScores.get(row.id) ?? null;
        const semanticScore = semanticScores.get(row.id) ?? null;
        const hybridScore = (keywordScore ?? 0) + (semanticScore ?? 0);
        return {
          thread: threadToDto(row),
          keywordScore,
          semanticScore,
          hybridScore,
          neighbors: (neighborsByThread.get(row.id) ?? []).sort((left, right) => right.score - left.score).slice(0, 3),
        };
      })
      .sort((left, right) => right.hybridScore - left.hybridScore)
      .slice(0, limit);

    return searchResponseSchema.parse({
      repository,
      query: params.query,
      mode,
      hits,
    });
  }

  listNeighbors(params: {
    owner: string;
    repo: string;
    threadNumber: number;
    limit?: number;
    minScore?: number;
  }): NeighborsResultInternal {
    const repository = this.requireRepository(params.owner, params.repo);
    const limit = params.limit ?? 10;
    const minScore = params.minScore ?? 0.2;

    const targetRow = this.db
      .prepare(
        `select t.*, tv.basis, tv.model, tv.dimensions, tv.content_hash, tv.vector_json, tv.vector_backend
         from threads t
         join thread_vectors tv on tv.thread_id = t.id
         where t.repo_id = ?
           and t.number = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and tv.model = ?
           and tv.basis = ?
           and tv.dimensions = ?
         limit 1`,
      )
      .get(
        repository.id,
        params.threadNumber,
        this.config.embedModel,
        this.config.embeddingBasis,
        ACTIVE_EMBED_DIMENSIONS,
      ) as ActiveVectorRow | undefined;
    let responseThread: ThreadRow | ActiveVectorRow;
    let neighbors: Array<{ threadId: number; number: number; kind: 'issue' | 'pull_request'; title: string; score: number }>;

    if (targetRow) {
      responseThread = targetRow;
      const candidateRows = this.queryNearestWithRecovery(repository.id, repository.fullName, {
        vector: parseStoredVector(targetRow.vector_json),
        limit: limit * 2,
        candidateK: Math.max(limit * 8, 64),
        excludeThreadId: targetRow.id,
      })
        .filter((row) => row.score >= minScore);
      const candidateIds = candidateRows.map((row) => row.threadId);
      const neighborMeta = candidateIds.length
        ? (this.db
            .prepare(
              `select * from threads
               where repo_id = ? and state = 'open' and closed_at_local is null and id in (${candidateIds.map(() => '?').join(',')})`,
            )
            .all(repository.id, ...candidateIds) as ThreadRow[])
        : [];
      const metaById = new Map<number, ThreadRow>(neighborMeta.map((row) => [row.id, row]));
      neighbors = candidateRows
        .map((row) => {
          const meta = metaById.get(row.threadId);
          if (!meta) {
            return null;
          }
          return {
            threadId: row.threadId,
            number: meta.number,
            kind: meta.kind,
            title: meta.title,
            score: row.score,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .slice(0, limit);
    } else {
      const targetRows = loadStoredEmbeddingsForThreadNumber({
        db: this.db,
        repoId: repository.id,
        threadNumber: params.threadNumber,
        embedModel: this.config.embedModel,
      });
      if (targetRows.length === 0) {
        throw new Error(
          `Thread #${params.threadNumber} for ${repository.fullName} was not found with an embedding. Run embed first.`,
        );
      }
      responseThread = targetRows[0]!;
      const targetBySource = new Map<EmbeddingSourceKind, number[]>();
      for (const row of targetRows) {
        targetBySource.set(row.source_kind, JSON.parse(row.embedding_json) as number[]);
      }

      const aggregated = new Map<number, { number: number; kind: 'issue' | 'pull_request'; title: string; score: number }>();
      for (const row of iterateStoredEmbeddings({ db: this.db, repoId: repository.id, embedModel: this.config.embedModel })) {
        if (row.id === responseThread.id) continue;
        const targetEmbedding = targetBySource.get(row.source_kind);
        if (!targetEmbedding) continue;
        const score = cosineSimilarity(targetEmbedding, JSON.parse(row.embedding_json) as number[]);
        if (score < minScore) continue;
        const previous = aggregated.get(row.id);
        if (!previous || score > previous.score) {
          aggregated.set(row.id, { number: row.number, kind: row.kind, title: row.title, score });
        }
      }

      neighbors = Array.from(aggregated.entries())
        .map(([threadId, value]) => ({
          threadId,
          number: value.number,
          kind: value.kind,
          title: value.title,
          score: value.score,
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    }

    return neighborsResponseSchema.parse({
      repository,
      thread: threadToDto(responseThread),
      neighbors,
    });
  }

  listClusters(params: { owner: string; repo: string; includeClosed?: boolean }): ClustersResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return listStoredClusters(this.db, repository, params);
  }

  listDurableClusters(params: { owner: string; repo: string; includeInactive?: boolean; memberLimit?: number }): DurableClustersResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return listStoredDurableClusters(this.db, repository, params);
  }

  explainDurableCluster(params: { owner: string; repo: string; clusterId: number; memberLimit?: number; eventLimit?: number }): ClusterExplainResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return explainStoredDurableCluster(this.db, repository, params);
  }

  async refreshRepository(params: {
    owner: string;
    repo: string;
    sync?: boolean;
    embed?: boolean;
    cluster?: boolean;
    includeCode?: boolean;
    onProgress?: (message: string) => void;
  }): Promise<RefreshResponse> {
    const selected = {
      sync: params.sync ?? true,
      embed: params.embed ?? true,
      cluster: params.cluster ?? true,
    };
    if (!selected.sync && !selected.embed && !selected.cluster) {
      throw new Error('Refresh requires at least one selected step');
    }
    if (!selected.sync) {
      this.requireRepository(params.owner, params.repo);
    }

    let sync: SyncResultDto | null = null;
    let embed: EmbedResultDto | null = null;
    let cluster: ClusterResultDto | null = null;

    if (selected.sync) {
      sync = await this.syncRepository({
        owner: params.owner,
        repo: params.repo,
        includeCode: params.includeCode,
        onProgress: params.onProgress,
      });
    }
    if (selected.embed && this.config.embeddingBasis === 'title_summary') {
      params.onProgress?.(
        `[refresh] embedding basis ${this.config.embeddingBasis} requires summaries; running summarize before embed`,
      );
      await this.summarizeRepository({
        owner: params.owner,
        repo: params.repo,
        onProgress: params.onProgress,
      });
    }
    if (selected.embed) {
      embed = await this.embedRepository({
        owner: params.owner,
        repo: params.repo,
        onProgress: params.onProgress,
      });
    }
    if (selected.cluster) {
      cluster = await this.clusterRepository({
        owner: params.owner,
        repo: params.repo,
        onProgress: params.onProgress,
      });
    }

    const repository = this.requireRepository(params.owner, params.repo);

    return refreshResponseSchema.parse({
      repository,
      selected,
      sync,
      embed,
      cluster,
    });
  }

  optimizeStorage(params: { owner?: string; repo?: string } = {}): OptimizeResponse {
    const repository =
      params.owner && params.repo
        ? this.requireRepository(params.owner, params.repo)
        : null;

    return optimizeStorageStores({
      config: this.config,
      db: this.db,
      vectorStore: this.vectorStore,
      repository,
    });
  }

  exportPortableSync(params: PortableSyncExportOptions): PortableSyncExportResponse {
    if (this.config.dbPath === ':memory:') {
      throw new Error('Portable sync export requires a file-backed source database');
    }

    const repository = this.requireRepository(params.owner, params.repo);
    const sourcePath = path.resolve(this.config.dbPath);
    const outputPath = path.resolve(
      params.outputPath ?? path.join(this.config.configDir, 'exports', `${repository.owner}__${repository.name}.sync.db`),
    );

    return exportPortableSyncDatabase({
      repository,
      sourceDb: this.db,
      sourcePath,
      outputPath,
      bodyChars: params.bodyChars,
      profile: params.profile,
      writeManifest: params.writeManifest,
    });
  }

  validatePortableSync(dbPath: string): PortableSyncValidationResponse {
    return validatePortableSyncDatabase(dbPath);
  }

  portableSyncSize(dbPath: string): PortableSyncSizeResponse {
    return portableSyncSizeReport(dbPath);
  }

  portableSyncStatus(params: { owner: string; repo: string; portablePath: string }): PortableSyncStatusResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    return portableSyncStatusReport({
      liveDb: this.db,
      repository,
      portablePath: params.portablePath,
    });
  }

  importPortableSync(dbPath: string): PortableSyncImportResponse {
    return importPortableSyncDatabase({
      liveDb: this.db,
      portablePath: dbPath,
    });
  }

  listClusterSummaries(params: {
    owner: string;
    repo: string;
    minSize?: number;
    limit?: number;
    sort?: TuiClusterSortMode;
    search?: string;
    includeClosed?: boolean;
  }): ClusterSummariesResponse {
    const snapshot = this.getTuiSnapshot({
      owner: params.owner,
      repo: params.repo,
      minSize: params.minSize,
      sort: params.sort,
      search: params.search,
      includeClosedClusters: params.includeClosed ?? true,
    });
    const clusters = params.limit ? snapshot.clusters.slice(0, params.limit) : snapshot.clusters;
    return clusterSummariesResponseSchema.parse({
      repository: snapshot.repository,
      stats: snapshot.stats,
      clusters: clusters.map((cluster) => ({
        clusterId: cluster.clusterId,
        displayTitle: cluster.displayTitle,
        isClosed: cluster.isClosed,
        closedAtLocal: cluster.closedAtLocal,
        closeReasonLocal: cluster.closeReasonLocal,
        totalCount: cluster.totalCount,
        issueCount: cluster.issueCount,
        pullRequestCount: cluster.pullRequestCount,
        latestUpdatedAt: cluster.latestUpdatedAt,
        representativeThreadId: cluster.representativeThreadId,
        representativeNumber: cluster.representativeNumber,
        representativeKind: cluster.representativeKind,
      })),
    });
  }

  getClusterDetailDump(params: {
    owner: string;
    repo: string;
    clusterId: number;
    memberLimit?: number;
    bodyChars?: number;
    includeClosed?: boolean;
  }): ClusterDetailResponse {
    const snapshot = this.getTuiSnapshot({
      owner: params.owner,
      repo: params.repo,
      minSize: 0,
      includeClosedClusters: params.includeClosed ?? true,
    });
    const cluster = snapshot.clusters.find((item) => item.clusterId === params.clusterId);
    if (!cluster) {
      throw new Error(`Cluster ${params.clusterId} was not found for ${snapshot.repository.fullName}.`);
    }

    const detail = this.getTuiClusterDetail({
      owner: params.owner,
      repo: params.repo,
      clusterId: params.clusterId,
      clusterRunId: snapshot.clusterRunId ?? undefined,
    });
    const members = detail.members.slice(0, params.memberLimit ?? detail.members.length).map((member) => {
      const threadDetail = this.getTuiThreadDetail({
        owner: params.owner,
        repo: params.repo,
        threadId: member.id,
        includeNeighbors: false,
      });
      return {
        thread: {
          ...threadDetail.thread,
          body: null,
        },
        bodySnippet: snippetText(threadDetail.thread.body, params.bodyChars ?? 280),
        summaries: threadDetail.summaries,
      };
    });

    return clusterDetailResponseSchema.parse({
      repository: snapshot.repository,
      stats: snapshot.stats,
      cluster: {
        clusterId: cluster.clusterId,
        displayTitle: cluster.displayTitle,
        isClosed: cluster.isClosed,
        closedAtLocal: cluster.closedAtLocal,
        closeReasonLocal: cluster.closeReasonLocal,
        totalCount: cluster.totalCount,
        issueCount: cluster.issueCount,
        pullRequestCount: cluster.pullRequestCount,
        latestUpdatedAt: cluster.latestUpdatedAt,
        representativeThreadId: cluster.representativeThreadId,
        representativeNumber: cluster.representativeNumber,
        representativeKind: cluster.representativeKind,
      },
      members,
    });
  }

  getTuiSnapshot(params: {
    owner: string;
    repo: string;
    minSize?: number;
    sort?: TuiClusterSortMode;
    search?: string;
    includeClosedClusters?: boolean;
  }): TuiSnapshot {
    const repository = this.requireRepository(params.owner, params.repo);
    const stats = getTuiRepoStats({ db: this.db, config: this.config, repoId: repository.id });
    const latestRun = getLatestClusterRun(this.db, repository.id);
    const includeClosedClusters = params.includeClosedClusters ?? true;
    const minSize = params.minSize ?? 1;
    const rawClusters = latestRun ? listRawTuiClusters(this.db, repository.id, latestRun.id, minSize) : [];
    const representedThreadIds = new Set(
      rawClusters
        .map((cluster) => cluster.representativeThreadId)
        .filter((threadId): threadId is number => threadId !== null),
    );
    const durableClosedClusters = includeClosedClusters
      ? listClosedDurableTuiClusters(this.db, repository.id, representedThreadIds, minSize)
      : [];
    const clusters = [...rawClusters, ...durableClosedClusters]
      .filter((cluster) => (includeClosedClusters ? true : !cluster.isClosed))
      .filter((cluster) => {
        const search = params.search?.trim().toLowerCase();
        if (!search) return true;
        return cluster.searchText.includes(search);
      })
      .sort((left, right) => compareTuiClusterSummary(left, right, params.sort ?? 'size'));

    return {
      repository,
      stats,
      clusterRunId: latestRun?.id ?? null,
      clusters,
    };
  }

  getTuiRefreshState(params: { owner: string; repo: string }): TuiRefreshState {
    const repository = this.requireRepository(params.owner, params.repo);
    return getTuiRepositoryRefreshState({ db: this.db, repository });
  }

  getTuiClusterDetail(params: { owner: string; repo: string; clusterId: number; clusterRunId?: number }): TuiClusterDetail {
    const repository = this.requireRepository(params.owner, params.repo);
    const clusterRunId =
      params.clusterRunId ??
      (getLatestClusterRun(this.db, repository.id)?.id ?? null);

    const summary = clusterRunId ? getRawTuiClusterSummary(this.db, repository.id, clusterRunId, params.clusterId) : null;
    const durableSummary = summary ? null : getDurableTuiClusterSummary(this.db, repository.id, params.clusterId);
    const resolvedSummary = summary ?? durableSummary;
    if (!resolvedSummary) {
      throw new Error(`Cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    return {
      clusterId: resolvedSummary.clusterId,
      displayTitle: resolvedSummary.displayTitle,
      isClosed: resolvedSummary.isClosed,
      closedAtLocal: resolvedSummary.closedAtLocal,
      closeReasonLocal: resolvedSummary.closeReasonLocal,
      totalCount: resolvedSummary.totalCount,
      issueCount: resolvedSummary.issueCount,
      pullRequestCount: resolvedSummary.pullRequestCount,
      latestUpdatedAt: resolvedSummary.latestUpdatedAt,
      representativeThreadId: resolvedSummary.representativeThreadId,
      representativeNumber: resolvedSummary.representativeNumber,
      representativeKind: resolvedSummary.representativeKind,
      members: listTuiClusterMembers(this.db, params.clusterId, summary ? 'run_cluster' : 'durable_cluster'),
    };
  }

  getTuiThreadDetail(params: {
    owner: string;
    repo: string;
    threadId?: number;
    threadNumber?: number;
    includeNeighbors?: boolean;
  }): TuiThreadDetail {
    const repository = this.requireRepository(params.owner, params.repo);
    const row = getTuiThreadRow({
      db: this.db,
      repoId: repository.id,
      threadId: params.threadId,
      threadNumber: params.threadNumber,
    });

    if (!row) {
      throw new Error(`Thread was not found for ${repository.fullName}.`);
    }

    const clusterId = getLatestTuiThreadClusterId(this.db, repository.id, row.id);
    const summaries = getTuiThreadSummaries(this.db, row.id, this.config.summaryModel);
    const topFiles = getTopChangedFiles(this.db, row.id, 5);
    const keySummary = getLatestTuiKeySummary(this.db, row.id, this.config.summaryModel);

    let neighbors: SearchHitDto['neighbors'] = [];
    if (params.includeNeighbors !== false) {
      neighbors = listStoredClusterNeighbors({ db: this.db, repoId: repository.id, threadId: row.id, limit: 8 });
      if (neighbors.length === 0) {
        try {
          neighbors = this.listNeighbors({
            owner: params.owner,
            repo: params.repo,
            threadNumber: row.number,
            limit: 8,
            minScore: 0.2,
          }).neighbors;
        } catch {
          neighbors = [];
        }
      }
    }

    return {
      thread: threadToDto(row, clusterId),
      summaries,
      keySummary,
      topFiles,
      neighbors,
    };
  }

  async rerunAction(request: ActionRequest): Promise<ActionResponse> {
    switch (request.action) {
      case 'summarize': {
        const result = await this.summarizeRepository(request);
        return actionResponseSchema.parse({
          ok: true,
          action: request.action,
          runId: result.runId,
          message: `Summarized ${result.summarized} thread(s)`,
        });
      }
      case 'embed': {
        const result = await this.embedRepository(request);
        return actionResponseSchema.parse({
          ok: true,
          action: request.action,
          runId: result.runId,
          message: `Embedded ${result.embedded} source vector(s)`,
        });
      }
      case 'cluster': {
        const result = await this.clusterRepository(request);
        return actionResponseSchema.parse({
          ok: true,
          action: request.action,
          runId: result.runId,
          message: `Clustered ${result.clusters} group(s) from ${result.edges} edge(s)`,
        });
      }
    }
  }

  private queryNearestWithRecovery(
    repoId: number,
    repoFullName: string,
    params: Omit<VectorQueryParams, 'storePath' | 'dimensions'>,
  ): VectorNeighbor[] {
    return queryNearestWithRecovery({
      vectorStore: this.vectorStore,
      configDir: this.config.configDir,
      repoFullName,
      dimensions: ACTIVE_EMBED_DIMENSIONS,
      query: params,
      rebuild: () => this.rebuildRepositoryVectorStore(repoId, repoFullName),
    });
  }

  private rebuildRepositoryVectorStore(repoId: number, repoFullName: string): void {
    rebuildRepositoryVectorStore({
      vectorStore: this.vectorStore,
      configDir: this.config.configDir,
      repoFullName,
      dimensions: ACTIVE_EMBED_DIMENSIONS,
      vectors: loadClusterableActiveVectorMeta({ db: this.db, config: this.config, repoId }),
    });
  }

  private resetRepositoryVectors(repoId: number, repoFullName: string): void {
    resetRepositoryVectors({
      db: this.db,
      vectorStore: this.vectorStore,
      config: this.config,
      repoId,
      repoFullName,
      dimensions: ACTIVE_EMBED_DIMENSIONS,
    });
  }

  private pruneInactiveRepositoryVectors(repoId: number, repoFullName: string): number {
    return pruneInactiveRepositoryVectors({
      db: this.db,
      vectorStore: this.vectorStore,
      configDir: this.config.configDir,
      repoId,
      repoFullName,
      dimensions: ACTIVE_EMBED_DIMENSIONS,
      rebuild: () => this.rebuildRepositoryVectorStore(repoId, repoFullName),
    });
  }

  private cleanupMigratedRepositoryArtifacts(repoId: number, repoFullName: string, onProgress?: (message: string) => void): void {
    cleanupMigratedRepositoryArtifacts({
      db: this.db,
      dbPath: this.config.dbPath,
      repoId,
      repoFullName,
      onProgress,
    });
  }

  private ensureDurableClusterForRunCluster(repoId: number, runClusterId: number, representativeThreadId: number | null): number {
    const members = this.db
      .prepare(
        `select thread_id, score_to_representative
         from cluster_members
         where cluster_id = ?
         order by thread_id asc`,
      )
      .all(runClusterId) as Array<{ thread_id: number; score_to_representative: number | null }>;
    if (members.length === 0) {
      throw new Error(`Cluster ${runClusterId} has no members.`);
    }

    const resolvedRepresentativeThreadId = representativeThreadId ?? members[0]?.thread_id;
    if (resolvedRepresentativeThreadId === undefined) {
      throw new Error(`Cluster ${runClusterId} has no representative.`);
    }

    const identity = humanKeyForValue(`repo:${repoId}:cluster-representative:${resolvedRepresentativeThreadId}`);
    const memberIds = members.map((member) => member.thread_id);
    const durableIdentity = this.resolveDurableClusterIdentity(repoId, identity.hash, memberIds, new Set());
    const durableClusterId = upsertClusterGroup(this.db, {
      repoId,
      stableKey: durableIdentity?.stable_key ?? identity.hash,
      stableSlug: durableIdentity?.stable_slug ?? humanKeyStableSlug(identity),
      status: 'active',
      clusterType: members.length > 1 ? 'duplicate_candidate' : 'singleton_orphan',
      representativeThreadId: resolvedRepresentativeThreadId,
      title: `Cluster ${identity.slug}`,
    });

    for (const member of members) {
      upsertClusterMembership(this.db, {
        clusterId: durableClusterId,
        threadId: member.thread_id,
        role: member.thread_id === resolvedRepresentativeThreadId ? 'canonical' : 'related',
        state: 'active',
        scoreToRepresentative: member.thread_id === resolvedRepresentativeThreadId ? 1 : member.score_to_representative,
        addedBy: 'algo',
        addedReason: {
          source: 'closeClusterLocally',
          runClusterId,
          representativeThreadId: resolvedRepresentativeThreadId,
        },
      });
    }

    return durableClusterId;
  }

  private requireAi(): AiProvider {
    if (!this.ai) {
      requireOpenAiKey(this.config);
    }
    return this.ai as AiProvider;
  }

  private requireGithub(): GitHubClient {
    if (!this.github) {
      requireGithubToken(this.config);
    }
    return this.github as GitHubClient;
  }

  private requireRepository(owner: string, repo: string): RepositoryDto {
    const fullName = `${owner}/${repo}`;
    const row = this.db.prepare('select * from repositories where full_name = ? limit 1').get(fullName) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Repository ${fullName} not found. Run sync first.`);
    }
    return repositoryToDto(row);
  }

  private async aggregateRepositoryEdges(
    repoId: number,
    sourceKinds: EmbeddingSourceKind[],
    params: { limit: number; minScore: number; onProgress?: (message: string) => void },
  ): Promise<Map<string, AggregatedClusterEdge>> {
    const aggregated = new Map<string, AggregatedClusterEdge>();
    const totalItems = sourceKinds.reduce((sum, sourceKind) => sum + countEmbeddingsForSourceKind({ db: this.db, repoId, sourceKind }), 0);

    if (sourceKinds.length === 0 || totalItems === 0) {
      return aggregated;
    }

    const workerRuntime = resolveEdgeWorkerRuntime();
    const shouldParallelize = workerRuntime !== null && sourceKinds.length > 1 && totalItems >= CLUSTER_PARALLEL_MIN_EMBEDDINGS && os.availableParallelism() > 1;
    if (!shouldParallelize) {
      let processedItems = 0;
      for (const sourceKind of sourceKinds) {
        const items = loadNormalizedEmbeddingsForSourceKind({
          db: this.db,
          repoId,
          embedModel: this.config.embedModel,
          sourceKind,
        });
        const edges = buildSourceKindEdges(items, {
          limit: params.limit,
          minScore: params.minScore,
          progressIntervalMs: CLUSTER_PROGRESS_INTERVAL_MS,
          onProgress: (progress) => {
            if (!params.onProgress) return;
            params.onProgress(
              `[cluster] identifying similarity edges ${processedItems + progress.processedItems}/${totalItems} source embeddings processed current_edges~=${aggregated.size + progress.currentEdgeEstimate}`,
            );
          },
        });
        processedItems += items.length;
        mergeSourceKindEdges(aggregated, edges, sourceKind);
      }

      return aggregated;
    }

    const progressBySource = new Map<EmbeddingSourceKind, { processedItems: number; totalItems: number; currentEdgeEstimate: number }>();

    const edgeSets = await Promise.all(
      sourceKinds.map(
        (sourceKind) =>
          new Promise<Array<{ leftThreadId: number; rightThreadId: number; score: number }>>((resolve, reject) => {
            const worker = new Worker(workerRuntime.url, {
              workerData: {
                dbPath: this.config.dbPath,
                repoId,
                sourceKind,
                limit: params.limit,
                minScore: params.minScore,
              },
            });

            worker.on('message', (message: unknown) => {
              if (!message || typeof message !== 'object') {
                return;
              }
              const typed = message as
                | {
                    type: 'progress';
                    sourceKind: EmbeddingSourceKind;
                    processedItems: number;
                    totalItems: number;
                    currentEdgeEstimate: number;
                  }
                | { type: 'result'; sourceKind: EmbeddingSourceKind; edges: Array<{ leftThreadId: number; rightThreadId: number; score: number }> };
              if (typed.type === 'progress') {
                progressBySource.set(typed.sourceKind, {
                  processedItems: typed.processedItems,
                  totalItems: typed.totalItems,
                  currentEdgeEstimate: typed.currentEdgeEstimate,
                });
                if (params.onProgress) {
                  const processedItems = Array.from(progressBySource.values()).reduce((sum, value) => sum + value.processedItems, 0);
                  const currentEdgeEstimate = Array.from(progressBySource.values()).reduce((sum, value) => sum + value.currentEdgeEstimate, 0);
                  params.onProgress(
                    `[cluster] identifying similarity edges ${processedItems}/${totalItems} source embeddings processed current_edges~=${aggregated.size + currentEdgeEstimate}`,
                  );
                }
                return;
              }
              resolve(typed.edges);
            });

            worker.on('error', reject);
            worker.on('exit', (code) => {
              if (code !== 0) {
                reject(new Error(`edge worker for ${sourceKind} exited with code ${code}`));
              }
            });
          }),
      ),
    );

    for (const [index, edges] of edgeSets.entries()) {
      mergeSourceKindEdges(aggregated, edges, sourceKinds[index] as EmbeddingSourceKind);
    }

    return aggregated;
  }

  private persistClusterRun(
    repoId: number,
    runId: number,
    aggregatedEdges: Map<string, AggregatedClusterEdge>,
    clusters: Array<{ representativeThreadId: number; members: number[] }>,
  ): void {
    const insertEdge = this.db.prepare(
      `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCluster = this.db.prepare(
      'insert into clusters (repo_id, cluster_run_id, representative_thread_id, member_count, created_at) values (?, ?, ?, ?, ?)',
    );
    const insertMember = this.db.prepare(
      'insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)',
    );

    this.db.transaction(() => {
      this.db.prepare('delete from cluster_members where cluster_id in (select id from clusters where cluster_run_id = ?)').run(runId);
      this.db.prepare('delete from clusters where cluster_run_id = ?').run(runId);
      this.db.prepare('delete from similarity_edges where cluster_run_id = ?').run(runId);

      const createdAt = nowIso();
      for (const edge of aggregatedEdges.values()) {
        insertEdge.run(
          repoId,
          runId,
          edge.leftThreadId,
          edge.rightThreadId,
          'exact_cosine',
          edge.score,
          asJson({ sources: Array.from(edge.sourceKinds).sort(), model: this.config.embedModel }),
          createdAt,
        );
      }

      for (const cluster of clusters) {
        const clusterResult = insertCluster.run(
          repoId,
          runId,
          cluster.representativeThreadId,
          cluster.members.length,
          createdAt,
        );
        const clusterId = Number(clusterResult.lastInsertRowid);
        for (const memberId of cluster.members) {
          const key = edgeKey(cluster.representativeThreadId, memberId);
          const score = memberId === cluster.representativeThreadId ? null : (aggregatedEdges.get(key)?.score ?? null);
          insertMember.run(clusterId, memberId, score, createdAt);
        }
      }
    })();
  }

  private persistDurableClusterState(
    repoId: number,
    pipelineRunId: number,
    aggregatedEdges: Map<string, AggregatedClusterEdge>,
    clusters: Array<{ representativeThreadId: number; members: number[] }>,
  ): void {
    this.db.transaction(() => {
      const claimedDurableClusterIds = new Set<number>();
      for (const edge of aggregatedEdges.values()) {
        upsertSimilarityEdgeEvidence(this.db, {
          repoId,
          leftThreadId: edge.leftThreadId,
          rightThreadId: edge.rightThreadId,
          algorithmVersion: 'persistent-cluster-v1',
          configHash: stableContentHash(JSON.stringify({ sources: Array.from(edge.sourceKinds).sort(), model: this.config.embedModel })),
          score: edge.score,
          tier: edge.score >= DEFAULT_CLUSTER_MIN_SCORE ? 'strong' : 'weak',
          state: 'active',
          breakdown: {
            sources: Array.from(edge.sourceKinds).sort(),
            score: edge.score,
          },
          runId: pipelineRunId,
        });
      }

      for (const cluster of clusters) {
        const identity = humanKeyForValue(`repo:${repoId}:cluster-representative:${cluster.representativeThreadId}`);
        const durableIdentity = this.resolveDurableClusterIdentity(repoId, identity.hash, cluster.members, claimedDurableClusterIds);
        const clusterId = upsertClusterGroup(this.db, {
          repoId,
          stableKey: durableIdentity?.stable_key ?? identity.hash,
          stableSlug: durableIdentity?.stable_slug ?? humanKeyStableSlug(identity),
          status: 'active',
          clusterType: cluster.members.length > 1 ? 'duplicate_candidate' : 'singleton_orphan',
          representativeThreadId: cluster.representativeThreadId,
          title: `Cluster ${identity.slug}`,
        });
        claimedDurableClusterIds.add(clusterId);
        const forcedCanonical = this.db
          .prepare(
            `select thread_id
             from cluster_overrides
             where cluster_id = ?
               and action = 'force_canonical'
               and (expires_at is null or expires_at > ?)
             order by created_at desc, id desc
             limit 1`,
          )
          .get(clusterId, nowIso()) as { thread_id: number } | undefined;
        const representativeThreadId =
          forcedCanonical && cluster.members.includes(forcedCanonical.thread_id)
            ? forcedCanonical.thread_id
            : cluster.representativeThreadId;
        if (representativeThreadId !== cluster.representativeThreadId) {
          this.db
            .prepare('update cluster_groups set representative_thread_id = ?, updated_at = ? where id = ?')
            .run(representativeThreadId, nowIso(), clusterId);
        }
        for (const memberId of cluster.members) {
          const scoreKey = edgeKey(representativeThreadId, memberId);
          const score = memberId === representativeThreadId ? 1 : (aggregatedEdges.get(scoreKey)?.score ?? null);
          const excluded = this.db
            .prepare(
              `select 1
               from cluster_overrides
               where cluster_id = ?
                 and thread_id = ?
                 and action = 'exclude'
                 and (expires_at is null or expires_at > ?)
               limit 1`,
            )
            .get(clusterId, memberId, nowIso());
          if (excluded) {
            upsertClusterMembership(this.db, {
              clusterId,
              threadId: memberId,
              role: 'related',
              state: 'blocked_by_override',
              scoreToRepresentative: score,
              runId: pipelineRunId,
              addedBy: 'algo',
              removedBy: 'user',
              addedReason: {
                source: 'clusterRepository',
                representativeThreadId,
              },
              removedReason: {
                source: 'cluster_overrides',
                action: 'exclude',
              },
            });
            recordClusterEvent(this.db, {
              clusterId,
              runId: pipelineRunId,
              eventType: 'block_member',
              actorKind: 'algo',
              payload: {
                threadId: memberId,
                representativeThreadId,
                scoreToRepresentative: score,
                reason: 'manual_exclusion',
              },
            });
            continue;
          }
          upsertClusterMembership(this.db, {
            clusterId,
            threadId: memberId,
            role: memberId === representativeThreadId ? 'canonical' : 'related',
            state: 'active',
            scoreToRepresentative: memberId === representativeThreadId ? 1 : score,
            runId: pipelineRunId,
            addedBy: memberId === representativeThreadId && forcedCanonical?.thread_id === memberId ? 'user' : 'algo',
            addedReason: {
              source: 'clusterRepository',
              representativeThreadId,
              forceCanonical: forcedCanonical?.thread_id === memberId,
            },
          });
          recordClusterEvent(this.db, {
            clusterId,
            runId: pipelineRunId,
            eventType: memberId === representativeThreadId ? 'keep_canonical' : 'upsert_member',
            actorKind: 'algo',
            payload: {
              threadId: memberId,
              representativeThreadId,
              scoreToRepresentative: memberId === representativeThreadId ? 1 : score,
            },
          });
        }
        const forcedIncludes = this.db
          .prepare(
            `select thread_id, reason
             from cluster_overrides
             where cluster_id = ?
               and action = 'force_include'
               and (expires_at is null or expires_at > ?)
             order by created_at asc, id asc`,
          )
          .all(clusterId, nowIso()) as Array<{ thread_id: number; reason: string | null }>;
        for (const forced of forcedIncludes) {
          if (cluster.members.includes(forced.thread_id)) {
            continue;
          }
          const scoreKey = edgeKey(representativeThreadId, forced.thread_id);
          const score = forced.thread_id === representativeThreadId ? 1 : (aggregatedEdges.get(scoreKey)?.score ?? null);
          upsertClusterMembership(this.db, {
            clusterId,
            threadId: forced.thread_id,
            role: forced.thread_id === representativeThreadId ? 'canonical' : 'related',
            state: 'active',
            scoreToRepresentative: score,
            runId: pipelineRunId,
            addedBy: 'user',
            addedReason: {
              source: 'cluster_overrides',
              action: 'force_include',
              reason: forced.reason,
            },
          });
          this.db
            .prepare("update cluster_memberships set added_by = 'user', updated_at = ? where cluster_id = ? and thread_id = ?")
            .run(nowIso(), clusterId, forced.thread_id);
          recordClusterEvent(this.db, {
            clusterId,
            runId: pipelineRunId,
            eventType: 'force_include_member',
            actorKind: 'algo',
            payload: {
              threadId: forced.thread_id,
              representativeThreadId,
              scoreToRepresentative: score,
              reason: forced.reason,
            },
          });
        }
      }
    })();
  }

  private resolveDurableClusterIdentity(
    repoId: number,
    representativeStableKey: string,
    memberIds: number[],
    claimedClusterIds: Set<number>,
  ): { id: number; stable_key: string; stable_slug: string } | null {
    const exact = this.db
      .prepare(
        `select id, stable_key, stable_slug
         from cluster_groups
         where repo_id = ?
           and stable_key = ?
           and status <> 'merged'
         limit 1`,
      )
      .get(repoId, representativeStableKey) as { id: number; stable_key: string; stable_slug: string } | undefined;
    if (exact && !claimedClusterIds.has(exact.id)) {
      return exact;
    }

    const uniqueMemberIds = Array.from(new Set(memberIds));
    if (uniqueMemberIds.length === 0) {
      return null;
    }

    const placeholders = uniqueMemberIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `select
            cg.id,
            cg.stable_key,
            cg.stable_slug,
            count(*) as member_count,
            sum(case when cm.thread_id in (${placeholders}) then 1 else 0 end) as overlap_count,
            max(cm.updated_at) as latest_membership_updated_at
         from cluster_groups cg
         join cluster_memberships cm on cm.cluster_id = cg.id and cm.state <> 'removed_by_user'
         where cg.repo_id = ?
           and cg.status <> 'merged'
         group by cg.id, cg.stable_key, cg.stable_slug
         having overlap_count > 0`,
      )
      .all(...uniqueMemberIds, repoId) as Array<{
      id: number;
      stable_key: string;
      stable_slug: string;
      member_count: number;
      overlap_count: number;
      latest_membership_updated_at: string | null;
    }>;

    return (
      rows
        .filter((row) => !claimedClusterIds.has(row.id))
        .map((row) => {
          const overlapBase = Math.min(uniqueMemberIds.length, row.member_count);
          return {
            row,
            overlapScore: overlapBase > 0 ? row.overlap_count / overlapBase : 0,
            latestMembershipTime: row.latest_membership_updated_at ? Date.parse(row.latest_membership_updated_at) : 0,
          };
        })
        .filter((entry) => entry.overlapScore >= DURABLE_CLUSTER_REUSE_MIN_OVERLAP)
        .sort(
          (left, right) =>
            right.overlapScore - left.overlapScore ||
            right.row.overlap_count - left.row.overlap_count ||
            right.latestMembershipTime - left.latestMembershipTime ||
            left.row.id - right.row.id,
        )[0]?.row ?? null
    );
  }

  private pruneOldClusterRuns(repoId: number, keepRunId: number): void {
    this.db.prepare('delete from cluster_runs where repo_id = ? and id <> ?').run(repoId, keepRunId);
  }

  private upsertSummary(threadId: number, contentHash: string, summaryKind: string, summaryText: string): void {
    this.db
      .prepare(
        `insert into document_summaries (thread_id, summary_kind, model, prompt_version, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(thread_id, summary_kind, model) do update set
           prompt_version = excluded.prompt_version,
           content_hash = excluded.content_hash,
           summary_text = excluded.summary_text,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, summaryKind, this.config.summaryModel, SUMMARY_PROMPT_VERSION, contentHash, summaryText, nowIso(), nowIso());
  }

  private upsertActiveVector(
    repoId: number,
    repoFullName: string,
    threadId: number,
    basis: EmbeddingBasis,
    contentHash: string,
    embedding: number[],
  ): void {
    this.db
      .prepare(
        `insert into thread_vectors (thread_id, basis, model, dimensions, content_hash, vector_json, vector_backend, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(thread_id) do update set
           basis = excluded.basis,
           model = excluded.model,
           dimensions = excluded.dimensions,
           content_hash = excluded.content_hash,
           vector_json = excluded.vector_json,
           vector_backend = excluded.vector_backend,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        basis,
        this.config.embedModel,
        embedding.length,
        contentHash,
        vectorBlob(embedding),
        this.config.vectorBackend,
        nowIso(),
        nowIso(),
      );
    try {
      this.vectorStore.upsertVector({
        storePath: repositoryVectorStorePath(this.config.configDir, repoFullName),
        dimensions: ACTIVE_EMBED_DIMENSIONS,
        threadId,
        vector: embedding,
      });
    } catch (error) {
      if (!isCorruptedVectorIndexError(error)) {
        throw error;
      }
      this.rebuildRepositoryVectorStore(repoId, repoFullName);
    }
  }

  private upsertEmbedding(threadId: number, sourceKind: EmbeddingSourceKind, contentHash: string, embedding: number[]): void {
    this.db
      .prepare(
        `insert into document_embeddings (thread_id, source_kind, model, dimensions, content_hash, embedding_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(thread_id, source_kind, model) do update set
           dimensions = excluded.dimensions,
           content_hash = excluded.content_hash,
           embedding_json = excluded.embedding_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        sourceKind,
        this.config.embedModel,
        embedding.length,
        contentHash,
        asJson(embedding),
        nowIso(),
        nowIso(),
      );
  }

}
