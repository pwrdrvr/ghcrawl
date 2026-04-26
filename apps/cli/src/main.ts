#!/usr/bin/env node
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createApiServer,
  GHCrawlService,
  loadConfig,
  portableSyncSizeReport,
  readPersistedConfig,
  validatePortableSyncDatabase,
  writePersistedConfig,
  type LoadConfigOptions,
} from '@ghcrawl/api-core';
import {
  CliError,
  CliUsageError,
  parseArgsForCommand,
  parseEnum,
  parseFiniteNumber,
  parseGlobalFlags,
  parseOwnerRepo,
  parsePositiveInteger,
  parsePositiveIntegerList,
  parseRepoFlags,
  resolveSinceValue,
  type ParsedGlobalFlags,
  type RepoCommandValues,
} from './args.js';
import {
  commandUsage,
  getCommandSpec,
  hasHelpFlag,
  usage,
  usageHint,
  type CommandName,
} from './commands.js';
import { createHeapDiagnostics, type HeapDiagnostics } from './heap-diagnostics.js';
import { buildConfigureReport, formatConfigureReport, formatDoctorReport, type DoctorReport } from './reports.js';
import { startTui } from './tui/app.js';

type RunContext = {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

const CLI_VERSION = loadCliVersion();

export function formatLogLine(message: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] ${message}`;
}

function writeProgress(message: string, stderr: NodeJS.WritableStream): void {
  stderr.write(`${formatLogLine(message)}\n`);
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
      case 'configure': {
        const parsed = parseArgsForCommand('configure', rest, {
          'summary-model': { type: 'string' },
          'embedding-basis': { type: 'string' },
          json: { type: 'boolean' },
        });
        const values = parsed.values as RepoCommandValues;
        const summaryModel = parseEnum('configure', 'summary-model', values['summary-model'], ['gpt-5.4', 'gpt-5-mini', 'gpt-5.4-mini']);
        const embeddingBasis = parseEnum('configure', 'embedding-basis', values['embedding-basis'], ['title_original', 'title_summary', 'llm_key_summary']);
        const current = getConfig();
        const stored = readPersistedConfig(loadConfigOptions);
        const next = {
          ...stored.data,
          summaryModel: summaryModel ?? current.summaryModel,
          embeddingBasis: embeddingBasis ?? current.embeddingBasis,
          vectorBackend: 'vectorlite' as const,
        };
        const updated =
          next.summaryModel !== current.summaryModel ||
          next.embeddingBasis !== current.embeddingBasis ||
          next.vectorBackend !== current.vectorBackend;
        if (updated) {
          writePersistedConfig(next, loadConfigOptions);
        }
        const result = buildConfigureReport({
          configPath: current.configPath,
          updated,
          summaryModel: next.summaryModel as 'gpt-5.4' | 'gpt-5-mini' | 'gpt-5.4-mini',
          embeddingBasis: next.embeddingBasis as 'title_original' | 'title_summary' | 'llm_key_summary',
          vectorBackend: 'vectorlite',
        });
        const shouldWriteJson = values.json === true || (stdout as NodeJS.WriteStream).isTTY !== true;
        stdout.write(shouldWriteJson ? `${JSON.stringify(result, null, 2)}\n` : formatConfigureReport(result));
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
          includeCode: values['include-code'] === true,
          fullReconcile: values['full-reconcile'] === true,
          onProgress: (message: string) => writeProgress(message, stderr),
        });
        writeJson(stdout, result);
        return;
      }
      case 'export-sync': {
        const { owner, repo, values } = parseRepoFlags('export-sync', rest);
        const result = getService().exportPortableSync({
          owner,
          repo,
          outputPath: typeof values.output === 'string' ? values.output : undefined,
          profile: parseEnum('export-sync', 'profile', values.profile, ['lean', 'review']),
          writeManifest: values.manifest === true,
          bodyChars:
            typeof values['body-chars'] === 'string'
              ? parsePositiveInteger('body-chars', values['body-chars'], 'export-sync')
              : undefined,
        });
        writeJson(stdout, result);
        return;
      }
      case 'validate-sync': {
        const parsed = parseArgsForCommand('validate-sync', rest, { json: { type: 'boolean' } }, true);
        if (parsed.positionals.length !== 1) {
          throw new CliUsageError('validate-sync requires exactly one portable database path', 'validate-sync');
        }
        const result = validatePortableSyncDatabase(parsed.positionals[0]);
        writeJson(stdout, result);
        return;
      }
      case 'portable-size': {
        const parsed = parseArgsForCommand('portable-size', rest, { json: { type: 'boolean' } }, true);
        if (parsed.positionals.length !== 1) {
          throw new CliUsageError('portable-size requires exactly one portable database path', 'portable-size');
        }
        const result = portableSyncSizeReport(parsed.positionals[0]);
        writeJson(stdout, result);
        return;
      }
      case 'sync-status': {
        const { owner, repo, values } = parseRepoFlags('sync-status', rest);
        if (typeof values.portable !== 'string') {
          throw new CliUsageError('Missing --portable', 'sync-status');
        }
        const result = getService().portableSyncStatus({
          owner,
          repo,
          portablePath: values.portable,
        });
        writeJson(stdout, result);
        return;
      }
      case 'import-sync': {
        const parsed = parseArgsForCommand('import-sync', rest, { json: { type: 'boolean' } }, true);
        if (parsed.positionals.length !== 1) {
          throw new CliUsageError('import-sync requires exactly one portable database path', 'import-sync');
        }
        const result = getService().importPortableSync(parsed.positionals[0]);
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
            includeCode: values['include-code'] === true,
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
      case 'optimize': {
        const parsed = parseArgsForCommand(
          'optimize',
          rest,
          {
            owner: { type: 'string' },
            repo: { type: 'string' },
            json: { type: 'boolean' },
          },
          true,
        );
        const values = parsed.values as RepoCommandValues;
        if (parsed.positionals.length > 1) {
          throw new CliUsageError('Too many positional arguments for optimize', 'optimize');
        }
        let target: { owner: string; repo: string } | undefined;
        if (parsed.positionals.length === 1) {
          target = parseOwnerRepo(parsed.positionals[0]);
        } else if (typeof values.owner === 'string' || typeof values.repo === 'string') {
          if (typeof values.owner !== 'string' || typeof values.repo !== 'string') {
            throw new CliUsageError('Both --owner and --repo are required when either is set', 'optimize');
          }
          target = { owner: values.owner, repo: values.repo };
        }
        const result = getService().optimizeStorage(target);
        writeJson(stdout, result);
        return;
      }
      case 'runs': {
        const { owner, repo, values } = parseRepoFlags('runs', rest);
        const kind = parseEnum('runs', 'kind', values.kind, ['sync', 'summary', 'embedding', 'cluster']);
        const result = getService().listRunHistory({
          owner,
          repo,
          kind,
          limit: typeof values.limit === 'string' ? parsePositiveInteger('limit', values.limit, 'runs') : undefined,
        });
        writeJson(stdout, result);
        return;
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
      case 'exclude-cluster-member': {
        const { owner, repo, values } = parseRepoFlags('exclude-cluster-member', rest);
        if (typeof values.id !== 'string') {
          throw new CliUsageError('Missing --id', 'exclude-cluster-member');
        }
        if (typeof values.number !== 'string') {
          throw new CliUsageError('Missing --number', 'exclude-cluster-member');
        }
        const result = getService().excludeThreadFromCluster({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id, 'exclude-cluster-member'),
          threadNumber: parsePositiveInteger('number', values.number, 'exclude-cluster-member'),
          reason: typeof values.reason === 'string' ? values.reason : undefined,
        });
        writeJson(stdout, result);
        return;
      }
      case 'include-cluster-member': {
        const { owner, repo, values } = parseRepoFlags('include-cluster-member', rest);
        if (typeof values.id !== 'string') {
          throw new CliUsageError('Missing --id', 'include-cluster-member');
        }
        if (typeof values.number !== 'string') {
          throw new CliUsageError('Missing --number', 'include-cluster-member');
        }
        const result = getService().includeThreadInCluster({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id, 'include-cluster-member'),
          threadNumber: parsePositiveInteger('number', values.number, 'include-cluster-member'),
          reason: typeof values.reason === 'string' ? values.reason : undefined,
        });
        writeJson(stdout, result);
        return;
      }
      case 'set-cluster-canonical': {
        const { owner, repo, values } = parseRepoFlags('set-cluster-canonical', rest);
        if (typeof values.id !== 'string') {
          throw new CliUsageError('Missing --id', 'set-cluster-canonical');
        }
        if (typeof values.number !== 'string') {
          throw new CliUsageError('Missing --number', 'set-cluster-canonical');
        }
        const result = getService().setClusterCanonicalThread({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id, 'set-cluster-canonical'),
          threadNumber: parsePositiveInteger('number', values.number, 'set-cluster-canonical'),
          reason: typeof values.reason === 'string' ? values.reason : undefined,
        });
        writeJson(stdout, result);
        return;
      }
      case 'merge-clusters': {
        const { owner, repo, values } = parseRepoFlags('merge-clusters', rest);
        if (typeof values.source !== 'string') {
          throw new CliUsageError('Missing --source', 'merge-clusters');
        }
        if (typeof values.target !== 'string') {
          throw new CliUsageError('Missing --target', 'merge-clusters');
        }
        const result = getService().mergeDurableClusters({
          owner,
          repo,
          sourceClusterId: parsePositiveInteger('source', values.source, 'merge-clusters'),
          targetClusterId: parsePositiveInteger('target', values.target, 'merge-clusters'),
          reason: typeof values.reason === 'string' ? values.reason : undefined,
        });
        writeJson(stdout, result);
        return;
      }
      case 'split-cluster': {
        const { owner, repo, values } = parseRepoFlags('split-cluster', rest);
        if (typeof values.source !== 'string') {
          throw new CliUsageError('Missing --source', 'split-cluster');
        }
        if (typeof values.numbers !== 'string') {
          throw new CliUsageError('Missing --numbers', 'split-cluster');
        }
        const result = getService().splitDurableCluster({
          owner,
          repo,
          sourceClusterId: parsePositiveInteger('source', values.source, 'split-cluster'),
          threadNumbers: parsePositiveIntegerList('numbers', values.numbers, 'split-cluster'),
          reason: typeof values.reason === 'string' ? values.reason : undefined,
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
      case 'key-summaries': {
        const { owner, repo, values } = parseRepoFlags('key-summaries', rest);
        const result = await getService().generateKeySummaries({
          owner,
          repo,
          threadNumber: typeof values.number === 'string' ? parsePositiveInteger('number', values.number, 'key-summaries') : undefined,
          limit: typeof values.limit === 'string' ? parsePositiveInteger('limit', values.limit, 'key-summaries') : undefined,
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
            threadNumber: typeof values.number === 'string' ? parsePositiveInteger('number', values.number, 'cluster') : undefined,
            k: typeof values.k === 'string' ? parsePositiveInteger('k', values.k, 'cluster') : undefined,
            minScore: typeof values.threshold === 'string' ? parseFiniteNumber('threshold', values.threshold, 'cluster') : undefined,
            maxClusterSize:
              typeof values['max-cluster-size'] === 'string'
                ? parsePositiveInteger('max-cluster-size', values['max-cluster-size'], 'cluster')
                : undefined,
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
          includeClosed: values['hide-closed'] === true ? false : true,
        });
        writeJson(stdout, result);
        return;
      }
      case 'durable-clusters': {
        const { owner, repo, values } = parseRepoFlags('durable-clusters', rest);
        const result = getService().listDurableClusters({
          owner,
          repo,
          includeInactive: values['include-inactive'] === true,
          memberLimit:
            typeof values['member-limit'] === 'string'
              ? parsePositiveInteger('member-limit', values['member-limit'], 'durable-clusters')
              : undefined,
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
          includeClosed: values['hide-closed'] === true ? false : true,
        });
        writeJson(stdout, result);
        return;
      }
      case 'cluster-explain': {
        const { owner, repo, values } = parseRepoFlags('cluster-explain', rest);
        if (typeof values.id !== 'string') {
          throw new CliUsageError('Missing --id', 'cluster-explain');
        }
        const result = getService().explainDurableCluster({
          owner,
          repo,
          clusterId: parsePositiveInteger('id', values.id, 'cluster-explain'),
          memberLimit:
            typeof values['member-limit'] === 'string'
              ? parsePositiveInteger('member-limit', values['member-limit'], 'cluster-explain')
              : undefined,
          eventLimit:
            typeof values['event-limit'] === 'string'
              ? parsePositiveInteger('event-limit', values['event-limit'], 'cluster-explain')
              : undefined,
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

export { formatConfigureReport, formatDoctorReport } from './reports.js';
export { parseOwnerRepo, parseRepoFlags, resolveSinceValue } from './args.js';

function loadCliVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(here, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
}
