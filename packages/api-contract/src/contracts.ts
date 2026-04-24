import { z } from 'zod';

export const threadKindSchema = z.enum(['issue', 'pull_request']);
export type ThreadKind = z.infer<typeof threadKindSchema>;

export const searchModeSchema = z.enum(['keyword', 'semantic', 'hybrid']);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const repositorySchema = z.object({
  id: z.number().int().positive(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  githubRepoId: z.string().nullable(),
  updatedAt: z.string(),
});
export type RepositoryDto = z.infer<typeof repositorySchema>;

export const threadSchema = z.object({
  id: z.number().int().positive(),
  repoId: z.number().int().positive(),
  number: z.number().int().positive(),
  kind: threadKindSchema,
  state: z.string(),
  isClosed: z.boolean(),
  closedAtGh: z.string().nullable().optional(),
  closedAtLocal: z.string().nullable().optional(),
  closeReasonLocal: z.string().nullable().optional(),
  title: z.string(),
  body: z.string().nullable(),
  authorLogin: z.string().nullable(),
  htmlUrl: z.string().url(),
  labels: z.array(z.string()),
  updatedAtGh: z.string().nullable(),
  clusterId: z.number().int().positive().nullable().optional(),
});
export type ThreadDto = z.infer<typeof threadSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  configPath: z.string(),
  configFileExists: z.boolean(),
  dbPath: z.string(),
  apiPort: z.number().int().positive(),
  githubConfigured: z.boolean(),
  openaiConfigured: z.boolean(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const repositoriesResponseSchema = z.object({
  repositories: z.array(repositorySchema),
});
export type RepositoriesResponse = z.infer<typeof repositoriesResponseSchema>;

export const runKindSchema = z.enum(['sync', 'summary', 'embedding', 'cluster']);
export type RunKind = z.infer<typeof runKindSchema>;

export const runRecordSchema = z.object({
  runId: z.number().int().positive(),
  runKind: runKindSchema,
  scope: z.string(),
  status: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  stats: z.record(z.string(), z.unknown()).nullable(),
  errorText: z.string().nullable(),
});
export type RunRecordDto = z.infer<typeof runRecordSchema>;

export const runHistoryResponseSchema = z.object({
  repository: repositorySchema,
  runs: z.array(runRecordSchema),
});
export type RunHistoryResponse = z.infer<typeof runHistoryResponseSchema>;

export const threadsResponseSchema = z.object({
  repository: repositorySchema,
  threads: z.array(threadSchema),
});
export type ThreadsResponse = z.infer<typeof threadsResponseSchema>;

export const neighborSchema = z.object({
  threadId: z.number().int().positive(),
  number: z.number().int().positive(),
  kind: threadKindSchema,
  title: z.string(),
  score: z.number(),
});
export type NeighborDto = z.infer<typeof neighborSchema>;

export const searchHitSchema = z.object({
  thread: threadSchema,
  keywordScore: z.number().nullable(),
  semanticScore: z.number().nullable(),
  hybridScore: z.number(),
  neighbors: z.array(neighborSchema).default([]),
});
export type SearchHitDto = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  repository: repositorySchema,
  query: z.string(),
  mode: searchModeSchema,
  hits: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const neighborsResponseSchema = z.object({
  repository: repositorySchema,
  thread: threadSchema,
  neighbors: z.array(neighborSchema),
});
export type NeighborsResponse = z.infer<typeof neighborsResponseSchema>;

export const clusterMemberSchema = z.object({
  threadId: z.number().int().positive(),
  number: z.number().int().positive(),
  kind: threadKindSchema,
  isClosed: z.boolean().default(false),
  title: z.string(),
  scoreToRepresentative: z.number().nullable(),
});
export type ClusterMemberDto = z.infer<typeof clusterMemberSchema>;

export const clusterSchema = z.object({
  id: z.number().int().positive(),
  repoId: z.number().int().positive(),
  isClosed: z.boolean().default(false),
  closedAtLocal: z.string().nullable().optional(),
  closeReasonLocal: z.string().nullable().optional(),
  representativeThreadId: z.number().int().positive().nullable(),
  memberCount: z.number().int().nonnegative(),
  members: z.array(clusterMemberSchema),
});
export type ClusterDto = z.infer<typeof clusterSchema>;

export const clustersResponseSchema = z.object({
  repository: repositorySchema,
  clusters: z.array(clusterSchema),
});
export type ClustersResponse = z.infer<typeof clustersResponseSchema>;

export const repoStatsSchema = z.object({
  openIssueCount: z.number().int().nonnegative(),
  openPullRequestCount: z.number().int().nonnegative(),
  lastGithubReconciliationAt: z.string().nullable(),
  lastEmbedRefreshAt: z.string().nullable(),
  staleEmbedThreadCount: z.number().int().nonnegative(),
  staleEmbedSourceCount: z.number().int().nonnegative(),
  latestClusterRunId: z.number().int().positive().nullable(),
  latestClusterRunFinishedAt: z.string().nullable(),
});
export type RepoStatsDto = z.infer<typeof repoStatsSchema>;

export const clusterSummarySchema = z.object({
  clusterId: z.number().int().positive(),
  displayTitle: z.string(),
  isClosed: z.boolean().default(false),
  closedAtLocal: z.string().nullable().optional(),
  closeReasonLocal: z.string().nullable().optional(),
  totalCount: z.number().int().nonnegative(),
  issueCount: z.number().int().nonnegative(),
  pullRequestCount: z.number().int().nonnegative(),
  latestUpdatedAt: z.string().nullable(),
  representativeThreadId: z.number().int().positive().nullable(),
  representativeNumber: z.number().int().positive().nullable(),
  representativeKind: threadKindSchema.nullable(),
});
export type ClusterSummaryDto = z.infer<typeof clusterSummarySchema>;

export const clusterSummariesResponseSchema = z.object({
  repository: repositorySchema,
  stats: repoStatsSchema,
  clusters: z.array(clusterSummarySchema),
});
export type ClusterSummariesResponse = z.infer<typeof clusterSummariesResponseSchema>;

export const durableClusterMemberSchema = z.object({
  thread: threadSchema,
  role: z.enum(['canonical', 'duplicate', 'related']),
  state: z.enum(['active', 'removed_by_user', 'blocked_by_override', 'pending_review', 'stale']),
  scoreToRepresentative: z.number().nullable(),
});
export type DurableClusterMemberDto = z.infer<typeof durableClusterMemberSchema>;

export const durableClusterSchema = z.object({
  clusterId: z.number().int().positive(),
  stableKey: z.string(),
  stableSlug: z.string(),
  status: z.enum(['active', 'closed', 'merged', 'split']),
  clusterType: z.string().nullable(),
  title: z.string().nullable(),
  representativeThreadId: z.number().int().positive().nullable(),
  activeCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  members: z.array(durableClusterMemberSchema),
});
export type DurableClusterDto = z.infer<typeof durableClusterSchema>;

export const durableClustersResponseSchema = z.object({
  repository: repositorySchema,
  clusters: z.array(durableClusterSchema),
});
export type DurableClustersResponse = z.infer<typeof durableClustersResponseSchema>;

export const threadSummariesSchema = z.object({
  problem_summary: z.string().optional(),
  solution_summary: z.string().optional(),
  maintainer_signal_summary: z.string().optional(),
  dedupe_summary: z.string().optional(),
});
export type ThreadSummariesDto = z.infer<typeof threadSummariesSchema>;

export const clusterThreadDumpSchema = z.object({
  thread: threadSchema,
  bodySnippet: z.string().nullable(),
  summaries: threadSummariesSchema,
});
export type ClusterThreadDumpDto = z.infer<typeof clusterThreadDumpSchema>;

export const clusterDetailResponseSchema = z.object({
  repository: repositorySchema,
  stats: repoStatsSchema,
  cluster: clusterSummarySchema,
  members: z.array(clusterThreadDumpSchema),
});
export type ClusterDetailResponse = z.infer<typeof clusterDetailResponseSchema>;

export const clusterExplainAliasSchema = z.object({
  aliasSlug: z.string(),
  reason: z.string(),
  createdAt: z.string(),
});
export type ClusterExplainAliasDto = z.infer<typeof clusterExplainAliasSchema>;

export const clusterExplainOverrideSchema = z.object({
  threadNumber: z.number().int().positive(),
  action: z.enum(['exclude', 'force_include', 'force_canonical']),
  reason: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type ClusterExplainOverrideDto = z.infer<typeof clusterExplainOverrideSchema>;

export const clusterExplainEventSchema = z.object({
  eventType: z.string(),
  actorKind: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type ClusterExplainEventDto = z.infer<typeof clusterExplainEventSchema>;

export const clusterExplainEvidenceSchema = z.object({
  leftThreadNumber: z.number().int().positive(),
  rightThreadNumber: z.number().int().positive(),
  score: z.number(),
  tier: z.enum(['strong', 'weak']),
  state: z.enum(['active', 'stale', 'rejected']),
  sources: z.array(z.string()),
  breakdown: z.record(z.string(), z.unknown()),
  lastSeenRunId: z.number().int().positive().nullable(),
  updatedAt: z.string(),
});
export type ClusterExplainEvidenceDto = z.infer<typeof clusterExplainEvidenceSchema>;

export const clusterExplainResponseSchema = z.object({
  repository: repositorySchema,
  cluster: durableClusterSchema,
  aliases: z.array(clusterExplainAliasSchema),
  overrides: z.array(clusterExplainOverrideSchema),
  events: z.array(clusterExplainEventSchema),
  evidence: z.array(clusterExplainEvidenceSchema),
});
export type ClusterExplainResponse = z.infer<typeof clusterExplainResponseSchema>;

export const syncResultSchema = z.object({
  runId: z.number().int().positive(),
  threadsSynced: z.number().int().nonnegative(),
  commentsSynced: z.number().int().nonnegative(),
  codeFilesSynced: z.number().int().nonnegative().default(0),
  threadsClosed: z.number().int().nonnegative(),
});
export type SyncResultDto = z.infer<typeof syncResultSchema>;

export const embedResultSchema = z.object({
  runId: z.number().int().positive(),
  embedded: z.number().int().nonnegative(),
});
export type EmbedResultDto = z.infer<typeof embedResultSchema>;

export const clusterResultSchema = z.object({
  runId: z.number().int().positive(),
  edges: z.number().int().nonnegative(),
  clusters: z.number().int().nonnegative(),
});
export type ClusterResultDto = z.infer<typeof clusterResultSchema>;

export const refreshRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  sync: z.boolean().optional(),
  embed: z.boolean().optional(),
  cluster: z.boolean().optional(),
  includeCode: z.boolean().optional(),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResponseSchema = z.object({
  repository: repositorySchema,
  selected: z.object({
    sync: z.boolean(),
    embed: z.boolean(),
    cluster: z.boolean(),
  }),
  sync: syncResultSchema.nullable(),
  embed: embedResultSchema.nullable(),
  cluster: clusterResultSchema.nullable(),
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const closeThreadRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  threadNumber: z.number().int().positive(),
});
export type CloseThreadRequest = z.infer<typeof closeThreadRequestSchema>;

export const closeClusterRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  clusterId: z.number().int().positive(),
});
export type CloseClusterRequest = z.infer<typeof closeClusterRequestSchema>;

export const excludeClusterMemberRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  clusterId: z.number().int().positive(),
  threadNumber: z.number().int().positive(),
  reason: z.string().trim().min(1).optional(),
});
export type ExcludeClusterMemberRequest = z.infer<typeof excludeClusterMemberRequestSchema>;

export const includeClusterMemberRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  clusterId: z.number().int().positive(),
  threadNumber: z.number().int().positive(),
  reason: z.string().trim().min(1).optional(),
});
export type IncludeClusterMemberRequest = z.infer<typeof includeClusterMemberRequestSchema>;

export const setClusterCanonicalRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  clusterId: z.number().int().positive(),
  threadNumber: z.number().int().positive(),
  reason: z.string().trim().min(1).optional(),
});
export type SetClusterCanonicalRequest = z.infer<typeof setClusterCanonicalRequestSchema>;

export const mergeClustersRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  sourceClusterId: z.number().int().positive(),
  targetClusterId: z.number().int().positive(),
  reason: z.string().trim().min(1).optional(),
});
export type MergeClustersRequest = z.infer<typeof mergeClustersRequestSchema>;

export const splitClusterRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  sourceClusterId: z.number().int().positive(),
  threadNumbers: z.array(z.number().int().positive()).min(1),
  reason: z.string().trim().min(1).optional(),
});
export type SplitClusterRequest = z.infer<typeof splitClusterRequestSchema>;

export const closeResponseSchema = z.object({
  ok: z.boolean(),
  repository: repositorySchema,
  thread: threadSchema.nullable().optional(),
  clusterId: z.number().int().positive().nullable().optional(),
  clusterClosed: z.boolean().optional(),
  message: z.string(),
});
export type CloseResponse = z.infer<typeof closeResponseSchema>;

export const clusterOverrideResponseSchema = z.object({
  ok: z.boolean(),
  repository: repositorySchema,
  clusterId: z.number().int().positive(),
  thread: threadSchema,
  action: z.enum(['exclude', 'force_include', 'force_canonical']),
  state: z.enum(['active', 'removed_by_user', 'blocked_by_override']),
  message: z.string(),
});
export type ClusterOverrideResponse = z.infer<typeof clusterOverrideResponseSchema>;

export const clusterMergeResponseSchema = z.object({
  ok: z.boolean(),
  repository: repositorySchema,
  sourceClusterId: z.number().int().positive(),
  targetClusterId: z.number().int().positive(),
  message: z.string(),
});
export type ClusterMergeResponse = z.infer<typeof clusterMergeResponseSchema>;

export const clusterSplitResponseSchema = z.object({
  ok: z.boolean(),
  repository: repositorySchema,
  sourceClusterId: z.number().int().positive(),
  newClusterId: z.number().int().positive(),
  movedCount: z.number().int().nonnegative(),
  message: z.string(),
});
export type ClusterSplitResponse = z.infer<typeof clusterSplitResponseSchema>;

export const rerunActionSchema = z.enum(['summarize', 'embed', 'cluster']);
export type RerunAction = z.infer<typeof rerunActionSchema>;

export const actionRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  action: rerunActionSchema,
  threadNumber: z.number().int().positive().optional(),
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const actionResponseSchema = z.object({
  ok: z.boolean(),
  action: rerunActionSchema,
  runId: z.number().int().positive().nullable(),
  message: z.string(),
});
export type ActionResponse = z.infer<typeof actionResponseSchema>;
