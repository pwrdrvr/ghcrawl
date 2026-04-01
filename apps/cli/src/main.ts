#!/usr/bin/env node
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createApiServer, GHCrawlService, loadConfig, type LoadConfigOptions } from '@ghcrawl/api-core';
import { createHeapDiagnostics, type HeapDiagnostics } from './heap-diagnostics.js';
import { runInitWizard } from './init-wizard.js';
import { startTui } from './tui/app.js';

type CommandName =
  | 'init'
  | 'doctor'
  | 'version'
  | 'sync'
  | 'refresh'
  | 'threads'
  | 'author'
  | 'close-thread'
  | 'close-cluster'
  | 'summarize'
  | 'purge-comments'
  | 'embed'
  | 'cluster'
  | 'cluster-experiment'
  | 'clusters'
  | 'cluster-detail'
  | 'search'
  | 'neighbors'
  | 'tui'
  | 'serve';

type CommandSpec = {
  name: CommandName;
  synopsis: string;
  description: string;
  options: string[];
  examples: string[];
  devOnly?: boolean;
  agentJson?: boolean;
};

type DoctorResult = Awaited<ReturnType<GHCrawlService['doctor']>>;
type DoctorReport = DoctorResult & { version: string };

type ParsedGlobalFlags = {
  argv: string[];
  devMode: boolean;
  configPathOverride?: string;
  workspaceRootOverride?: string;
};

type RunContext = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

type RepoCommandValues = Record<string, string | boolean>;
type ParsedRepoFlags = { owner: string; repo: string; values: RepoCommandValues };

const CLI_VERSION = loadCliVersion();

const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    name: 'init',
    synopsis: 'init [--reconfigure]',
    description: 'Configure secrets and local runtime paths.',
    options: ['--reconfigure  Re-run setup even if config already exists'],
    examples: ['ghcrawl init', 'ghcrawl init --reconfigure'],
  },
  {
    name: 'doctor',
    synopsis: 'doctor [--json]',
    description: 'Check local config, database wiring, and auth health.',
    options: ['--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl doctor', 'ghcrawl doctor --json'],
    agentJson: true,
  },
  {
    name: 'version',
    synopsis: 'version',
    description: 'Print the installed ghcrawl version.',
    options: [],
    examples: ['ghcrawl version', 'ghcrawl --version'],
  },
  {
    name: 'sync',
    synopsis: 'sync <owner/repo> [--since <iso|duration>] [--limit <count>] [--include-comments] [--full-reconcile] [--json]',
    description: 'Sync open GitHub issues and PRs into the local database.',
    options: [
      '--since <iso|duration>  Limit sync window using ISO time or 15m/2h/7d/1mo',
      '--limit <count>  Limit the number of synced items',
      '--include-comments  Hydrate issue comments, PR reviews, and review comments',
      '--full-reconcile  Reconcile stale open items instead of metadata-only incrementals',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl sync openclaw/openclaw --limit 1', 'ghcrawl sync openclaw/openclaw --since 7d --json'],
    agentJson: true,
  },
  {
    name: 'refresh',
    synopsis: 'refresh <owner/repo> [--no-sync] [--no-embed] [--no-cluster] [--heap-snapshot-dir <dir>] [--heap-log-interval-ms <ms>] [--json]',
    description: 'Run sync, embed, and cluster in one staged pipeline.',
    options: [
      '--no-sync  Skip the GitHub sync stage',
      '--no-embed  Skip the embeddings stage',
      '--no-cluster  Skip the clustering stage',
      '--heap-snapshot-dir <dir>  Write heap snapshots during long-running work',
      '--heap-log-interval-ms <ms>  Emit periodic heap diagnostics',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl refresh openclaw/openclaw', 'ghcrawl refresh openclaw/openclaw --no-sync --json'],
    agentJson: true,
  },
  {
    name: 'threads',
    synopsis: 'threads <owner/repo> [--numbers <n,n,...>] [--kind issue|pull_request] [--include-closed] [--json]',
    description: 'Read specific local issue and PR records from SQLite.',
    options: [
      '--numbers <n,n,...>  Fetch one or more thread numbers in one call',
      '--kind issue|pull_request  Filter by issue or pull request',
      '--include-closed  Include locally closed items',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl threads openclaw/openclaw --numbers 42,43,44 --json', 'ghcrawl threads openclaw/openclaw --numbers 42 --include-closed --json'],
    agentJson: true,
  },
  {
    name: 'author',
    synopsis: 'author <owner/repo> --login <user> [--include-closed] [--json]',
    description: 'List local issue and PR records for a single author.',
    options: [
      '--login <user>  GitHub login to inspect',
      '--include-closed  Include locally closed items',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl author openclaw/openclaw --login lqquan --json'],
    agentJson: true,
  },
  {
    name: 'close-thread',
    synopsis: 'close-thread <owner/repo> --number <thread> [--json]',
    description: 'Mark one local issue or PR closed immediately.',
    options: ['--number <thread>  Thread number to close locally', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl close-thread openclaw/openclaw --number 42 --json'],
    agentJson: true,
  },
  {
    name: 'close-cluster',
    synopsis: 'close-cluster <owner/repo> --id <cluster-id> [--json]',
    description: 'Mark one local cluster closed immediately.',
    options: ['--id <cluster-id>  Cluster id to close locally', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl close-cluster openclaw/openclaw --id 123 --json'],
    agentJson: true,
  },
  {
    name: 'embed',
    synopsis: 'embed <owner/repo> [--number <thread>] [--json]',
    description: 'Generate or refresh embeddings for one repo or one thread.',
    options: ['--number <thread>  Restrict embedding work to one thread', '--json  Emit machine-readable JSON output explicitly'],
    examples: ['ghcrawl embed openclaw/openclaw --json', 'ghcrawl embed openclaw/openclaw --number 42 --json'],
    agentJson: true,
  },
  {
    name: 'cluster',
    synopsis: 'cluster <owner/repo> [--k <count>] [--threshold <score>] [--heap-snapshot-dir <dir>] [--heap-log-interval-ms <ms>] [--json]',
    description: 'Build or refresh local similarity clusters.',
    options: [
      '--k <count>  Limit nearest-neighbor fanout',
      '--threshold <score>  Minimum similarity score',
      '--heap-snapshot-dir <dir>  Write heap snapshots during long-running work',
      '--heap-log-interval-ms <ms>  Emit periodic heap diagnostics',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl cluster openclaw/openclaw --json', 'ghcrawl cluster openclaw/openclaw --threshold 0.82 --json'],
    agentJson: true,
  },
  {
    name: 'clusters',
    synopsis: 'clusters <owner/repo> [--min-size <count>] [--limit <count>] [--sort recent|size] [--search <text>] [--include-closed] [--json]',
    description: 'List local cluster summaries for one repository.',
    options: [
      '--min-size <count>  Minimum cluster size to return',
      '--limit <count>  Maximum number of clusters to return',
      '--sort recent|size  Sort by recency or cluster size',
      '--search <text>  Filter clusters by text',
      '--include-closed  Include locally closed clusters',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl clusters openclaw/openclaw --min-size 10 --limit 20 --sort recent --json'],
    agentJson: true,
  },
  {
    name: 'cluster-detail',
    synopsis: 'cluster-detail <owner/repo> --id <cluster-id> [--member-limit <count>] [--body-chars <count>] [--include-closed] [--json]',
    description: 'Dump one local cluster and its members.',
    options: [
      '--id <cluster-id>  Cluster id to inspect',
      '--member-limit <count>  Limit member rows in the response',
      '--body-chars <count>  Limit body snippet size',
      '--include-closed  Include locally closed clusters',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl cluster-detail openclaw/openclaw --id 123 --member-limit 20 --body-chars 280 --json'],
    agentJson: true,
  },
  {
    name: 'search',
    synopsis: 'search <owner/repo> --query <text> [--mode keyword|semantic|hybrid] [--json]',
    description: 'Search local cluster and thread data.',
    options: [
      '--query <text>  Query string to search for',
      '--mode keyword|semantic|hybrid  Choose search mode explicitly',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl search openclaw/openclaw --query "download stalls" --mode hybrid --json'],
    agentJson: true,
  },
  {
    name: 'neighbors',
    synopsis: 'neighbors <owner/repo> --number <thread> [--limit <count>] [--threshold <score>] [--json]',
    description: 'List nearest semantic matches for one thread.',
    options: [
      '--number <thread>  Thread number to inspect',
      '--limit <count>  Maximum number of neighbors to return',
      '--threshold <score>  Minimum similarity score',
      '--json  Emit machine-readable JSON output explicitly',
    ],
    examples: ['ghcrawl neighbors openclaw/openclaw --number 42 --limit 10 --json'],
    agentJson: true,
  },
  {
    name: 'tui',
    synopsis: 'tui [owner/repo]',
    description: 'Start the interactive terminal UI.',
    options: [],
    examples: ['ghcrawl tui', 'ghcrawl tui openclaw/openclaw'],
  },
  {
    name: 'serve',
    synopsis: 'serve [--port <port>]',
    description: 'Start the local HTTP API server.',
    options: ['--port <port>  Override the configured local API port'],
    examples: ['ghcrawl serve', 'ghcrawl serve --port 5179'],
  },
  {
    name: 'summarize',
    synopsis: 'summarize <owner/repo> [--number <thread>] [--include-comments]',
    description: 'Generate or refresh summaries for local thread content.',
    options: ['--number <thread>  Restrict summary work to one thread', '--include-comments  Include comments in the summary input'],
    examples: ['ghcrawl --dev summarize openclaw/openclaw', 'ghcrawl --dev summarize openclaw/openclaw --number 42 --include-comments'],
    devOnly: true,
  },
  {
    name: 'purge-comments',
    synopsis: 'purge-comments <owner/repo> [--number <thread>]',
    description: 'Delete stored comments for one repo or one thread.',
    options: ['--number <thread>  Restrict purge to one thread'],
    examples: ['ghcrawl --dev purge-comments openclaw/openclaw', 'ghcrawl --dev purge-comments openclaw/openclaw --number 42'],
    devOnly: true,
  },
];

class CliError extends Error {
  readonly exitCode: number;
  readonly command?: CommandName;

  constructor(message: string, exitCode: number, command?: CommandName) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.command = command;
  }
}

class CliUsageError extends CliError {
  constructor(message: string, command?: CommandName) {
    super(message, 2, command);
    this.name = 'CliUsageError';
  }
}

function visibleCommandSpecs(devMode: boolean): CommandSpec[] {
  return COMMAND_SPECS.filter((spec) => devMode || spec.devOnly !== true);
}

function getCommandSpec(name: string, devMode: boolean): CommandSpec | undefined {
  return visibleCommandSpecs(devMode).find((spec) => spec.name === name);
}

function renderCommandList(devMode: boolean): string[] {
  const specs = visibleCommandSpecs(devMode);
  const width = Math.max(...specs.map((spec) => spec.name.length));
  return specs.map((spec) => `  ${spec.name.padEnd(width)}  ${spec.description}`);
}

function commonGlobalOptions(): string[] {
  return [
    '--config-path <path>  Override the persisted config.json path',
    '--workspace-root <path>  Override workspace root detection for .env.local and data/ghcrawl.db',
    '--dev  Enable dev-only commands and help output',
  ];
}

function usage(devMode = false): string {
  const lines = [
    'ghcrawl <command> [options]',
    '',
    'Commands:',
    ...renderCommandList(devMode),
    '',
    'Global options:',
    ...commonGlobalOptions().map((line) => `  ${line}`),
    '',
    "Use 'ghcrawl help <command>' or 'ghcrawl <command> --help' for details.",
  ];
  return `${lines.join('\n')}\n`;
}

function commandUsage(spec: CommandSpec): string {
  const lines = [`ghcrawl ${spec.synopsis}`, '', spec.description];
  if (spec.options.length > 0) {
    lines.push('', 'Options:', ...spec.options.map((line) => `  ${line}`));
  }
  lines.push('', 'Global options:', ...commonGlobalOptions().map((line) => `  ${line}`));
  if (spec.agentJson) {
    lines.push('', 'Machine output:', '  Supports explicit --json. JSON remains the default in this compatibility pass.');
  }
  lines.push('', 'Examples:', ...spec.examples.map((example) => `  ${example}`));
  return `${lines.join('\n')}\n`;
}

function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function usageHint(command?: CommandName): string {
  return command ? `Run 'ghcrawl ${command} --help' for usage.` : "Run 'ghcrawl --help' for usage.";
}

function readFlagValue(argv: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const arg = argv[index];
  const inlinePrefix = `${flag}=`;
  if (arg.startsWith(inlinePrefix)) {
    return { value: arg.slice(inlinePrefix.length), nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return { value, nextIndex: index + 1 };
}

function parseGlobalFlags(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedGlobalFlags {
  let devMode = env.GHCRAWL_DEV_MODE === '1';
  let configPathOverride: string | undefined;
  let workspaceRootOverride: string | undefined;
  const filtered: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dev') {
      devMode = true;
      continue;
    }
    if (arg === '--config-path' || arg.startsWith('--config-path=')) {
      const { value, nextIndex } = readFlagValue(argv, index, '--config-path');
      configPathOverride = value;
      index = nextIndex;
      continue;
    }
    if (arg === '--workspace-root' || arg.startsWith('--workspace-root=')) {
      const { value, nextIndex } = readFlagValue(argv, index, '--workspace-root');
      workspaceRootOverride = value;
      index = nextIndex;
      continue;
    }
    filtered.push(arg);
  }

  return { argv: filtered, devMode, configPathOverride, workspaceRootOverride };
}

function parseArgsForCommand(
  command: CommandName,
  args: string[],
  options: NonNullable<Parameters<typeof parseArgs>[0]>['options'],
  allowPositionals = false,
) {
  try {
    return parseArgs({
      args,
      allowPositionals,
      options,
    });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error), command);
  }
}

export function parseOwnerRepo(value: string): { owner: string; repo: string } {
  const trimmed = value.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CliUsageError(`Expected owner/repo, received: ${value}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function parseRepoFlags(command: CommandName, args: string[]): ParsedRepoFlags {
  const parsed = parseArgsForCommand(
    command,
    args,
    {
      owner: { type: 'string' },
      repo: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
      'include-comments': { type: 'boolean' },
      'full-reconcile': { type: 'boolean' },
      'include-closed': { type: 'boolean' },
      kind: { type: 'string' },
      number: { type: 'string' },
      numbers: { type: 'string' },
      login: { type: 'string' },
      query: { type: 'string' },
      mode: { type: 'string' },
      k: { type: 'string' },
      backend: { type: 'string' },
      'candidate-k': { type: 'string' },
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
      'heap-snapshot-dir': { type: 'string' },
      'heap-log-interval-ms': { type: 'string' },
    },
    true,
  );
  const values = parsed.values as RepoCommandValues;

  if (parsed.positionals.length > 1) {
    throw new CliUsageError(`Too many positional arguments for ${command}`, command);
  }

  if (typeof values.repo === 'string' && values.repo.includes('/')) {
    let target: { owner: string; repo: string };
    try {
      target = parseOwnerRepo(values.repo);
    } catch (error) {
      throw new CliUsageError(formatErrorMessage(error), command);
    }
    return { ...target, values };
  }

  if (parsed.positionals.length === 1) {
    let target: { owner: string; repo: string };
    try {
      target = parseOwnerRepo(parsed.positionals[0]);
    } catch (error) {
      throw new CliUsageError(formatErrorMessage(error), command);
    }
    return { ...target, values };
  }

  const owner = values.owner;
  const repo = values.repo;
  if (typeof owner === 'string' && typeof repo === 'string') {
    return { owner, repo, values };
  }

  throw new CliUsageError('Use --repo owner/repo or provide owner/repo as the first positional argument', command);
}

export function resolveSinceValue(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  const absolute = new Date(trimmed);
  if (!Number.isNaN(absolute.getTime())) {
    return absolute.toISOString();
  }

  const match = trimmed.match(/^(\d+)(s|m|h|d|w|mo|y)$/i);
  if (!match) {
    throw new CliUsageError(`Invalid --since value: ${value}. Use an ISO timestamp or duration like 15m, 2h, 7d, or 1mo.`);
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
      throw new CliUsageError(`Unsupported --since unit: ${unit}`);
  }

  return resolved.toISOString();
}

export function formatLogLine(message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] ${message}`;
}

function writeProgress(message: string, stderr: NodeJS.WritableStream): void {
  stderr.write(`${formatLogLine(message)}\n`);
}

function formatBooleanStatus(value: boolean): string {
  return value ? 'yes' : 'no';
}

function parsePositiveInteger(name: string, value: string, command: CommandName): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`Invalid --${name}: ${value}`, command);
  }
  return parsed;
}

function parseFiniteNumber(name: string, value: string, command: CommandName): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`Invalid --${name}: ${value}`, command);
  }
  return parsed;
}

function parsePositiveIntegerList(name: string, value: string, command: CommandName): number[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new CliUsageError(`Invalid --${name}: ${value}`, command);
  }
  return parts.map((part) => parsePositiveInteger(name, part, command));
}

function parseEnum<T extends string>(command: CommandName, flagName: string, value: string | boolean | undefined, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new CliUsageError(`Invalid --${flagName}: ${value}. Use one of ${allowed.join(', ')}.`, command);
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

function isBrokenPipeError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EPIPE',
  );
}

function attachBrokenPipeHandler(stream: NodeJS.WritableStream): void {
  if (typeof stream.on !== 'function') {
    return;
  }
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) {
      process.exit(0);
    }
    throw error;
  });
}

function createOptionalHeapDiagnostics(
  values: Record<string, string | boolean>,
  stderr: NodeJS.WritableStream,
  command: CommandName,
): HeapDiagnostics | null {
  const snapshotDir = typeof values['heap-snapshot-dir'] === 'string' ? values['heap-snapshot-dir'] : undefined;
  const logIntervalMs =
    typeof values['heap-log-interval-ms'] === 'string'
      ? parsePositiveInteger('heap-log-interval-ms', values['heap-log-interval-ms'], command)
      : undefined;
  if (!snapshotDir && !logIntervalMs) {
    return null;
  }
  return createHeapDiagnostics({
    snapshotDir,
    logIntervalMs,
    log: (message) => writeProgress(message, stderr),
  });
}

function normalizeRunContext(stdoutOrContext: NodeJS.WritableStream | RunContext = process.stdout, context: RunContext = {}) {
  if (typeof (stdoutOrContext as NodeJS.WritableStream).write === 'function' && !('stdout' in (stdoutOrContext as RunContext))) {
    return {
      stdout: stdoutOrContext as NodeJS.WritableStream,
      stderr: context.stderr ?? process.stderr,
      env: context.env ?? process.env,
      cwd: context.cwd ?? process.cwd(),
    };
  }

  const resolved = stdoutOrContext as RunContext;
  return {
    stdout: resolved.stdout ?? process.stdout,
    stderr: resolved.stderr ?? process.stderr,
    env: resolved.env ?? process.env,
    cwd: resolved.cwd ?? process.cwd(),
  };
}

function buildLoadConfigOptions(context: { cwd: string; env: NodeJS.ProcessEnv } & ParsedGlobalFlags): LoadConfigOptions {
  return {
    cwd: context.cwd,
    env: context.env,
    configPathOverride: context.configPathOverride,
    workspaceRootOverride: context.workspaceRootOverride,
  };
}

function writeJson(stdout: NodeJS.WritableStream, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function run(
  argv: string[],
  stdoutOrContext: NodeJS.WritableStream | RunContext = process.stdout,
  context: RunContext = {},
): Promise<void> {
  const { stdout, stderr, env, cwd } = normalizeRunContext(stdoutOrContext, context);
  attachBrokenPipeHandler(stdout);
  const parsedGlobals = parseGlobalFlags(argv, env);
  const [commandRaw, ...rest] = parsedGlobals.argv;

  if (commandRaw === '--version' || commandRaw === '-v') {
    stdout.write(`${CLI_VERSION}\n`);
    return;
  }

  if (!commandRaw || commandRaw === '--help' || commandRaw === '-h') {
    stdout.write(usage(parsedGlobals.devMode));
    return;
  }

  if (commandRaw === 'help') {
    const [requested, ...extra] = rest;
    if (!requested) {
      stdout.write(usage(parsedGlobals.devMode));
      return;
    }
    if (extra.length > 0) {
      throw new CliUsageError('Usage: ghcrawl help <command>');
    }
    const helpSpec = getCommandSpec(requested, parsedGlobals.devMode);
    if (!helpSpec) {
      throw new CliUsageError(`Unknown command: ${requested}`);
    }
    stdout.write(commandUsage(helpSpec));
    return;
  }

  const commandSpec = getCommandSpec(commandRaw, parsedGlobals.devMode);
  if (!commandSpec) {
    throw new CliUsageError(`Unknown command: ${commandRaw}`);
  }

  if (hasHelpFlag(rest)) {
    stdout.write(commandUsage(commandSpec));
    return;
  }

  const loadConfigOptions = buildLoadConfigOptions({
    ...parsedGlobals,
    cwd,
    env,
  });
  let loadedConfig: ReturnType<typeof loadConfig> | null = null;
  let service: GHCrawlService | null = null;
  const getConfig = () => {
    loadedConfig ??= loadConfig(loadConfigOptions);
    return loadedConfig;
  };
  const getService = (): GHCrawlService => {
    service ??= new GHCrawlService({ config: getConfig() });
    return service;
  };

  try {
    switch (commandSpec.name) {
      case 'init': {
        const parsed = parseArgsForCommand('init', rest, {
          reconfigure: { type: 'boolean' },
        });
        const values = parsed.values as RepoCommandValues;
        await runInitWizard({
          reconfigure: values.reconfigure === true,
          cwd,
          env,
          configPathOverride: parsedGlobals.configPathOverride,
          workspaceRootOverride: parsedGlobals.workspaceRootOverride,
        });
        writeJson(stdout, getService().init());
        return;
      }
      case 'doctor': {
        const parsed = parseArgsForCommand('doctor', rest, {
          json: { type: 'boolean' },
        });
        const values = parsed.values as RepoCommandValues;
        const result: DoctorReport = {
          version: CLI_VERSION,
          ...(await getService().doctor()),
        };
        const shouldWriteJson = values.json === true || (stdout as NodeJS.WriteStream).isTTY !== true;
        stdout.write(shouldWriteJson ? `${JSON.stringify(result, null, 2)}\n` : formatDoctorReport(result));
        return;
      }
      case 'version': {
        stdout.write(`${CLI_VERSION}\n`);
        return;
      }
      case 'sync': {
        const { owner, repo, values } = parseRepoFlags('sync', rest);
        const result = await getService().syncRepository({
          owner,
          repo,
          since: typeof values.since === 'string' ? resolveSinceValue(values.since) : undefined,
          limit: typeof values.limit === 'string' ? parsePositiveInteger('limit', values.limit, 'sync') : undefined,
          includeComments: values['include-comments'] === true,
          fullReconcile: values['full-reconcile'] === true,
          onProgress: (message: string) => writeProgress(message, stderr),
        });
        writeJson(stdout, result);
        return;
      }
      case 'refresh': {
        const { owner, repo, values } = parseRepoFlags('refresh', rest);
        const heapDiagnostics = createOptionalHeapDiagnostics(values, stderr, 'refresh');
        try {
          const result = await getService().refreshRepository({
            owner,
            repo,
            sync: values['no-sync'] === true ? false : undefined,
            embed: values['no-embed'] === true ? false : undefined,
            cluster: values['no-cluster'] === true ? false : undefined,
            onProgress:
              heapDiagnostics?.wrapProgress((message: string) => writeProgress(message, stderr)) ??
              ((message: string) => writeProgress(message, stderr)),
          });
          heapDiagnostics?.capture('refresh-complete');
          writeJson(stdout, result);
          return;
        } catch (error) {
          heapDiagnostics?.capture('refresh-error');
          throw error;
        } finally {
          heapDiagnostics?.dispose();
        }
      }
      case 'threads': {
        const { owner, repo, values } = parseRepoFlags('threads', rest);
        const kind = parseEnum('threads', 'kind', values.kind, ['issue', 'pull_request']);
        const result = getService().listThreads({
          owner,
          repo,
          kind,
          numbers: typeof values.numbers === 'string' ? parsePositiveIntegerList('numbers', values.numbers, 'threads') : undefined,
          includeClosed: values['include-closed'] === true,
        });
        writeJson(stdout, result);
        return;
      }
      case 'author': {
        const { owner, repo, values } = parseRepoFlags('author', rest);
        if (typeof values.login !== 'string' || values.login.trim().length === 0) {
          throw new CliUsageError('Missing --login', 'author');
        }
        const result = getService().listAuthorThreads({
          owner,
          repo,
          login: values.login,
          includeClosed: values['include-closed'] === true,
        });
        writeJson(stdout, result);
        return;
      }
      case 'close-thread': {
        const { owner, repo, values } = parseRepoFlags('close-thread', rest);
        if (typeof values.number !== 'string') {
          throw new CliUsageError('Missing --number', 'close-thread');
        }
        const result = getService().closeThreadLocally({
          owner,
          repo,
          threadNumber: parsePositiveInteger('number', values.number, 'close-thread'),
        });
        writeJson(stdout, result);
        return;
      }
      case 'close-cluster': {
        const { owner, repo, values } = parseRepoFlags('close-cluster', rest);
        if (typeof values.id !== 'string') {
          throw new CliUsageError('Missing --id', 'close-cluster');
        }
        const result = getService().closeClusterLocally({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id, 'close-cluster'),
        });
        writeJson(stdout, result);
        return;
      }
      case 'summarize': {
        const { owner, repo, values } = parseRepoFlags('summarize', rest);
        const result = await getService().summarizeRepository({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? parsePositiveInteger('number', values.number, 'summarize') : undefined,
          includeComments: values['include-comments'] === true,
          onProgress: (message: string) => writeProgress(message, stderr),
        });
        writeJson(stdout, result);
        return;
      }
      case 'purge-comments': {
        const { owner, repo, values } = parseRepoFlags('purge-comments', rest);
        const result = getService().purgeComments({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? parsePositiveInteger('number', values.number, 'purge-comments') : undefined,
          onProgress: (message: string) => writeProgress(message, stderr),
        });
        writeJson(stdout, result);
        return;
      }
      case 'embed': {
        const { owner, repo, values } = parseRepoFlags('embed', rest);
        const result = await getService().embedRepository({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? parsePositiveInteger('number', values.number, 'embed') : undefined,
          onProgress: (message: string) => writeProgress(message, stderr),
        });
        writeJson(stdout, result);
        return;
      }
      case 'cluster': {
        const { owner, repo, values } = parseRepoFlags('cluster', rest);
        const heapDiagnostics = createOptionalHeapDiagnostics(values, stderr, 'cluster');
        try {
          const result = await getService().clusterRepository({
            owner,
            repo,
            k: typeof values.k === 'string' ? parsePositiveInteger('k', values.k, 'cluster') : undefined,
            minScore: typeof values.threshold === 'string' ? parseFiniteNumber('threshold', values.threshold, 'cluster') : undefined,
            onProgress:
              heapDiagnostics?.wrapProgress((message: string) => writeProgress(message, stderr)) ??
              ((message: string) => writeProgress(message, stderr)),
          });
          heapDiagnostics?.capture('cluster-complete');
          writeJson(stdout, result);
          return;
        } catch (error) {
          heapDiagnostics?.capture('cluster-error');
          throw error;
        } finally {
          heapDiagnostics?.dispose();
        }
      }
      case 'cluster-experiment': {
        const { owner, repo, values } = parseRepoFlags('cluster-experiment', rest);
        const backend = values.backend === 'exact' || values.backend === 'vectorlite' ? values.backend : undefined;
        const result = getService().clusterExperiment({
          owner,
          repo,
          backend,
          k: typeof values.k === 'string' ? Number(values.k) : undefined,
          minScore: typeof values.threshold === 'string' ? Number(values.threshold) : undefined,
          candidateK: typeof values['candidate-k'] === 'string' ? Number(values['candidate-k']) : undefined,
          onProgress: (message: string) => writeProgress(message, stderr),
        });
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      case 'clusters': {
        const { owner, repo, values } = parseRepoFlags('clusters', rest);
        const sort = parseEnum('clusters', 'sort', values.sort, ['recent', 'size']);
        const result = getService().listClusterSummaries({
          owner,
          repo,
          minSize: typeof values['min-size'] === 'string' ? parsePositiveInteger('min-size', values['min-size'], 'clusters') : undefined,
          limit: typeof values.limit === 'string' ? parsePositiveInteger('limit', values.limit, 'clusters') : undefined,
          sort,
          search: typeof values.search === 'string' ? values.search : undefined,
          includeClosed: values['include-closed'] === true,
        });
        writeJson(stdout, result);
        return;
      }
      case 'cluster-detail': {
        const { owner, repo, values } = parseRepoFlags('cluster-detail', rest);
        if (typeof values.id !== 'string') {
          throw new CliUsageError('Missing --id', 'cluster-detail');
        }
        const result = getService().getClusterDetailDump({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id, 'cluster-detail'),
          memberLimit:
            typeof values['member-limit'] === 'string'
              ? parsePositiveInteger('member-limit', values['member-limit'], 'cluster-detail')
              : undefined,
          bodyChars:
            typeof values['body-chars'] === 'string'
              ? parsePositiveInteger('body-chars', values['body-chars'], 'cluster-detail')
              : undefined,
          includeClosed: values['include-closed'] === true,
        });
        writeJson(stdout, result);
        return;
      }
      case 'search': {
        const { owner, repo, values } = parseRepoFlags('search', rest);
        if (typeof values.query !== 'string') {
          throw new CliUsageError('Missing --query', 'search');
        }
        const mode = parseEnum('search', 'mode', values.mode, ['keyword', 'semantic', 'hybrid']);
        const result = await getService().searchRepository({
          owner,
          repo,
          query: values.query,
          mode,
        });
        writeJson(stdout, result);
        return;
      }
      case 'neighbors': {
        const { owner, repo, values } = parseRepoFlags('neighbors', rest);
        if (typeof values.number !== 'string') {
          throw new CliUsageError('Missing --number', 'neighbors');
        }
        const result = getService().listNeighbors({
          owner,
          repo,
          threadNumber: parsePositiveInteger('number', values.number, 'neighbors'),
          limit: typeof values.limit === 'string' ? parsePositiveInteger('limit', values.limit, 'neighbors') : undefined,
          minScore: typeof values.threshold === 'string' ? parseFiniteNumber('threshold', values.threshold, 'neighbors') : undefined,
        });
        writeJson(stdout, result);
        return;
      }
      case 'tui': {
        if (rest.length === 0) {
          await startTui({ service: getService() });
          return;
        }
        const { owner, repo } = parseRepoFlags('tui', rest);
        await startTui({ service: getService(), owner, repo });
        return;
      }
      case 'serve': {
        const serviceForServe = getService();
        const server = createApiServer(serviceForServe);
        const parsed = parseArgsForCommand('serve', rest, {
          port: { type: 'string' },
        });
        const values = parsed.values as RepoCommandValues;
        const port =
          typeof values.port === 'string'
            ? parsePositiveInteger('port', values.port, 'serve')
            : serviceForServe.config.apiPort;
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
    }
  } finally {
    if (commandSpec.name !== 'serve') {
      closeService(service);
    }
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getExitCode(error: unknown): number {
  if (isBrokenPipeError(error)) {
    return 0;
  }
  return error instanceof CliError ? error.exitCode : 1;
}

function writeCliError(stderr: NodeJS.WritableStream, error: unknown): void {
  stderr.write(`${formatErrorMessage(error)}\n`);
  if (error instanceof CliUsageError) {
    stderr.write(`${usageHint(error.command)}\n`);
  }
}

export async function runCli(argv: string[], context: RunContext = {}): Promise<number> {
  const resolved = normalizeRunContext(context);
  try {
    await run(argv, resolved);
    return 0;
  } catch (error) {
    writeCliError(resolved.stderr, error);
    return getExitCode(error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runCli(process.argv.slice(2));
  if (code !== 0) {
    process.exit(code);
  }
}

function loadCliVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(here, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
}
