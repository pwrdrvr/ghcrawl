import http from 'node:http';
import crypto from 'node:crypto';

import { IterableMapper } from '@shutterstock/p-map-iterable';
import {
  actionResponseSchema,
  clustersResponseSchema,
  healthResponseSchema,
  neighborsResponseSchema,
  repositoriesResponseSchema,
  searchResponseSchema,
  threadsResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type ClusterDto,
  type ClustersResponse,
  type HealthResponse,
  type NeighborsResponse,
  type RepositoriesResponse,
  type RepositoryDto,
  type SearchHitDto,
  type SearchMode,
  type SearchResponse,
  type ThreadDto,
  type ThreadsResponse,
} from '@gitcrawl/api-contract';

import { buildClusters } from './cluster/build.js';
import { ensureRuntimeDirs, loadConfig, requireGithubToken, requireOpenAiKey, type GitcrawlConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { openDb, type SqliteDatabase } from './db/sqlite.js';
import { buildCanonicalDocument, isBotLikeAuthor } from './documents/normalize.js';
import { makeGitHubClient, type GitHubClient } from './github/client.js';
import { OpenAiProvider, type AiProvider } from './openai/provider.js';
import { cosineSimilarity, rankNearestNeighbors } from './search/exact.js';

type RunTable = 'sync_runs' | 'summary_runs' | 'embedding_runs' | 'cluster_runs';

type ThreadRow = {
  id: number;
  repo_id: number;
  number: number;
  kind: 'issue' | 'pull_request';
  state: string;
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

type EmbeddingSourceKind = 'title' | 'body' | 'dedupe_summary';

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

export type DoctorResult = {
  health: HealthResponse;
  githubOk: boolean;
  openAiOk: boolean;
  openSearchOk: boolean;
};

type SyncOptions = {
  owner: string;
  repo: string;
  since?: string;
  limit?: number;
  includeComments?: boolean;
  onProgress?: (message: string) => void;
};

type SearchResultInternal = SearchResponse;
type NeighborsResultInternal = NeighborsResponse;

const SYNC_BATCH_SIZE = 100;
const SYNC_BATCH_DELAY_MS = 5000;
const EMBED_ESTIMATED_CHARS_PER_TOKEN = 3;
const EMBED_MAX_ITEM_TOKENS = 7000;
const EMBED_MAX_BATCH_TOKENS = 250000;
const EMBED_TRUNCATION_MARKER = '\n\n[truncated for embedding]';

function nowIso(): string {
  return new Date().toISOString();
}

function asJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseArray(value: string): string[] {
  return JSON.parse(value) as string[];
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
    title: row.title,
    body: row.body,
    authorLogin: row.author_login,
    htmlUrl: row.html_url,
    labels: parseArray(row.labels_json),
    updatedAtGh: row.updated_at_gh,
    clusterId: clusterId ?? null,
  };
}

export class GitcrawlService {
  readonly config: GitcrawlConfig;
  readonly db: SqliteDatabase;
  readonly github: GitHubClient;
  readonly ai?: AiProvider;

  constructor(options: {
    config?: GitcrawlConfig;
    db?: SqliteDatabase;
    github?: GitHubClient;
    ai?: AiProvider;
  } = {}) {
    this.config = options.config ?? loadConfig();
    ensureRuntimeDirs(this.config);
    this.db = options.db ?? openDb(this.config.dbPath);
    migrate(this.db);
    this.github = options.github ?? makeGitHubClient({ token: requireGithubToken(this.config) });
    this.ai = options.ai ?? (this.config.openaiApiKey ? new OpenAiProvider(this.config.openaiApiKey) : undefined);
  }

  close(): void {
    this.db.close();
  }

  init(): HealthResponse {
    ensureRuntimeDirs(this.config);
    migrate(this.db);
    const response = {
      ok: true,
      dbPath: this.config.dbPath,
      apiPort: this.config.apiPort,
      githubConfigured: Boolean(this.config.githubToken),
      openaiConfigured: Boolean(this.config.openaiApiKey),
      openSearchConfigured: Boolean(this.config.openSearchUrl),
    };
    return healthResponseSchema.parse(response);
  }

  async doctor(): Promise<DoctorResult> {
    const health = this.init();
    let githubOk = false;
    let openAiOk = false;
    let openSearchOk = false;

    if (this.config.githubToken) {
      await this.github.checkAuth();
      githubOk = true;
    }
    if (this.ai) {
      await this.ai.checkAuth();
      openAiOk = true;
    }
    if (this.config.openSearchUrl) {
      const response = await fetch(this.config.openSearchUrl, { method: 'GET' });
      openSearchOk = response.ok;
    }

    return { health, githubOk, openAiOk, openSearchOk };
  }

  listRepositories(): RepositoriesResponse {
    const rows = this.db.prepare('select * from repositories order by full_name asc').all() as Array<Record<string, unknown>>;
    return repositoriesResponseSchema.parse({ repositories: rows.map(repositoryToDto) });
  }

  listThreads(params: { owner: string; repo: string; kind?: 'issue' | 'pull_request' }): ThreadsResponse {
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

    let sql = "select * from threads where repo_id = ? and state = 'open'";
    const args: Array<string | number> = [repository.id];
    if (params.kind) {
      sql += ' and kind = ?';
      args.push(params.kind);
    }
    sql += ' order by updated_at_gh desc, number desc';
    const rows = this.db.prepare(sql).all(...args) as ThreadRow[];
    return threadsResponseSchema.parse({
      repository,
      threads: rows.map((row) => threadToDto(row, clusterIds.get(row.id) ?? null)),
    });
  }

  async syncRepository(
    params: SyncOptions,
  ): Promise<{ runId: number; threadsSynced: number; commentsSynced: number; threadsClosed: number }> {
    const crawlStartedAt = nowIso();
    const includeComments = params.includeComments ?? false;
    params.onProgress?.(`[sync] fetching repository metadata for ${params.owner}/${params.repo}`);
    const reporter = params.onProgress ? (message: string) => params.onProgress?.(message.replace(/^\[github\]/, '[sync/github]')) : undefined;
    const repoData = await this.github.getRepo(params.owner, params.repo, reporter);
    const repoId = this.upsertRepository(params.owner, params.repo, repoData);
    const runId = this.startRun('sync_runs', repoId, `${params.owner}/${params.repo}`);

    try {
      params.onProgress?.(`[sync] listing issues and pull requests for ${params.owner}/${params.repo}`);
      params.onProgress?.(
        includeComments
          ? '[sync] comment hydration enabled; fetching issue comments, reviews, and review comments'
          : '[sync] metadata-only mode; skipping comment, review, and review-comment fetches',
      );
      const items = await this.github.listRepositoryIssues(params.owner, params.repo, params.since, params.limit, reporter);
      params.onProgress?.(`[sync] discovered ${items.length} threads to process`);
      let threadsSynced = 0;
      let commentsSynced = 0;

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
          const threadPayload = isPr ? await this.github.getPull(params.owner, params.repo, number, reporter) : item;
          const threadId = this.upsertThread(repoId, kind, threadPayload, crawlStartedAt);
          if (includeComments) {
            const comments = await this.fetchThreadComments(params.owner, params.repo, number, isPr, reporter);
            this.replaceComments(threadId, comments);
            commentsSynced += comments.length;
          }
          this.refreshDocument(threadId);
          threadsSynced += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`sync failed while processing ${kind} #${number}: ${message}`);
        }
      }

      const shouldReconcileMissingOpenThreads = params.limit === undefined && params.since === undefined;
      if (!shouldReconcileMissingOpenThreads) {
        params.onProgress?.('[sync] skipping stale-open reconciliation because this was a filtered crawl');
      }
      const threadsClosed = shouldReconcileMissingOpenThreads
        ? await this.reconcileMissingOpenThreads({
            repoId,
            owner: params.owner,
            repo: params.repo,
            crawlStartedAt,
            reporter,
            onProgress: params.onProgress,
          })
        : 0;

      this.finishRun('sync_runs', runId, 'completed', { threadsSynced, commentsSynced, threadsClosed });
      return { runId, threadsSynced, commentsSynced, threadsClosed };
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
            'select content_hash from document_summaries where thread_id = ? and summary_kind = ? and model = ? limit 1',
          )
          .get(row.id, 'dedupe_summary', this.config.summaryModel) as { content_hash: string } | undefined;
        return latest?.content_hash !== row.summaryContentHash;
      });

      params.onProgress?.(
        `[summarize] pending=${pending.length} skipped=${rows.length - pending.length} model=${this.config.summaryModel}`,
      );

      let summarized = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let totalTokens = 0;
      for (const [index, row] of pending.entries()) {
        params.onProgress?.(`[summarize] ${index + 1}/${pending.length} thread #${row.number}`);
        const result = await ai.summarizeThread({
          model: this.config.summaryModel,
          text: row.summaryInput,
        });
        const summary = result.summary;

        this.upsertSummary(row.id, row.summaryContentHash, 'problem_summary', summary.problemSummary);
        this.upsertSummary(row.id, row.summaryContentHash, 'solution_summary', summary.solutionSummary);
        this.upsertSummary(row.id, row.summaryContentHash, 'maintainer_signal_summary', summary.maintainerSignalSummary);
        this.upsertSummary(row.id, row.summaryContentHash, 'dedupe_summary', summary.dedupeSummary);
        if (result.usage) {
          inputTokens += result.usage.inputTokens;
          outputTokens += result.usage.outputTokens;
          totalTokens += result.usage.totalTokens;
          params.onProgress?.(
            `[summarize] tokens thread #${row.number} in=${result.usage.inputTokens} out=${result.usage.outputTokens} total=${result.usage.totalTokens} cached_in=${result.usage.cachedInputTokens} reasoning=${result.usage.reasoningTokens}`,
          );
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
  }): Promise<{ runId: number; embedded: number }> {
    const ai = this.requireAi();
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = this.startRun('embedding_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);

    try {
      let sql =
        `select t.id, t.number, t.title, t.body
         from threads t
         where t.repo_id = ? and t.state = 'open'`;
      const args: Array<string | number> = [repository.id];
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
      }>;
      const summaryTexts = this.loadCombinedSummaryTextMap(repository.id, params.threadNumber);

      const tasks = rows.flatMap((row) =>
        this.buildEmbeddingTasks({
          threadId: row.id,
          threadNumber: row.number,
          title: row.title,
          body: row.body,
          dedupeSummary: summaryTexts.get(row.id) ?? null,
        }),
      );
      const existingRows = this.db
        .prepare(
          `select e.thread_id, e.source_kind, e.content_hash
           from document_embeddings e
           join threads t on t.id = e.thread_id
           where t.repo_id = ? and e.model = ?`,
        )
        .all(repository.id, this.config.embedModel) as Array<{
          thread_id: number;
          source_kind: EmbeddingSourceKind;
          content_hash: string;
        }>;
      const existing = new Map<string, string>();
      for (const row of existingRows) {
        existing.set(`${row.thread_id}:${row.source_kind}`, row.content_hash);
      }
      const pending = tasks.filter((task) => existing.get(`${task.threadId}:${task.sourceKind}`) !== task.contentHash);
      const skipped = tasks.length - pending.length;
      const truncated = tasks.filter((task) => task.wasTruncated).length;

      params.onProgress?.(
        `[embed] loaded ${rows.length} open thread(s) and ${tasks.length} embedding source(s) for ${repository.fullName}`,
      );
      params.onProgress?.(
        `[embed] pending=${pending.length} skipped=${skipped} truncated=${truncated} model=${this.config.embedModel} batch_size=${this.config.embedBatchSize} concurrency=${this.config.embedConcurrency} max_unread=${this.config.embedMaxUnread} max_batch_tokens=${EMBED_MAX_BATCH_TOKENS}`,
      );

      let embedded = 0;
      const batches = this.chunkEmbeddingTasks(pending, this.config.embedBatchSize, EMBED_MAX_BATCH_TOKENS);
      const mapper = new IterableMapper(
        batches,
        async (batch: EmbeddingTask[]) => {
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
        const numbers = batchResult.map(({ task }) => `#${task.threadNumber}:${task.sourceKind}`);
        const estimatedTokens = batchResult.reduce((sum, { task }) => sum + task.estimatedTokens, 0);
        params.onProgress?.(
          `[embed] batch ${completedBatches}/${Math.max(batches.length, 1)} size=${batchResult.length} est_tokens=${estimatedTokens} items=${numbers.join(',')}`,
        );
        for (const { task, embedding } of batchResult) {
          this.upsertEmbedding(task.threadId, task.sourceKind, task.contentHash, embedding);
          embedded += 1;
        }
      }

      this.finishRun('embedding_runs', runId, 'completed', { embedded });
      return { runId, embedded };
    } catch (error) {
      this.finishRun('embedding_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  clusterRepository(params: {
    owner: string;
    repo: string;
    minScore?: number;
    k?: number;
    onProgress?: (message: string) => void;
  }): { runId: number; edges: number; clusters: number } {
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = this.startRun('cluster_runs', repository.id, repository.fullName);
    const minScore = params.minScore ?? 0.82;
    const k = params.k ?? 6;

    try {
      const rows = this.loadStoredEmbeddings(repository.id);
      const threadMeta = new Map<number, { number: number; title: string }>();
      for (const row of rows) {
        threadMeta.set(row.id, { number: row.number, title: row.title });
      }
      const items = Array.from(threadMeta.entries()).map(([id, meta]) => ({
        id,
        number: meta.number,
        title: meta.title,
      }));

      params.onProgress?.(
        `[cluster] loaded ${items.length} embedded thread(s) across ${new Set(rows.map((row) => row.source_kind)).size} source kind(s) for ${repository.fullName} k=${k} minScore=${minScore}`,
      );

      this.db.prepare('delete from cluster_members where cluster_id in (select id from clusters where cluster_run_id = ?)').run(runId);
      this.db.prepare('delete from clusters where cluster_run_id = ?').run(runId);
      this.db.prepare('delete from similarity_edges where cluster_run_id = ?').run(runId);

      const aggregatedEdges = this.aggregateRepositoryEdges(rows, { limit: k, minScore });
      const edges = Array.from(aggregatedEdges.values()).map((entry) => ({
        leftThreadId: entry.leftThreadId,
        rightThreadId: entry.rightThreadId,
        score: entry.score,
      }));
      const insertEdge = this.db.prepare(
        `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of aggregatedEdges.values()) {
        insertEdge.run(
          repository.id,
          runId,
          edge.leftThreadId,
          edge.rightThreadId,
          'exact_cosine',
          edge.score,
          asJson({ sources: Array.from(edge.sourceKinds).sort(), model: this.config.embedModel }),
          nowIso(),
        );
      }

      params.onProgress?.(`[cluster] built ${edges.length} similarity edge(s)`);

      const clusters = buildClusters(
        items.map((item) => ({ threadId: item.id, number: item.number, title: item.title })),
        edges,
      );

      const insertCluster = this.db.prepare(
        'insert into clusters (repo_id, cluster_run_id, representative_thread_id, member_count, created_at) values (?, ?, ?, ?, ?)',
      );
      const insertMember = this.db.prepare(
        'insert into cluster_members (cluster_id, thread_id, score_to_representative, created_at) values (?, ?, ?, ?)',
      );

      for (const cluster of clusters) {
        const clusterResult = insertCluster.run(
          repository.id,
          runId,
          cluster.representativeThreadId,
          cluster.members.length,
          nowIso(),
        );
        const clusterId = Number(clusterResult.lastInsertRowid);
        for (const memberId of cluster.members) {
          const key = this.edgeKey(cluster.representativeThreadId, memberId);
          const score = memberId === cluster.representativeThreadId ? null : (aggregatedEdges.get(key)?.score ?? null);
          insertMember.run(clusterId, memberId, score, nowIso());
        }
      }

      params.onProgress?.(`[cluster] persisted ${clusters.length} cluster(s)`);

      this.finishRun('cluster_runs', runId, 'completed', { edges: edges.length, clusters: clusters.length });
      return { runId, edges: edges.length, clusters: clusters.length };
    } catch (error) {
      this.finishRun('cluster_runs', runId, 'failed', null, error);
      throw error;
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
           where t.repo_id = ? and t.state = 'open' and documents_fts match ?
           order by rank
           limit ?`,
        )
        .all(repository.id, params.query, limit * 2) as Array<{ thread_id: number; rank: number }>;
      for (const row of rows) {
        keywordScores.set(row.thread_id, 1 / (1 + Math.abs(row.rank)));
      }
    }

    if (mode !== 'keyword' && this.ai) {
      const [queryEmbedding] = await this.ai.embedTexts({ model: this.config.embedModel, texts: [params.query] });
      const rows = this.loadStoredEmbeddings(repository.id);
      for (const row of rows) {
        const score = cosineSimilarity(queryEmbedding, JSON.parse(row.embedding_json) as number[]);
        if (score < 0.2) continue;
        semanticScores.set(row.id, Math.max(semanticScores.get(row.id) ?? -1, score));
      }
    }

    const candidateIds = new Set<number>([...keywordScores.keys(), ...semanticScores.keys()]);
    const threadRows = candidateIds.size
      ? (this.db
          .prepare(
            `select * from threads
             where repo_id = ? and state = 'open' and id in (${[...candidateIds].map(() => '?').join(',')})
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

    const rows = this.loadStoredEmbeddings(repository.id);
    const targetRows = rows.filter((row) => row.number === params.threadNumber);
    if (targetRows.length === 0) {
      throw new Error(
        `Thread #${params.threadNumber} for ${repository.fullName} was not found with an embedding. Run embed first.`,
      );
    }
    const targetRow = targetRows[0];
    const targetBySource = new Map<EmbeddingSourceKind, number[]>();
    for (const row of targetRows) {
      targetBySource.set(row.source_kind, JSON.parse(row.embedding_json) as number[]);
    }

    const aggregated = new Map<number, { number: number; kind: 'issue' | 'pull_request'; title: string; score: number }>();
    for (const row of rows) {
      if (row.id === targetRow.id) continue;
      const targetEmbedding = targetBySource.get(row.source_kind);
      if (!targetEmbedding) continue;
      const score = cosineSimilarity(targetEmbedding, JSON.parse(row.embedding_json) as number[]);
      if (score < minScore) continue;
      const previous = aggregated.get(row.id);
      if (!previous || score > previous.score) {
        aggregated.set(row.id, { number: row.number, kind: row.kind, title: row.title, score });
      }
    }

    const neighbors = Array.from(aggregated.entries())
      .map(([threadId, value]) => ({
        threadId,
        number: value.number,
        kind: value.kind,
        title: value.title,
        score: value.score,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return neighborsResponseSchema.parse({
      repository,
      thread: threadToDto(targetRow),
      neighbors,
    });
  }

  listClusters(params: { owner: string; repo: string }): ClustersResponse {
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
                cm.thread_id, cm.score_to_representative, t.number, t.kind, t.title
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
        thread_id: number | null;
        score_to_representative: number | null;
        number: number | null;
        kind: 'issue' | 'pull_request' | null;
        title: string | null;
      }>;

    const clusters = new Map<number, ClusterDto>();
    for (const row of rows) {
      const cluster = clusters.get(row.id) ?? {
        id: row.id,
        repoId: row.repo_id,
        representativeThreadId: row.representative_thread_id,
        memberCount: row.member_count,
        members: [],
      };
      if (row.thread_id !== null && row.number !== null && row.kind !== null && row.title !== null) {
        cluster.members.push({
          threadId: row.thread_id,
          number: row.number,
          kind: row.kind,
          title: row.title,
          scoreToRepresentative: row.score_to_representative,
        });
      }
      clusters.set(row.id, cluster);
    }

    return clustersResponseSchema.parse({
      repository,
      clusters: Array.from(clusters.values()),
    });
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
        const result = this.clusterRepository(request);
        return actionResponseSchema.parse({
          ok: true,
          action: request.action,
          runId: result.runId,
          message: `Clustered ${result.clusters} group(s) from ${result.edges} edge(s)`,
        });
      }
    }
  }

  private async fetchThreadComments(
    owner: string,
    repo: string,
    number: number,
    isPr: boolean,
    reporter?: (message: string) => void,
  ): Promise<CommentSeed[]> {
    const comments: CommentSeed[] = [];

    const issueComments = await this.github.listIssueComments(owner, repo, number, reporter);
    comments.push(
      ...issueComments.map((comment) => ({
        githubId: String(comment.id),
        commentType: 'issue_comment',
        authorLogin: userLogin(comment),
        authorType: userType(comment),
        body: String(comment.body ?? ''),
        isBot: isBotLikeAuthor({ authorLogin: userLogin(comment), authorType: userType(comment) }),
        rawJson: asJson(comment),
        createdAtGh: typeof comment.created_at === 'string' ? comment.created_at : null,
        updatedAtGh: typeof comment.updated_at === 'string' ? comment.updated_at : null,
      })),
    );

    if (isPr) {
      const reviews = await this.github.listPullReviews(owner, repo, number, reporter);
      comments.push(
        ...reviews.map((review) => ({
          githubId: String(review.id),
          commentType: 'review',
          authorLogin: userLogin(review),
          authorType: userType(review),
          body: String(review.body ?? review.state ?? ''),
          isBot: isBotLikeAuthor({ authorLogin: userLogin(review), authorType: userType(review) }),
          rawJson: asJson(review),
          createdAtGh: typeof review.submitted_at === 'string' ? review.submitted_at : null,
          updatedAtGh: typeof review.submitted_at === 'string' ? review.submitted_at : null,
        })),
      );

      const reviewComments = await this.github.listPullReviewComments(owner, repo, number, reporter);
      comments.push(
        ...reviewComments.map((comment) => ({
          githubId: String(comment.id),
          commentType: 'review_comment',
          authorLogin: userLogin(comment),
          authorType: userType(comment),
          body: String(comment.body ?? ''),
          isBot: isBotLikeAuthor({ authorLogin: userLogin(comment), authorType: userType(comment) }),
          rawJson: asJson(comment),
          createdAtGh: typeof comment.created_at === 'string' ? comment.created_at : null,
          updatedAtGh: typeof comment.updated_at === 'string' ? comment.updated_at : null,
        })),
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

  private async reconcileMissingOpenThreads(params: {
    repoId: number;
    owner: string;
    repo: string;
    crawlStartedAt: string;
    reporter?: (message: string) => void;
    onProgress?: (message: string) => void;
  }): Promise<number> {
    const staleRows = this.db
      .prepare(
        `select id, number, kind
         from threads
         where repo_id = ?
           and state = 'open'
           and (last_pulled_at is null or last_pulled_at < ?)
         order by number asc`,
      )
      .all(params.repoId, params.crawlStartedAt) as Array<{ id: number; number: number; kind: 'issue' | 'pull_request' }>;

    if (staleRows.length === 0) {
      return 0;
    }

    params.onProgress?.(
      `[sync] reconciling ${staleRows.length} previously-open thread(s) not seen in the open crawl`,
    );

    let threadsClosed = 0;
    for (const [index, row] of staleRows.entries()) {
      if (index > 0 && index % SYNC_BATCH_SIZE === 0) {
        params.onProgress?.(`[sync] stale reconciliation batch boundary reached at ${index} threads; sleeping 5s before continuing`);
        await new Promise((resolve) => setTimeout(resolve, SYNC_BATCH_DELAY_MS));
      }
      params.onProgress?.(`[sync] reconciling stale ${row.kind} #${row.number}`);
      const payload =
        row.kind === 'pull_request'
          ? await this.github.getPull(params.owner, params.repo, row.number, params.reporter)
          : await this.github.getIssue(params.owner, params.repo, row.number, params.reporter);
      const pulledAt = nowIso();
      const state = String(payload.state ?? 'open');

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
        thread_id, github_id, comment_type, author_login, author_type, body, is_bot, raw_json, created_at_gh, updated_at_gh
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((commentRows: CommentSeed[]) => {
      this.db.prepare('delete from comments where thread_id = ?').run(threadId);
      for (const comment of commentRows) {
        insert.run(
          threadId,
          comment.githubId,
          comment.commentType,
          comment.authorLogin,
          comment.authorType,
          comment.body,
          comment.isBot ? 1 : 0,
          comment.rawJson,
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
    const summaryContentHash = stableContentHash(`summary:${includeComments ? 'with-comments' : 'metadata-only'}\n${summaryInput}`);
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

  private isEmbeddingContextError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /maximum context length/i.test(message) || /requested \d+ tokens/i.test(message);
  }

  private async embedBatchWithRecovery(
    ai: AiProvider,
    batch: EmbeddingTask[],
    onProgress?: (message: string) => void,
  ): Promise<Array<{ task: EmbeddingTask; embedding: number[] }>> {
    try {
      const embeddings = await ai.embedTexts({
        model: this.config.embedModel,
        texts: batch.map((task) => task.text),
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

      const recovered: Array<{ task: EmbeddingTask; embedding: number[] }> = [];
      for (const task of batch) {
        recovered.push(await this.embedSingleTaskWithRecovery(ai, task, onProgress));
      }
      return recovered;
    }
  }

  private async embedSingleTaskWithRecovery(
    ai: AiProvider,
    task: EmbeddingTask,
    onProgress?: (message: string) => void,
  ): Promise<{ task: EmbeddingTask; embedding: number[] }> {
    let current = task;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const [embedding] = await ai.embedTexts({
          model: this.config.embedModel,
          texts: [current.text],
        });
        return { task: current, embedding };
      } catch (error) {
        if (!this.isEmbeddingContextError(error)) {
          throw error;
        }

        const next = this.shrinkEmbeddingTask(current);
        if (!next || next.text === current.text) {
          throw error;
        }
        onProgress?.(
          `[embed] shortened #${current.threadNumber}:${current.sourceKind} after context error est_tokens=${current.estimatedTokens}->${next.estimatedTokens}`,
        );
        current = next;
      }
    }

    throw new Error(`Unable to shrink embedding input for #${task.threadNumber}:${task.sourceKind} below model limits`);
  }

  private shrinkEmbeddingTask(task: EmbeddingTask): EmbeddingTask | null {
    const withoutMarker = task.text.endsWith(EMBED_TRUNCATION_MARKER)
      ? task.text.slice(0, -EMBED_TRUNCATION_MARKER.length)
      : task.text;
    if (withoutMarker.length < 256) {
      return null;
    }

    const nextLength = Math.max(256, Math.floor(withoutMarker.length * 0.5));
    const nextText = `${withoutMarker.slice(0, Math.max(0, nextLength - EMBED_TRUNCATION_MARKER.length)).trimEnd()}${EMBED_TRUNCATION_MARKER}`;
    return {
      ...task,
      text: nextText,
      contentHash: stableContentHash(`embedding:${task.sourceKind}\n${nextText}`),
      estimatedTokens: this.estimateEmbeddingTokens(nextText),
      wasTruncated: true,
    };
  }

  private chunkEmbeddingTasks(items: EmbeddingTask[], maxItems: number, maxEstimatedTokens: number): EmbeddingTask[][] {
    const chunks: EmbeddingTask[][] = [];
    let current: EmbeddingTask[] = [];
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
        `select t.id, t.repo_id, t.number, t.kind, t.state, t.title, t.body, t.author_login, t.html_url, t.labels_json,
                t.updated_at_gh, t.first_pulled_at, t.last_pulled_at, e.source_kind, e.embedding_json
         from threads t
         join document_embeddings e on e.thread_id = t.id
         where t.repo_id = ? and t.state = 'open' and e.model = ?
         order by t.number asc, e.source_kind asc`,
      )
      .all(repoId, this.config.embedModel) as StoredEmbeddingRow[];
  }

  private loadCombinedSummaryTextMap(repoId: number, threadNumber?: number): Map<number, string> {
    let sql =
      `select s.thread_id, s.summary_kind, s.summary_text
       from document_summaries s
       join threads t on t.id = s.thread_id
       where t.repo_id = ? and t.state = 'open' and s.model = ?`;
    const args: Array<number | string> = [repoId, this.config.summaryModel];
    if (threadNumber) {
      sql += ' and t.number = ?';
      args.push(threadNumber);
    }
    sql += ' order by t.number asc, s.summary_kind asc';

    const rows = this.db.prepare(sql).all(...args) as Array<{
      thread_id: number;
      summary_kind: string;
      summary_text: string;
    }>;
    const byThread = new Map<number, Map<string, string>>();
    for (const row of rows) {
      const entry = byThread.get(row.thread_id) ?? new Map<string, string>();
      entry.set(row.summary_kind, normalizeSummaryText(row.summary_text));
      byThread.set(row.thread_id, entry);
    }

    const combined = new Map<number, string>();
    const order = ['problem_summary', 'solution_summary', 'maintainer_signal_summary', 'dedupe_summary'];
    for (const [threadId, entry] of byThread.entries()) {
      const parts = order
        .map((summaryKind) => {
          const text = entry.get(summaryKind);
          return text ? `${summaryKind}: ${text}` : '';
        })
        .filter(Boolean);
      if (parts.length > 0) {
        combined.set(threadId, parts.join('\n\n'));
      }
    }
    return combined;
  }

  private edgeKey(leftThreadId: number, rightThreadId: number): string {
    const left = Math.min(leftThreadId, rightThreadId);
    const right = Math.max(leftThreadId, rightThreadId);
    return `${left}:${right}`;
  }

  private aggregateRepositoryEdges(
    rows: StoredEmbeddingRow[],
    params: { limit: number; minScore: number },
  ): Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<EmbeddingSourceKind> }> {
    const bySource = new Map<EmbeddingSourceKind, Array<{ id: number; embedding: number[] }>>();
    for (const row of rows) {
      const list = bySource.get(row.source_kind) ?? [];
      list.push({ id: row.id, embedding: JSON.parse(row.embedding_json) as number[] });
      bySource.set(row.source_kind, list);
    }

    const aggregated = new Map<string, { leftThreadId: number; rightThreadId: number; score: number; sourceKinds: Set<EmbeddingSourceKind> }>();
    for (const [sourceKind, items] of bySource.entries()) {
      for (const item of items) {
        const neighbors = rankNearestNeighbors(items, {
          targetEmbedding: item.embedding,
          limit: params.limit,
          minScore: params.minScore,
          skipId: item.id,
        });
        for (const neighbor of neighbors) {
          const key = this.edgeKey(item.id, neighbor.item.id);
          const existing = aggregated.get(key);
          if (existing) {
            existing.score = Math.max(existing.score, neighbor.score);
            existing.sourceKinds.add(sourceKind);
            continue;
          }
          aggregated.set(key, {
            leftThreadId: Math.min(item.id, neighbor.item.id),
            rightThreadId: Math.max(item.id, neighbor.item.id),
            score: neighbor.score,
            sourceKinds: new Set([sourceKind]),
          });
        }
      }
    }

    return aggregated;
  }

  private upsertSummary(threadId: number, contentHash: string, summaryKind: string, summaryText: string): void {
    this.db
      .prepare(
        `insert into document_summaries (thread_id, summary_kind, model, content_hash, summary_text, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(thread_id, summary_kind, model) do update set
           content_hash = excluded.content_hash,
           summary_text = excluded.summary_text,
           updated_at = excluded.updated_at`,
      )
      .run(threadId, summaryKind, this.config.summaryModel, contentHash, summaryText, nowIso(), nowIso());
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

  private finishRun(table: RunTable, runId: number, status: 'completed' | 'failed', stats?: unknown, error?: unknown): void {
    this.db
      .prepare(`update ${table} set status = ?, finished_at = ?, stats_json = ?, error_text = ? where id = ?`)
      .run(
        status,
        nowIso(),
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
