import http from 'node:http';

import { actionRequestSchema, closeClusterRequestSchema, closeThreadRequestSchema, refreshRequestSchema } from '@ghcrawl/api-contract';
import { ZodError } from 'zod';

import { GHCrawlService, parseRepoParams } from '../service.js';

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function createApiServer(service: GHCrawlService): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        sendJson(res, 400, { error: 'Missing request metadata' });
        return;
      }

      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, service.init());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/repositories') {
        sendJson(res, 200, service.listRepositories());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/threads') {
        const params = parseRepoParams(url);
        const kindParam = url.searchParams.get('kind');
        const kind = kindParam === 'issue' || kindParam === 'pull_request' ? kindParam : undefined;
        const numbersValue = url.searchParams.get('numbers');
        const numbers =
          numbersValue && numbersValue.trim().length > 0
            ? numbersValue
                .split(',')
                .map((value) => Number(value.trim()))
                .filter((value) => Number.isSafeInteger(value) && value > 0)
            : undefined;
        const includeClosed = url.searchParams.get('includeClosed') === 'true';
        sendJson(res, 200, service.listThreads({ ...params, kind, numbers, includeClosed }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/author-threads') {
        const params = parseRepoParams(url);
        const login = (url.searchParams.get('login') ?? '').trim();
        if (!login) {
          sendJson(res, 400, { error: 'Missing login parameter' });
          return;
        }
        const includeClosed = url.searchParams.get('includeClosed') === 'true';
        sendJson(res, 200, service.listAuthorThreads({ ...params, login, includeClosed }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/search') {
        const params = parseRepoParams(url);
        const query = url.searchParams.get('query');
        if (!query) {
          sendJson(res, 400, { error: 'Missing query parameter' });
          return;
        }
        const modeParam = url.searchParams.get('mode');
        const mode = modeParam === 'keyword' || modeParam === 'semantic' || modeParam === 'hybrid' ? modeParam : undefined;
        sendJson(res, 200, await service.searchRepository({ ...params, query, mode }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/neighbors') {
        const params = parseRepoParams(url);
        const numberValue = url.searchParams.get('number');
        if (!numberValue) {
          sendJson(res, 400, { error: 'Missing number parameter' });
          return;
        }
        const threadNumber = Number(numberValue);
        if (!Number.isInteger(threadNumber) || threadNumber <= 0) {
          sendJson(res, 400, { error: 'Invalid number parameter' });
          return;
        }
        const limitValue = url.searchParams.get('limit');
        const minScoreValue = url.searchParams.get('minScore');
        sendJson(
          res,
          200,
          service.listNeighbors({
            ...params,
            threadNumber,
            limit: limitValue ? Number(limitValue) : undefined,
            minScore: minScoreValue ? Number(minScoreValue) : undefined,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/clusters') {
        const params = parseRepoParams(url);
        const includeClosed = url.searchParams.get('includeClosed') === 'true';
        sendJson(res, 200, service.listClusters({ ...params, includeClosed }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/cluster-summaries') {
        const params = parseRepoParams(url);
        const sortParam = url.searchParams.get('sort');
        const sort = sortParam === 'recent' || sortParam === 'size' ? sortParam : undefined;
        const minSizeValue = url.searchParams.get('minSize');
        const limitValue = url.searchParams.get('limit');
        const search = url.searchParams.get('search') ?? undefined;
        const includeClosed = url.searchParams.get('includeClosed') === 'true';
        sendJson(
          res,
          200,
          service.listClusterSummaries({
            ...params,
            minSize: minSizeValue ? Number(minSizeValue) : undefined,
            limit: limitValue ? Number(limitValue) : undefined,
            sort,
            search,
            includeClosed,
          }),
        );
        return;
      }

      if (req.method === 'GET' && url.pathname === '/cluster-detail') {
        const params = parseRepoParams(url);
        const clusterIdValue = url.searchParams.get('clusterId');
        if (!clusterIdValue) {
          sendJson(res, 400, { error: 'Missing clusterId parameter' });
          return;
        }
        const clusterId = Number(clusterIdValue);
        if (!Number.isInteger(clusterId) || clusterId <= 0) {
          sendJson(res, 400, { error: 'Invalid clusterId parameter' });
          return;
        }
        const memberLimitValue = url.searchParams.get('memberLimit');
        const bodyCharsValue = url.searchParams.get('bodyChars');
        const includeClosed = url.searchParams.get('includeClosed') === 'true';
        sendJson(
          res,
          200,
          service.getClusterDetailDump({
            ...params,
            clusterId,
            memberLimit: memberLimitValue ? Number(memberLimitValue) : undefined,
            bodyChars: bodyCharsValue ? Number(bodyCharsValue) : undefined,
            includeClosed,
          }),
        );
        return;
      }

      if (req.method === 'POST' && url.pathname === '/actions/rerun') {
        const body = actionRequestSchema.parse(await readBody(req));
        sendJson(res, 200, await service.rerunAction(body));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/actions/refresh') {
        const body = refreshRequestSchema.parse(await readBody(req));
        sendJson(res, 200, await service.refreshRepository(body));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/actions/close-thread') {
        const body = closeThreadRequestSchema.parse(await readBody(req));
        sendJson(res, 200, service.closeThreadLocally(body));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/actions/close-cluster') {
        const body = closeClusterRequestSchema.parse(await readBody(req));
        sendJson(res, 200, service.closeClusterLocally(body));
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, isBadRequestError(error, message) ? 400 : 500, { error: message });
    }
  });
}

function isBadRequestError(error: unknown, message: string): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof ZodError ||
    message.startsWith('Missing ') ||
    message.startsWith('Invalid ')
  );
}
