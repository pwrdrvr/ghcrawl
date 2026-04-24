import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GHCrawlService, readPersistedConfig } from '@ghcrawl/api-core';
import { formatDoctorReport, formatLogLine, getExitCode, parseOwnerRepo, parseRepoFlags, resolveSinceValue, run, runCli } from './main.js';

function createWritableCapture(isTTY?: boolean) {
  let output = '';
  return {
    stream: {
      isTTY,
      write(chunk: string) {
        output += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    read: () => output,
  };
}

function makeRunContext(): { env: NodeJS.ProcessEnv; cwd: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-cli-home-'));
  return {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: undefined,
      APPDATA: undefined,
    },
    cwd: process.cwd(),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const publicCommands = [
  'init',
  'doctor',
  'configure',
  'version',
  'sync',
  'refresh',
  'threads',
  'author',
  'close-thread',
  'close-cluster',
  'exclude-cluster-member',
  'embed',
  'cluster',
  'clusters',
  'durable-clusters',
  'cluster-detail',
  'search',
  'neighbors',
  'tui',
  'serve',
] as const;

test('run prints usage with no command', async () => {
  const stdout = createWritableCapture();

  await run([], stdout.stream);

  assert.match(stdout.read(), /ghcrawl <command> \[options\]/);
  assert.match(stdout.read(), /\n  version\s+/);
  assert.match(stdout.read(), /\n  sync\s+/);
  assert.match(stdout.read(), /\n  cluster-detail\s+/);
  assert.match(stdout.read(), /Use 'ghcrawl help <command>' or 'ghcrawl <command> --help' for details\./);
  assert.doesNotMatch(stdout.read(), /\n  summarize\s+/);
});

test('run prints usage for help flag', async () => {
  const stdout = createWritableCapture();

  await run(['--help'], stdout.stream);

  assert.match(stdout.read(), /ghcrawl <command> \[options\]/);
  assert.match(stdout.read(), /\n  doctor\s+/);
  assert.match(stdout.read(), /\n  neighbors\s+/);
  assert.doesNotMatch(stdout.read(), /\n  summarize\s+/);
});

test('run prints dev-only commands when dev mode is enabled', async () => {
  const stdout = createWritableCapture();

  await run(['--dev', '--help'], stdout.stream);

  assert.match(stdout.read(), /\n  summarize\s+/);
  assert.match(stdout.read(), /\n  purge-comments\s+/);
});

test('help <command> works for every public command', async () => {
  for (const command of publicCommands) {
    const stdout = createWritableCapture();
    await run(['help', command], stdout.stream);
    assert.match(stdout.read(), new RegExp(`^ghcrawl ${command}`));
    assert.match(stdout.read(), /Examples:/);
  }
});

test('<command> --help works for every public command', async () => {
  for (const command of publicCommands) {
    const stdout = createWritableCapture();
    await run([command, '--help'], stdout.stream);
    assert.match(stdout.read(), new RegExp(`^ghcrawl ${command}`));
  }
});

test('<command> -h works for every public command', async () => {
  for (const command of publicCommands) {
    const stdout = createWritableCapture();
    await run([command, '-h'], stdout.stream);
    assert.match(stdout.read(), new RegExp(`^ghcrawl ${command}`));
  }
});

test('dev-only command help is gated behind dev mode', async () => {
  const stderr = createWritableCapture();
  const code = await runCli(['help', 'summarize'], { stderr: stderr.stream });

  assert.equal(code, 2);
  assert.match(stderr.read(), /Unknown command: summarize/);

  const stdout = createWritableCapture();
  await run(['--dev', 'help', 'summarize'], stdout.stream);
  assert.match(stdout.read(), /^ghcrawl summarize/);
});

test('run prints version for version command', async () => {
  const stdout = createWritableCapture();

  await run(['version'], stdout.stream);
  assert.match(stdout.read(), /^\d+\.\d+\.\d+/);
});

test('run prints version for --version flag', async () => {
  const stdout = createWritableCapture();

  await run(['--version'], stdout.stream);
  assert.match(stdout.read(), /^\d+\.\d+\.\d+/);
});

test('run prints pretty doctor output on a tty', async () => {
  const stdout = createWritableCapture(true);
  const context = makeRunContext();

  try {
    await run(['doctor'], stdout.stream, { env: context.env, cwd: context.cwd });
  } finally {
    context.cleanup();
  }

  assert.match(stdout.read(), /ghcrawl doctor/);
  assert.match(stdout.read(), /version: \d+\.\d+\.\d+/);
  assert.match(stdout.read(), /Health/);
  assert.doesNotMatch(stdout.read(), /^\s*\{/m);
});

test('run prints json doctor output when explicitly requested', async () => {
  const stdout = createWritableCapture(true);
  const context = makeRunContext();

  try {
    await run(['doctor', '--json'], stdout.stream, { env: context.env, cwd: context.cwd });
  } finally {
    context.cleanup();
  }

  assert.match(stdout.read(), /"version":/);
  assert.match(stdout.read(), /"health"/);
  assert.match(stdout.read(), /"github"/);
});

test('configure prints current persisted settings and cost estimates', async () => {
  const stdout = createWritableCapture(true);
  const context = makeRunContext();

  try {
    await run(['configure'], stdout.stream, { env: context.env, cwd: context.cwd });
  } finally {
    context.cleanup();
  }

  assert.match(stdout.read(), /ghcrawl configure/);
  assert.match(stdout.read(), /summary model: gpt-5-mini/);
  assert.match(stdout.read(), /embedding basis: title_original/);
  assert.match(stdout.read(), /gpt-5\.4-mini: ~\$30 USD/);
});

test('configure persists summary model changes', async () => {
  const stdout = createWritableCapture();
  const context = makeRunContext();

  try {
    await run(['configure', '--summary-model', 'gpt-5.4-mini', '--json'], stdout.stream, {
      env: context.env,
      cwd: context.cwd,
    });
    const persisted = readPersistedConfig({ env: context.env, cwd: context.cwd });
    assert.equal(persisted.data.summaryModel, 'gpt-5.4-mini');
  } finally {
    context.cleanup();
  }
});

test('unknown command exits with code 2 and a top-level help hint', async () => {
  const stderr = createWritableCapture();
  const code = await runCli(['wat'], { stderr: stderr.stream });

  assert.equal(code, 2);
  assert.match(stderr.read(), /Unknown command: wat/);
  assert.match(stderr.read(), /Run 'ghcrawl --help' for usage\./);
});

test('missing required flags exit with code 2 and command-specific hints', async () => {
  const cases = [
    { argv: ['author', 'openclaw/openclaw'], message: /Missing --login/, hint: /Run 'ghcrawl author --help' for usage\./ },
    { argv: ['close-thread', 'openclaw/openclaw'], message: /Missing --number/, hint: /Run 'ghcrawl close-thread --help' for usage\./ },
    { argv: ['cluster-detail', 'openclaw/openclaw'], message: /Missing --id/, hint: /Run 'ghcrawl cluster-detail --help' for usage\./ },
  ];

  for (const testCase of cases) {
    const stderr = createWritableCapture();
    const code = await runCli(testCase.argv, { stderr: stderr.stream });
    assert.equal(code, 2);
    assert.match(stderr.read(), testCase.message);
    assert.match(stderr.read(), testCase.hint);
  }
});

test('invalid enum and value parsing exits with code 2', async () => {
  const context = makeRunContext();

  try {
    {
      const stderr = createWritableCapture();
      const code = await runCli(['search', 'openclaw/openclaw', '--query', 'download stalls', '--mode', 'bogus'], {
        stderr: stderr.stream,
        env: context.env,
        cwd: context.cwd,
      });
      assert.equal(code, 2);
      assert.match(stderr.read(), /Invalid --mode: bogus/);
    }

    {
      const stderr = createWritableCapture();
      const code = await runCli(['clusters', 'openclaw/openclaw', '--limit', 'nope'], {
        stderr: stderr.stream,
        env: context.env,
        cwd: context.cwd,
      });
      assert.equal(code, 2);
      assert.match(stderr.read(), /Invalid --limit: nope/);
    }
  } finally {
    context.cleanup();
  }
});

test('agent-facing command help advertises explicit --json', async () => {
  for (const command of [
    'doctor',
    'sync',
    'refresh',
    'threads',
    'author',
    'close-thread',
    'close-cluster',
    'exclude-cluster-member',
    'embed',
    'cluster',
    'clusters',
    'durable-clusters',
    'cluster-detail',
    'search',
    'neighbors',
  ] as const) {
    const stdout = createWritableCapture();
    await run([command, '--help'], stdout.stream);
    assert.match(stdout.read(), /--json/);
  }
});

test('parseRepoFlags accepts explicit json flag for repo-backed commands', () => {
  const parsed = parseRepoFlags('threads', ['openclaw/openclaw', '--json']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.json, true);
});

test('compatibility path keeps json-by-default commands working without --json', async () => {
  const stdout = createWritableCapture();
  const context = makeRunContext();
  const original = GHCrawlService.prototype.listThreads;

  GHCrawlService.prototype.listThreads = function listThreadsStub() {
    return { threads: [{ number: 42 }] } as never;
  };

  try {
    await run(['threads', 'openclaw/openclaw', '--numbers', '42'], stdout.stream, {
      env: context.env,
      cwd: context.cwd,
    });
  } finally {
    GHCrawlService.prototype.listThreads = original;
    context.cleanup();
  }

  assert.match(stdout.read(), /"threads"/);
});

test('exclude-cluster-member command forwards durable override inputs', async () => {
  const stdout = createWritableCapture();
  const context = makeRunContext();
  const original = GHCrawlService.prototype.excludeThreadFromCluster;
  let received: unknown;

  GHCrawlService.prototype.excludeThreadFromCluster = function excludeThreadFromClusterStub(params: unknown) {
    received = params;
    return {
      ok: true,
      clusterId: 7,
      thread: { number: 42 },
      action: 'exclude',
      state: 'removed_by_user',
      message: 'removed',
    } as never;
  };

  try {
    await run(['exclude-cluster-member', 'openclaw/openclaw', '--id', '7', '--number', '42', '--reason', 'false positive'], stdout.stream, {
      env: context.env,
      cwd: context.cwd,
    });
  } finally {
    GHCrawlService.prototype.excludeThreadFromCluster = original;
    context.cleanup();
  }

  assert.deepEqual(received, {
    owner: 'openclaw',
    repo: 'openclaw',
    clusterId: 7,
    threadNumber: 42,
    reason: 'false positive',
  });
  assert.match(stdout.read(), /"state": "removed_by_user"/);
});

test('durable-clusters command forwards stable cluster list options', async () => {
  const stdout = createWritableCapture();
  const context = makeRunContext();
  const original = GHCrawlService.prototype.listDurableClusters;
  let received: unknown;

  GHCrawlService.prototype.listDurableClusters = function listDurableClustersStub(params: unknown) {
    received = params;
    return { repository: { fullName: 'openclaw/openclaw' }, clusters: [{ stableSlug: 'trace-alpha-river' }] } as never;
  };

  try {
    await run(['durable-clusters', 'openclaw/openclaw', '--include-inactive', '--member-limit', '5'], stdout.stream, {
      env: context.env,
      cwd: context.cwd,
    });
  } finally {
    GHCrawlService.prototype.listDurableClusters = original;
    context.cleanup();
  }

  assert.deepEqual(received, {
    owner: 'openclaw',
    repo: 'openclaw',
    includeInactive: true,
    memberLimit: 5,
  });
  assert.match(stdout.read(), /trace-alpha-river/);
});

test('long-running command progress stays on stderr and payload stays on stdout', async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  const context = makeRunContext();
  const original = GHCrawlService.prototype.syncRepository;

  GHCrawlService.prototype.syncRepository = async function syncRepositoryStub({
    onProgress,
  }: {
    onProgress?: (message: string) => void;
  }) {
    onProgress?.('[sync] started');
    return { ok: true, repository: 'openclaw/openclaw' } as never;
  };

  try {
    await run(['sync', 'openclaw/openclaw', '--limit', '1', '--json'], stdout.stream, {
      stderr: stderr.stream,
      env: context.env,
      cwd: context.cwd,
    });
  } finally {
    GHCrawlService.prototype.syncRepository = original;
    context.cleanup();
  }

  assert.match(stderr.read(), /\[sync] started/);
  assert.match(stdout.read(), /"ok": true/);
  assert.doesNotMatch(stdout.read(), /\[sync] started/);
});

test('sync command forwards include-code hydration flag', async () => {
  const stdout = createWritableCapture();
  const context = makeRunContext();
  const original = GHCrawlService.prototype.syncRepository;
  let received: unknown;

  GHCrawlService.prototype.syncRepository = async function syncRepositoryStub(params: unknown) {
    received = params;
    return { runId: 1, threadsSynced: 1, commentsSynced: 0, codeFilesSynced: 1, threadsClosed: 0 } as never;
  };

  try {
    await run(['sync', 'openclaw/openclaw', '--include-code'], stdout.stream, {
      env: context.env,
      cwd: context.cwd,
    });
  } finally {
    GHCrawlService.prototype.syncRepository = original;
    context.cleanup();
  }

  assert.equal((received as { includeCode?: boolean }).includeCode, true);
  assert.match(stdout.read(), /"codeFilesSynced": 1/);
});

test('refresh command forwards include-code hydration flag', async () => {
  const stdout = createWritableCapture();
  const context = makeRunContext();
  const original = GHCrawlService.prototype.refreshRepository;
  let received: unknown;

  GHCrawlService.prototype.refreshRepository = async function refreshRepositoryStub(params: unknown) {
    received = params;
    return {
      repository: { fullName: 'openclaw/openclaw' },
      selected: { sync: true, embed: true, cluster: true },
      sync: { codeFilesSynced: 1 },
      embed: null,
      cluster: null,
    } as never;
  };

  try {
    await run(['refresh', 'openclaw/openclaw', '--include-code'], stdout.stream, {
      env: context.env,
      cwd: context.cwd,
    });
  } finally {
    GHCrawlService.prototype.refreshRepository = original;
    context.cleanup();
  }

  assert.equal((received as { includeCode?: boolean }).includeCode, true);
  assert.match(stdout.read(), /"codeFilesSynced": 1/);
});

test('parseOwnerRepo accepts owner slash repo syntax', () => {
  assert.deepEqual(parseOwnerRepo('openclaw/openclaw'), { owner: 'openclaw', repo: 'openclaw' });
});

test('parseRepoFlags accepts repo flag with owner slash repo syntax', () => {
  const parsed = parseRepoFlags('sync', ['--repo', 'openclaw/openclaw', '--limit', '1']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.limit, '1');
});

test('parseRepoFlags accepts positional owner slash repo syntax', () => {
  const parsed = parseRepoFlags('sync', ['openclaw/openclaw', '--limit', '2']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.limit, '2');
});

test('parseRepoFlags accepts include-comments boolean flag', () => {
  const parsed = parseRepoFlags('sync', ['openclaw/openclaw', '--include-comments']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['include-comments'], true);
});

test('parseRepoFlags accepts include-code boolean flag', () => {
  const parsed = parseRepoFlags('sync', ['openclaw/openclaw', '--include-code']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['include-code'], true);
});

test('parseRepoFlags accepts full-reconcile boolean flag', () => {
  const parsed = parseRepoFlags('sync', ['openclaw/openclaw', '--full-reconcile']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['full-reconcile'], true);
});

test('parseRepoFlags accepts include-closed boolean flag', () => {
  const parsed = parseRepoFlags('threads', ['openclaw/openclaw', '--include-closed']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['include-closed'], true);
});

test('parseRepoFlags accepts include-inactive durable cluster flag', () => {
  const parsed = parseRepoFlags('durable-clusters', ['openclaw/openclaw', '--include-inactive']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['include-inactive'], true);
});

test('parseRepoFlags accepts kind filter for threads', () => {
  const parsed = parseRepoFlags('threads', ['openclaw/openclaw', '--kind', 'pull_request']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.kind, 'pull_request');
});

test('parseRepoFlags accepts exclusion reason', () => {
  const parsed = parseRepoFlags('exclude-cluster-member', ['openclaw/openclaw', '--id', '7', '--number', '42', '--reason', 'false positive']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.reason, 'false positive');
});

test('parseRepoFlags accepts heap diagnostics options', () => {
  const parsed = parseRepoFlags('cluster', ['openclaw/openclaw', '--heap-snapshot-dir', './tmp/heaps', '--heap-log-interval-ms', '5000']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['heap-snapshot-dir'], './tmp/heaps');
  assert.equal(parsed.values['heap-log-interval-ms'], '5000');
});

test('resolveSinceValue keeps ISO timestamps', () => {
  assert.equal(resolveSinceValue('2026-03-01T00:00:00Z'), '2026-03-01T00:00:00.000Z');
});

test('resolveSinceValue parses minute duration shorthand', () => {
  const now = new Date('2026-03-09T12:00:00Z');
  assert.equal(resolveSinceValue('15m', now), '2026-03-09T11:45:00.000Z');
});

test('resolveSinceValue parses month duration shorthand', () => {
  const now = new Date('2026-03-09T12:00:00Z');
  assert.equal(resolveSinceValue('1mo', now), '2026-02-09T12:00:00.000Z');
});

test('resolveSinceValue rejects unsupported syntax', () => {
  assert.throws(() => resolveSinceValue('yesterday'), /Invalid --since value/);
});

test('formatLogLine prefixes ISO timestamps with millisecond resolution', () => {
  assert.equal(formatLogLine('[sync] hello', new Date('2026-03-09T12:34:56.789Z')), '[2026-03-09T12:34:56.789Z] [sync] hello');
});

test('formatDoctorReport renders a human-readable health summary', () => {
  const rendered = formatDoctorReport({
    version: '0.0.0',
    health: {
      ok: true,
      configPath: '/tmp/config.json',
      configFileExists: true,
      dbPath: '/tmp/ghcrawl.db',
      apiPort: 5179,
      githubConfigured: true,
      openaiConfigured: true,
    },
    github: {
      configured: true,
      source: 'config',
      formatOk: true,
      authOk: true,
      error: null,
    },
    openai: {
      configured: false,
      source: 'none',
      formatOk: false,
      authOk: false,
      error: 'missing',
    },
    vectorlite: {
      configured: true,
      runtimeOk: true,
      error: null,
    },
  });

  assert.match(rendered, /config path: \/tmp\/config\.json/);
  assert.match(rendered, /version: 0\.0\.0/);
  assert.match(rendered, /GitHub/);
  assert.match(rendered, /OpenAI/);
  assert.match(rendered, /note: missing/);
});

test('getExitCode returns 1 for unknown runtime failures', () => {
  assert.equal(getExitCode(new Error('boom')), 1);
});

test('published cli package exposes ghcrawl and compatibility gitcrawl bin shims', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(here, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: Record<string, string> };
  const ghcrawlBinPath = packageJson.bin?.ghcrawl;
  const gitcrawlBinPath = packageJson.bin?.gitcrawl;

  assert.equal(typeof ghcrawlBinPath, 'string');
  assert.equal(typeof gitcrawlBinPath, 'string');
  assert.equal(ghcrawlBinPath, './bin/ghcrawl.js');
  assert.equal(gitcrawlBinPath, './bin/ghcrawl.js');
  assert.equal(existsSync(path.resolve(here, '..', ghcrawlBinPath)), true);
});
