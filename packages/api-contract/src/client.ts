import {
  actionRequestSchema,
  actionResponseSchema,
  closeClusterRequestSchema,
  closeResponseSchema,
  closeThreadRequestSchema,
  clusterDetailResponseSchema,
  clusterExplainResponseSchema,
  clusterMergeResponseSchema,
  clusterOverrideResponseSchema,
  clusterSplitResponseSchema,
  clusterSummariesResponseSchema,
  clustersResponseSchema,
  excludeClusterMemberRequestSchema,
  healthResponseSchema,
  includeClusterMemberRequestSchema,
  mergeClustersRequestSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  repositoriesResponseSchema,
  searchResponseSchema,
  setClusterCanonicalRequestSchema,
  splitClusterRequestSchema,
  threadsResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type CloseResponse,
  type ClusterMergeResponse,
  type ClusterOverrideResponse,
  type ClusterSplitResponse,
  type ClusterDetailResponse,
  type ClusterExplainResponse,
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
  explainCluster: (params: { owner: string; repo: string; clusterId: number; memberLimit?: number; eventLimit?: number }) => Promise<ClusterExplainResponse>;
  refresh: (request: RefreshRequest) => Promise<RefreshResponse>;
  rerun: (request: ActionRequest) => Promise<ActionResponse>;
  closeThread: (request: { owner: string; repo: string; threadNumber: number }) => Promise<CloseResponse>;
  closeCluster: (request: { owner: string; repo: string; clusterId: number }) => Promise<CloseResponse>;
  excludeClusterMember: (request: { owner: string; repo: string; clusterId: number; threadNumber: number; reason?: string }) => Promise<ClusterOverrideResponse>;
  includeClusterMember: (request: { owner: string; repo: string; clusterId: number; threadNumber: number; reason?: string }) => Promise<ClusterOverrideResponse>;
  setClusterCanonical: (request: { owner: string; repo: string; clusterId: number; threadNumber: number; reason?: string }) => Promise<ClusterOverrideResponse>;
  mergeClusters: (request: { owner: string; repo: string; sourceClusterId: number; targetClusterId: number; reason?: string }) => Promise<ClusterMergeResponse>;
  splitCluster: (request: { owner: string; repo: string; sourceClusterId: number; threadNumbers: number[]; reason?: string }) => Promise<ClusterSplitResponse>;
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
      if (params.includeClosed !== undefined) search.set('includeClosed', String(params.includeClosed));
      const res = await fetchImpl(`${normalized}/clusters?${search.toString()}`);
      return readJson(res, clustersResponseSchema);
    },
    async listClusterSummaries(params) {
      const search = new URLSearchParams({ owner: params.owner, repo: params.repo });
      if (params.minSize !== undefined) search.set('minSize', String(params.minSize));
      if (params.limit !== undefined) search.set('limit', String(params.limit));
      if (params.sort) search.set('sort', params.sort);
      if (params.search) search.set('search', params.search);
      if (params.includeClosed !== undefined) search.set('includeClosed', String(params.includeClosed));
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
      if (params.includeClosed !== undefined) search.set('includeClosed', String(params.includeClosed));
      const res = await fetchImpl(`${normalized}/cluster-detail?${search.toString()}`);
      return readJson(res, clusterDetailResponseSchema);
    },
    async explainCluster(params) {
      const search = new URLSearchParams({
        owner: params.owner,
        repo: params.repo,
        clusterId: String(params.clusterId),
      });
      if (params.memberLimit !== undefined) search.set('memberLimit', String(params.memberLimit));
      if (params.eventLimit !== undefined) search.set('eventLimit', String(params.eventLimit));
      const res = await fetchImpl(`${normalized}/cluster-explain?${search.toString()}`);
      return readJson(res, clusterExplainResponseSchema);
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
    async excludeClusterMember(request) {
      const body = excludeClusterMemberRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/exclude-cluster-member`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, clusterOverrideResponseSchema);
    },
    async includeClusterMember(request) {
      const body = includeClusterMemberRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/include-cluster-member`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, clusterOverrideResponseSchema);
    },
    async setClusterCanonical(request) {
      const body = setClusterCanonicalRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/set-cluster-canonical`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, clusterOverrideResponseSchema);
    },
    async mergeClusters(request) {
      const body = mergeClustersRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/merge-clusters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, clusterMergeResponseSchema);
    },
    async splitCluster(request) {
      const body = splitClusterRequestSchema.parse(request);
      const res = await fetchImpl(`${normalized}/actions/split-cluster`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return readJson(res, clusterSplitResponseSchema);
    },
  };
}
