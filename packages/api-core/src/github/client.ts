import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from 'octokit';

export type GitHubClient = {
  checkAuth: (reporter?: GitHubReporter) => Promise<void>;
  getRepo: (owner: string, repo: string, reporter?: GitHubReporter) => Promise<Record<string, unknown>>;
  listRepositoryIssues: (
    owner: string,
    repo: string,
    since?: string,
    limit?: number,
    reporter?: GitHubReporter,
    state?: 'open' | 'closed',
  ) => Promise<Array<Record<string, unknown>>>;
  getIssue: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Record<string, unknown>>;
  getPull: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Record<string, unknown>>;
  listIssueComments: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Array<Record<string, unknown>>>;
  listPullReviews: (owner: string, repo: string, number: number, reporter?: GitHubReporter) => Promise<Array<Record<string, unknown>>>;
  listPullReviewComments: (
    owner: string,
    repo: string,
    number: number,
    reporter?: GitHubReporter,
  ) => Promise<Array<Record<string, unknown>>>;
  getUser?: (login: string, reporter?: GitHubReporter) => Promise<Record<string, unknown>>;
  listUserPublicEvents?: (login: string, reporter?: GitHubReporter) => Promise<Array<Record<string, unknown>>>;
};

export type GitHubReporter = (message: string) => void;

export class GitHubRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHubRequestError';
    this.status = status;
  }
}

type RequestOptions = {
  token: string;
  userAgent?: string;
  timeoutMs?: number;
  pageDelayMs?: number;
};

type OctokitPage<T> = {
  data: T[];
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function formatResetTime(resetSeconds: string | null | undefined): string | null {
  if (!resetSeconds) return null;
  const value = Number(resetSeconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

export function makeGitHubClient(options: RequestOptions): GitHubClient {
  const userAgent = options.userAgent ?? 'ghcrawl';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pageDelayMs = options.pageDelayMs ?? 5000;
  const BaseOctokit = Octokit.plugin(retry, throttling);

  function createOctokit(reporter?: GitHubReporter) {
    return new BaseOctokit({
      auth: options.token,
      request: {
        timeout: timeoutMs,
      },
      userAgent,
      retry: {
        doNotRetry: [400, 401, 403, 404, 422],
        retries: 4,
      },
      throttle: {
        fallbackSecondaryRateRetryAfter: Math.ceil(pageDelayMs / 1000),
        onRateLimit: (retryAfter, requestOptions) => {
          const responseHeaders = (requestOptions.response as { headers?: Record<string, string> } | undefined)?.headers;
          const resetAt = formatResetTime(responseHeaders?.['x-ratelimit-reset']);
          const remaining = responseHeaders?.['x-ratelimit-remaining'];
          const method = requestOptions.method ?? 'GET';
          const url = requestOptions.url ?? 'unknown';
          reporter?.(
            `[github] backoff rate-limited wait=${formatDuration(retryAfter * 1000)}${remaining ? ` remaining=${remaining}` : ''}${resetAt ? ` reset_at=${resetAt}` : ''} method=${method} url=${url}`,
          );
          return true;
        },
        onSecondaryRateLimit: (retryAfter, requestOptions) => {
          const method = requestOptions.method ?? 'GET';
          const url = requestOptions.url ?? 'unknown';
          reporter?.(
            `[github] backoff secondary-rate-limit wait=${formatDuration(retryAfter * 1000)} method=${method} url=${url}`,
          );
          return true;
        },
      },
    });
  }

  async function request<T>(label: string, reporter: GitHubReporter | undefined, fn: (octokit: InstanceType<typeof BaseOctokit>) => Promise<T>): Promise<T> {
    reporter?.(`[github] request ${label}`);
    const octokit = createOctokit(reporter);
    try {
      return await fn(octokit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = typeof (error as { status?: unknown })?.status === 'number' ? Number((error as { status?: unknown }).status) : undefined;
      throw new GitHubRequestError(`GitHub request failed for ${label}: ${message}`, status);
    }
  }

  async function paginate<T>(
    label: string,
    limit: number | undefined,
    reporter: GitHubReporter | undefined,
    iteratorFactory: (octokit: InstanceType<typeof BaseOctokit>) => AsyncIterable<OctokitPage<T>>,
  ): Promise<T[]> {
    reporter?.(`[github] request ${label}`);
    const octokit = createOctokit(reporter);
    const out: T[] = [];

    try {
      let pageIndex = 0;
      for await (const page of iteratorFactory(octokit)) {
        pageIndex += 1;
        const remaining = typeof limit === 'number' ? Math.max(limit - out.length, 0) : page.data.length;
        out.push(...page.data.slice(0, remaining));
        reporter?.(`[github] page ${pageIndex} fetched count=${page.data.length} accumulated=${out.length}`);
        if (typeof limit === 'number' && out.length >= limit) {
          break;
        }
        await delay(pageDelayMs);
      }
      return out;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = typeof (error as { status?: unknown })?.status === 'number' ? Number((error as { status?: unknown }).status) : undefined;
      throw new GitHubRequestError(`GitHub pagination failed for ${label}: ${message}`, status);
    }
  }

  return {
    async checkAuth(reporter) {
      await request('GET /rate_limit', reporter, async (octokit) => {
        await octokit.request('GET /rate_limit');
      });
    },
    async getRepo(owner, repo, reporter) {
      return request(`GET /repos/${owner}/${repo}`, reporter, async (octokit) => {
        const response = await octokit.rest.repos.get({ owner, repo });
        return response.data as Record<string, unknown>;
      });
    },
    async listRepositoryIssues(owner, repo, since, limit, reporter, state = 'open') {
      return paginate(
        `GET /repos/${owner}/${repo}/issues state=${state} per_page=100`,
        limit,
        reporter,
        (octokit) =>
          octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
            owner,
            repo,
            state,
            sort: 'updated',
            direction: 'desc',
            per_page: 100,
            since,
          }) as AsyncIterable<OctokitPage<Record<string, unknown>>>,
      );
    },
    async getIssue(owner, repo, number, reporter) {
      return request(`GET /repos/${owner}/${repo}/issues/${number}`, reporter, async (octokit) => {
        const response = await octokit.rest.issues.get({ owner, repo, issue_number: number });
        return response.data as Record<string, unknown>;
      });
    },
    async getPull(owner, repo, number, reporter) {
      return request(`GET /repos/${owner}/${repo}/pulls/${number}`, reporter, async (octokit) => {
        const response = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
        return response.data as Record<string, unknown>;
      });
    },
    async listIssueComments(owner, repo, number, reporter) {
      return paginate(
        `GET /repos/${owner}/${repo}/issues/${number}/comments per_page=100`,
        undefined,
        reporter,
        (octokit) =>
          octokit.paginate.iterator(octokit.rest.issues.listComments, {
            owner,
            repo,
            issue_number: number,
            per_page: 100,
          }) as AsyncIterable<OctokitPage<Record<string, unknown>>>,
      );
    },
    async listPullReviews(owner, repo, number, reporter) {
      return paginate(
        `GET /repos/${owner}/${repo}/pulls/${number}/reviews per_page=100`,
        undefined,
        reporter,
        (octokit) =>
          octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          }) as AsyncIterable<OctokitPage<Record<string, unknown>>>,
      );
    },
    async listPullReviewComments(owner, repo, number, reporter) {
      return paginate(
        `GET /repos/${owner}/${repo}/pulls/${number}/comments per_page=100`,
        undefined,
        reporter,
        (octokit) =>
          octokit.paginate.iterator(octokit.rest.pulls.listReviewComments, {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
          }) as AsyncIterable<OctokitPage<Record<string, unknown>>>,
      );
    },
    async getUser(login, reporter) {
      return request(`GET /users/${login}`, reporter, async (octokit) => {
        const response = await octokit.rest.users.getByUsername({ username: login });
        return response.data as Record<string, unknown>;
      });
    },
    async listUserPublicEvents(login, reporter) {
      return paginate(
        `GET /users/${login}/events/public per_page=100`,
        100,
        reporter,
        (octokit) =>
          octokit.paginate.iterator(octokit.rest.activity.listPublicEventsForUser, {
            username: login,
            per_page: 100,
          }) as AsyncIterable<OctokitPage<Record<string, unknown>>>,
      );
    },
  };
}
