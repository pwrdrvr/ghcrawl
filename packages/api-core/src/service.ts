import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { IterableMapper } from '@shutterstock/p-map-iterable';
import {
  actionResponseSchema,
  closeResponseSchema,
  clusterOverrideResponseSchema,
  clusterMergeResponseSchema,
  clusterSplitResponseSchema,
  clusterDetailResponseSchema,
  clusterExplainResponseSchema,
  clusterResultSchema,
  clusterSummariesResponseSchema,
  clustersResponseSchema,
  durableClustersResponseSchema,
  embedResultSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  refreshResponseSchema,
  repositoriesResponseSchema,
  runHistoryResponseSchema,
  searchResponseSchema,
  syncResultSchema,
  threadsResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type CloseResponse,
  type ClusterMergeResponse,
  type ClusterOverrideResponse,
  type ClusterSplitResponse,
  type ClusterDetailResponse,
  type ClusterExplainResponse,
  type ClusterDto,
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
  type ThreadDto,
  type ThreadsResponse,
} from '@ghcrawl/api-contract';

import { buildClusters, buildRefinedClusters, buildSizeBoundedClusters } from './cluster/build.js';
import { buildCodeSnapshotSignature } from './cluster/code-signature.js';
import { buildDeterministicClusterGraphFromFingerprints, extractDeterministicRefs } from './cluster/deterministic-engine.js';
import { buildSourceKindEdges } from './cluster/exact-edges.js';
import { humanKeyForValue } from './cluster/human-key.js';
import { LLM_KEY_SUMMARY_PROMPT_VERSION, llmKeyInputHash } from './cluster/llm-key-summary.js';
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
} from './cluster/persistent-store.js';
import {
  buildDeterministicThreadFingerprint,
  THREAD_FINGERPRINT_ALGORITHM_VERSION,
  type DeterministicThreadFingerprint,
} from './cluster/thread-fingerprint.js';
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
import { openDb, type SqliteDatabase } from './db/sqlite.js';
import { readTextBlob, storeTextBlob } from './db/blob-store.js';
import { buildCanonicalDocument, isBotLikeAuthor } from './documents/normalize.js';
import { makeGitHubClient, type GitHubClient } from './github/client.js';
import { OpenAiProvider, type AiProvider } from './openai/provider.js';
import { cosineSimilarity, dotProduct, normalizeEmbedding, rankNearestNeighbors, rankNearestNeighborsByScore } from './search/exact.js';
import type { VectorNeighbor, VectorQueryParams, VectorStore } from './vector/store.js';
import { VectorliteStore } from './vector/vectorlite-store.js';

type RunTable = 'sync_runs' | 'summary_runs' | 'embedding_runs' | 'cluster_runs';

type ThreadRow = {
  id: number;
  repo_id: number;
  number: number;
  kind: 'issue' | 'pull_request';
  state: string;
  closed_at_gh: string | null;
  closed_at_local: string | null;
  close_reason_local: string | null;
  title: string;
  body: string | null;
  author_login: string | null;
  html_url: string;
  labels_json: string;
  updated_at_gh: string | null;
  first_pulled_at: string | null;
  last_pulled_at: string | null;
};

type CommentSeed = {
  githubId: string;
  commentType: string;
  authorLogin: string | null;
  authorType: string | null;
  body: string;
  isBot: boolean;
  rawJson: string;
  createdAtGh: string | null;
  updatedAtGh: string | null;
};

type EmbeddingSourceKind = 'title' | 'body' | 'dedupe_summary' | 'llm_key_summary';
type SimilaritySourceKind = EmbeddingSourceKind | 'deterministic_fingerprint';

type EmbeddingTask = {
  threadId: number;
  threadNumber: number;
  sourceKind: EmbeddingSourceKind;
  text: string;
  contentHash: string;
  estimatedTokens: number;
  wasTruncated: boolean;
};

type StoredEmbeddingRow = ThreadRow & {
  source_kind: EmbeddingSourceKind;
  embedding_json: string;
};

type ActiveVectorTask = {
  threadId: number;
  threadNumber: number;
  basis: EmbeddingBasis;
  text: string;
  contentHash: string;
  estimatedTokens: number;
  wasTruncated: boolean;
};

type ActiveVectorRow = ThreadRow & {
  basis: EmbeddingBasis;
  model: string;
  dimensions: number;
  content_hash: string;
  vector_json: Buffer | string;
  vector_backend: string;
};

type RepoPipelineStateRow = {
  repo_id: number;
  summary_model: string;
  summary_prompt_version: string;
  embedding_basis: EmbeddingBasis;
  embed_model: string;
  embed_dimensions: number;
  embed_pipeline_version: string;
  vector_backend: string;
  vectors_current_at: string | null;
  clusters_current_at: string | null;
  updated_at: string;
};

type ClusterExperimentMemoryStats = {
  rssBeforeBytes: number;
  rssAfterBytes: number;
  peakRssBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  peakHeapUsedBytes: number;
};

type ClusterExperimentSizeBucket = {
  size: number;
  count: number;
};

type ClusterExperimentClusterSizeStats = {
  soloClusters: number;
  maxClusterSize: number;
  topClusterSizes: number[];
  histogram: ClusterExperimentSizeBucket[];
};

type ClusterExperimentCluster = {
  representativeThreadId: number;
  memberThreadIds: number[];
};

type ClusterExperimentResult = {
  backend: 'exact' | 'vectorlite';
  repository: RepositoryDto;
  tempDbPath: string | null;
  threads: number;
  sourceKinds: number;
  edges: number;
  clusters: number;
  timingBasis: 'cluster-only';
  durationMs: number;
  totalDurationMs: number;
  loadMs: number;
  setupMs: number;
  edgeBuildMs: number;
  indexBuildMs: number;
  queryMs: number;
  clusterBuildMs: number;
  candidateK: number;
  memory: ClusterExperimentMemoryStats;
  clusterSizes: ClusterExperimentClusterSizeStats;
  clustersDetail: ClusterExperimentCluster[] | null;
};

type SummaryModelPricing = {
  inputCostPerM: number;
  cachedInputCostPerM: number;
  outputCostPerM: number;
};

type EmbeddingWorkset = {
  rows: Array<{
    id: number;
    number: number;
    title: string;
    body: string | null;
  }>;
  tasks: ActiveVectorTask[];
  existing: Map<string, string>;
  pending: ActiveVectorTask[];
  missingSummaryThreadNumbers: number[];
};

type SyncCursorState = {
  lastFullOpenScanStartedAt: string | null;
  lastOverlappingOpenScanCompletedAt: string | null;
  lastNonOverlappingScanCompletedAt: string | null;
  lastReconciledOpenCloseAt: string | null;
};

type SyncRunStats = {
  threadsSynced: number;
  commentsSynced: number;
  codeFilesSynced: number;
  threadsClosed: number;
  threadsClosedFromClosedSweep?: number;
  threadsClosedFromDirectReconcile?: number;
  crawlStartedAt: string;
  requestedSince: string | null;
  effectiveSince: string | null;
  limit: number | null;
  includeComments: boolean;
  includeCode?: boolean;
  fullReconcile?: boolean;
  isFullOpenScan: boolean;
  isOverlappingOpenScan: boolean;
  overlapReferenceAt: string | null;
  reconciledOpenCloseAt: string | null;
};

export type TuiClusterSortMode = 'recent' | 'size';

export type TuiRepoStats = {
  openIssueCount: number;
  openPullRequestCount: number;
  lastGithubReconciliationAt: string | null;
  lastEmbedRefreshAt: string | null;
  staleEmbedThreadCount: number;
  staleEmbedSourceCount: number;
  latestClusterRunId: number | null;
  latestClusterRunFinishedAt: string | null;
};

export type TuiClusterSummary = {
  clusterId: number;
  displayTitle: string;
  isClosed: boolean;
  closedAtLocal: string | null;
  closeReasonLocal: string | null;
  totalCount: number;
  issueCount: number;
  pullRequestCount: number;
  latestUpdatedAt: string | null;
  representativeThreadId: number | null;
  representativeNumber: number | null;
  representativeKind: 'issue' | 'pull_request' | null;
  searchText: string;
};

export type TuiClusterMember = {
  id: number;
  number: number;
  kind: 'issue' | 'pull_request';
  isClosed: boolean;
  title: string;
  updatedAtGh: string | null;
  htmlUrl: string;
  labels: string[];
  clusterScore: number | null;
};

export type TuiClusterDetail = {
  clusterId: number;
  displayTitle: string;
  isClosed: boolean;
  closedAtLocal: string | null;
  closeReasonLocal: string | null;
  totalCount: number;
  issueCount: number;
  pullRequestCount: number;
  latestUpdatedAt: string | null;
  representativeThreadId: number | null;
  representativeNumber: number | null;
  representativeKind: 'issue' | 'pull_request' | null;
  members: TuiClusterMember[];
};

export type TuiThreadDetail = {
  thread: ThreadDto;
  summaries: Partial<Record<'problem_summary' | 'solution_summary' | 'maintainer_signal_summary' | 'dedupe_summary', string>>;
  neighbors: SearchHitDto['neighbors'];
};

export type TuiSnapshot = {
  repository: RepositoryDto;
  stats: TuiRepoStats;
  clusterRunId: number | null;
  clusters: TuiClusterSummary[];
};

export type DoctorResult = {
  health: HealthResponse;
  github: {
    configured: boolean;
    source: ConfigValueSource;
    tokenPresent: boolean;
    error: string | null;
  };
  openai: {
    configured: boolean;
    source: ConfigValueSource;
    tokenPresent: boolean;
    error: string | null;
  };
  vectorlite: {
    configured: boolean;
    runtimeOk: boolean;
    error: string | null;
  };
};

type SyncOptions = {
  owner: string;
  repo: string;
  since?: string;
  limit?: number;
  includeComments?: boolean;
  includeCode?: boolean;
  fullReconcile?: boolean;
  onProgress?: (message: string) => void;
  startedAt?: string;
};

type SearchResultInternal = SearchResponse;
type NeighborsResultInternal = NeighborsResponse;

const SYNC_BATCH_SIZE = 100;
const SYNC_BATCH_DELAY_MS = 5000;
const STALE_CLOSED_SWEEP_LIMIT = 1000;
const CLUSTER_PROGRESS_INTERVAL_MS = 5000;
const RAW_JSON_INLINE_THRESHOLD_BYTES = 4096;
const CLUSTER_PARALLEL_MIN_EMBEDDINGS = 5000;
const EMBED_ESTIMATED_CHARS_PER_TOKEN = 3;
const EMBED_MAX_ITEM_TOKENS = 7000;
const EMBED_MAX_BATCH_TOKENS = 250000;
const requireFromHere = createRequire(import.meta.url);
const EMBED_TRUNCATION_MARKER = '\n\n[truncated for embedding]';
const EMBED_CONTEXT_RETRY_ATTEMPTS = 5;
const EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO = 0.9;
const EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO = 0.95;
const SUMMARY_PROMPT_VERSION = 'v1';
const ACTIVE_EMBED_DIMENSIONS = 1024;
const ACTIVE_EMBED_PIPELINE_VERSION = 'vectorlite-1024-v1';
const DEFAULT_CLUSTER_MIN_SCORE = 0.78;
const VECTORLITE_CLUSTER_EXPANDED_K = 24;
const VECTORLITE_CLUSTER_EXPANDED_MULTIPLIER = 4;
const VECTORLITE_CLUSTER_EXPANDED_CANDIDATE_K = 512;
const VECTORLITE_CLUSTER_EXPANDED_EF_SEARCH = 1024;
const SUMMARY_MODEL_PRICING: Record<string, SummaryModelPricing> = {
  'gpt-5-mini': {
    inputCostPerM: 0.25,
    cachedInputCostPerM: 0.025,
    outputCostPerM: 2.0,
  },
  'gpt-5.4-mini': {
    inputCostPerM: 0.75,
    cachedInputCostPerM: 0.075,
    outputCostPerM: 4.5,
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isEffectivelyClosed(row: { state: string; closed_at_local: string | null }): boolean {
  return row.state !== 'open' || row.closed_at_local !== null;
}

function isMissingGitHubResourceError(error: unknown): boolean {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? Number((error as { status?: unknown }).status) : null;
  if (status === 404 || status === 410) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(404|410)\b/.test(message) || /Not Found|Gone/i.test(message);
}

function deriveIncrementalSince(referenceAt: string, crawlStartedAt: string): string {
  const referenceMs = parseIso(referenceAt) ?? Date.now();
  const crawlMs = parseIso(crawlStartedAt) ?? Date.now();
  const gapMs = Math.max(0, crawlMs - referenceMs);
  const hourMs = 60 * 60 * 1000;
  const roundedHours = Math.max(2, Math.ceil(gapMs / hourMs));
  return new Date(crawlMs - roundedHours * hourMs).toISOString();
}

function parseSyncRunStats(statsJson: string | null): SyncRunStats | null {
  if (!statsJson) return null;
  try {
    const parsed = JSON.parse(statsJson) as Partial<SyncRunStats>;
    if (typeof parsed.crawlStartedAt !== 'string') {
      return null;
    }
    return {
      threadsSynced: typeof parsed.threadsSynced === 'number' ? parsed.threadsSynced : 0,
      commentsSynced: typeof parsed.commentsSynced === 'number' ? parsed.commentsSynced : 0,
      threadsClosed: typeof parsed.threadsClosed === 'number' ? parsed.threadsClosed : 0,
      crawlStartedAt: parsed.crawlStartedAt,
      requestedSince: typeof parsed.requestedSince === 'string' ? parsed.requestedSince : null,
      effectiveSince: typeof parsed.effectiveSince === 'string' ? parsed.effectiveSince : null,
      limit: typeof parsed.limit === 'number' ? parsed.limit : null,
      includeComments: parsed.includeComments === true,
      codeFilesSynced: typeof parsed.codeFilesSynced === 'number' ? parsed.codeFilesSynced : 0,
      includeCode: parsed.includeCode === true,
      isFullOpenScan: parsed.isFullOpenScan === true,
      isOverlappingOpenScan: parsed.isOverlappingOpenScan === true,
      overlapReferenceAt: typeof parsed.overlapReferenceAt === 'string' ? parsed.overlapReferenceAt : null,
      reconciledOpenCloseAt: typeof parsed.reconciledOpenCloseAt === 'string' ? parsed.reconciledOpenCloseAt : null,
    };
  } catch {
    return null;
  }
}

function asJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseArray(value: string): string[] {
  return JSON.parse(value) as string[];
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function parseObjectJson(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function userLogin(payload: Record<string, unknown>): string | null {
  const user = payload.user as Record<string, unknown> | undefined;
  const login = user?.login;
  return typeof login === 'string' ? login : null;
}

function userType(payload: Record<string, unknown>): string | null {
  const user = payload.user as Record<string, unknown> | undefined;
  const type = user?.type;
  return typeof type === 'string' ? type : null;
}

function isPullRequestPayload(payload: Record<string, unknown>): boolean {
  return Boolean(payload.pull_request);
}

function parseLabels(payload: Record<string, unknown>): string[] {
  const labels = payload.labels;
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label;
      if (label && typeof label === 'object' && typeof (label as Record<string, unknown>).name === 'string') {
        return String((label as Record<string, unknown>).name);
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function parseAssignees(payload: Record<string, unknown>): string[] {
  const assignees = payload.assignees;
  if (!Array.isArray(assignees)) return [];
  return assignees
    .map((assignee) => {
      if (assignee && typeof assignee === 'object' && typeof (assignee as Record<string, unknown>).login === 'string') {
        return String((assignee as Record<string, unknown>).login);
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function stableContentHash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
}

function snippetText(value: string | null | undefined, maxChars: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function repositoryToDto(row: Record<string, unknown>): RepositoryDto {
  return {
    id: Number(row.id),
    owner: String(row.owner),
    name: String(row.name),
    fullName: String(row.full_name),
    githubRepoId: row.github_repo_id === null ? null : String(row.github_repo_id),
    updatedAt: String(row.updated_at),
  };
}

function threadToDto(row: ThreadRow, clusterId?: number | null): ThreadDto {
  return {
    id: row.id,
    repoId: row.repo_id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    isClosed: isEffectivelyClosed(row),
    closedAtGh: row.closed_at_gh ?? null,
    closedAtLocal: row.closed_at_local ?? null,
    closeReasonLocal: row.close_reason_local ?? null,
    title: row.title,
    body: row.body,
    authorLogin: row.author_login,
    htmlUrl: row.html_url,
    labels: parseArray(row.labels_json),
    updatedAtGh: row.updated_at_gh,
    clusterId: clusterId ?? null,
  };
}

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
    const health = this.init();
    const github = {
      configured: Boolean(this.config.githubToken),
      source: this.config.githubTokenSource,
      tokenPresent: Boolean(this.config.githubToken),
      error: null as string | null,
    };
    const openai = {
      configured: Boolean(this.config.openaiApiKey),
      source: this.config.openaiApiKeySource,
      tokenPresent: Boolean(this.config.openaiApiKey),
      error: null as string | null,
    };
    if (!github.configured) {
      github.error = 'Set GITHUB_TOKEN to crawl GitHub data.';
    }
    if (!openai.configured) {
      openai.error = 'Set OPENAI_API_KEY only for summary or embedding commands.';
    }

    const vectorliteHealth = this.vectorStore.checkRuntime();

    return {
      health,
      github,
      openai,
      vectorlite: {
        configured: this.config.vectorBackend === 'vectorlite',
        runtimeOk: vectorliteHealth.ok,
        error: vectorliteHealth.error,
      },
    };
  }

  listRepositories(): RepositoriesResponse {
    const rows = this.db.prepare('select * from repositories order by full_name asc').all() as Array<Record<string, unknown>>;
    return repositoriesResponseSchema.parse({ repositories: rows.map(repositoryToDto) });
  }

  listRunHistory(params: { owner: string; repo: string; kind?: RunKind; limit?: number }): RunHistoryResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 200);
    const tables: Array<{ kind: RunKind; table: RunTable }> = [
      { kind: 'sync', table: 'sync_runs' },
      { kind: 'summary', table: 'summary_runs' },
      { kind: 'embedding', table: 'embedding_runs' },
      { kind: 'cluster', table: 'cluster_runs' },
    ];
    const selectedTables = params.kind ? tables.filter((entry) => entry.kind === params.kind) : tables;
    const sql = selectedTables
      .map(
        (entry) =>
          `select '${entry.kind}' as run_kind, id, scope, status, started_at, finished_at, stats_json, error_text from ${entry.table} where repo_id = ?`,
      )
      .join(' union all ');
    const rows = this.db
      .prepare(`select * from (${sql}) order by started_at desc, id desc limit ?`)
      .all(...selectedTables.map(() => repository.id), limit) as Array<{
      run_kind: RunKind;
      id: number;
      scope: string;
      status: string;
      started_at: string;
      finished_at: string | null;
      stats_json: string | null;
      error_text: string | null;
    }>;

    return runHistoryResponseSchema.parse({
      repository,
      runs: rows.map((row) => ({
        runId: row.id,
        runKind: row.run_kind,
        scope: row.scope,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        stats: parseObjectJson(row.stats_json),
        errorText: row.error_text,
      })),
    });
  }

  listThreads(params: { owner: string; repo: string; kind?: 'issue' | 'pull_request'; numbers?: number[]; includeClosed?: boolean }): ThreadsResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const clusterIds = new Map<number, number>();
    const clusterRows = this.db
      .prepare(
        `select cm.thread_id, cm.cluster_id
         from cluster_members cm
         join clusters c on c.id = cm.cluster_id
         where c.repo_id = ? and c.cluster_run_id = (
           select id from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1
         )`,
      )
      .all(repository.id, repository.id) as Array<{ thread_id: number; cluster_id: number }>;
    for (const row of clusterRows) clusterIds.set(row.thread_id, row.cluster_id);

    let sql = 'select * from threads where repo_id = ?';
    const args: Array<string | number> = [repository.id];
    if (!params.includeClosed) {
      sql += " and state = 'open' and closed_at_local is null";
    }
    if (params.kind) {
      sql += ' and kind = ?';
      args.push(params.kind);
    }
    if (params.numbers && params.numbers.length > 0) {
      const uniqueNumbers = Array.from(new Set(params.numbers.filter((value) => Number.isSafeInteger(value) && value > 0)));
      if (uniqueNumbers.length === 0) {
        return threadsResponseSchema.parse({
          repository,
          threads: [],
        });
      }
      sql += ` and number in (${uniqueNumbers.map(() => '?').join(', ')})`;
      args.push(...uniqueNumbers);
    }
    sql += ' order by updated_at_gh desc, number desc';
    const rows = this.db.prepare(sql).all(...args) as ThreadRow[];
    const orderedRows =
      params.numbers && params.numbers.length > 0
        ? (() => {
            const byNumber = new Map(rows.map((row) => [row.number, row] as const));
            const uniqueRequested = Array.from(new Set(params.numbers));
            return uniqueRequested.map((number) => byNumber.get(number)).filter((row): row is ThreadRow => row !== undefined);
          })()
        : rows;
    return threadsResponseSchema.parse({
      repository,
      threads: orderedRows.map((row) => threadToDto(row, clusterIds.get(row.id) ?? null)),
    });
  }

  closeThreadLocally(params: { owner: string; repo: string; threadNumber: number }): CloseResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const row = this.db
      .prepare('select * from threads where repo_id = ? and number = ? limit 1')
      .get(repository.id, params.threadNumber) as ThreadRow | undefined;
    if (!row) {
      throw new Error(`Thread #${params.threadNumber} was not found for ${repository.fullName}.`);
    }

    const closedAt = nowIso();
    this.db
      .prepare(
        `update threads
         set closed_at_local = ?,
             close_reason_local = 'manual',
             updated_at = ?
         where id = ?`,
      )
      .run(closedAt, closedAt, row.id);
    const clusterIds = this.getLatestRunClusterIdsForThread(repository.id, row.id);
    const clusterClosed = this.reconcileClusterCloseState(repository.id, clusterIds) > 0;
    const updated = this.db.prepare('select * from threads where id = ? limit 1').get(row.id) as ThreadRow;

    return closeResponseSchema.parse({
      ok: true,
      repository,
      thread: threadToDto(updated),
      clusterId: clusterIds[0] ?? null,
      clusterClosed,
      message: `Marked ${updated.kind} #${updated.number} closed locally.`,
    });
  }

  closeClusterLocally(params: { owner: string; repo: string; clusterId: number }): CloseResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const latestRun = this.getLatestClusterRun(repository.id);
    if (!latestRun) {
      throw new Error(`No completed cluster run found for ${repository.fullName}.`);
    }

    const row = this.db
      .prepare('select id from clusters where repo_id = ? and cluster_run_id = ? and id = ? limit 1')
      .get(repository.id, latestRun.id, params.clusterId) as { id: number } | undefined;
    if (!row) {
      throw new Error(`Cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const closedAt = nowIso();
    this.db
      .prepare(
        `update clusters
         set closed_at_local = ?,
             close_reason_local = 'manual'
         where id = ?`,
      )
      .run(closedAt, row.id);

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
         from cluster_groups
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
         from cluster_groups
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
        stableSlug: identity.slug,
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
    const repoId = this.upsertRepository(params.owner, params.repo, repoData);
    const runId = this.startRun('sync_runs', repoId, `${params.owner}/${params.repo}`);
    const syncCursor = this.getSyncCursorState(repoId);
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
        if (index > 0 && index % SYNC_BATCH_SIZE === 0) {
          params.onProgress?.(`[sync] batch boundary reached at ${index} threads; sleeping 5s before continuing`);
          await new Promise((resolve) => setTimeout(resolve, SYNC_BATCH_DELAY_MS));
        }
        const number = Number(item.number);
        const isPr = isPullRequestPayload(item);
        const kind = isPr ? 'pull_request' : 'issue';
        params.onProgress?.(`[sync] ${index + 1}/${items.length} ${kind} #${number}`);
        try {
          const threadPayload = isPr ? await github.getPull(params.owner, params.repo, number, reporter) : item;
          const threadId = this.upsertThread(repoId, kind, threadPayload, crawlStartedAt);
          if (includeCode && isPr) {
            const files = await github.listPullFiles(params.owner, params.repo, number, reporter);
            this.persistThreadCodeSnapshot(threadId, threadPayload, files);
            codeFilesSynced += files.length;
          }
          if (includeComments) {
            const comments = await this.fetchThreadComments(params.owner, params.repo, number, isPr, reporter);
            this.replaceComments(threadId, comments);
            commentsSynced += comments.length;
          }
          this.refreshDocument(threadId);
          fingerprintThreadIds.push(threadId);
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
        ? await this.applyClosedOverlapSweep({
            repoId,
            owner: params.owner,
            repo: params.repo,
            crawlStartedAt,
            closedSweepSince: effectiveSince,
            reporter,
            onProgress: params.onProgress,
          })
        : 0;
      const shouldReconcileMissingOpenThreads =
        params.fullReconcile === true && params.limit === undefined && (isFullOpenScan || isOverlappingOpenScan);
      if (!shouldReconcileMissingOpenThreads && params.fullReconcile !== true) {
        params.onProgress?.('[sync] skipping full stale-open reconciliation by default; use --full-reconcile to force direct checks of all unseen open items');
      } else if (!shouldReconcileMissingOpenThreads) {
        params.onProgress?.('[sync] skipping full stale-open reconciliation because this scan did not overlap a confirmed full/overlap cursor');
      }
      const threadsClosedFromDirectReconcile = shouldReconcileMissingOpenThreads
        ? await this.reconcileMissingOpenThreads({
            repoId,
            owner: params.owner,
            repo: params.repo,
            crawlStartedAt,
            reporter,
            onProgress: params.onProgress,
          })
        : 0;
      const threadsClosed = threadsClosedFromClosedSweep + threadsClosedFromDirectReconcile;
      if (threadsClosed > 0) {
        this.reconcileClusterCloseState(repoId);
      }
      if (fingerprintThreadIds.length > 0) {
        const fingerprintItems = this.loadDeterministicClusterableThreadMeta(
          repoId,
          Array.from(new Set(fingerprintThreadIds)),
        );
        this.materializeLatestDeterministicFingerprints(fingerprintItems, params.onProgress);
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
      this.writeSyncCursorState(repoId, nextSyncCursor);
      this.finishRun('sync_runs', runId, 'completed', {
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
        threadsClosedFromDirectReconcile,
        reconciledOpenCloseAt,
      } satisfies SyncRunStats, undefined, finishedAt);
      return syncResultSchema.parse({ runId, threadsSynced, commentsSynced, codeFilesSynced, threadsClosed });
    } catch (error) {
      this.finishRun('sync_runs', runId, 'failed', null, error);
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
    const runId = this.startRun('summary_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);
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

      const sources = rows.map((row) => {
        const source = this.buildSummarySource(row.id, row.title, row.body, parseArray(row.labels_json), includeComments);
        return { ...row, ...source };
      });

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

      this.finishRun('summary_runs', runId, 'completed', { summarized, inputTokens, outputTokens, totalTokens });
      return { runId, summarized, inputTokens, outputTokens, totalTokens };
    } catch (error) {
      this.finishRun('summary_runs', runId, 'failed', null, error);
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
    const providerName = ai.providerName ?? 'custom';
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = this.startRun('summary_runs', repository.id, params.threadNumber ? `key-summary:${params.threadNumber}` : `key-summary:${repository.fullName}`);

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
      sql += ' order by number asc';
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

      for (const row of rows) {
        const labels = parseArray(row.labels_json);
        const inputHash = llmKeyInputHash({
          title: row.title,
          body: row.body,
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

        let result: Awaited<ReturnType<NonNullable<typeof ai.generateKeySummary>>>;
        try {
          result = await ai.generateKeySummary({
            model: this.config.summaryModel,
            text: [`title: ${row.title}`, `labels: ${labels.join(', ')}`, `body: ${row.body ?? ''}`].join('\n'),
          });
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          if (errorSamples.length < 10) {
            errorSamples.push({ number: row.number, error: message });
          }
          params.onProgress?.(`[key-summary] failed thread #${row.number}: ${message}`);
          continue;
        }
        upsertThreadKeySummary(this.db, {
          threadRevisionId: revisionId,
          summaryKind: 'llm_key_3line',
          promptVersion: LLM_KEY_SUMMARY_PROMPT_VERSION,
          provider: providerName,
          model: this.config.summaryModel,
          inputHash,
          summary: result.summary,
        });
        generated += 1;
        if (result.usage) {
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
          totalTokens += result.usage.totalTokens;
        }
        params.onProgress?.(`[key-summary] generated ${generated}/${rows.length} thread #${row.number}`);
      }

      const payload = { runId, generated, skipped, failed, inputTokens, outputTokens, totalTokens, errorSamples };
      this.finishRun('summary_runs', runId, 'completed', payload);
      return payload;
    } catch (error) {
      this.finishRun('summary_runs', runId, 'failed', null, error);
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
      this.refreshDocument(thread.id);
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
    const runId = this.startRun('embedding_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);

    try {
      if (params.threadNumber === undefined) {
        if (!this.isRepoVectorStateCurrent(repository.id)) {
          this.resetRepositoryVectors(repository.id, repository.fullName);
        } else {
          const pruned = this.pruneInactiveRepositoryVectors(repository.id, repository.fullName);
          if (pruned > 0) {
            params.onProgress?.(`[embed] pruned ${pruned} closed or inactive vector(s) before refresh`);
          }
        }
      }

      const { rows, tasks, pending, missingSummaryThreadNumbers } = this.getEmbeddingWorkset(repository.id, params.threadNumber);
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
      const batches = this.chunkEmbeddingTasks(pending, this.config.embedBatchSize, EMBED_MAX_BATCH_TOKENS);
      const mapper = new IterableMapper(
        batches,
        async (batch: ActiveVectorTask[]) => {
          return this.embedBatchWithRecovery(ai, batch, params.onProgress);
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

      this.markRepoVectorsCurrent(repository.id);
      this.finishRun('embedding_runs', runId, 'completed', { embedded });
      return embedResultSchema.parse({ runId, embedded });
    } catch (error) {
      this.finishRun('embedding_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  async clusterRepository(params: {
    owner: string;
    repo: string;
    threadNumber?: number;
    minScore?: number;
    k?: number;
    onProgress?: (message: string) => void;
  }): Promise<ClusterResultDto> {
    const repository = this.requireRepository(params.owner, params.repo);
    const runSubject = params.threadNumber ? `${repository.fullName}#${params.threadNumber}` : repository.fullName;
    const runId = this.startRun('cluster_runs', repository.id, runSubject);
    const pipelineRunId = createPipelineRun(this.db, {
      repoId: repository.id,
      runKind: params.threadNumber ? 'cluster_incremental' : 'cluster',
      algorithmVersion: 'persistent-cluster-v1',
      configHash: stableContentHash(
        JSON.stringify({
          threadNumber: params.threadNumber ?? null,
          minScore: params.minScore ?? DEFAULT_CLUSTER_MIN_SCORE,
          k: params.k ?? 6,
          embedModel: this.config.embedModel,
          embeddingBasis: this.config.embeddingBasis,
        }),
      ),
    });
    const minScore = params.minScore ?? DEFAULT_CLUSTER_MIN_SCORE;
    const k = params.k ?? 6;

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
      const deterministicItems = this.loadDeterministicClusterableThreadMeta(repository.id);
      const fingerprintItems = seedThreadIds ? deterministicItems.filter((item) => seedThreadIds.includes(item.id)) : deterministicItems;
      this.materializeLatestDeterministicFingerprints(fingerprintItems, params.onProgress);
      const persistedFingerprints = this.loadLatestDeterministicFingerprints(deterministicItems.map((item) => item.id));
      const deterministic = buildDeterministicClusterGraphFromFingerprints(
        deterministicItems.map((item) => ({ id: item.id, number: item.number, title: item.title })),
        persistedFingerprints,
        { topK: Math.max(k * 8, 64), seedThreadIds },
      );
      const aggregatedEdges = new Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<SimilaritySourceKind> }>();
      this.mergeSourceKindEdges(
        aggregatedEdges,
        deterministic.edges.filter((edge) => edge.score >= minScore),
        'deterministic_fingerprint',
      );
      params.onProgress?.(
        `[cluster] built ${aggregatedEdges.size} deterministic similarity edge(s) for ${runSubject}`,
      );

      if (this.isRepoVectorStateCurrent(repository.id)) {
        const vectorItems = this.loadClusterableActiveVectorMeta(repository.id, repository.fullName);
        const queryVectorItems = seedThreadIds ? vectorItems.filter((item) => seedThreadIds.includes(item.id)) : vectorItems;
        const activeSourceKind = this.activeVectorSourceKind();
        const activeIds = new Set(vectorItems.map((item) => item.id));
        const annQuery = this.getVectorliteClusterQuery(vectorItems.length, k);
        let processed = 0;
        let lastProgressAt = Date.now();

        params.onProgress?.(
          `[cluster] loaded ${vectorItems.length} active vector(s), querying ${queryVectorItems.length} for ${runSubject} backend=${this.config.vectorBackend} k=${k} query_limit=${annQuery.limit} candidateK=${annQuery.candidateK} efSearch=${annQuery.efSearch ?? 'default'} minScore=${minScore}`,
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
            this.mergeSourceKindEdges(
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
      } else if (!seedThreadIds && this.hasLegacyEmbeddings(repository.id)) {
        const legacy = this.loadClusterableThreadMeta(repository.id);
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
            this.mergeSourceKindEdges(
              aggregatedEdges,
              [{ leftThreadId: legacyEdge.leftThreadId, rightThreadId: legacyEdge.rightThreadId, score: legacyEdge.score }],
              sourceKind,
            );
          }
        }
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
      const clusters = buildClusters(
        clusterItems.map((item) => ({ threadId: item.id, number: item.number, title: item.title })),
        edges,
      );
      if (!seedThreadIds) {
        this.persistClusterRun(repository.id, runId, aggregatedEdges, clusters);
      }
      this.persistDurableClusterState(repository.id, pipelineRunId, aggregatedEdges, clusters);
      if (!seedThreadIds) {
        this.pruneOldClusterRuns(repository.id, runId);
      }
      if (!seedThreadIds && this.isRepoVectorStateCurrent(repository.id)) {
        this.markRepoClustersCurrent(repository.id);
        this.cleanupMigratedRepositoryArtifacts(repository.id, repository.fullName, params.onProgress);
      }

      params.onProgress?.(
        seedThreadIds
          ? `[cluster] persisted ${clusters.length} durable neighborhood cluster(s) without replacing the full cluster snapshot`
          : `[cluster] persisted ${clusters.length} cluster(s) and pruned older cluster runs`,
      );

      const stats = { edges: edges.length, clusters: clusters.length, threadNumber: params.threadNumber ?? null };
      this.finishRun('cluster_runs', runId, 'completed', stats);
      finishPipelineRun(this.db, pipelineRunId, { status: 'completed', stats });
      return clusterResultSchema.parse({ runId, edges: edges.length, clusters: clusters.length });
    } catch (error) {
      this.finishRun('cluster_runs', runId, 'failed', null, error);
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
    const loaded = this.loadClusterableThreadMeta(repository.id);
    const activeVectors = this.isRepoVectorStateCurrent(repository.id) ? this.loadNormalizedActiveVectors(repository.id) : [];
    const activeSourceKind = this.activeVectorSourceKind();
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

    const perSourceScores = new Map<string, { leftThreadId: number; rightThreadId: number; scores: Map<EmbeddingSourceKind, number> }>();
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
          this.collectSourceKindScores(perSourceScores, edges, activeSourceKind);
          recordMemory();
        } else {
          const totalItems = sourceKinds.reduce((sum, sourceKind) => sum + this.countEmbeddingsForSourceKind(repository.id, sourceKind), 0);
          let processedItems = 0;

          for (const sourceKind of sourceKinds) {
            const loadStartedAt = Date.now();
            const normalizedRows = this.loadNormalizedEmbeddingsForSourceKind(repository.id, sourceKind);
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
            this.collectSourceKindScores(perSourceScores, edges, sourceKind);
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
              rows: this.loadNormalizedEmbeddingsForSourceKind(repository.id, sourceKind).map((row) => ({
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
              insert.run(row.id, this.normalizedEmbeddingBuffer(row.normalizedEmbedding));
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
            const candidates = query.all(this.normalizedEmbeddingBuffer(row.normalizedEmbedding)) as Array<{
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
                return this.normalizedDistanceToScore(candidate.distance);
              },
            });
            let addedThisRow = 0;
            for (const candidate of ranked) {
              const score = candidate.score;
              const key = this.edgeKey(row.id, candidate.item.rowid);
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
      const aggregated = this.finalizeEdgeScores(perSourceScores, aggregation, weights, minScore);

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
        clusterSizes: this.summarizeClusterSizes(clusters),
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
      if (this.isRepoVectorStateCurrent(repository.id)) {
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
      } else if (this.hasLegacyEmbeddings(repository.id)) {
        const [queryEmbedding] = await this.ai.embedTexts({ model: this.config.embedModel, texts: [params.query] });
        for (const row of this.iterateStoredEmbeddings(repository.id)) {
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
        vector: this.parseStoredVector(targetRow.vector_json),
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
      const targetRows = this.loadStoredEmbeddingsForThreadNumber(repository.id, params.threadNumber);
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
      for (const row of this.iterateStoredEmbeddings(repository.id)) {
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
    const latestRun = this.db
      .prepare("select id from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1")
      .get(repository.id) as { id: number } | undefined;

    if (!latestRun) {
      return clustersResponseSchema.parse({ repository, clusters: [] });
    }

    const rows = this.db
      .prepare(
        `select c.id, c.repo_id, c.representative_thread_id, c.member_count,
                c.closed_at_local, c.close_reason_local,
                cm.thread_id, cm.score_to_representative, t.number, t.kind, t.title, t.state, t.closed_at_local as thread_closed_at_local
         from clusters c
         left join cluster_members cm on cm.cluster_id = c.id
         left join threads t on t.id = cm.thread_id
         where c.cluster_run_id = ?
         order by c.member_count desc, c.id asc, t.number asc`,
      )
      .all(latestRun.id) as Array<{
        id: number;
        repo_id: number;
        representative_thread_id: number | null;
        member_count: number;
        closed_at_local: string | null;
        close_reason_local: string | null;
        thread_id: number | null;
        score_to_representative: number | null;
        number: number | null;
        kind: 'issue' | 'pull_request' | null;
        title: string | null;
        state: string | null;
        thread_closed_at_local: string | null;
      }>;

    const clusters = new Map<number, ClusterDto>();
    for (const row of rows) {
      const cluster = clusters.get(row.id) ?? {
        id: row.id,
        repoId: row.repo_id,
        isClosed: row.close_reason_local !== null,
        closedAtLocal: row.closed_at_local,
        closeReasonLocal: row.close_reason_local,
        representativeThreadId: row.representative_thread_id,
        memberCount: row.member_count,
        members: [],
      };
      if (row.thread_id !== null && row.number !== null && row.kind !== null && row.title !== null) {
        cluster.members.push({
          threadId: row.thread_id,
          number: row.number,
          kind: row.kind,
          isClosed: row.state !== null && isEffectivelyClosed({ state: row.state, closed_at_local: row.thread_closed_at_local }),
          title: row.title,
          scoreToRepresentative: row.score_to_representative,
        });
      }
      clusters.set(row.id, cluster);
    }

    const clusterValues = Array.from(clusters.values()).map((cluster) => ({
      ...cluster,
      isClosed: cluster.isClosed || (cluster.memberCount > 0 && cluster.members.every((member) => member.isClosed)),
    }));

    return clustersResponseSchema.parse({
      repository,
      clusters: clusterValues.filter((cluster) => (params.includeClosed ? true : !cluster.isClosed)),
    });
  }

  listDurableClusters(params: { owner: string; repo: string; includeInactive?: boolean; memberLimit?: number }): DurableClustersResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const clusterRows = this.db
      .prepare(
        `select id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title
         from cluster_groups
         where repo_id = ?
           and (? = 1 or status = 'active')
         order by updated_at desc, id asc`,
      )
      .all(repository.id, params.includeInactive ? 1 : 0) as Array<{
      id: number;
      stable_key: string;
      stable_slug: string;
      status: 'active' | 'closed' | 'merged' | 'split';
      cluster_type: string | null;
      representative_thread_id: number | null;
      title: string | null;
    }>;
    if (clusterRows.length === 0) {
      return durableClustersResponseSchema.parse({ repository, clusters: [] });
    }

    const clusterIds = clusterRows.map((row) => row.id);
    const placeholders = clusterIds.map(() => '?').join(',');
    const memberRows = this.db
      .prepare(
        `select
           cm.cluster_id,
           cm.role as membership_role,
           cm.state as membership_state,
           cm.score_to_representative as membership_score,
           t.*
         from cluster_memberships cm
         join threads t on t.id = cm.thread_id
         where cm.cluster_id in (${placeholders})
         order by
           case cm.role when 'canonical' then 0 else 1 end,
           case cm.state when 'active' then 0 when 'pending_review' then 1 else 2 end,
           t.number asc`,
      )
      .all(...clusterIds) as Array<
      ThreadRow & {
        cluster_id: number;
        membership_role: 'canonical' | 'duplicate' | 'related';
        membership_state: 'active' | 'removed_by_user' | 'blocked_by_override' | 'pending_review' | 'stale';
        membership_score: number | null;
      }
    >;
    const membersByCluster = new Map<number, typeof memberRows>();
    for (const row of memberRows) {
      const members = membersByCluster.get(row.cluster_id) ?? [];
      members.push(row);
      membersByCluster.set(row.cluster_id, members);
    }

    return durableClustersResponseSchema.parse({
      repository,
      clusters: clusterRows.map((cluster) => {
        const rows = membersByCluster.get(cluster.id) ?? [];
        const visibleRows = params.memberLimit === undefined ? rows : rows.slice(0, params.memberLimit);
        return {
          clusterId: cluster.id,
          stableKey: cluster.stable_key,
          stableSlug: cluster.stable_slug,
          status: cluster.status,
          clusterType: cluster.cluster_type,
          title: cluster.title,
          representativeThreadId: cluster.representative_thread_id,
          activeCount: rows.filter((row) => row.membership_state === 'active').length,
          removedCount: rows.filter((row) => row.membership_state === 'removed_by_user').length,
          blockedCount: rows.filter((row) => row.membership_state === 'blocked_by_override').length,
          members: visibleRows.map((row) => ({
            thread: threadToDto(row),
            role: row.membership_role,
            state: row.membership_state,
            scoreToRepresentative: row.membership_score,
          })),
        };
      }),
    });
  }

  explainDurableCluster(params: { owner: string; repo: string; clusterId: number; memberLimit?: number; eventLimit?: number }): ClusterExplainResponse {
    const repository = this.requireRepository(params.owner, params.repo);
    const cluster = this.db
      .prepare(
        `select id, stable_key, stable_slug, status, cluster_type, representative_thread_id, title
         from cluster_groups
         where repo_id = ?
           and id = ?
         limit 1`,
      )
      .get(repository.id, params.clusterId) as
      | {
          id: number;
          stable_key: string;
          stable_slug: string;
          status: 'active' | 'closed' | 'merged' | 'split';
          cluster_type: string | null;
          representative_thread_id: number | null;
          title: string | null;
        }
      | undefined;
    if (!cluster) {
      throw new Error(`Durable cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const allMembers = this.db
      .prepare(
        `select
           cm.role as membership_role,
           cm.state as membership_state,
           cm.score_to_representative as membership_score,
           t.*
         from cluster_memberships cm
         join threads t on t.id = cm.thread_id
         where cm.cluster_id = ?
         order by
           case cm.role when 'canonical' then 0 else 1 end,
           case cm.state when 'active' then 0 when 'pending_review' then 1 else 2 end,
           t.number asc`,
      )
      .all(cluster.id) as Array<
      ThreadRow & {
        membership_role: 'canonical' | 'duplicate' | 'related';
        membership_state: 'active' | 'removed_by_user' | 'blocked_by_override' | 'pending_review' | 'stale';
        membership_score: number | null;
      }
    >;
    const visibleMembers = allMembers.slice(0, params.memberLimit ?? 50);
    const visibleThreadIds = visibleMembers.map((row) => row.id);

    const aliases = this.db
      .prepare(
        `select alias_slug, reason, created_at
         from cluster_aliases
         where cluster_id = ?
         order by created_at desc, alias_slug asc`,
      )
      .all(cluster.id) as Array<{ alias_slug: string; reason: string; created_at: string }>;
    const overrides = this.db
      .prepare(
        `select t.number, co.action, co.reason, co.created_at, co.expires_at
         from cluster_overrides co
         join threads t on t.id = co.thread_id
         where co.cluster_id = ?
         order by co.created_at desc, t.number asc`,
      )
      .all(cluster.id) as Array<{ number: number; action: 'exclude' | 'force_include' | 'force_canonical'; reason: string | null; created_at: string; expires_at: string | null }>;
    const events = this.db
      .prepare(
        `select event_type, actor_kind, payload_json, created_at
         from cluster_events
         where cluster_id = ?
         order by created_at desc, id desc
         limit ?`,
      )
      .all(cluster.id, params.eventLimit ?? 25) as Array<{ event_type: string; actor_kind: string; payload_json: string; created_at: string }>;

    let evidence: Array<{
      leftThreadNumber: number;
      rightThreadNumber: number;
      score: number;
      tier: 'strong' | 'weak';
      state: 'active' | 'stale' | 'rejected';
      sources: string[];
      breakdown: Record<string, unknown>;
      lastSeenRunId: number | null;
      updatedAt: string;
    }> = [];
    if (visibleThreadIds.length >= 2) {
      const placeholders = visibleThreadIds.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `select
             le.number as left_number,
             re.number as right_number,
             e.score,
             e.tier,
             e.state,
             e.breakdown_json,
             e.last_seen_run_id,
             e.updated_at
           from similarity_edge_evidence e
           join threads le on le.id = e.left_thread_id
           join threads re on re.id = e.right_thread_id
           where e.repo_id = ?
             and e.left_thread_id in (${placeholders})
             and e.right_thread_id in (${placeholders})
           order by e.score desc, le.number asc, re.number asc`,
        )
        .all(repository.id, ...visibleThreadIds, ...visibleThreadIds) as Array<{
        left_number: number;
        right_number: number;
        score: number;
        tier: 'strong' | 'weak';
        state: 'active' | 'stale' | 'rejected';
        breakdown_json: string;
        last_seen_run_id: number | null;
        updated_at: string;
      }>;
      evidence = rows.map((row) => {
        const breakdown = parseObjectJson(row.breakdown_json) ?? {};
        const rawSources = breakdown.sources;
        return {
          leftThreadNumber: row.left_number,
          rightThreadNumber: row.right_number,
          score: row.score,
          tier: row.tier,
          state: row.state,
          sources: Array.isArray(rawSources) ? rawSources.filter((source): source is string => typeof source === 'string') : [],
          breakdown,
          lastSeenRunId: row.last_seen_run_id,
          updatedAt: row.updated_at,
        };
      });
    }

    return clusterExplainResponseSchema.parse({
      repository,
      cluster: {
        clusterId: cluster.id,
        stableKey: cluster.stable_key,
        stableSlug: cluster.stable_slug,
        status: cluster.status,
        clusterType: cluster.cluster_type,
        title: cluster.title,
        representativeThreadId: cluster.representative_thread_id,
        activeCount: allMembers.filter((row) => row.membership_state === 'active').length,
        removedCount: allMembers.filter((row) => row.membership_state === 'removed_by_user').length,
        blockedCount: allMembers.filter((row) => row.membership_state === 'blocked_by_override').length,
        members: visibleMembers.map((row) => ({
          thread: threadToDto(row),
          role: row.membership_role,
          state: row.membership_state,
          scoreToRepresentative: row.membership_score,
        })),
      },
      aliases: aliases.map((alias) => ({
        aliasSlug: alias.alias_slug,
        reason: alias.reason,
        createdAt: alias.created_at,
      })),
      overrides: overrides.map((override) => ({
        threadNumber: override.number,
        action: override.action,
        reason: override.reason,
        createdAt: override.created_at,
        expiresAt: override.expires_at,
      })),
      events: events.map((event) => ({
        eventType: event.event_type,
        actorKind: event.actor_kind,
        payload: parseObjectJson(event.payload_json),
        createdAt: event.created_at,
      })),
      evidence,
    });
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
      includeClosedClusters: params.includeClosed === true,
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
      includeClosedClusters: params.includeClosed === true,
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
    const stats = this.getTuiRepoStats(repository.id);
    const latestRun = this.getLatestClusterRun(repository.id);
    if (!latestRun) {
      return { repository, stats, clusterRunId: null, clusters: [] };
    }

    const includeClosedClusters = params.includeClosedClusters ?? true;
    const clusters = this.listRawTuiClusters(repository.id, latestRun.id)
      .filter((cluster) => (includeClosedClusters ? true : !cluster.isClosed))
      .filter((cluster) => cluster.totalCount >= (params.minSize ?? 1))
      .filter((cluster) => {
        const search = params.search?.trim().toLowerCase();
        if (!search) return true;
        return cluster.searchText.includes(search);
      })
      .sort((left, right) => this.compareTuiClusterSummary(left, right, params.sort ?? 'recent'));

    return {
      repository,
      stats,
      clusterRunId: latestRun.id,
      clusters,
    };
  }

  getTuiClusterDetail(params: { owner: string; repo: string; clusterId: number; clusterRunId?: number }): TuiClusterDetail {
    const repository = this.requireRepository(params.owner, params.repo);
    const clusterRunId =
      params.clusterRunId ??
      (this.getLatestClusterRun(repository.id)?.id ?? null);
    if (!clusterRunId) {
      throw new Error(`No completed cluster run found for ${repository.fullName}. Run cluster first.`);
    }

    const summary = this.getRawTuiClusterSummary(repository.id, clusterRunId, params.clusterId);
    if (!summary) {
      throw new Error(`Cluster ${params.clusterId} was not found for ${repository.fullName}.`);
    }

    const rows = this.db
      .prepare(
        `select t.id, t.number, t.kind, t.state, t.closed_at_local, t.title, t.updated_at_gh, t.html_url, t.labels_json, cm.score_to_representative
         from cluster_members cm
         join threads t on t.id = cm.thread_id
         where cm.cluster_id = ?
         order by
           case t.kind when 'issue' then 0 else 1 end asc,
           coalesce(t.updated_at_gh, t.updated_at) desc,
           t.number desc`,
      )
      .all(params.clusterId) as Array<{
        id: number;
        number: number;
        kind: 'issue' | 'pull_request';
        state: string;
        closed_at_local: string | null;
        title: string;
        updated_at_gh: string | null;
        html_url: string;
        labels_json: string;
        score_to_representative: number | null;
      }>;

    return {
      clusterId: summary.clusterId,
      displayTitle: summary.displayTitle,
      isClosed: summary.isClosed,
      closedAtLocal: summary.closedAtLocal,
      closeReasonLocal: summary.closeReasonLocal,
      totalCount: summary.totalCount,
      issueCount: summary.issueCount,
      pullRequestCount: summary.pullRequestCount,
      latestUpdatedAt: summary.latestUpdatedAt,
      representativeThreadId: summary.representativeThreadId,
      representativeNumber: summary.representativeNumber,
      representativeKind: summary.representativeKind,
      members: rows.map((row) => ({
        id: row.id,
        number: row.number,
        kind: row.kind,
        isClosed: isEffectivelyClosed(row),
        title: row.title,
        updatedAtGh: row.updated_at_gh,
        htmlUrl: row.html_url,
        labels: parseArray(row.labels_json),
        clusterScore: row.score_to_representative,
      })),
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
    const row = params.threadId
      ? ((this.db
          .prepare('select * from threads where repo_id = ? and id = ? limit 1')
          .get(repository.id, params.threadId) as ThreadRow | undefined) ?? null)
      : params.threadNumber
        ? ((this.db
            .prepare('select * from threads where repo_id = ? and number = ? limit 1')
            .get(repository.id, params.threadNumber) as ThreadRow | undefined) ?? null)
        : null;

    if (!row) {
      throw new Error(`Thread was not found for ${repository.fullName}.`);
    }

    const latestRun = this.getLatestClusterRun(repository.id);
    const clusterMembership = latestRun
      ? ((this.db
          .prepare(
            `select cm.cluster_id
             from cluster_members cm
             join clusters c on c.id = cm.cluster_id
             where c.cluster_run_id = ? and cm.thread_id = ?
             limit 1`,
          )
          .get(latestRun.id, row.id) as { cluster_id: number } | undefined) ?? null)
      : null;

    const summaryRows = this.db
      .prepare(
        `select summary_kind, summary_text
         from document_summaries
         where thread_id = ? and model = ? and prompt_version = ?
         order by summary_kind asc`,
      )
      .all(row.id, this.config.summaryModel, SUMMARY_PROMPT_VERSION) as Array<{ summary_kind: string; summary_text: string }>;
    const summaries: TuiThreadDetail['summaries'] = {};
    for (const summary of summaryRows) {
      if (
        summary.summary_kind === 'problem_summary' ||
        summary.summary_kind === 'solution_summary' ||
        summary.summary_kind === 'maintainer_signal_summary' ||
        summary.summary_kind === 'dedupe_summary'
      ) {
        summaries[summary.summary_kind] = summary.summary_text;
      }
    }

    let neighbors: SearchHitDto['neighbors'] = [];
    if (params.includeNeighbors !== false) {
      neighbors = this.listStoredClusterNeighbors(repository.id, row.id, 8);
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
      thread: threadToDto(row, clusterMembership?.cluster_id ?? null),
      summaries,
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

  private getSyncCursorState(repoId: number): SyncCursorState {
    const persisted = (this.db
      .prepare(
        `select
            last_full_open_scan_started_at,
            last_overlapping_open_scan_completed_at,
            last_non_overlapping_scan_completed_at,
            last_open_close_reconciled_at
         from repo_sync_state
         where repo_id = ?`,
      )
      .get(repoId) as
      | {
          last_full_open_scan_started_at: string | null;
          last_overlapping_open_scan_completed_at: string | null;
          last_non_overlapping_scan_completed_at: string | null;
          last_open_close_reconciled_at: string | null;
        }
      | undefined) ?? null;
    if (persisted) {
      return {
        lastFullOpenScanStartedAt: persisted.last_full_open_scan_started_at,
        lastOverlappingOpenScanCompletedAt: persisted.last_overlapping_open_scan_completed_at,
        lastNonOverlappingScanCompletedAt: persisted.last_non_overlapping_scan_completed_at,
        lastReconciledOpenCloseAt: persisted.last_open_close_reconciled_at,
      };
    }

    const rows = this.db
      .prepare("select finished_at, stats_json from sync_runs where repo_id = ? and status = 'completed' order by id desc")
      .all(repoId) as Array<{ finished_at: string | null; stats_json: string | null }>;
    const state: SyncCursorState = {
      lastFullOpenScanStartedAt: null,
      lastOverlappingOpenScanCompletedAt: null,
      lastNonOverlappingScanCompletedAt: null,
      lastReconciledOpenCloseAt: null,
    };

    for (const row of rows) {
      const stats = parseSyncRunStats(row.stats_json);
      if (!stats) continue;
      if (state.lastFullOpenScanStartedAt === null && stats.isFullOpenScan) {
        state.lastFullOpenScanStartedAt = stats.crawlStartedAt;
      }
      if (state.lastOverlappingOpenScanCompletedAt === null && stats.isOverlappingOpenScan && row.finished_at) {
        state.lastOverlappingOpenScanCompletedAt = row.finished_at;
      }
      if (state.lastNonOverlappingScanCompletedAt === null && !stats.isFullOpenScan && !stats.isOverlappingOpenScan && row.finished_at) {
        state.lastNonOverlappingScanCompletedAt = row.finished_at;
      }
      if (state.lastReconciledOpenCloseAt === null && stats.reconciledOpenCloseAt) {
        state.lastReconciledOpenCloseAt = stats.reconciledOpenCloseAt;
      }
    }

    if (
      state.lastFullOpenScanStartedAt !== null ||
      state.lastOverlappingOpenScanCompletedAt !== null ||
      state.lastNonOverlappingScanCompletedAt !== null ||
      state.lastReconciledOpenCloseAt !== null
    ) {
      this.writeSyncCursorState(repoId, state);
    }

    return state;
  }

  private writeSyncCursorState(repoId: number, state: SyncCursorState): void {
    this.db
      .prepare(
        `insert into repo_sync_state (
            repo_id,
            last_full_open_scan_started_at,
            last_overlapping_open_scan_completed_at,
            last_non_overlapping_scan_completed_at,
            last_open_close_reconciled_at,
            updated_at
         ) values (?, ?, ?, ?, ?, ?)
         on conflict(repo_id) do update set
           last_full_open_scan_started_at = excluded.last_full_open_scan_started_at,
           last_overlapping_open_scan_completed_at = excluded.last_overlapping_open_scan_completed_at,
           last_non_overlapping_scan_completed_at = excluded.last_non_overlapping_scan_completed_at,
           last_open_close_reconciled_at = excluded.last_open_close_reconciled_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        repoId,
        state.lastFullOpenScanStartedAt,
        state.lastOverlappingOpenScanCompletedAt,
        state.lastNonOverlappingScanCompletedAt,
        state.lastReconciledOpenCloseAt,
        nowIso(),
      );
  }

  private getTuiRepoStats(repoId: number): TuiRepoStats {
    const counts = this.db
      .prepare(
        `select kind, count(*) as count
         from threads
         where repo_id = ? and state = 'open' and closed_at_local is null
         group by kind`,
      )
      .all(repoId) as Array<{ kind: 'issue' | 'pull_request'; count: number }>;
    const latestRun = this.getLatestClusterRun(repoId);
    const latestSync = (this.db
      .prepare("select finished_at from sync_runs where repo_id = ? and status = 'completed' order by id desc limit 1")
      .get(repoId) as { finished_at: string | null } | undefined) ?? null;
    const latestEmbed = (this.db
      .prepare("select finished_at from embedding_runs where repo_id = ? and status = 'completed' order by id desc limit 1")
      .get(repoId) as { finished_at: string | null } | undefined) ?? null;
    const embeddingWorkset = this.getEmbeddingWorkset(repoId);
    const staleThreadIds = new Set<number>(embeddingWorkset.pending.map((task) => task.threadId));
    return {
      openIssueCount: counts.find((row) => row.kind === 'issue')?.count ?? 0,
      openPullRequestCount: counts.find((row) => row.kind === 'pull_request')?.count ?? 0,
      lastGithubReconciliationAt: latestSync?.finished_at ?? null,
      lastEmbedRefreshAt: latestEmbed?.finished_at ?? null,
      staleEmbedThreadCount: staleThreadIds.size,
      staleEmbedSourceCount: embeddingWorkset.pending.length,
      latestClusterRunId: latestRun?.id ?? null,
      latestClusterRunFinishedAt: latestRun?.finished_at ?? null,
    };
  }

  private getDesiredPipelineState(): Omit<RepoPipelineStateRow, 'repo_id' | 'vectors_current_at' | 'clusters_current_at' | 'updated_at'> {
    return {
      summary_model: this.config.summaryModel,
      summary_prompt_version: SUMMARY_PROMPT_VERSION,
      embedding_basis: this.config.embeddingBasis,
      embed_model: this.config.embedModel,
      embed_dimensions: ACTIVE_EMBED_DIMENSIONS,
      embed_pipeline_version: ACTIVE_EMBED_PIPELINE_VERSION,
      vector_backend: this.config.vectorBackend,
    };
  }

  private getRepoPipelineState(repoId: number): RepoPipelineStateRow | null {
    return (
      (this.db.prepare('select * from repo_pipeline_state where repo_id = ? limit 1').get(repoId) as RepoPipelineStateRow | undefined) ??
      null
    );
  }

  private isRepoVectorStateCurrent(repoId: number): boolean {
    const state = this.getRepoPipelineState(repoId);
    if (!state || !state.vectors_current_at) {
      return false;
    }
    const desired = this.getDesiredPipelineState();
    return (
      state.summary_model === desired.summary_model &&
      state.summary_prompt_version === desired.summary_prompt_version &&
      state.embedding_basis === desired.embedding_basis &&
      state.embed_model === desired.embed_model &&
      state.embed_dimensions === desired.embed_dimensions &&
      state.embed_pipeline_version === desired.embed_pipeline_version &&
      state.vector_backend === desired.vector_backend
    );
  }

  private isRepoClusterStateCurrent(repoId: number): boolean {
    const state = this.getRepoPipelineState(repoId);
    return this.isRepoVectorStateCurrent(repoId) && Boolean(state?.clusters_current_at);
  }

  private hasLegacyEmbeddings(repoId: number): boolean {
    const row = this.db
      .prepare(
        `select count(*) as count
         from document_embeddings e
         join threads t on t.id = e.thread_id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and e.model = ?`,
      )
      .get(repoId, this.config.embedModel) as { count: number };
    return row.count > 0;
  }

  private writeRepoPipelineState(
    repoId: number,
    overrides: Partial<Pick<RepoPipelineStateRow, 'vectors_current_at' | 'clusters_current_at'>>,
  ): void {
    const desired = this.getDesiredPipelineState();
    const current = this.getRepoPipelineState(repoId);
    this.db
      .prepare(
        `insert into repo_pipeline_state (
            repo_id,
            summary_model,
            summary_prompt_version,
            embedding_basis,
            embed_model,
            embed_dimensions,
            embed_pipeline_version,
            vector_backend,
            vectors_current_at,
            clusters_current_at,
            updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(repo_id) do update set
           summary_model = excluded.summary_model,
           summary_prompt_version = excluded.summary_prompt_version,
           embedding_basis = excluded.embedding_basis,
           embed_model = excluded.embed_model,
           embed_dimensions = excluded.embed_dimensions,
           embed_pipeline_version = excluded.embed_pipeline_version,
           vector_backend = excluded.vector_backend,
           vectors_current_at = excluded.vectors_current_at,
           clusters_current_at = excluded.clusters_current_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        repoId,
        desired.summary_model,
        desired.summary_prompt_version,
        desired.embedding_basis,
        desired.embed_model,
        desired.embed_dimensions,
        desired.embed_pipeline_version,
        desired.vector_backend,
        overrides.vectors_current_at ?? current?.vectors_current_at ?? null,
        overrides.clusters_current_at ?? current?.clusters_current_at ?? null,
        nowIso(),
      );
  }

  private markRepoVectorsCurrent(repoId: number): void {
    this.writeRepoPipelineState(repoId, {
      vectors_current_at: nowIso(),
      clusters_current_at: null,
    });
  }

  private markRepoClustersCurrent(repoId: number): void {
    const state = this.getRepoPipelineState(repoId);
    this.writeRepoPipelineState(repoId, {
      vectors_current_at: state?.vectors_current_at ?? nowIso(),
      clusters_current_at: nowIso(),
    });
  }

  private repoVectorStorePath(repoFullName: string): string {
    const safeName = repoFullName.replace(/[^a-zA-Z0-9._-]+/g, '__');
    return path.join(this.config.configDir, 'vectors', `${safeName}.sqlite`);
  }

  private queryNearestWithRecovery(
    repoId: number,
    repoFullName: string,
    params: Omit<VectorQueryParams, 'storePath' | 'dimensions'>,
  ): VectorNeighbor[] {
    try {
      return this.vectorStore.queryNearest({
        ...params,
        storePath: this.repoVectorStorePath(repoFullName),
        dimensions: ACTIVE_EMBED_DIMENSIONS,
      });
    } catch (error) {
      if (!this.isCorruptedVectorIndexError(error)) {
        throw error;
      }
      this.rebuildRepositoryVectorStore(repoId, repoFullName);
      return this.vectorStore.queryNearest({
        ...params,
        storePath: this.repoVectorStorePath(repoFullName),
        dimensions: ACTIVE_EMBED_DIMENSIONS,
      });
    }
  }

  private rebuildRepositoryVectorStore(repoId: number, repoFullName: string): void {
    this.vectorStore.resetRepository({
      storePath: this.repoVectorStorePath(repoFullName),
      dimensions: ACTIVE_EMBED_DIMENSIONS,
    });
    for (const row of this.loadClusterableActiveVectorMeta(repoId, repoFullName)) {
      this.vectorStore.upsertVector({
        storePath: this.repoVectorStorePath(repoFullName),
        dimensions: ACTIVE_EMBED_DIMENSIONS,
        threadId: row.id,
        vector: row.embedding,
      });
    }
  }

  private isCorruptedVectorIndexError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Failed to load index from file|corrupted or unsupported/i.test(message);
  }

  private resetRepositoryVectors(repoId: number, repoFullName: string): void {
    this.db
      .prepare(
        `delete from thread_vectors
         where thread_id in (select id from threads where repo_id = ?)`,
      )
      .run(repoId);
    this.vectorStore.resetRepository({
      storePath: this.repoVectorStorePath(repoFullName),
      dimensions: ACTIVE_EMBED_DIMENSIONS,
    });
    this.writeRepoPipelineState(repoId, {
      vectors_current_at: null,
      clusters_current_at: null,
    });
  }

  private pruneInactiveRepositoryVectors(repoId: number, repoFullName: string): number {
    const rows = this.db
      .prepare(
        `select tv.thread_id
         from thread_vectors tv
         join threads t on t.id = tv.thread_id
         where t.repo_id = ?
           and (t.state != 'open' or t.closed_at_local is not null)`,
      )
      .all(repoId) as Array<{ thread_id: number }>;
    if (rows.length === 0) {
      return 0;
    }

    const deleteVectorRow = this.db.prepare('delete from thread_vectors where thread_id = ?');
    let shouldRebuildVectorStore = false;
    this.db.transaction(() => {
      for (const row of rows) {
        deleteVectorRow.run(row.thread_id);
        try {
          this.vectorStore.deleteVector({
            storePath: this.repoVectorStorePath(repoFullName),
            dimensions: ACTIVE_EMBED_DIMENSIONS,
            threadId: row.thread_id,
          });
        } catch (error) {
          if (!this.isCorruptedVectorIndexError(error)) {
            throw error;
          }
          shouldRebuildVectorStore = true;
        }
      }
    })();
    if (shouldRebuildVectorStore) {
      this.rebuildRepositoryVectorStore(repoId, repoFullName);
    }
    return rows.length;
  }

  private cleanupMigratedRepositoryArtifacts(repoId: number, repoFullName: string, onProgress?: (message: string) => void): void {
    const legacyEmbeddingCount = this.countLegacyEmbeddings(repoId);
    const inlineJsonVectorCount = this.countInlineJsonThreadVectors(repoId);
    if (legacyEmbeddingCount === 0 && inlineJsonVectorCount === 0) {
      return;
    }

    if (legacyEmbeddingCount > 0) {
      this.db
        .prepare(
          `delete from document_embeddings
           where thread_id in (select id from threads where repo_id = ?)`,
        )
        .run(repoId);
      onProgress?.(`[cleanup] removed ${legacyEmbeddingCount} legacy document embedding row(s) after vector migration`);
    }

    if (inlineJsonVectorCount > 0) {
      const rows = this.db
        .prepare(
          `select tv.thread_id, tv.vector_json
           from thread_vectors tv
           join threads t on t.id = tv.thread_id
           where t.repo_id = ?
             and typeof(tv.vector_json) = 'text'
             and tv.vector_json != ''`,
        )
        .all(repoId) as Array<{ thread_id: number; vector_json: string }>;
      const update = this.db.prepare('update thread_vectors set vector_json = ?, updated_at = ? where thread_id = ?');
      this.db.transaction(() => {
        for (const row of rows) {
          update.run(this.vectorBlob(JSON.parse(row.vector_json) as number[]), nowIso(), row.thread_id);
        }
      })();
      onProgress?.(`[cleanup] compacted ${inlineJsonVectorCount} inline SQLite vector payload(s) from JSON to binary blobs`);
    }

    if (this.config.dbPath !== ':memory:') {
      onProgress?.(`[cleanup] checkpointing WAL and vacuuming ${repoFullName} migration changes`);
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    }
  }

  private getLatestClusterRun(repoId: number): { id: number; finished_at: string | null } | null {
    const state = this.getRepoPipelineState(repoId);
    if (state && !this.isRepoClusterStateCurrent(repoId)) {
      return null;
    }
    return (
      (this.db
        .prepare("select id, finished_at from cluster_runs where repo_id = ? and status = 'completed' order by id desc limit 1")
        .get(repoId) as { id: number; finished_at: string | null } | undefined) ?? null
    );
  }

  private getLatestRunClusterIdsForThread(repoId: number, threadId: number): number[] {
    const latestRun = this.getLatestClusterRun(repoId);
    if (!latestRun) {
      return [];
    }
    return (
      this.db
        .prepare(
          `select cm.cluster_id
           from cluster_members cm
           join clusters c on c.id = cm.cluster_id
           where c.repo_id = ? and c.cluster_run_id = ? and cm.thread_id = ?
           order by cm.cluster_id asc`,
        )
        .all(repoId, latestRun.id, threadId) as Array<{ cluster_id: number }>
    ).map((row) => row.cluster_id);
  }

  private reconcileClusterCloseState(repoId: number, clusterIds?: number[]): number {
    const latestRun = this.getLatestClusterRun(repoId);
    if (!latestRun) {
      return 0;
    }

    const resolvedClusterIds =
      clusterIds && clusterIds.length > 0
        ? Array.from(new Set(clusterIds))
        : (
            this.db
              .prepare('select id from clusters where repo_id = ? and cluster_run_id = ? order by id asc')
              .all(repoId, latestRun.id) as Array<{ id: number }>
          ).map((row) => row.id);
    if (resolvedClusterIds.length === 0) {
      return 0;
    }

    const summarize = this.db.prepare(
      `select
          c.id,
          c.close_reason_local,
          count(*) as member_count,
          sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count
       from clusters c
       join cluster_members cm on cm.cluster_id = c.id
       join threads t on t.id = cm.thread_id
       where c.id = ?
       group by c.id, c.close_reason_local`,
    );
    const markClosed = this.db.prepare(
      `update clusters
       set closed_at_local = coalesce(closed_at_local, ?),
           close_reason_local = 'all_members_closed'
       where id = ?`,
    );
    const clearClosed = this.db.prepare(
      `update clusters
       set closed_at_local = null,
           close_reason_local = null
       where id = ? and close_reason_local = 'all_members_closed'`,
    );

    let changed = 0;
    for (const clusterId of resolvedClusterIds) {
      const row = summarize.get(clusterId) as
        | {
            id: number;
            close_reason_local: string | null;
            member_count: number;
            closed_member_count: number;
          }
        | undefined;
      if (!row || row.close_reason_local === 'manual') {
        continue;
      }
      if (row.member_count > 0 && row.closed_member_count >= row.member_count) {
        const result = markClosed.run(nowIso(), clusterId);
        changed += result.changes;
        continue;
      }
      const cleared = clearClosed.run(clusterId);
      changed += cleared.changes;
    }

    return changed;
  }

  private listRawTuiClusters(repoId: number, clusterRunId: number): TuiClusterSummary[] {
    const rows = this.db
      .prepare(
        `select
            c.id as cluster_id,
            c.member_count,
            c.closed_at_local,
            c.close_reason_local,
            c.representative_thread_id,
            rt.number as representative_number,
            rt.kind as representative_kind,
            rt.title as representative_title,
            max(coalesce(t.updated_at_gh, t.updated_at)) as latest_updated_at,
            sum(case when t.kind = 'issue' then 1 else 0 end) as issue_count,
            sum(case when t.kind = 'pull_request' then 1 else 0 end) as pull_request_count,
            sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count,
            group_concat(lower(coalesce(t.title, '')), ' ') as search_text
         from clusters c
         left join threads rt on rt.id = c.representative_thread_id
         join cluster_members cm on cm.cluster_id = c.id
         join threads t on t.id = cm.thread_id
         where c.repo_id = ? and c.cluster_run_id = ?
         group by
           c.id,
           c.member_count,
           c.closed_at_local,
           c.close_reason_local,
           c.representative_thread_id,
           rt.number,
           rt.kind,
           rt.title`,
      )
      .all(repoId, clusterRunId) as Array<{
        cluster_id: number;
        member_count: number;
        closed_at_local: string | null;
        close_reason_local: string | null;
        representative_thread_id: number | null;
        representative_number: number | null;
        representative_kind: 'issue' | 'pull_request' | null;
        representative_title: string | null;
        latest_updated_at: string | null;
        issue_count: number;
        pull_request_count: number;
        closed_member_count: number;
        search_text: string | null;
      }>;

    return rows.map((row) => ({
      clusterId: row.cluster_id,
      displayTitle: row.representative_title ?? `Cluster ${row.cluster_id}`,
      isClosed: row.close_reason_local !== null || row.closed_member_count >= row.member_count,
      closedAtLocal: row.closed_at_local,
      closeReasonLocal: row.close_reason_local,
      totalCount: row.member_count,
      issueCount: row.issue_count,
      pullRequestCount: row.pull_request_count,
      latestUpdatedAt: row.latest_updated_at,
      representativeThreadId: row.representative_thread_id,
      representativeNumber: row.representative_number,
      representativeKind: row.representative_kind,
      searchText: `${(row.representative_title ?? '').toLowerCase()} ${row.search_text ?? ''}`.trim(),
    }));
  }

  private getRawTuiClusterSummary(repoId: number, clusterRunId: number, clusterId: number): TuiClusterSummary | null {
    const row = this.db
      .prepare(
        `select
            c.id as cluster_id,
            c.member_count,
            c.closed_at_local,
            c.close_reason_local,
            c.representative_thread_id,
            rt.number as representative_number,
            rt.kind as representative_kind,
            rt.title as representative_title,
            max(coalesce(t.updated_at_gh, t.updated_at)) as latest_updated_at,
            sum(case when t.kind = 'issue' then 1 else 0 end) as issue_count,
            sum(case when t.kind = 'pull_request' then 1 else 0 end) as pull_request_count,
            sum(case when t.state != 'open' or t.closed_at_local is not null then 1 else 0 end) as closed_member_count,
            group_concat(lower(coalesce(t.title, '')), ' ') as search_text
         from clusters c
         left join threads rt on rt.id = c.representative_thread_id
         join cluster_members cm on cm.cluster_id = c.id
         join threads t on t.id = cm.thread_id
         where c.repo_id = ? and c.cluster_run_id = ? and c.id = ?
         group by
           c.id,
           c.member_count,
           c.closed_at_local,
           c.close_reason_local,
           c.representative_thread_id,
           rt.number,
           rt.kind,
           rt.title`,
      )
      .get(repoId, clusterRunId, clusterId) as
      | {
          cluster_id: number;
          member_count: number;
          closed_at_local: string | null;
          close_reason_local: string | null;
          representative_thread_id: number | null;
          representative_number: number | null;
          representative_kind: 'issue' | 'pull_request' | null;
          representative_title: string | null;
          latest_updated_at: string | null;
          issue_count: number;
          pull_request_count: number;
          closed_member_count: number;
          search_text: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      clusterId: row.cluster_id,
      displayTitle: row.representative_title ?? `Cluster ${row.cluster_id}`,
      isClosed: row.close_reason_local !== null || row.closed_member_count >= row.member_count,
      closedAtLocal: row.closed_at_local,
      closeReasonLocal: row.close_reason_local,
      totalCount: row.member_count,
      issueCount: row.issue_count,
      pullRequestCount: row.pull_request_count,
      latestUpdatedAt: row.latest_updated_at,
      representativeThreadId: row.representative_thread_id,
      representativeNumber: row.representative_number,
      representativeKind: row.representative_kind,
      searchText: `${(row.representative_title ?? '').toLowerCase()} ${row.search_text ?? ''}`.trim(),
    };
  }

  private compareTuiClusterSummary(left: TuiClusterSummary, right: TuiClusterSummary, sort: TuiClusterSortMode): number {
    const leftTime = left.latestUpdatedAt ? Date.parse(left.latestUpdatedAt) : 0;
    const rightTime = right.latestUpdatedAt ? Date.parse(right.latestUpdatedAt) : 0;
    if (sort === 'size') {
      return right.totalCount - left.totalCount || rightTime - leftTime || left.clusterId - right.clusterId;
    }
    return rightTime - leftTime || right.totalCount - left.totalCount || left.clusterId - right.clusterId;
  }

  private async fetchThreadComments(
    owner: string,
    repo: string,
    number: number,
    isPr: boolean,
    reporter?: (message: string) => void,
  ): Promise<CommentSeed[]> {
    const github = this.requireGithub();
    const comments: CommentSeed[] = [];

    const issueComments = await github.listIssueComments(owner, repo, number, reporter);
    comments.push(
      ...issueComments.map((comment) => {
        const authorLogin = userLogin(comment);
        const authorType = userType(comment);
        return {
          githubId: String(comment.id),
          commentType: 'issue_comment',
          authorLogin,
          authorType,
          body: String(comment.body ?? ''),
          isBot: isBotLikeAuthor({ authorLogin, authorType }),
          rawJson: asJson(comment),
          createdAtGh: typeof comment.created_at === 'string' ? comment.created_at : null,
          updatedAtGh: typeof comment.updated_at === 'string' ? comment.updated_at : null,
        };
      }),
    );

    if (isPr) {
      const reviews = await github.listPullReviews(owner, repo, number, reporter);
      comments.push(
        ...reviews.map((review) => {
          const authorLogin = userLogin(review);
          const authorType = userType(review);
          return {
            githubId: String(review.id),
            commentType: 'review',
            authorLogin,
            authorType,
            body: String(review.body ?? review.state ?? ''),
            isBot: isBotLikeAuthor({ authorLogin, authorType }),
            rawJson: asJson(review),
            createdAtGh: typeof review.submitted_at === 'string' ? review.submitted_at : null,
            updatedAtGh: typeof review.submitted_at === 'string' ? review.submitted_at : null,
          };
        }),
      );

      const reviewComments = await github.listPullReviewComments(owner, repo, number, reporter);
      comments.push(
        ...reviewComments.map((comment) => {
          const authorLogin = userLogin(comment);
          const authorType = userType(comment);
          return {
            githubId: String(comment.id),
            commentType: 'review_comment',
            authorLogin,
            authorType,
            body: String(comment.body ?? ''),
            isBot: isBotLikeAuthor({ authorLogin, authorType }),
            rawJson: asJson(comment),
            createdAtGh: typeof comment.created_at === 'string' ? comment.created_at : null,
            updatedAtGh: typeof comment.updated_at === 'string' ? comment.updated_at : null,
          };
        }),
      );
    }

    return comments;
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

  private upsertRepository(owner: string, repo: string, payload: Record<string, unknown>): number {
    const fullName = `${owner}/${repo}`;
    this.db
      .prepare(
        `insert into repositories (owner, name, full_name, github_repo_id, raw_json, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(full_name) do update set
           github_repo_id = excluded.github_repo_id,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`,
      )
      .run(owner, repo, fullName, payload.id ? String(payload.id) : null, asJson(payload), nowIso());
    const row = this.db.prepare('select id from repositories where full_name = ?').get(fullName) as { id: number };
    return row.id;
  }

  private upsertThread(
    repoId: number,
    kind: 'issue' | 'pull_request',
    payload: Record<string, unknown>,
    pulledAt: string,
  ): number {
    const title = String(payload.title ?? `#${payload.number}`);
    const body = typeof payload.body === 'string' ? payload.body : null;
    const labels = parseLabels(payload);
    const assignees = parseAssignees(payload);
    const contentHash = stableContentHash(`${title}\n${body ?? ''}`);
    this.db
      .prepare(
        `insert into threads (
            repo_id, github_id, number, kind, state, title, body, author_login, author_type, html_url,
            labels_json, assignees_json, raw_json, content_hash, is_draft,
            created_at_gh, updated_at_gh, closed_at_gh, merged_at_gh, first_pulled_at, last_pulled_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(repo_id, kind, number) do update set
            github_id = excluded.github_id,
            state = excluded.state,
            title = excluded.title,
            body = excluded.body,
            author_login = excluded.author_login,
            author_type = excluded.author_type,
            html_url = excluded.html_url,
            labels_json = excluded.labels_json,
            assignees_json = excluded.assignees_json,
            raw_json = excluded.raw_json,
            content_hash = excluded.content_hash,
            is_draft = excluded.is_draft,
            created_at_gh = excluded.created_at_gh,
            updated_at_gh = excluded.updated_at_gh,
            closed_at_gh = excluded.closed_at_gh,
            merged_at_gh = excluded.merged_at_gh,
            last_pulled_at = excluded.last_pulled_at,
            updated_at = excluded.updated_at`,
      )
      .run(
        repoId,
        String(payload.id),
        Number(payload.number),
        kind,
        String(payload.state ?? 'open'),
        title,
        body,
        userLogin(payload),
        userType(payload),
        String(payload.html_url),
        asJson(labels),
        asJson(assignees),
        asJson(payload),
        contentHash,
        payload.draft ? 1 : 0,
        typeof payload.created_at === 'string' ? payload.created_at : null,
        typeof payload.updated_at === 'string' ? payload.updated_at : null,
        typeof payload.closed_at === 'string' ? payload.closed_at : null,
        typeof payload.merged_at === 'string' ? payload.merged_at : null,
        pulledAt,
        pulledAt,
        nowIso(),
      );
    const row = this.db
      .prepare('select id from threads where repo_id = ? and kind = ? and number = ?')
      .get(repoId, kind, Number(payload.number)) as { id: number };
    return row.id;
  }

  private persistThreadCodeSnapshot(threadId: number, threadPayload: Record<string, unknown>, files: Array<Record<string, unknown>>): void {
    const title = String(threadPayload.title ?? `#${threadPayload.number}`);
    const body = typeof threadPayload.body === 'string' ? threadPayload.body : null;
    const revisionId = upsertThreadRevision(this.db, {
      threadId,
      sourceUpdatedAt: typeof threadPayload.updated_at === 'string' ? threadPayload.updated_at : null,
      title,
      body,
      labels: parseLabels(threadPayload),
      rawJson: asJson(threadPayload),
    });
    const base = threadPayload.base as Record<string, unknown> | undefined;
    const head = threadPayload.head as Record<string, unknown> | undefined;
    upsertThreadCodeSnapshot(this.db, {
      threadRevisionId: revisionId,
      baseSha: typeof base?.sha === 'string' ? base.sha : null,
      headSha: typeof head?.sha === 'string' ? head.sha : null,
      signature: buildCodeSnapshotSignature(files),
      storeRoot: this.blobStoreRoot(),
    });
  }

  private blobStoreRoot(): string {
    return path.join(path.dirname(this.config.dbPath), '.ghcrawl-store');
  }

  private rawJsonStorage(rawJson: string, mediaType: string): { inlineJson: string; blobId: number | null } {
    if (Buffer.byteLength(rawJson, 'utf8') <= RAW_JSON_INLINE_THRESHOLD_BYTES) {
      return { inlineJson: rawJson, blobId: null };
    }
    const blob = storeTextBlob(this.db, this.blobStoreRoot(), rawJson, {
      mediaType,
      inlineThresholdBytes: RAW_JSON_INLINE_THRESHOLD_BYTES,
    });
    return { inlineJson: '{}', blobId: blob.id };
  }

  private async applyClosedOverlapSweep(params: {
    repoId: number;
    owner: string;
    repo: string;
    crawlStartedAt: string;
    closedSweepSince: string;
    reporter?: (message: string) => void;
    onProgress?: (message: string) => void;
  }): Promise<number> {
    const staleRows = this.db
      .prepare(
        `select id, number, kind
         from threads
         where repo_id = ?
           and state = 'open'
           and closed_at_local is null
           and (last_pulled_at is null or last_pulled_at < ?)
         order by number asc`,
      )
      .all(params.repoId, params.crawlStartedAt) as Array<{ id: number; number: number; kind: 'issue' | 'pull_request' }>;

    if (staleRows.length === 0) {
      return 0;
    }

    params.onProgress?.(
      `[sync] scanning ${staleRows.length} unseen previously-open thread(s) against recently-updated closed items since ${params.closedSweepSince}`,
    );

    const github = this.requireGithub();
    const staleByNumber = new Map<number, { id: number; number: number; kind: 'issue' | 'pull_request' }>(
      staleRows.map((row) => [row.number, row]),
    );
    const recentlyClosed = await github.listRepositoryIssues(
      params.owner,
      params.repo,
      params.closedSweepSince,
      STALE_CLOSED_SWEEP_LIMIT,
      params.reporter,
      'closed',
    );

    let threadsClosed = 0;
    for (const payload of recentlyClosed) {
      const number = Number(payload.number);
      const staleRow = staleByNumber.get(number);
      if (!staleRow) continue;
      const state = String(payload.state ?? 'closed');
      if (state === 'open') continue;
      const pulledAt = nowIso();
      this.db
        .prepare(
          `update threads
           set state = ?,
               raw_json = ?,
               updated_at_gh = ?,
               closed_at_gh = ?,
               merged_at_gh = ?,
               last_pulled_at = ?,
               updated_at = ?
           where id = ?`,
        )
        .run(
          state,
          asJson(payload),
          typeof payload.updated_at === 'string' ? payload.updated_at : null,
          typeof payload.closed_at === 'string' ? payload.closed_at : null,
          typeof payload.merged_at === 'string' ? payload.merged_at : null,
          pulledAt,
          pulledAt,
          staleRow.id,
        );
      staleByNumber.delete(number);
      threadsClosed += 1;
    }

    params.onProgress?.(
      `[sync] recent closed sweep matched ${threadsClosed} stale thread(s); ${staleByNumber.size} remain open locally`,
    );

    return threadsClosed;
  }

  private async reconcileMissingOpenThreads(params: {
    repoId: number;
    owner: string;
    repo: string;
    crawlStartedAt: string;
    reporter?: (message: string) => void;
    onProgress?: (message: string) => void;
  }): Promise<number> {
    const github = this.requireGithub();
    const staleRows = this.db
      .prepare(
        `select id, number, kind
         from threads
         where repo_id = ?
           and state = 'open'
           and closed_at_local is null
           and (last_pulled_at is null or last_pulled_at < ?)
         order by number asc`,
      )
      .all(params.repoId, params.crawlStartedAt) as Array<{ id: number; number: number; kind: 'issue' | 'pull_request' }>;

    if (staleRows.length === 0) {
      return 0;
    }

    params.onProgress?.(
      `[sync] full reconciliation requested; directly checking ${staleRows.length} previously-open thread(s) not seen in the open crawl`,
    );

    let threadsClosed = 0;
    for (const [index, row] of staleRows.entries()) {
      if (index > 0 && index % SYNC_BATCH_SIZE === 0) {
        params.onProgress?.(`[sync] stale reconciliation batch boundary reached at ${index} threads; sleeping 5s before continuing`);
        await new Promise((resolve) => setTimeout(resolve, SYNC_BATCH_DELAY_MS));
      }
      params.onProgress?.(`[sync] reconciling stale ${row.kind} #${row.number}`);
      const pulledAt = nowIso();
      let payload: Record<string, unknown> | null = null;
      let state = 'closed';

      try {
        payload =
          row.kind === 'pull_request'
            ? await github.getPull(params.owner, params.repo, row.number, params.reporter)
            : await github.getIssue(params.owner, params.repo, row.number, params.reporter);
        state = String(payload.state ?? 'open');
      } catch (error) {
        if (!isMissingGitHubResourceError(error)) {
          throw error;
        }
        params.onProgress?.(
          `[sync] stale ${row.kind} #${row.number} is missing on GitHub; marking it closed locally and continuing`,
        );
      }

      if (payload) {
        this.db
          .prepare(
            `update threads
             set state = ?,
                 raw_json = ?,
                 updated_at_gh = ?,
                 closed_at_gh = ?,
                 merged_at_gh = ?,
                 last_pulled_at = ?,
                 updated_at = ?
             where id = ?`,
          )
          .run(
            state,
            asJson(payload),
            typeof payload.updated_at === 'string' ? payload.updated_at : null,
            typeof payload.closed_at === 'string' ? payload.closed_at : null,
            typeof payload.merged_at === 'string' ? payload.merged_at : null,
            pulledAt,
            pulledAt,
            row.id,
          );
      } else {
        this.db
          .prepare(
            `update threads
             set state = 'closed',
                 closed_at_gh = coalesce(closed_at_gh, ?),
                 last_pulled_at = ?,
                 updated_at = ?
             where id = ?`,
          )
          .run(pulledAt, pulledAt, pulledAt, row.id);
      }

      if (state !== 'open') {
        threadsClosed += 1;
      }
    }

    if (threadsClosed > 0) {
      params.onProgress?.(`[sync] marked ${threadsClosed} stale thread(s) as closed after GitHub confirmation`);
    }

    return threadsClosed;
  }

  private replaceComments(threadId: number, comments: CommentSeed[]): void {
    const insert = this.db.prepare(
      `insert into comments (
        thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, raw_json_blob_id, created_at_gh, updated_at_gh
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((commentRows: CommentSeed[]) => {
      this.db.prepare('delete from comments where thread_id = ?').run(threadId);
      for (const comment of commentRows) {
        const raw = this.rawJsonStorage(comment.rawJson, `application/vnd.ghcrawl.${comment.commentType}.raw+json`);
        insert.run(
          threadId,
          comment.githubId,
          comment.commentType,
          comment.authorLogin,
          comment.authorType,
          comment.body,
          comment.isBot ? 1 : 0,
          raw.inlineJson,
          raw.blobId,
          comment.createdAtGh,
          comment.updatedAtGh,
        );
      }
    });
    tx(comments);
  }

  private refreshDocument(threadId: number): void {
    const thread = this.db.prepare('select * from threads where id = ?').get(threadId) as ThreadRow;
    const comments = this.db
      .prepare(
        'select body, author_login, author_type, is_bot from comments where thread_id = ? order by coalesce(created_at_gh, updated_at_gh) asc, id asc',
      )
      .all(threadId) as Array<{ body: string; author_login: string | null; author_type: string | null; is_bot: number }>;

    const canonical = buildCanonicalDocument({
      title: thread.title,
      body: thread.body,
      labels: parseArray(thread.labels_json),
      comments: comments.map((comment) => ({
        body: comment.body,
        authorLogin: comment.author_login,
        authorType: comment.author_type,
        isBot: comment.is_bot === 1,
      })),
    });

    this.db
      .prepare(
        `insert into documents (thread_id, title, body, raw_text, dedupe_text, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(thread_id) do update set
           title = excluded.title,
           body = excluded.body,
           raw_text = excluded.raw_text,
           dedupe_text = excluded.dedupe_text,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, thread.title, thread.body, canonical.rawText, canonical.dedupeText, nowIso());

    this.db.prepare('update threads set content_hash = ?, updated_at = ? where id = ?').run(canonical.contentHash, nowIso(), threadId);
  }

  private buildSummarySource(
    threadId: number,
    title: string,
    body: string | null,
    labels: string[],
    includeComments: boolean,
  ): { summaryInput: string; summaryContentHash: string } {
    const parts = [`title: ${normalizeSummaryText(title)}`];
    const normalizedBody = normalizeSummaryText(body ?? '');
    if (normalizedBody) {
      parts.push(`body: ${normalizedBody}`);
    }
    if (labels.length > 0) {
      parts.push(`labels: ${labels.join(', ')}`);
    }

    if (includeComments) {
      const comments = this.db
        .prepare(
          `select body, author_login, author_type, is_bot
           from comments
           where thread_id = ?
           order by coalesce(created_at_gh, updated_at_gh) asc, id asc`,
        )
        .all(threadId) as Array<{ body: string; author_login: string | null; author_type: string | null; is_bot: number }>;

      const humanComments = comments
        .filter((comment) =>
          !isBotLikeAuthor({
            authorLogin: comment.author_login,
            authorType: comment.author_type,
            isBot: comment.is_bot === 1,
          }),
        )
        .map((comment) => {
          const author = comment.author_login ? `@${comment.author_login}` : 'unknown';
          const normalized = normalizeSummaryText(comment.body);
          return normalized ? `${author}: ${normalized}` : '';
        })
        .filter(Boolean);

      if (humanComments.length > 0) {
        parts.push(`discussion:\n${humanComments.join('\n')}`);
      }
    }

    const summaryInput = parts.join('\n\n');
    const summaryContentHash = stableContentHash(
      `summary:${SUMMARY_PROMPT_VERSION}:${includeComments ? 'with-comments' : 'metadata-only'}\n${summaryInput}`,
    );
    return { summaryInput, summaryContentHash };
  }

  private buildEmbeddingTasks(params: {
    threadId: number;
    threadNumber: number;
    title: string;
    body: string | null;
    dedupeSummary: string | null;
  }): EmbeddingTask[] {
    const tasks: EmbeddingTask[] = [];
    const titleText = this.prepareEmbeddingText(normalizeSummaryText(params.title), EMBED_MAX_ITEM_TOKENS);
    if (titleText) {
      tasks.push({
        threadId: params.threadId,
        threadNumber: params.threadNumber,
        sourceKind: 'title',
        text: titleText.text,
        contentHash: stableContentHash(`embedding:title\n${titleText.text}`),
        estimatedTokens: titleText.estimatedTokens,
        wasTruncated: titleText.wasTruncated,
      });
    }

    const bodyText = this.prepareEmbeddingText(normalizeSummaryText(params.body ?? ''), EMBED_MAX_ITEM_TOKENS);
    if (bodyText) {
      tasks.push({
        threadId: params.threadId,
        threadNumber: params.threadNumber,
        sourceKind: 'body',
        text: bodyText.text,
        contentHash: stableContentHash(`embedding:body\n${bodyText.text}`),
        estimatedTokens: bodyText.estimatedTokens,
        wasTruncated: bodyText.wasTruncated,
      });
    }

    const summaryText = this.prepareEmbeddingText(normalizeSummaryText(params.dedupeSummary ?? ''), EMBED_MAX_ITEM_TOKENS);
    if (summaryText) {
      tasks.push({
        threadId: params.threadId,
        threadNumber: params.threadNumber,
        sourceKind: 'dedupe_summary',
        text: summaryText.text,
        contentHash: stableContentHash(`embedding:dedupe_summary\n${summaryText.text}`),
        estimatedTokens: summaryText.estimatedTokens,
        wasTruncated: summaryText.wasTruncated,
      });
    }

    return tasks;
  }

  private buildActiveVectorTask(params: {
    threadId: number;
    threadNumber: number;
    title: string;
    body: string | null;
    dedupeSummary: string | null;
    keySummary: string | null;
  }): ActiveVectorTask | null {
    const sections = [`title: ${normalizeSummaryText(params.title)}`];
    if (this.config.embeddingBasis === 'title_summary') {
      const summary = normalizeSummaryText(params.dedupeSummary ?? '');
      if (!summary) {
        return null;
      }
      sections.push(`summary: ${summary}`);
    } else if (this.config.embeddingBasis === 'llm_key_summary') {
      const keySummary = normalizeSummaryText(params.keySummary ?? '');
      if (!keySummary) {
        return null;
      }
      sections.push(`key_summary:\n${keySummary}`);
    } else {
      const body = normalizeSummaryText(params.body ?? '');
      if (body) {
        sections.push(`body: ${body}`);
      }
    }

    const prepared = this.prepareEmbeddingText(sections.join('\n\n'), EMBED_MAX_ITEM_TOKENS);
    if (!prepared) {
      return null;
    }

    return {
      threadId: params.threadId,
      threadNumber: params.threadNumber,
      basis: this.config.embeddingBasis,
      text: prepared.text,
      contentHash: stableContentHash(
        `embedding:${ACTIVE_EMBED_PIPELINE_VERSION}:${this.config.embeddingBasis}:${this.config.embedModel}:${ACTIVE_EMBED_DIMENSIONS}\n${prepared.text}`,
      ),
      estimatedTokens: prepared.estimatedTokens,
      wasTruncated: prepared.wasTruncated,
    };
  }

  private activeVectorSourceKind(): EmbeddingSourceKind {
    if (this.config.embeddingBasis === 'title_summary') {
      return 'dedupe_summary';
    }
    if (this.config.embeddingBasis === 'llm_key_summary') {
      return 'llm_key_summary';
    }
    return 'body';
  }

  private prepareEmbeddingText(
    text: string,
    maxEstimatedTokens: number,
  ): { text: string; estimatedTokens: number; wasTruncated: boolean } | null {
    if (!text) {
      return null;
    }

    const maxChars = maxEstimatedTokens * EMBED_ESTIMATED_CHARS_PER_TOKEN;
    const wasTruncated = text.length > maxChars;
    const prepared = wasTruncated
      ? `${text.slice(0, Math.max(0, maxChars - EMBED_TRUNCATION_MARKER.length)).trimEnd()}${EMBED_TRUNCATION_MARKER}`
      : text;
    return {
      text: prepared,
      estimatedTokens: this.estimateEmbeddingTokens(prepared),
      wasTruncated,
    };
  }

  private estimateEmbeddingTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / EMBED_ESTIMATED_CHARS_PER_TOKEN));
  }

  private parseEmbeddingContextError(error: unknown): { limitTokens: number | null; requestedTokens: number | null } | null {
    const message = error instanceof Error ? error.message : String(error);
    const requestedMatch = message.match(/requested\s+(\d+)\s+tokens/i);
    const contextLimitMatch = message.match(/maximum context length is\s+(\d+)\s+tokens/i);
    const inputLimitMatch = message.match(/maximum input length is\s+(\d+)\s+tokens/i);
    const limitTokens = Number(contextLimitMatch?.[1] ?? inputLimitMatch?.[1] ?? NaN);
    const requestedTokens = Number(requestedMatch?.[1] ?? NaN);

    if (!Number.isFinite(limitTokens) && !Number.isFinite(requestedTokens)) {
      return null;
    }

    return {
      limitTokens: Number.isFinite(limitTokens) ? limitTokens : null,
      requestedTokens: Number.isFinite(requestedTokens) ? requestedTokens : null,
    };
  }

  private isEmbeddingContextError(error: unknown): boolean {
    return this.parseEmbeddingContextError(error) !== null;
  }

  private async embedBatchWithRecovery(
    ai: AiProvider,
    batch: ActiveVectorTask[],
    onProgress?: (message: string) => void,
  ): Promise<Array<{ task: ActiveVectorTask; embedding: number[] }>> {
    try {
      const embeddings = await ai.embedTexts({
        model: this.config.embedModel,
        texts: batch.map((task) => task.text),
        dimensions: ACTIVE_EMBED_DIMENSIONS,
      });
      return batch.map((task, index) => ({ task, embedding: embeddings[index] }));
    } catch (error) {
      if (!this.isEmbeddingContextError(error) || batch.length === 1) {
        if (batch.length === 1 && this.isEmbeddingContextError(error)) {
          const recovered = await this.embedSingleTaskWithRecovery(ai, batch[0], onProgress);
          return [recovered];
        }
        throw error;
      }

      onProgress?.(
        `[embed] batch context error; isolating ${batch.length} item(s) to find oversized input(s)`,
      );

      const recovered: Array<{ task: ActiveVectorTask; embedding: number[] }> = [];
      for (const task of batch) {
        recovered.push(await this.embedSingleTaskWithRecovery(ai, task, onProgress));
      }
      return recovered;
    }
  }

  private async embedSingleTaskWithRecovery(
    ai: AiProvider,
    task: ActiveVectorTask,
    onProgress?: (message: string) => void,
  ): Promise<{ task: ActiveVectorTask; embedding: number[] }> {
    let current = task;

    for (let attempt = 0; attempt < EMBED_CONTEXT_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const [embedding] = await ai.embedTexts({
          model: this.config.embedModel,
          texts: [current.text],
          dimensions: ACTIVE_EMBED_DIMENSIONS,
        });
        return { task: current, embedding };
      } catch (error) {
        const context = this.parseEmbeddingContextError(error);
        if (!context) {
          throw error;
        }

        const next = this.shrinkEmbeddingTask(current, context);
        if (!next || next.text === current.text) {
          throw error;
        }
        onProgress?.(
          `[embed] shortened #${current.threadNumber}:${current.basis} after context error est_tokens=${current.estimatedTokens}->${next.estimatedTokens}`,
        );
        current = next;
      }
    }

    throw new Error(`Unable to shrink embedding input for #${task.threadNumber}:${task.basis} below model limits`);
  }

  private shrinkEmbeddingTask(
    task: ActiveVectorTask,
    context?: { limitTokens: number | null; requestedTokens: number | null },
  ): ActiveVectorTask | null {
    const withoutMarker = task.text.endsWith(EMBED_TRUNCATION_MARKER)
      ? task.text.slice(0, -EMBED_TRUNCATION_MARKER.length)
      : task.text;
    if (withoutMarker.length < 256) {
      return null;
    }

    const nextLength = Math.max(
      256,
      this.projectEmbeddingRetryLength(withoutMarker.length, task.estimatedTokens, context),
    );
    if (nextLength >= withoutMarker.length) {
      return null;
    }
    const nextText = `${withoutMarker.slice(0, Math.max(0, nextLength - EMBED_TRUNCATION_MARKER.length)).trimEnd()}${EMBED_TRUNCATION_MARKER}`;
    return {
      ...task,
      text: nextText,
      contentHash: stableContentHash(
        `embedding:${ACTIVE_EMBED_PIPELINE_VERSION}:${task.basis}:${this.config.embedModel}:${ACTIVE_EMBED_DIMENSIONS}\n${nextText}`,
      ),
      estimatedTokens: this.estimateEmbeddingTokens(nextText),
      wasTruncated: true,
    };
  }

  private projectEmbeddingRetryLength(
    textLength: number,
    estimatedTokens: number,
    context?: { limitTokens: number | null; requestedTokens: number | null },
  ): number {
    const limitTokens = context?.limitTokens ?? null;
    const requestedTokens = context?.requestedTokens ?? null;
    if (limitTokens && requestedTokens && requestedTokens > limitTokens) {
      const targetRatio = (limitTokens * EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO) / requestedTokens;
      return Math.floor(textLength * Math.max(0.1, Math.min(targetRatio, EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO)));
    }

    if (limitTokens && estimatedTokens > limitTokens) {
      const targetRatio = (limitTokens * EMBED_CONTEXT_RETRY_TARGET_BUFFER_RATIO) / estimatedTokens;
      return Math.floor(textLength * Math.max(0.1, Math.min(targetRatio, EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO)));
    }

    return Math.floor(textLength * EMBED_CONTEXT_RETRY_FALLBACK_SHRINK_RATIO);
  }

  private chunkEmbeddingTasks(items: ActiveVectorTask[], maxItems: number, maxEstimatedTokens: number): ActiveVectorTask[][] {
    const chunks: ActiveVectorTask[][] = [];
    let current: ActiveVectorTask[] = [];
    let currentEstimatedTokens = 0;

    for (const item of items) {
      const wouldExceedItemCount = current.length >= maxItems;
      const wouldExceedTokenBudget = current.length > 0 && currentEstimatedTokens + item.estimatedTokens > maxEstimatedTokens;
      if (wouldExceedItemCount || wouldExceedTokenBudget) {
        chunks.push(current);
        current = [];
        currentEstimatedTokens = 0;
      }

      current.push(item);
      currentEstimatedTokens += item.estimatedTokens;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  private loadStoredEmbeddings(repoId: number): StoredEmbeddingRow[] {
    return this.db
      .prepare(
        `select t.id, t.repo_id, t.number, t.kind, t.state, t.closed_at_gh, t.closed_at_local, t.close_reason_local,
                t.title, t.body, t.author_login, t.html_url, t.labels_json,
                t.updated_at_gh, t.first_pulled_at, t.last_pulled_at, e.source_kind, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ? and t.state = 'open' and t.closed_at_local is null and e.model = ?
         order by t.number asc, e.source_kind asc`,
      )
      .all(repoId, this.config.embedModel) as StoredEmbeddingRow[];
  }

  private loadStoredEmbeddingsForThreadNumber(repoId: number, threadNumber: number): StoredEmbeddingRow[] {
    return this.db
      .prepare(
        `select t.id, t.repo_id, t.number, t.kind, t.state, t.closed_at_gh, t.closed_at_local, t.close_reason_local,
                t.title, t.body, t.author_login, t.html_url, t.labels_json,
                t.updated_at_gh, t.first_pulled_at, t.last_pulled_at, e.source_kind, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ?
           and t.number = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and e.model = ?
         order by e.source_kind asc`,
      )
      .all(repoId, threadNumber, this.config.embedModel) as StoredEmbeddingRow[];
  }

  private iterateStoredEmbeddings(repoId: number): IterableIterator<StoredEmbeddingRow> {
    return this.db
      .prepare(
        `select t.id, t.repo_id, t.number, t.kind, t.state, t.closed_at_gh, t.closed_at_local, t.close_reason_local,
                t.title, t.body, t.author_login, t.html_url, t.labels_json,
                t.updated_at_gh, t.first_pulled_at, t.last_pulled_at, e.source_kind, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ? and t.state = 'open' and t.closed_at_local is null and e.model = ?
         order by t.number asc, e.source_kind asc`,
      )
      .iterate(repoId, this.config.embedModel) as IterableIterator<StoredEmbeddingRow>;
  }

  private loadNormalizedEmbeddingForSourceKindHead(
    repoId: number,
    sourceKind: EmbeddingSourceKind,
  ): { id: number; normalizedEmbedding: number[] } | null {
    const row = this.db
      .prepare(
        `select t.id, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and e.model = ?
           and e.source_kind = ?
         order by t.number asc
         limit 1`,
      )
      .get(repoId, this.config.embedModel, sourceKind) as { id: number; embedding_json: string } | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      normalizedEmbedding: normalizeEmbedding(JSON.parse(row.embedding_json) as number[]).normalized,
    };
  }

  private *iterateNormalizedEmbeddingsForSourceKind(
    repoId: number,
    sourceKind: EmbeddingSourceKind,
  ): IterableIterator<{ id: number; normalizedEmbedding: number[] }> {
    const rows = this.db
      .prepare(
        `select t.id, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and e.model = ?
           and e.source_kind = ?
         order by t.number asc`,
      )
      .iterate(repoId, this.config.embedModel, sourceKind) as IterableIterator<{ id: number; embedding_json: string }>;

    for (const row of rows) {
      yield {
        id: row.id,
        normalizedEmbedding: normalizeEmbedding(JSON.parse(row.embedding_json) as number[]).normalized,
      };
    }
  }

  private loadNormalizedEmbeddingsForSourceKind(
    repoId: number,
    sourceKind: EmbeddingSourceKind,
  ): Array<{ id: number; normalizedEmbedding: number[] }> {
    const rows = this.db
      .prepare(
        `select t.id, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and e.model = ?
           and e.source_kind = ?
         order by t.number asc`,
      )
      .all(repoId, this.config.embedModel, sourceKind) as Array<{ id: number; embedding_json: string }>;

    return rows.map((row) => ({
      id: row.id,
      normalizedEmbedding: normalizeEmbedding(JSON.parse(row.embedding_json) as number[]).normalized,
    }));
  }

  private normalizedEmbeddingBuffer(values: number[]): Buffer {
    return Buffer.from(Float32Array.from(values).buffer);
  }

  private normalizedDistanceToScore(distance: number): number {
    return 1 - distance / 2;
  }

  private loadClusterableThreadMeta(repoId: number): {
    items: Array<{ id: number; number: number; title: string }>;
    sourceKinds: EmbeddingSourceKind[];
  } {
    const rows = this.db
      .prepare(
        `select t.id, t.number, t.title, e.source_kind
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null`,
      )
      .all(repoId) as Array<{ id: number; number: number; title: string; source_kind: EmbeddingSourceKind }>;

    const itemsById = new Map<number, { id: number; number: number; title: string }>();
    const sourceKinds = new Set<EmbeddingSourceKind>();
    for (const row of rows) {
      itemsById.set(row.id, { id: row.id, number: row.number, title: row.title });
      sourceKinds.add(row.source_kind);
    }

    return {
      items: Array.from(itemsById.values()),
      sourceKinds: Array.from(sourceKinds.values()),
    };
  }

  private loadClusterableActiveVectorMeta(repoId: number, _repoFullName: string): Array<{ id: number; number: number; title: string; embedding: number[] }> {
    const rows = this.db
      .prepare(
        `select t.id, t.number, t.title, tv.vector_json
         from threads t
         join thread_vectors tv on tv.thread_id = t.id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and tv.model = ?
           and tv.basis = ?
           and tv.dimensions = ?
         order by t.number asc`,
      )
      .all(repoId, this.config.embedModel, this.config.embeddingBasis, ACTIVE_EMBED_DIMENSIONS) as Array<{
      id: number;
      number: number;
      title: string;
      vector_json: Buffer | string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      embedding: this.parseStoredVector(row.vector_json),
    }));
  }

  private loadDeterministicClusterableThreadMeta(repoId: number, threadIds?: number[]): Array<{
    id: number;
    number: number;
    kind: 'issue' | 'pull_request';
    title: string;
    body: string | null;
    labels: string[];
    rawJson: string;
    updatedAtGh: string | null;
    changedFiles: string[];
    hunkSignatures: string[];
    patchIds: string[];
  }> {
    let sql =
      `select id, number, kind, title, body, labels_json, raw_json, updated_at_gh
       from threads
       where repo_id = ?
         and state = 'open'
         and closed_at_local is null`;
    const args: Array<number> = [repoId];
    if (threadIds && threadIds.length > 0) {
      sql += ` and id in (${threadIds.map(() => '?').join(',')})`;
      args.push(...threadIds);
    }
    sql += ' order by number asc';

    const rows = this.db
      .prepare(
        sql,
      )
      .all(...args) as Array<{
      id: number;
      number: number;
      kind: 'issue' | 'pull_request';
      title: string;
      body: string | null;
      labels_json: string;
      raw_json: string;
      updated_at_gh: string | null;
    }>;
    const codeFeaturesByThread = this.loadLatestCodeFeatures(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      kind: row.kind,
      title: row.title,
      body: row.body,
      labels: parseArray(row.labels_json),
      rawJson: row.raw_json,
      updatedAtGh: row.updated_at_gh,
      changedFiles: codeFeaturesByThread.get(row.id)?.changedFiles ?? [],
      hunkSignatures: codeFeaturesByThread.get(row.id)?.hunkSignatures ?? [],
      patchIds: codeFeaturesByThread.get(row.id)?.patchIds ?? [],
    }));
  }

  private loadLatestCodeFeatures(threadIds: number[]): Map<number, { changedFiles: string[]; hunkSignatures: string[]; patchIds: string[] }> {
    if (threadIds.length === 0) return new Map();
    const placeholders = threadIds.map(() => '?').join(',');
    const latestRevisions = this.db
      .prepare(
        `select thread_id, max(id) as revision_id
         from thread_revisions
         where thread_id in (${placeholders})
         group by thread_id`,
      )
      .all(...threadIds) as Array<{ thread_id: number; revision_id: number }>;
    if (latestRevisions.length === 0) return new Map();

    const revisionToThread = new Map(latestRevisions.map((row) => [row.revision_id, row.thread_id]));
    const revisionPlaceholders = latestRevisions.map(() => '?').join(',');
    const fileRows = this.db
      .prepare(
        `select cs.thread_revision_id, cf.path, cf.patch_hash
         from thread_code_snapshots cs
         join thread_changed_files cf on cf.snapshot_id = cs.id
         where cs.thread_revision_id in (${revisionPlaceholders})
         order by cf.path asc`,
      )
      .all(...latestRevisions.map((row) => row.revision_id)) as Array<{ thread_revision_id: number; path: string; patch_hash: string | null }>;
    const hunkRows = this.db
      .prepare(
        `select cs.thread_revision_id, hs.hunk_hash
         from thread_code_snapshots cs
         join thread_hunk_signatures hs on hs.snapshot_id = cs.id
         where cs.thread_revision_id in (${revisionPlaceholders})
         order by hs.hunk_hash asc`,
      )
      .all(...latestRevisions.map((row) => row.revision_id)) as Array<{ thread_revision_id: number; hunk_hash: string }>;

    const out = new Map<number, { changedFiles: string[]; hunkSignatures: string[]; patchIds: string[] }>();
    function entry(threadId: number): { changedFiles: string[]; hunkSignatures: string[]; patchIds: string[] } {
      const existing = out.get(threadId) ?? { changedFiles: [], hunkSignatures: [], patchIds: [] };
      out.set(threadId, existing);
      return existing;
    }
    for (const row of fileRows) {
      const threadId = revisionToThread.get(row.thread_revision_id);
      if (threadId === undefined) continue;
      const target = entry(threadId);
      target.changedFiles.push(row.path);
      if (row.patch_hash) target.patchIds.push(row.patch_hash);
    }
    for (const row of hunkRows) {
      const threadId = revisionToThread.get(row.thread_revision_id);
      if (threadId === undefined) continue;
      entry(threadId).hunkSignatures.push(row.hunk_hash);
    }

    for (const target of out.values()) {
      target.changedFiles = Array.from(new Set(target.changedFiles)).sort();
      target.hunkSignatures = Array.from(new Set(target.hunkSignatures)).sort();
      target.patchIds = Array.from(new Set(target.patchIds)).sort();
    }
    return out;
  }

  private materializeLatestDeterministicFingerprints(
    items: Array<{
      id: number;
      number: number;
      kind: 'issue' | 'pull_request';
      title: string;
      body: string | null;
      labels: string[];
      rawJson: string;
      updatedAtGh: string | null;
      changedFiles: string[];
      hunkSignatures: string[];
      patchIds: string[];
    }>,
    onProgress?: (message: string) => void,
  ): { computed: number; skipped: number } {
    let computed = 0;
    let skipped = 0;
    for (const item of items) {
      const revisionId = upsertThreadRevision(this.db, {
        threadId: item.id,
        sourceUpdatedAt: item.updatedAtGh,
        title: item.title,
        body: item.body,
        labels: item.labels,
        rawJson: item.rawJson,
      });
      const existing = this.db
        .prepare(
          `select id
           from thread_fingerprints
           where thread_revision_id = ?
             and algorithm_version = ?
           limit 1`,
        )
        .get(revisionId, THREAD_FINGERPRINT_ALGORITHM_VERSION) as { id: number } | undefined;
      if (existing) {
        skipped += 1;
        continue;
      }

      const inferredRefs = extractDeterministicRefs(`${item.title}\n${item.body ?? ''}`);
      const fingerprint = buildDeterministicThreadFingerprint({
        threadId: item.id,
        number: item.number,
        kind: item.kind,
        title: item.title,
        body: item.body,
        labels: item.labels,
        linkedRefs: inferredRefs,
        changedFiles: item.changedFiles,
        hunkSignatures: item.hunkSignatures,
        patchIds: item.patchIds,
      });
      upsertThreadFingerprint(this.db, { threadRevisionId: revisionId, fingerprint });
      computed += 1;
    }
    onProgress?.(`[fingerprint] latest revisions computed=${computed} skipped=${skipped}`);
    return { computed, skipped };
  }

  private loadLatestDeterministicFingerprints(threadIds: number[]): Map<number, DeterministicThreadFingerprint> {
    if (threadIds.length === 0) return new Map();
    const placeholders = threadIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `select
           tr.thread_id,
           tf.fingerprint_hash,
           tf.fingerprint_slug,
           tf.title_tokens_json,
           tf.linked_refs_json,
           tf.module_buckets_json,
           tf.minhash_signature_blob_id,
           tf.simhash64,
           tf.winnow_hashes_blob_id,
           tf.feature_json
         from thread_revisions tr
         join (
           select thread_id, max(id) as revision_id
           from thread_revisions
           where thread_id in (${placeholders})
           group by thread_id
         ) latest on latest.revision_id = tr.id
         join thread_fingerprints tf on tf.thread_revision_id = tr.id
         where tf.algorithm_version = ?`,
      )
      .all(...threadIds, THREAD_FINGERPRINT_ALGORITHM_VERSION) as Array<{
      thread_id: number;
      fingerprint_hash: string;
      fingerprint_slug: string;
      title_tokens_json: string;
      linked_refs_json: string;
      module_buckets_json: string;
      minhash_signature_blob_id: number | null;
      simhash64: string;
      winnow_hashes_blob_id: number | null;
      feature_json: string;
    }>;

    const fingerprints = new Map<number, DeterministicThreadFingerprint>();
    for (const row of rows) {
      const feature = (() => {
        try {
          return JSON.parse(row.feature_json) as Record<string, unknown>;
        } catch {
          return {};
        }
      })();
      const stringFeature = (key: string): string[] => {
        const value = feature[key];
        return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
      };
      fingerprints.set(row.thread_id, {
        algorithmVersion: THREAD_FINGERPRINT_ALGORITHM_VERSION,
        fingerprintHash: row.fingerprint_hash,
        fingerprintSlug: row.fingerprint_slug,
        titleTokens: parseStringArrayJson(row.title_tokens_json),
        salientTitleTokens: stringFeature('salientTitleTokens'),
        bodyTokens: [],
        linkedRefs: parseStringArrayJson(row.linked_refs_json),
        moduleBuckets: parseStringArrayJson(row.module_buckets_json),
        changedFiles: stringFeature('changedFiles'),
        hunkSignatures: stringFeature('hunkSignatures'),
        patchIds: stringFeature('patchIds'),
        minhashSignature: row.minhash_signature_blob_id
          ? parseStringArrayJson(readTextBlob(this.db, this.blobStoreRoot(), row.minhash_signature_blob_id))
          : [],
        simhash64: row.simhash64,
        winnowHashes: row.winnow_hashes_blob_id
          ? parseStringArrayJson(readTextBlob(this.db, this.blobStoreRoot(), row.winnow_hashes_blob_id))
          : [],
      });
    }
    return fingerprints;
  }

  private loadNormalizedActiveVectors(repoId: number): Array<{ id: number; number: number; title: string; embedding: number[] }> {
    return this.loadClusterableActiveVectorMeta(repoId, '').map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      embedding: normalizeEmbedding(row.embedding).normalized,
    }));
  }

  private listStoredClusterNeighbors(repoId: number, threadId: number, limit: number): SearchHitDto['neighbors'] {
    const latestRun = this.getLatestClusterRun(repoId);
    if (!latestRun) {
      return [];
    }

    const rows = this.db
      .prepare(
        `select
            case
              when se.left_thread_id = ? then se.right_thread_id
              else se.left_thread_id
            end as neighbor_thread_id,
            case
              when se.left_thread_id = ? then t2.number
              else t1.number
            end as neighbor_number,
            case
              when se.left_thread_id = ? then t2.kind
              else t1.kind
            end as neighbor_kind,
            case
              when se.left_thread_id = ? then t2.title
              else t1.title
            end as neighbor_title,
            se.score
         from similarity_edges se
         join threads t1 on t1.id = se.left_thread_id
         join threads t2 on t2.id = se.right_thread_id
         where se.repo_id = ?
           and se.cluster_run_id = ?
           and (se.left_thread_id = ? or se.right_thread_id = ?)
           and t1.state = 'open'
           and t1.closed_at_local is null
           and t2.state = 'open'
           and t2.closed_at_local is null
         order by se.score desc
         limit ?`,
      )
      .all(threadId, threadId, threadId, threadId, repoId, latestRun.id, threadId, threadId, limit) as Array<{
      neighbor_thread_id: number;
      neighbor_number: number;
      neighbor_kind: 'issue' | 'pull_request';
      neighbor_title: string;
      score: number;
    }>;

    return rows.map((row) => ({
      threadId: row.neighbor_thread_id,
      number: row.neighbor_number,
      kind: row.neighbor_kind,
      title: row.neighbor_title,
      score: row.score,
    }));
  }

  private getEmbeddingWorkset(repoId: number, threadNumber?: number): EmbeddingWorkset {
    let sql =
      `select t.id, t.number, t.title, t.body
       from threads t
       where t.repo_id = ? and t.state = 'open' and t.closed_at_local is null`;
    const args: Array<string | number> = [repoId];
    if (threadNumber) {
      sql += ' and t.number = ?';
      args.push(threadNumber);
    }
    sql += ' order by t.number asc';
    const rows = this.db.prepare(sql).all(...args) as Array<{
      id: number;
      number: number;
      title: string;
      body: string | null;
    }>;
    const summaryTexts = this.loadDedupeSummaryTextMap(repoId, threadNumber);
    const keySummaryTexts = this.loadKeySummaryTextMap(repoId, threadNumber);
    const missingSummaryThreadNumbers: number[] = [];
    const tasks = rows.flatMap((row) => {
      const task = this.buildActiveVectorTask({
        threadId: row.id,
        threadNumber: row.number,
        title: row.title,
        body: row.body,
        dedupeSummary: summaryTexts.get(row.id) ?? null,
        keySummary: keySummaryTexts.get(row.id) ?? null,
      });
      if (task) {
        return [task];
      }
      if (this.config.embeddingBasis === 'title_summary' || this.config.embeddingBasis === 'llm_key_summary') {
        missingSummaryThreadNumbers.push(row.number);
      }
      return [];
    });
    const pipelineCurrent = this.isRepoVectorStateCurrent(repoId);
    const existingRows = this.db
      .prepare(
        `select tv.thread_id, tv.content_hash
         from thread_vectors tv
         join threads t on t.id = tv.thread_id
         where t.repo_id = ?
           and tv.model = ?
           and tv.basis = ?
           and tv.dimensions = ?`,
      )
      .all(repoId, this.config.embedModel, this.config.embeddingBasis, ACTIVE_EMBED_DIMENSIONS) as Array<{
        thread_id: number;
        content_hash: string;
      }>;
    const existing = new Map<string, string>();
    for (const row of existingRows) {
      existing.set(String(row.thread_id), row.content_hash);
    }
    const pending = pipelineCurrent
      ? tasks.filter((task) => existing.get(String(task.threadId)) !== task.contentHash)
      : tasks;
    return { rows, tasks, existing, pending, missingSummaryThreadNumbers };
  }

  private loadDedupeSummaryTextMap(repoId: number, threadNumber?: number): Map<number, string> {
    let sql =
      `select s.thread_id, s.summary_text
       from document_summaries s
       join threads t on t.id = s.thread_id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and s.model = ?
         and s.summary_kind = 'dedupe_summary'
         and s.prompt_version = ?`;
    const args: Array<number | string> = [repoId, this.config.summaryModel, SUMMARY_PROMPT_VERSION];
    if (threadNumber) {
      sql += ' and t.number = ?';
      args.push(threadNumber);
    }
    sql += ' order by t.number asc';

    const rows = this.db.prepare(sql).all(...args) as Array<{
      thread_id: number;
      summary_text: string;
    }>;
    const combined = new Map<number, string>();
    for (const row of rows) {
      const text = normalizeSummaryText(row.summary_text);
      if (text) {
        combined.set(row.thread_id, text);
      }
    }
    return combined;
  }

  private loadKeySummaryTextMap(repoId: number, threadNumber?: number): Map<number, string> {
    let sql =
      `select tr.thread_id, ks.key_text
       from thread_key_summaries ks
       join thread_revisions tr on tr.id = ks.thread_revision_id
       join threads t on t.id = tr.thread_id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and ks.summary_kind = 'llm_key_3line'
         and ks.prompt_version = ?
         and ks.model = ?`;
    const args: Array<number | string> = [repoId, LLM_KEY_SUMMARY_PROMPT_VERSION, this.config.summaryModel];
    if (threadNumber) {
      sql += ' and t.number = ?';
      args.push(threadNumber);
    }
    sql += ' order by tr.id asc';

    const rows = this.db.prepare(sql).all(...args) as Array<{
      thread_id: number;
      key_text: string;
    }>;
    const combined = new Map<number, string>();
    for (const row of rows) {
      const text = normalizeSummaryText(row.key_text);
      if (text) {
        combined.set(row.thread_id, text);
      }
    }
    return combined;
  }

  private edgeKey(leftThreadId: number, rightThreadId: number): string {
    const left = Math.min(leftThreadId, rightThreadId);
    const right = Math.max(leftThreadId, rightThreadId);
    return `${left}:${right}`;
  }

  private async aggregateRepositoryEdges(
    repoId: number,
    sourceKinds: EmbeddingSourceKind[],
    params: { limit: number; minScore: number; onProgress?: (message: string) => void },
  ): Promise<Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<SimilaritySourceKind> }>> {
    const aggregated = new Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<SimilaritySourceKind> }>();
    const totalItems = sourceKinds.reduce((sum, sourceKind) => sum + this.countEmbeddingsForSourceKind(repoId, sourceKind), 0);

    if (sourceKinds.length === 0 || totalItems === 0) {
      return aggregated;
    }

    const workerRuntime = this.resolveEdgeWorkerRuntime();
    const shouldParallelize = workerRuntime !== null && sourceKinds.length > 1 && totalItems >= CLUSTER_PARALLEL_MIN_EMBEDDINGS && os.availableParallelism() > 1;
    if (!shouldParallelize) {
      let processedItems = 0;
      for (const sourceKind of sourceKinds) {
        const items = this.loadNormalizedEmbeddingsForSourceKind(repoId, sourceKind);
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
        this.mergeSourceKindEdges(aggregated, edges, sourceKind);
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
      this.mergeSourceKindEdges(aggregated, edges, sourceKinds[index] as EmbeddingSourceKind);
    }

    return aggregated;
  }

  private mergeSourceKindEdges(
    aggregated: Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<SimilaritySourceKind> }>,
    edges: Array<{ leftThreadId: number; rightThreadId: number; score: number }>,
    sourceKind: SimilaritySourceKind,
  ): void {
    for (const edge of edges) {
      const key = this.edgeKey(edge.leftThreadId, edge.rightThreadId);
      const existing = aggregated.get(key);
      if (existing) {
        existing.score = Math.max(existing.score, edge.score);
        existing.sourceKinds.add(sourceKind);
        continue;
      }
      aggregated.set(key, {
        leftThreadId: edge.leftThreadId,
        rightThreadId: edge.rightThreadId,
        score: edge.score,
        sourceKinds: new Set([sourceKind]),
      });
    }
  }

  private collectSourceKindScores(
    perSourceScores: Map<string, { leftThreadId: number; rightThreadId: number; scores: Map<EmbeddingSourceKind, number> }>,
    edges: Array<{ leftThreadId: number; rightThreadId: number; score: number }>,
    sourceKind: EmbeddingSourceKind,
  ): void {
    for (const edge of edges) {
      const key = this.edgeKey(edge.leftThreadId, edge.rightThreadId);
      const existing = perSourceScores.get(key);
      if (existing) {
        existing.scores.set(sourceKind, Math.max(existing.scores.get(sourceKind) ?? -1, edge.score));
        continue;
      }
      const scores = new Map<EmbeddingSourceKind, number>();
      scores.set(sourceKind, edge.score);
      perSourceScores.set(key, {
        leftThreadId: edge.leftThreadId,
        rightThreadId: edge.rightThreadId,
        scores,
      });
    }
  }

  private finalizeEdgeScores(
    perSourceScores: Map<string, { leftThreadId: number; rightThreadId: number; scores: Map<EmbeddingSourceKind, number> }>,
    aggregation: 'max' | 'mean' | 'weighted' | 'min-of-2' | 'boost',
    weights: Record<EmbeddingSourceKind, number>,
    minScore: number,
  ): Array<{ leftThreadId: number; rightThreadId: number; score: number }> {
    const result: Array<{ leftThreadId: number; rightThreadId: number; score: number }> = [];

    for (const entry of perSourceScores.values()) {
      const scoreValues = Array.from(entry.scores.values());
      let finalScore: number;

      switch (aggregation) {
        case 'max':
          finalScore = Math.max(...scoreValues);
          break;

        case 'mean':
          finalScore = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
          break;

        case 'weighted': {
          let weightedSum = 0;
          let weightSum = 0;
          for (const [kind, score] of entry.scores) {
            const w = weights[kind] ?? 0.1;
            weightedSum += score * w;
            weightSum += w;
          }
          finalScore = weightSum > 0 ? weightedSum / weightSum : 0;
          break;
        }

        case 'min-of-2':
          // Require at least 2 source kinds to agree (both above minScore)
          if (scoreValues.length < 2) {
            continue; // Skip edges with only 1 source kind
          }
          finalScore = Math.max(...scoreValues);
          break;

        case 'boost': {
          // Best score + bonus per additional agreeing source
          const best = Math.max(...scoreValues);
          const bonusSources = scoreValues.length - 1;
          finalScore = Math.min(1.0, best + bonusSources * 0.05);
          break;
        }
      }

      if (finalScore >= minScore) {
        result.push({
          leftThreadId: entry.leftThreadId,
          rightThreadId: entry.rightThreadId,
          score: finalScore,
        });
      }
    }

    return result;
  }

  private countEmbeddingsForSourceKind(repoId: number, sourceKind: EmbeddingSourceKind): number {
    const row = this.db
      .prepare(
        `select count(*) as count
         from document_embeddings e
         join threads t on t.id = e.thread_id
         where t.repo_id = ?
           and t.state = 'open'
           and t.closed_at_local is null
           and e.source_kind = ?`,
      )
      .get(repoId, sourceKind) as { count: number };
    return row.count;
  }

  private resolveEdgeWorkerRuntime(): { url: URL } | null {
    const jsUrl = new URL('./cluster/edge-worker.js', import.meta.url);
    if (existsSync(fileURLToPath(jsUrl))) {
      return { url: jsUrl };
    }
    // Source-mode runs do not have a compiled worker entrypoint, so keep clustering in-process.
    return null;
  }

  private persistClusterRun(
    repoId: number,
    runId: number,
    aggregatedEdges: Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<SimilaritySourceKind> }>,
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
          const key = this.edgeKey(cluster.representativeThreadId, memberId);
          const score = memberId === cluster.representativeThreadId ? null : (aggregatedEdges.get(key)?.score ?? null);
          insertMember.run(clusterId, memberId, score, createdAt);
        }
      }
    })();
  }

  private persistDurableClusterState(
    repoId: number,
    pipelineRunId: number,
    aggregatedEdges: Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<SimilaritySourceKind> }>,
    clusters: Array<{ representativeThreadId: number; members: number[] }>,
  ): void {
    this.db.transaction(() => {
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
        const clusterId = upsertClusterGroup(this.db, {
          repoId,
          stableKey: identity.hash,
          stableSlug: identity.slug,
          status: 'active',
          clusterType: cluster.members.length > 1 ? 'duplicate_candidate' : 'singleton_orphan',
          representativeThreadId: cluster.representativeThreadId,
          title: `Cluster ${identity.slug}`,
        });
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
          const scoreKey = this.edgeKey(representativeThreadId, memberId);
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
          const scoreKey = this.edgeKey(representativeThreadId, forced.thread_id);
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

  private pruneOldClusterRuns(repoId: number, keepRunId: number): void {
    this.db.prepare('delete from cluster_runs where repo_id = ? and id <> ?').run(repoId, keepRunId);
  }

  private summarizeClusterSizes(
    clusters: Array<{ representativeThreadId: number; members: number[] }>,
  ): ClusterExperimentClusterSizeStats {
    const histogramCounts = new Map<number, number>();
    const topClusterSizes = clusters.map((cluster) => cluster.members.length).sort((left, right) => right - left);
    let soloClusters = 0;

    for (const cluster of clusters) {
      const size = cluster.members.length;
      histogramCounts.set(size, (histogramCounts.get(size) ?? 0) + 1);
      if (size === 1) {
        soloClusters += 1;
      }
    }

    return {
      soloClusters,
      maxClusterSize: topClusterSizes[0] ?? 0,
      topClusterSizes: topClusterSizes.slice(0, 50),
      histogram: Array.from(histogramCounts.entries())
        .map(([size, count]) => ({ size, count }))
        .sort((left, right) => left.size - right.size),
    };
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
        this.vectorBlob(embedding),
        this.config.vectorBackend,
        nowIso(),
        nowIso(),
      );
    try {
      this.vectorStore.upsertVector({
        storePath: this.repoVectorStorePath(repoFullName),
        dimensions: ACTIVE_EMBED_DIMENSIONS,
        threadId,
        vector: embedding,
      });
    } catch (error) {
      if (!this.isCorruptedVectorIndexError(error)) {
        throw error;
      }
      this.rebuildRepositoryVectorStore(repoId, repoFullName);
    }
  }

  private countLegacyEmbeddings(repoId: number): number {
    const row = this.db
      .prepare(
        `select count(*) as count
         from document_embeddings
         where thread_id in (select id from threads where repo_id = ?)`,
      )
      .get(repoId) as { count: number };
    return row.count;
  }

  private countInlineJsonThreadVectors(repoId: number): number {
    const row = this.db
      .prepare(
        `select count(*) as count
         from thread_vectors
         where thread_id in (select id from threads where repo_id = ?)
           and typeof(vector_json) = 'text'
           and vector_json != ''`,
      )
      .get(repoId) as { count: number };
    return row.count;
  }

  private getVectorliteClusterQuery(totalItems: number, requestedK: number): {
    limit: number;
    candidateK: number;
    efSearch?: number;
  } {
    if (totalItems < CLUSTER_PARALLEL_MIN_EMBEDDINGS) {
      return {
        limit: requestedK,
        candidateK: Math.max(requestedK * 16, 64),
      };
    }

    const limit = Math.min(
      Math.max(requestedK * VECTORLITE_CLUSTER_EXPANDED_MULTIPLIER, VECTORLITE_CLUSTER_EXPANDED_K),
      Math.max(1, totalItems - 1),
    );
    const candidateK = Math.min(
      Math.max(limit * 16, VECTORLITE_CLUSTER_EXPANDED_CANDIDATE_K),
      Math.max(limit, totalItems - 1),
    );
    return {
      limit,
      candidateK,
      efSearch: Math.max(candidateK * 2, VECTORLITE_CLUSTER_EXPANDED_EF_SEARCH),
    };
  }

  private vectorBlob(values: number[]): Buffer {
    return Buffer.from(Float32Array.from(values).buffer);
  }

  private parseStoredVector(value: Buffer | string): number[] {
    if (typeof value === 'string') {
      if (!value) {
        throw new Error('Stored vector payload is empty. Run refresh or embed first.');
      }
      return JSON.parse(value) as number[];
    }
    const floats = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / Float32Array.BYTES_PER_ELEMENT));
    return Array.from(floats);
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

  private startRun(table: RunTable, repoId: number, scope: string): number {
    const result = this.db
      .prepare(`insert into ${table} (repo_id, scope, status, started_at) values (?, ?, 'running', ?)`)
      .run(repoId, scope, nowIso());
    return Number(result.lastInsertRowid);
  }

  private finishRun(
    table: RunTable,
    runId: number,
    status: 'completed' | 'failed',
    stats?: unknown,
    error?: unknown,
    finishedAt = nowIso(),
  ): void {
    this.db
      .prepare(`update ${table} set status = ?, finished_at = ?, stats_json = ?, error_text = ? where id = ?`)
      .run(
        status,
        finishedAt,
        stats === undefined ? null : asJson(stats),
        error instanceof Error ? error.message : error ? String(error) : null,
        runId,
      );
  }
}

export function parseRepoParams(url: URL): { owner: string; repo: string } {
  const owner = url.searchParams.get('owner');
  const repo = url.searchParams.get('repo');
  if (!owner || !repo) {
    throw new Error('Missing owner or repo query parameter');
  }
  return { owner, repo };
}
