#!/usr/bin/env node
import { once } from 'node:events';
import { parseArgs } from 'node:util';

import { createApiServer, GitcrawlService } from '@gitcrawl/api-core';

type CommandName = 'init' | 'doctor' | 'sync' | 'summarize' | 'embed' | 'cluster' | 'search' | 'serve';

function usage(): string {
  return `gitcrawl <command> [options]

Commands:
  init
  doctor
  sync <owner/repo> [--since <iso>] [--limit <count>] [--include-comments]
  summarize <owner/repo> [--number <thread>]
  embed <owner/repo> [--number <thread>]
  cluster <owner/repo> [--k <count>] [--threshold <score>]
  search <owner/repo> --query <text> [--mode keyword|semantic|hybrid]
  serve
`;
}

export function parseOwnerRepo(value: string): { owner: string; repo: string } {
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Expected owner/repo, received: ${value}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function parseRepoFlags(args: string[]): { owner: string; repo: string; values: Record<string, string | boolean> } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      'include-comments': { type: 'boolean' },
      number: { type: 'string' },
      query: { type: 'string' },
      mode: { type: 'string' },
      k: { type: 'string' },
      threshold: { type: 'string' },
      port: { type: 'string' },
    },
  });

  if (typeof parsed.values.repo === 'string' && parsed.values.repo.includes('/')) {
    const target = parseOwnerRepo(parsed.values.repo);
    return { ...target, values: parsed.values };
  }

  if (parsed.positionals.length > 0) {
    const target = parseOwnerRepo(parsed.positionals[0]);
    return { ...target, values: parsed.values };
  }

  const owner = parsed.values.owner;
  const repo = parsed.values.repo;
  if (typeof owner === 'string' && typeof repo === 'string') {
    return { owner, repo, values: parsed.values };
  }

  throw new Error('Use --repo owner/repo or provide owner/repo as the first positional argument');
}

export async function run(argv: string[], stdout: NodeJS.WritableStream = process.stdout): Promise<void> {
  const [commandRaw, ...rest] = argv;
  const command = commandRaw as CommandName | undefined;
  if (!command) {
    stdout.write(usage());
    return;
  }

  const service = new GitcrawlService();
  try {
    switch (command) {
      case 'init': {
        stdout.write(`${JSON.stringify(service.init(), null, 2)}\n`);
        return;
      }
      case 'doctor': {
        stdout.write(`${JSON.stringify(await service.doctor(), null, 2)}\n`);
        return;
      }
      case 'sync': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await service.syncRepository({
          owner,
          repo,
          since: typeof values.since === 'string' ? values.since : undefined,
          limit: typeof values.limit === 'string' ? Number(values.limit) : undefined,
          includeComments: values['include-comments'] === true,
          onProgress: (message) => {
            process.stderr.write(`${message}\n`);
          },
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'summarize': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await service.summarizeRepository({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? Number(values.number) : undefined,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'embed': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await service.embedRepository({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? Number(values.number) : undefined,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'cluster': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = service.clusterRepository({
          owner,
          repo,
          k: typeof values.k === 'string' ? Number(values.k) : undefined,
          minScore: typeof values.threshold === 'string' ? Number(values.threshold) : undefined,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'search': {
        const { owner, repo, values } = parseRepoFlags(rest);
        if (typeof values.query !== 'string') {
          throw new Error('Missing --query');
        }
        const mode =
          values.mode === 'keyword' || values.mode === 'semantic' || values.mode === 'hybrid'
            ? values.mode
            : undefined;
        const result = await service.searchRepository({
          owner,
          repo,
          query: values.query,
          mode,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'serve': {
        const server = createApiServer(service);
        const parsed = parseArgs({
          args: rest,
          options: { port: { type: 'string' } },
        });
        const port = typeof parsed.values.port === 'string' ? Number(parsed.values.port) : service.config.apiPort;
        server.listen(port, '127.0.0.1');
        stdout.write(`gitcrawl API listening on http://127.0.0.1:${port}\n`);
        const stop = async () => {
          server.close();
          service.close();
        };
        process.once('SIGINT', () => void stop());
        process.once('SIGTERM', () => void stop());
        await once(server, 'close');
        return;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    if (command !== 'serve') {
      service.close();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
