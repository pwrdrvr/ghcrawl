import { parseArgs } from 'node:util';

import type { CommandName } from './commands.js';

export type ParsedGlobalFlags = {
  argv: string[];
  devMode: boolean;
  configPathOverride?: string;
  workspaceRootOverride?: string;
};

export type RepoCommandValues = Record<string, string | boolean>;
export type ParsedRepoFlags = { owner: string; repo: string; values: RepoCommandValues };

type ParseArgsOptions = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

export class CliError extends Error {
  readonly exitCode: number;
  readonly command?: CommandName;

  constructor(message: string, exitCode: number, command?: CommandName) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.command = command;
  }
}

export class CliUsageError extends CliError {
  constructor(message: string, command?: CommandName) {
    super(message, 2, command);
    this.name = 'CliUsageError';
  }
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

export function parseGlobalFlags(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedGlobalFlags {
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

export function parseArgsForCommand(
  command: CommandName,
  args: string[],
  options: ParseArgsOptions,
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
      'include-code': { type: 'boolean' },
      'full-reconcile': { type: 'boolean' },
      'include-closed': { type: 'boolean' },
      'hide-closed': { type: 'boolean' },
      'include-inactive': { type: 'boolean' },
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
      'max-cluster-size': { type: 'string' },
      port: { type: 'string' },
      id: { type: 'string' },
      source: { type: 'string' },
      target: { type: 'string' },
      reason: { type: 'string' },
      sort: { type: 'string' },
      search: { type: 'string' },
      'min-size': { type: 'string' },
      'member-limit': { type: 'string' },
      'event-limit': { type: 'string' },
      'body-chars': { type: 'string' },
      output: { type: 'string' },
      profile: { type: 'string' },
      manifest: { type: 'boolean' },
      portable: { type: 'string' },
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
    try {
      return { ...parseOwnerRepo(values.repo), values };
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error), command);
    }
  }

  if (parsed.positionals.length === 1) {
    try {
      return { ...parseOwnerRepo(parsed.positionals[0]), values };
    } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error), command);
    }
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

export function parsePositiveInteger(name: string, value: string, command: CommandName): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`Invalid --${name}: ${value}`, command);
  }
  return parsed;
}

export function parseFiniteNumber(name: string, value: string, command: CommandName): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`Invalid --${name}: ${value}`, command);
  }
  return parsed;
}

export function parsePositiveIntegerList(name: string, value: string, command: CommandName): number[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new CliUsageError(`Invalid --${name}: ${value}`, command);
  }
  return parts.map((part) => parsePositiveInteger(name, part, command));
}

export function parseEnum<T extends string>(
  command: CommandName,
  flagName: string,
  value: string | boolean | undefined,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new CliUsageError(`Invalid --${flagName}: ${value}. Use one of ${allowed.join(', ')}.`, command);
}
