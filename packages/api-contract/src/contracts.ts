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

export const authorThreadSchema = z.object({
  thread: threadSchema,
  strongestSameAuthorMatch: neighborSchema.nullable(),
});
export type AuthorThreadDto = z.infer<typeof authorThreadSchema>;

export const authorThreadsResponseSchema = z.object({
  repository: repositorySchema,
  authorLogin: z.string(),
  threads: z.array(authorThreadSchema),
});
export type AuthorThreadsResponse = z.infer<typeof authorThreadsResponseSchema>;

export const repoUserModeSchema = z.enum(['flagged', 'trusted_prs']);
export type RepoUserMode = z.infer<typeof repoUserModeSchema>;

export const reputationTierSchema = z.enum(['low', 'medium', 'high', 'unknown']);
export type ReputationTier = z.infer<typeof reputationTierSchema>;

export const repoUserTotalsSchema = z.object({
  matchingUserCount: z.number().int().nonnegative(),
  openIssueCount: z.number().int().nonnegative(),
  openPullRequestCount: z.number().int().nonnegative(),
  waitingPullRequestCount: z.number().int().nonnegative(),
});
export type RepoUserTotalsDto = z.infer<typeof repoUserTotalsSchema>;

export const repoUserSummarySchema = z.object({
  login: z.string(),
  reputationTier: reputationTierSchema,
  likelyHiddenActivity: z.boolean().default(false),
  isStale: z.boolean().default(true),
  lastRefreshedAt: z.string().nullable(),
  lastRefreshError: z.string().nullable(),
  accountCreatedAt: z.string().nullable(),
  accountAgeDays: z.number().int().nonnegative().nullable(),
  openIssueCount: z.number().int().nonnegative(),
  openPullRequestCount: z.number().int().nonnegative(),
  waitingPullRequestCount: z.number().int().nonnegative(),
  matchedLowReputation: z.boolean().default(false),
  matchedLikelyHiddenActivity: z.boolean().default(false),
  reasons: z.array(z.string()),
});
export type RepoUserSummaryDto = z.infer<typeof repoUserSummarySchema>;

export const repoUsersResponseSchema = z.object({
  repository: repositorySchema,
  mode: repoUserModeSchema,
  totals: repoUserTotalsSchema,
  users: z.array(repoUserSummarySchema),
});
export type RepoUsersResponse = z.infer<typeof repoUsersResponseSchema>;

export const repoUserThreadSchema = z.object({
  threadId: z.number().int().positive(),
  number: z.number().int().positive(),
  kind: threadKindSchema,
  title: z.string(),
  htmlUrl: z.string().url(),
  state: z.string(),
  isDraft: z.boolean().default(false),
  createdAtGh: z.string().nullable(),
  updatedAtGh: z.string().nullable(),
  ageDays: z.number().int().nonnegative().nullable(),
  filesChanged: z.number().int().nonnegative().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type RepoUserThreadDto = z.infer<typeof repoUserThreadSchema>;

export const repoUserProfileSchema = z.object({
  login: z.string(),
  githubUserId: z.string().nullable(),
  profileUrl: z.string().url().nullable(),
  avatarUrl: z.string().url().nullable(),
  userType: z.string().nullable(),
  accountCreatedAt: z.string().nullable(),
  accountAgeDays: z.number().int().nonnegative().nullable(),
  publicRepoCount: z.number().int().nonnegative().nullable(),
  publicGistCount: z.number().int().nonnegative().nullable(),
  followers: z.number().int().nonnegative().nullable(),
  following: z.number().int().nonnegative().nullable(),
  recentPublicEventCount: z.number().int().nonnegative().nullable(),
  reputationTier: reputationTierSchema,
  likelyHiddenActivity: z.boolean().default(false),
  isStale: z.boolean().default(true),
  lastGlobalRefreshAt: z.string().nullable(),
  lastRepoRefreshAt: z.string().nullable(),
  lastRefreshError: z.string().nullable(),
  firstSeenAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  reasons: z.array(z.string()),
});
export type RepoUserProfileDto = z.infer<typeof repoUserProfileSchema>;

export const repoUserDetailResponseSchema = z.object({
  repository: repositorySchema,
  profile: repoUserProfileSchema,
  totals: repoUserTotalsSchema,
  issues: z.array(repoUserThreadSchema),
  pullRequests: z.array(repoUserThreadSchema),
});
export type RepoUserDetailResponse = z.infer<typeof repoUserDetailResponseSchema>;

export const repoUserRefreshRequestSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  login: z.string(),
  force: z.boolean().optional(),
});
export type RepoUserRefreshRequest = z.infer<typeof repoUserRefreshRequestSchema>;

export const repoUserRefreshResponseSchema = z.object({
  ok: z.boolean(),
  repository: repositorySchema,
  login: z.string(),
  refreshedAt: z.string(),
  profile: repoUserProfileSchema,
});
export type RepoUserRefreshResponse = z.infer<typeof repoUserRefreshResponseSchema>;

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

export const syncResultSchema = z.object({
  runId: z.number().int().positive(),
  threadsSynced: z.number().int().nonnegative(),
  commentsSynced: z.number().int().nonnegative(),
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

export const closeResponseSchema = z.object({
  ok: z.boolean(),
  repository: repositorySchema,
  thread: threadSchema.nullable().optional(),
  clusterId: z.number().int().positive().nullable().optional(),
  clusterClosed: z.boolean().optional(),
  message: z.string(),
});
export type CloseResponse = z.infer<typeof closeResponseSchema>;

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
