import {
  actionRequestSchema,
  actionResponseSchema,
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
  listThreads: (params: { owner: string; repo: string; kind?: 'issue' | 'pull_request'; numbers?: number[] }) => Promise<ThreadsResponse>;
  search: (params: { owner: string; repo: string; query: string; mode?: SearchMode }) => Promise<SearchResponse>;
  listClusters: (params: { owner: string; repo: string }) => Promise<ClustersResponse>;
  listClusterSummaries: (params: {
    owner: string;
    repo: string;
    minSize?: number;
    limit?: number;
    sort?: 'recent' | 'size';
    search?: string;
  }) => Promise<ClusterSummariesResponse>;
  getClusterDetail: (params: {
    owner: string;
    repo: string;
    clusterId: number;
    memberLimit?: number;
    bodyChars?: number;
  }) => Promise<ClusterDetailResponse>;
  refresh: (request: RefreshRequest) => Promise<RefreshResponse>;
  rerun: (request: ActionRequest) => Promise<ActionResponse>;
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
      const res = await fetchImpl(`${normalized}/threads?${search.toString()}`);
      return readJson(res, threadsResponseSchema);
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
      const res = await fetchImpl(`${normalized}/clusters?${search.toString()}`);
      return readJson(res, clustersResponseSchema);
    },
    async listClusterSummaries(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo });
      if (params.minSize !== undefined) search.set('minSize', String(params.minSize));
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.sort) search.set('sort', params.sort);
      if (params.search) search.set('search', params.search);
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
  };
}
