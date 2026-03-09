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
  openSearchConfigured: z.boolean(),
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
  title: z.string(),
  scoreToRepresentative: z.number().nullable(),
});
export type ClusterMemberDto = z.infer<typeof clusterMemberSchema>;

export const clusterSchema = z.object({
  id: z.number().int().positive(),
  repoId: z.number().int().positive(),
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
