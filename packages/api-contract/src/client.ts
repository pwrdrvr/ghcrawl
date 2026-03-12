import {
  actionRequestSchema,
  actionResponseSchema,
  closeClusterRequestSchema,
  closeResponseSchema,
  closeThreadRequestSchema,
  authorThreadsResponseSchema,
  repoUserDetailResponseSchema,
  repoUserRefreshRequestSchema,
  repoUserRefreshResponseSchema,
  repoUsersResponseSchema,
  clusterDetailResponseSchema,
  clusterSummariesResponseSchema,
  clustersResponseSchema,
  healthResponseSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  repositoriesResponseSchema,
  searchResponseSchema,
  threadsResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type CloseResponse,
  type AuthorThreadsResponse,
  type RepoUserDetailResponse,
  type RepoUserMode,
  type RepoUserRefreshResponse,
  type RepoUsersResponse,
  type ClusterDetailResponse,
  type ClusterSummariesResponse,
  type ClustersResponse,
  type HealthResponse,
  type RefreshRequest,
  type RefreshResponse,
  type RepositoriesResponse,
  type SearchMode,
  type SearchResponse,
  type ThreadsResponse,
} from './contracts.js';

export type GitcrawlClient = {
  health: () => Promise<HealthResponse>;
  listRepositories: () => Promise<RepositoriesResponse>;
  listThreads: (params: { owner: string; repo: string; kind?: 'issue' | 'pull_request'; numbers?: number[]; includeClosed?: boolean }) => Promise<ThreadsResponse>;
  listAuthorThreads: (params: { owner: string; repo: string; login: string; includeClosed?: boolean }) => Promise<AuthorThreadsResponse>;
  listRepoUsers: (params: { owner: string; repo: string; mode: RepoUserMode; limit?: number; includeStale?: boolean }) => Promise<RepoUsersResponse>;
  getRepoUserDetail: (params: { owner: string; repo: string; login: string }) => Promise<RepoUserDetailResponse>;
  refreshRepoUser: (request: { owner: string; repo: string; login: string; force?: boolean }) => Promise<RepoUserRefreshResponse>;
  search: (params: { owner: string; repo: string; query: string; mode?: SearchMode }) => Promise<SearchResponse>;
  listClusters: (params: { owner: string; repo: string; includeClosed?: boolean }) => Promise<ClustersResponse>;
  listClusterSummaries: (params: {
    owner: string;
    repo: string;
    minSize?: number;
    limit?: number;
    sort?: 'recent' | 'size';
    search?: string;
    includeClosed?: boolean;
  }) => Promise<ClusterSummariesResponse>;
  getClusterDetail: (params: {
    owner: string;
    repo: string;
    clusterId: number;
    memberLimit?: number;
    bodyChars?: number;
    includeClosed?: boolean;
  }) => Promise<ClusterDetailResponse>;
  refresh: (request: RefreshRequest) => Promise<RefreshResponse>;
  rerun: (request: ActionRequest) => Promise<ActionResponse>;
  closeThread: (request: { owner: string; repo: string; threadNumber: number }) => Promise<CloseResponse>;
  closeCluster: (request: { owner: string; repo: string; clusterId: number }) => Promise<CloseResponse>;
};

type FetchLike = typeof fetch;

async function readJson<T>(res: Response, schema: { parse: (value: unknown) => T }): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API request failed ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`);
  }
  const value = (await res.json()) as unknown;
  return schema.parse(value);
}

export function createGitcrawlClient(baseUrl: string, fetchImpl: FetchLike = fetch): GitcrawlClient {
  const normalized = baseUrl.replace(/\/+$/, '');

  return {
    async health() {
      const res = await fetchImpl(`${normalized}/health`);
      return readJson(res, healthResponseSchema);
    },
    async listRepositories() {
      const res = await fetchImpl(`${normalized}/repositories`);
      return readJson(res, repositoriesResponseSchema);
    },
    async listThreads(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo });
      if (params.kind) search.set('kind', params.kind);
      if (params.numbers && params.numbers.length > 0) search.set('numbers', params.numbers.join(','));
      if (params.includeClosed) search.set('includeClosed', 'true');
      const res = await fetchImpl(`${normalized}/threads?${search.toString()}`);
      return readJson(res, threadsResponseSchema);
    },
    async listAuthorThreads(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo, login: params.login });
      if (params.includeClosed) search.set('includeClosed', 'true');
      const res = await fetchImpl(`${normalized}/author-threads?${search.toString()}`);
      return readJson(res, authorThreadsResponseSchema);
    },
    async listRepoUsers(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo, mode: params.mode });
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.includeStale !== undefined) search.set('includeStale', String(params.includeStale));
      const res = await fetchImpl(`${normalized}/repo-users?${search.toString()}`);
      return readJson(res, repoUsersResponseSchema);
    },
    async getRepoUserDetail(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo, login: params.login });
      const res = await fetchImpl(`${normalized}/repo-user-detail?${search.toString()}`);
      return readJson(res, repoUserDetailResponseSchema);
    },
    async refreshRepoUser(request) {
      const body = repoUserRefreshRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/refresh-user`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, repoUserRefreshResponseSchema);
    },
    async search(params) {
      const search = new URLSearchParams({
        owner: params.owner,
        repo: params.repo,
        query: params.query,
      });
      if (params.mode) search.set('mode', params.mode);
      const res = await fetchImpl(`${normalized}/search?${search.toString()}`);
      return readJson(res, searchResponseSchema);
    },
    async listClusters(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo });
      if (params.includeClosed) search.set('includeClosed', 'true');
      const res = await fetchImpl(`${normalized}/clusters?${search.toString()}`);
      return readJson(res, clustersResponseSchema);
    },
    async listClusterSummaries(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo });
      if (params.minSize !== undefined) search.set('minSize', String(params.minSize));
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.sort) search.set('sort', params.sort);
      if (params.search) search.set('search', params.search);
      if (params.includeClosed) search.set('includeClosed', 'true');
      const res = await fetchImpl(`${normalized}/cluster-summaries?${search.toString()}`);
      return readJson(res, clusterSummariesResponseSchema);
    },
    async getClusterDetail(params) {
      const search = new URLSearchParams({
        owner: params.owner,
        repo: params.repo,
        clusterId: String(params.clusterId),
      });
      if (params.memberLimit !== undefined) search.set('memberLimit', String(params.memberLimit));
      if (params.bodyChars !== undefined) search.set('bodyChars', String(params.bodyChars));
      if (params.includeClosed) search.set('includeClosed', 'true');
      const res = await fetchImpl(`${normalized}/cluster-detail?${search.toString()}`);
      return readJson(res, clusterDetailResponseSchema);
    },
    async refresh(request) {
      const body = refreshRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, refreshResponseSchema);
    },
    async rerun(request) {
      const body = actionRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/rerun`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, actionResponseSchema);
    },
    async closeThread(request) {
      const body = closeThreadRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/close-thread`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, closeResponseSchema);
    },
    async closeCluster(request) {
      const body = closeClusterRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/close-cluster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, closeResponseSchema);
    },
  };
}
