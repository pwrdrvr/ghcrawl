import type {
  HealthResponse,
  NeighborsResponse,
  RepositoryDto,
  SearchHitDto,
  SearchResponse,
  ThreadDto,
} from '@ghcrawl/api-contract';

import type { ConfigValueSource, EmbeddingBasis } from './config.js';
import type { PortableSyncProfile } from './portable/sync-store.js';

export type RunTable = 'sync_runs' | 'summary_runs' | 'embedding_runs' | 'cluster_runs';

export type ThreadRow = {
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

export type CommentSeed = {
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

export type EmbeddingSourceKind = 'title' | 'body' | 'dedupe_summary' | 'llm_key_summary';
export type SimilaritySourceKind = EmbeddingSourceKind | 'deterministic_fingerprint';
export type AggregatedClusterEdge = {
  leftThreadId: number;
  rightThreadId: number;
  score: number;
  sourceKinds: Set<SimilaritySourceKind>;
};

export type EmbeddingTask = {
  threadId: number;
  threadNumber: number;
  sourceKind: EmbeddingSourceKind;
  text: string;
  contentHash: string;
  estimatedTokens: number;
  wasTruncated: boolean;
};

export type StoredEmbeddingRow = ThreadRow & {
  source_kind: EmbeddingSourceKind;
  embedding_json: string;
};

export type ActiveVectorTask = {
  threadId: number;
  threadNumber: number;
  basis: EmbeddingBasis;
  text: string;
  contentHash: string;
  estimatedTokens: number;
  wasTruncated: boolean;
};

export type KeySummaryTask = {
  threadId: number;
  threadNumber: number;
  revisionId: number;
  inputHash: string;
  text: string;
};

export type ActiveVectorRow = ThreadRow & {
  basis: EmbeddingBasis;
  model: string;
  dimensions: number;
  content_hash: string;
  vector_json: Buffer | string;
  vector_backend: string;
};

export type SqliteMaintenanceStats = {
  pageSize: number;
  pageCount: number;
  freelistPages: number;
  bytes: number;
  walBytes: number;
  shmBytes: number;
  sidecarBytes: number;
};

export type DurableTuiClosure = {
  clusterId: number;
  status: 'active' | 'closed' | 'merged' | 'split';
  closedAt: string | null;
  reason: string | null;
};

export type RepoPipelineStateRow = {
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

export type ClusterExperimentMemoryStats = {
  rssBeforeBytes: number;
  rssAfterBytes: number;
  peakRssBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  peakHeapUsedBytes: number;
};

export type ClusterExperimentSizeBucket = {
  size: number;
  count: number;
};

export type ClusterExperimentClusterSizeStats = {
  soloClusters: number;
  maxClusterSize: number;
  topClusterSizes: number[];
  histogram: ClusterExperimentSizeBucket[];
};

export type ClusterExperimentCluster = {
  representativeThreadId: number;
  memberThreadIds: number[];
};

export type ClusterExperimentResult = {
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

export type SummaryModelPricing = {
  inputCostPerM: number;
  cachedInputCostPerM: number;
  outputCostPerM: number;
};

export type EmbeddingWorkset = {
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

export type SyncCursorState = {
  lastFullOpenScanStartedAt: string | null;
  lastOverlappingOpenScanCompletedAt: string | null;
  lastNonOverlappingScanCompletedAt: string | null;
  lastReconciledOpenCloseAt: string | null;
};

export type SyncRunStats = {
  threadsSynced: number;
  commentsSynced: number;
  codeFilesSynced: number;
  threadsClosed: number;
  threadsClosedFromClosedSweep?: number;
  threadsClosedFromClosedBackfill?: number;
  threadsClosedFromDirectReconcile?: number;
  directReconcileSkippedStaleThreadCount?: number;
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
  keySummary: {
    summaryKind: string;
    promptVersion: string;
    model: string;
    text: string;
  } | null;
  topFiles: Array<{
    path: string;
    status: string | null;
    additions: number;
    deletions: number;
  }>;
  neighbors: SearchHitDto['neighbors'];
};

export type TuiSnapshot = {
  repository: RepositoryDto;
  stats: TuiRepoStats;
  clusterRunId: number | null;
  clusters: TuiClusterSummary[];
};

export type TuiRefreshState = {
  repositoryUpdatedAt: string | null;
  threadUpdatedAt: string | null;
  threadClosedAt: string | null;
  clusterClosedAt: string | null;
  durableClusterUpdatedAt: string | null;
  durableMembershipUpdatedAt: string | null;
  latestSyncRunId: number | null;
  latestEmbeddingRunId: number | null;
  latestClusterRunId: number | null;
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

export type SyncOptions = {
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

export type PortableSyncExportOptions = {
  owner: string;
  repo: string;
  outputPath?: string;
  bodyChars?: number;
  profile?: PortableSyncProfile;
  writeManifest?: boolean;
};

export type SearchResultInternal = SearchResponse;
export type NeighborsResultInternal = NeighborsResponse;
