import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatDoctorReport, formatLogLine, parseOwnerRepo, parseRepoFlags, resolveSinceValue, run } from './main.js';

test('run prints usage with no command', async () => {
  let output = '';
  const stdout = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run([], stdout);
  assert.match(output, /ghcrawl <command>/);
  assert.match(output, /\n  version\n/);
  assert.match(output, /refresh <owner\/repo>/);
  assert.match(output, /threads <owner\/repo>/);
  assert.match(output, /author <owner\/repo> --login <user>/);
  assert.match(output, /close-thread <owner\/repo> --number <thread>/);
  assert.match(output, /close-cluster <owner\/repo> --id <cluster-id>/);
  assert.match(output, /clusters <owner\/repo>/);
  assert.match(output, /cluster-detail <owner\/repo>/);
  assert.match(output, /tui \[owner\/repo\]/);
  assert.doesNotMatch(output, /summarize <owner\/repo>/);
});

test('run prints usage for help flag', async () => {
  let output = '';
  const stdout = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run(['--help'], stdout);
  assert.match(output, /ghcrawl <command>/);
  assert.match(output, /\n  version\n/);
  assert.match(output, /refresh <owner\/repo>/);
  assert.match(output, /threads <owner\/repo>/);
  assert.match(output, /author <owner\/repo> --login <user>/);
  assert.match(output, /close-thread <owner\/repo> --number <thread>/);
  assert.match(output, /tui \[owner\/repo\]/);
  assert.doesNotMatch(output, /summarize <owner\/repo>/);
});

test('run prints advanced commands when dev mode is enabled', async () => {
  let output = '';
  const stdout = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run(['--dev', '--help'], stdout);
  assert.match(output, /Advanced Commands:/);
  assert.match(output, /summarize <owner\/repo>/);
  assert.match(output, /purge-comments <owner\/repo>/);
});

test('run prints version for version command', async () => {
  let output = '';
  const stdout = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run(['version'], stdout);
  assert.match(output, /^\d+\.\d+\.\d+/);
});

test('run prints version for --version flag', async () => {
  let output = '';
  const stdout = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run(['--version'], stdout);
  assert.match(output, /^\d+\.\d+\.\d+/);
});

test('run prints pretty doctor output on a tty', async () => {
  let output = '';
  const stdout = {
    isTTY: true,
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run(['doctor'], stdout);
  assert.match(output, /ghcrawl doctor/);
  assert.match(output, /version: \d+\.\d+\.\d+/);
  assert.match(output, /Health/);
  assert.doesNotMatch(output, /^\s*\{/m);
});

test('run prints json doctor output when explicitly requested', async () => {
  let output = '';
  const stdout = {
    isTTY: true,
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run(['doctor', '--json'], stdout);
  assert.match(output, /"version":/);
  assert.match(output, /"health"/);
  assert.match(output, /"github"/);
});

test('parseOwnerRepo accepts owner slash repo syntax', () => {
  assert.deepEqual(parseOwnerRepo('openclaw/openclaw'), { owner: 'openclaw', repo: 'openclaw' });
});

test('parseRepoFlags accepts repo flag with owner slash repo syntax', () => {
  const parsed = parseRepoFlags(['--repo', 'openclaw/openclaw', '--limit', '1']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.limit, '1');
});

test('parseRepoFlags accepts positional owner slash repo syntax', () => {
  const parsed = parseRepoFlags(['openclaw/openclaw', '--limit', '2']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.limit, '2');
});

test('parseRepoFlags accepts include-comments boolean flag', () => {
  const parsed = parseRepoFlags(['openclaw/openclaw', '--include-comments']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['include-comments'], true);
});

test('parseRepoFlags accepts full-reconcile boolean flag', () => {
  const parsed = parseRepoFlags(['openclaw/openclaw', '--full-reconcile']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['full-reconcile'], true);
});

test('parseRepoFlags accepts include-closed boolean flag', () => {
  const parsed = parseRepoFlags(['openclaw/openclaw', '--include-closed']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values['include-closed'], true);
});

test('parseRepoFlags accepts kind filter for threads', () => {
  const parsed = parseRepoFlags(['openclaw/openclaw', '--kind', 'pull_request']);
  assert.equal(parsed.owner, 'openclaw');
  assert.equal(parsed.repo, 'openclaw');
  assert.equal(parsed.values.kind, 'pull_request');
});

test('parseRepoFlags accepts heap diagnostics options', () => {
  const parsed = parseRepoFlags(['openclaw/openclaw', '--heap-snapshot-dir', './tmp/heaps', '--heap-log-interval-ms', '5000']);
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
  });

  assert.match(rendered, /config path: \/tmp\/config\.json/);
  assert.match(rendered, /version: 0\.0\.0/);
  assert.match(rendered, /GitHub/);
  assert.match(rendered, /OpenAI/);
  assert.match(rendered, /note: missing/);
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
