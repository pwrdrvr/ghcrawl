import http from 'node:http';
import crypto from 'node:crypto';

import {
  actionResponseSchema,
  clustersResponseSchema,
  healthResponseSchema,
  repositoriesResponseSchema,
  searchResponseSchema,
  threadsResponseSchema,
  type ActionRequest,
  type ActionResponse,
  type ClusterDto,
  type ClustersResponse,
  type HealthResponse,
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
import { rankNearestNeighbors } from './search/exact.js';

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

const SYNC_BATCH_SIZE = 100;
const SYNC_BATCH_DELAY_MS = 5000;

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

  async summarizeRepository(params: { owner: string; repo: string; threadNumber?: number }): Promise<{ runId: number; summarized: number }> {
    const ai = this.requireAi();
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = this.startRun('summary_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);

    try {
      let sql =
        `select t.id, t.content_hash, d.raw_text, d.dedupe_text
         from threads t
         join documents d on d.thread_id = t.id
         where t.repo_id = ? and t.state = 'open'`;
      const args: Array<number> = [repository.id];
      if (params.threadNumber) {
        sql += ' and t.number = ?';
        args.push(params.threadNumber);
      }
      sql += ' order by t.number asc';

      const rows = this.db.prepare(sql).all(...args) as Array<{
        id: number;
        content_hash: string;
        raw_text: string;
        dedupe_text: string;
      }>;

      let summarized = 0;
      for (const row of rows) {
        const latest = this.db
          .prepare(
            'select content_hash from document_summaries where thread_id = ? and summary_kind = ? and model = ? limit 1',
          )
          .get(row.id, 'dedupe_summary', this.config.summaryModel) as { content_hash: string } | undefined;
        if (latest?.content_hash === row.content_hash) continue;

        const summary = await ai.summarizeThread({
          model: this.config.summaryModel,
          text: `${row.raw_text}\n\n---\n\nDedupe focus:\n${row.dedupe_text}`,
        });

        this.upsertSummary(row.id, row.content_hash, 'problem_summary', summary.problemSummary);
        this.upsertSummary(row.id, row.content_hash, 'solution_summary', summary.solutionSummary);
        this.upsertSummary(row.id, row.content_hash, 'maintainer_signal_summary', summary.maintainerSignalSummary);
        this.upsertSummary(row.id, row.content_hash, 'dedupe_summary', summary.dedupeSummary);
        summarized += 1;
      }

      this.finishRun('summary_runs', runId, 'completed', { summarized });
      return { runId, summarized };
    } catch (error) {
      this.finishRun('summary_runs', runId, 'failed', null, error);
      throw error;
    }
  }

  async embedRepository(params: { owner: string; repo: string; threadNumber?: number }): Promise<{ runId: number; embedded: number }> {
    const ai = this.requireAi();
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = this.startRun('embedding_runs', repository.id, params.threadNumber ? `thread:${params.threadNumber}` : repository.fullName);

    try {
      let sql =
        `select t.id, s.summary_text, s.content_hash
         from threads t
         join document_summaries s on s.thread_id = t.id
         where t.repo_id = ? and t.state = 'open' and s.summary_kind = ? and s.model = ?`;
      const args: Array<string | number> = [repository.id, 'dedupe_summary', this.config.summaryModel];
      if (params.threadNumber) {
        sql += ' and t.number = ?';
        args.push(params.threadNumber);
      }
      sql += ' order by t.number asc';
      const rows = this.db.prepare(sql).all(...args) as Array<{ id: number; summary_text: string; content_hash: string }>;

      const pending = rows.filter((row) => {
        const latest = this.db
          .prepare('select content_hash from document_embeddings where thread_id = ? and source_kind = ? and model = ?')
          .get(row.id, 'dedupe_summary', this.config.embedModel) as { content_hash: string } | undefined;
        return latest?.content_hash !== row.content_hash;
      });

      let embedded = 0;
      for (let index = 0; index < pending.length; index += 32) {
        const batch = pending.slice(index, index + 32);
        const embeddings = await ai.embedTexts({
          model: this.config.embedModel,
          texts: batch.map((row) => row.summary_text),
        });
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          this.upsertEmbedding(batch[batchIndex].id, batch[batchIndex].content_hash, embeddings[batchIndex]);
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

  clusterRepository(params: { owner: string; repo: string; minScore?: number; k?: number }): { runId: number; edges: number; clusters: number } {
    const repository = this.requireRepository(params.owner, params.repo);
    const runId = this.startRun('cluster_runs', repository.id, repository.fullName);
    const minScore = params.minScore ?? 0.82;
    const k = params.k ?? 6;

    try {
      const rows = this.db
        .prepare(
          `select t.id, t.number, t.title, e.embedding_json
           from threads t
           join document_embeddings e on e.thread_id = t.id
           where t.repo_id = ? and t.state = 'open' and e.source_kind = ? and e.model = ?
           order by t.number asc`,
        )
        .all(repository.id, 'dedupe_summary', this.config.embedModel) as Array<{
          id: number;
          number: number;
          title: string;
          embedding_json: string;
        }>;

      const items = rows.map((row) => ({
        id: row.id,
        number: row.number,
        title: row.title,
        embedding: JSON.parse(row.embedding_json) as number[],
      }));

      this.db.prepare('delete from cluster_members where cluster_id in (select id from clusters where cluster_run_id = ?)').run(runId);
      this.db.prepare('delete from clusters where cluster_run_id = ?').run(runId);
      this.db.prepare('delete from similarity_edges where cluster_run_id = ?').run(runId);

      const pairSeen = new Set<string>();
      const edges: Array<{ leftThreadId: number; rightThreadId: number; score: number }> = [];
      const insertEdge = this.db.prepare(
        `insert into similarity_edges (repo_id, cluster_run_id, left_thread_id, right_thread_id, method, score, explanation_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const item of items) {
        const neighbors = rankNearestNeighbors(items, {
          targetEmbedding: item.embedding,
          limit: k,
          minScore,
          skipId: item.id,
        });
        for (const neighbor of neighbors) {
          const left = Math.min(item.id, neighbor.item.id);
          const right = Math.max(item.id, neighbor.item.id);
          const key = `${left}:${right}`;
          if (pairSeen.has(key)) continue;
          pairSeen.add(key);
          edges.push({ leftThreadId: left, rightThreadId: right, score: neighbor.score });
          insertEdge.run(
            repository.id,
            runId,
            left,
            right,
            'exact_cosine',
            neighbor.score,
            asJson({ source: 'dedupe_summary', model: this.config.embedModel }),
            nowIso(),
          );
        }
      }

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
        const representative = items.find((item) => item.id === cluster.representativeThreadId);
        for (const memberId of cluster.members) {
          const member = items.find((item) => item.id === memberId);
          const score =
            representative && member && representative.id !== member.id
              ? rankNearestNeighbors([member], {
                  targetEmbedding: representative.embedding,
                  limit: 1,
                  skipId: representative.id,
                })[0]?.score ?? null
              : null;
          insertMember.run(clusterId, memberId, score, nowIso());
        }
      }

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
      const rows = this.db
        .prepare(
          `select t.id, t.number, t.title, e.embedding_json
           from threads t
           join document_embeddings e on e.thread_id = t.id
           where t.repo_id = ? and t.state = 'open' and e.source_kind = ? and e.model = ?`,
        )
        .all(repository.id, 'dedupe_summary', this.config.embedModel) as Array<{
          id: number;
          number: number;
          title: string;
          embedding_json: string;
        }>;
      const ranked = rankNearestNeighbors(
        rows.map((row) => ({ id: row.id, embedding: JSON.parse(row.embedding_json) as number[] })),
        { targetEmbedding: queryEmbedding, limit: limit * 2, minScore: 0.2 },
      );
      for (const row of ranked) {
        semanticScores.set(row.item.id, row.score);
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
          message: `Embedded ${result.embedded} thread(s)`,
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

  private upsertEmbedding(threadId: number, contentHash: string, embedding: number[]): void {
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
        'dedupe_summary',
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
