#!/usr/bin/env node
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createApiServer, GHCrawlService } from '@ghcrawl/api-core';
import { runInitWizard } from './init-wizard.js';
import { startTui } from './tui/app.js';

type CommandName =
  | 'init'
  | 'doctor'
  | 'version'
  | 'sync'
  | 'refresh'
  | 'summarize'
  | 'purge-comments'
  | 'embed'
  | 'cluster'
  | 'clusters'
  | 'cluster-detail'
  | 'search'
  | 'neighbors'
  | 'tui'
  | 'serve';

type DoctorResult = Awaited<ReturnType<GHCrawlService['doctor']>>;
type DoctorReport = DoctorResult & { version: string };
const CLI_VERSION = loadCliVersion();

function usage(devMode = false): string {
  const lines = [
    'ghcrawl <command> [options]',
    '',
    'Commands:',
    '  init [--reconfigure]',
    '  doctor',
    '  version',
    '  sync <owner/repo> [--since <iso|duration>] [--limit <count>] [--include-comments] [--full-reconcile]',
    '  refresh <owner/repo> [--no-sync] [--no-embed] [--no-cluster]',
    '  embed <owner/repo> [--number <thread>]',
    '  cluster <owner/repo> [--k <count>] [--threshold <score>]',
    '  clusters <owner/repo> [--min-size <count>] [--limit <count>] [--sort recent|size] [--search <text>]',
    '  cluster-detail <owner/repo> --id <cluster-id> [--member-limit <count>] [--body-chars <count>]',
    '  search <owner/repo> --query <text> [--mode keyword|semantic|hybrid]',
    '  neighbors <owner/repo> --number <thread> [--limit <count>] [--threshold <score>]',
    '  tui [owner/repo]',
    '  serve',
  ];
  if (devMode) {
    lines.push('', 'Advanced Commands:', '  summarize <owner/repo> [--number <thread>] [--include-comments]', '  purge-comments <owner/repo> [--number <thread>]');
  }
  return `${lines.join('\n')}\n`;
}

function parseGlobalFlags(argv: string[], env: NodeJS.ProcessEnv = process.env): { argv: string[]; devMode: boolean } {
  let devMode = env.GHCRAWL_DEV_MODE === '1' || env.GHCRAWL_DEV_MODE === '1';
  const filtered: string[] = [];
  for (const arg of argv) {
    if (arg === '--dev') {
      devMode = true;
      continue;
    }
    filtered.push(arg);
  }
  return { argv: filtered, devMode };
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
      'full-reconcile': { type: 'boolean' },
      number: { type: 'string' },
      query: { type: 'string' },
      mode: { type: 'string' },
      k: { type: 'string' },
      threshold: { type: 'string' },
      port: { type: 'string' },
      id: { type: 'string' },
      sort: { type: 'string' },
      search: { type: 'string' },
      'min-size': { type: 'string' },
      'member-limit': { type: 'string' },
      'body-chars': { type: 'string' },
      'no-sync': { type: 'boolean' },
      'no-embed': { type: 'boolean' },
      'no-cluster': { type: 'boolean' },
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

export function resolveSinceValue(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  const absolute = new Date(trimmed);
  if (!Number.isNaN(absolute.getTime())) {
    return absolute.toISOString();
  }

  const match = trimmed.match(/^(\d+)(s|m|h|d|w|mo|y)$/i);
  if (!match) {
    throw new Error(`Invalid --since value: ${value}. Use an ISO timestamp or duration like 15m, 2h, 7d, or 1mo.`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const resolved = new Date(now);

  switch (unit) {
    case 's':
      resolved.setTime(resolved.getTime() - amount * 1000);
      break;
    case 'm':
      resolved.setTime(resolved.getTime() - amount * 60 * 1000);
      break;
    case 'h':
      resolved.setTime(resolved.getTime() - amount * 60 * 60 * 1000);
      break;
    case 'd':
      resolved.setTime(resolved.getTime() - amount * 24 * 60 * 60 * 1000);
      break;
    case 'w':
      resolved.setTime(resolved.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
      break;
    case 'mo':
      resolved.setUTCMonth(resolved.getUTCMonth() - amount);
      break;
    case 'y':
      resolved.setUTCFullYear(resolved.getUTCFullYear() - amount);
      break;
    default:
      throw new Error(`Unsupported --since unit: ${unit}`);
  }

  return resolved.toISOString();
}

export function formatLogLine(message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] ${message}`;
}

function writeProgress(message: string): void {
  process.stderr.write(`${formatLogLine(message)}\n`);
}

function formatBooleanStatus(value: boolean): string {
  return value ? 'yes' : 'no';
}

function parsePositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export function formatDoctorReport(result: DoctorReport): string {
  const lines = [
    'ghcrawl doctor',
    `version: ${result.version}`,
    '',
    'Health',
    `  ok: ${formatBooleanStatus(result.health.ok)}`,
    `  config path: ${result.health.configPath}`,
    `  config file exists: ${formatBooleanStatus(result.health.configFileExists)}`,
    `  db path: ${result.health.dbPath}`,
    `  api port: ${result.health.apiPort}`,
    '',
    'GitHub',
    `  configured: ${formatBooleanStatus(result.github.configured)}`,
    `  source: ${result.github.source}`,
    `  format ok: ${formatBooleanStatus(result.github.formatOk)}`,
    `  auth ok: ${formatBooleanStatus(result.github.authOk)}`,
  ];
  if (result.github.error) {
    lines.push(`  note: ${result.github.error}`);
  }
  lines.push(
    '',
    'OpenAI',
    `  configured: ${formatBooleanStatus(result.openai.configured)}`,
    `  source: ${result.openai.source}`,
    `  format ok: ${formatBooleanStatus(result.openai.formatOk)}`,
    `  auth ok: ${formatBooleanStatus(result.openai.authOk)}`,
  );
  if (result.openai.error) {
    lines.push(`  note: ${result.openai.error}`);
  }
  return `${lines.join('\n')}\n`;
}

function closeService(service: GHCrawlService | null): void {
  if (service) {
    service.close();
  }
}

export async function run(argv: string[], stdout: NodeJS.WritableStream = process.stdout): Promise<void> {
  const parsedGlobals = parseGlobalFlags(argv);
  const [commandRaw, ...rest] = parsedGlobals.argv;
  const command = commandRaw as CommandName | undefined;
  if (commandRaw === '--version' || commandRaw === '-v') {
    stdout.write(`${CLI_VERSION}\n`);
    return;
  }
  if (!command || commandRaw === '--help' || commandRaw === '-h' || commandRaw === 'help') {
    stdout.write(usage(parsedGlobals.devMode));
    return;
  }

  let service: GHCrawlService | null = null;
  const getService = (): GHCrawlService => {
    service ??= new GHCrawlService();
    return service;
  };
  try {
    switch (command) {
      case 'init': {
        const parsed = parseArgs({
          args: rest,
          options: {
            reconfigure: { type: 'boolean' },
          },
        });
        await runInitWizard({ reconfigure: parsed.values.reconfigure === true });
        stdout.write(`${JSON.stringify(getService().init(), null, 2)}\n`);
        return;
      }
      case 'doctor': {
        const parsed = parseArgs({
          args: rest,
          options: {
            json: { type: 'boolean' },
          },
        });
        const result: DoctorReport = {
          version: CLI_VERSION,
          ...(await getService().doctor()),
        };
        const shouldWriteJson = parsed.values.json === true || (stdout as NodeJS.WriteStream).isTTY !== true;
        stdout.write(shouldWriteJson ? `${JSON.stringify(result, null, 2)}\n` : formatDoctorReport(result));
        return;
      }
      case 'version': {
        stdout.write(`${CLI_VERSION}\n`);
        return;
      }
      case 'sync': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await getService().syncRepository({
          owner,
          repo,
          since: typeof values.since === 'string' ? resolveSinceValue(values.since) : undefined,
          limit: typeof values.limit === 'string' ? Number(values.limit) : undefined,
          includeComments: values['include-comments'] === true,
          fullReconcile: values['full-reconcile'] === true,
          onProgress: writeProgress,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'refresh': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await getService().refreshRepository({
          owner,
          repo,
          sync: values['no-sync'] === true ? false : undefined,
          embed: values['no-embed'] === true ? false : undefined,
          cluster: values['no-cluster'] === true ? false : undefined,
          onProgress: writeProgress,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'summarize': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await getService().summarizeRepository({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? Number(values.number) : undefined,
          includeComments: values['include-comments'] === true,
          onProgress: writeProgress,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'purge-comments': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = getService().purgeComments({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? Number(values.number) : undefined,
          onProgress: writeProgress,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'embed': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = await getService().embedRepository({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? Number(values.number) : undefined,
          onProgress: writeProgress,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'cluster': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const result = getService().clusterRepository({
          owner,
          repo,
          k: typeof values.k === 'string' ? Number(values.k) : undefined,
          minScore: typeof values.threshold === 'string' ? Number(values.threshold) : undefined,
          onProgress: writeProgress,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'clusters': {
        const { owner, repo, values } = parseRepoFlags(rest);
        const sort = values.sort === 'recent' || values.sort === 'size' ? values.sort : undefined;
        const result = getService().listClusterSummaries({
          owner,
          repo,
          minSize: typeof values['min-size'] === 'string' ? parsePositiveInteger('min-size', values['min-size']) : undefined,
          limit: typeof values.limit === 'string' ? parsePositiveInteger('limit', values.limit) : undefined,
          sort,
          search: typeof values.search === 'string' ? values.search : undefined,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'cluster-detail': {
        const { owner, repo, values } = parseRepoFlags(rest);
        if (typeof values.id !== 'string') {
          throw new Error('Missing --id');
        }
        const result = getService().getClusterDetailDump({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id),
          memberLimit:
            typeof values['member-limit'] === 'string'
              ? parsePositiveInteger('member-limit', values['member-limit'])
              : undefined,
          bodyChars:
            typeof values['body-chars'] === 'string'
              ? parsePositiveInteger('body-chars', values['body-chars'])
              : undefined,
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
        const result = await getService().searchRepository({
          owner,
          repo,
          query: values.query,
          mode,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'neighbors': {
        const { owner, repo, values } = parseRepoFlags(rest);
        if (typeof values.number !== 'string') {
          throw new Error('Missing --number');
        }
        const result = getService().listNeighbors({
          owner,
          repo,
          threadNumber: Number(values.number),
          limit: typeof values.limit === 'string' ? Number(values.limit) : undefined,
          minScore: typeof values.threshold === 'string' ? Number(values.threshold) : undefined,
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'tui': {
        if (rest.length === 0) {
          await startTui({ service: getService() });
          return;
        }
        const { owner, repo } = parseRepoFlags(rest);
        await startTui({ service: getService(), owner, repo });
        return;
      }
      case 'serve': {
        const serviceForServe = getService();
        const server = createApiServer(serviceForServe);
        const parsed = parseArgs({
          args: rest,
          options: { port: { type: 'string' } },
        });
        const port = typeof parsed.values.port === 'string' ? Number(parsed.values.port) : serviceForServe.config.apiPort;
        server.listen(port, '127.0.0.1');
        stdout.write(`ghcrawl API listening on http://127.0.0.1:${port}\n`);
        const stop = async () => {
          server.close();
          serviceForServe.close();
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
      closeService(service);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((error) => {
    writeProgress(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

function loadCliVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(here, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
}
