import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatLogLine, parseOwnerRepo, parseRepoFlags, resolveSinceValue, run } from './main.js';

test('run prints usage with no command', async () => {
  let output = '';
  const stdout = {
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await run([], stdout);
  assert.match(output, /gitcrawl <command>/);
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
  assert.match(output, /gitcrawl <command>/);
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

test('published cli package exposes a gitcrawl bin shim', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.resolve(here, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { bin?: Record<string, string> };
  const binPath = packageJson.bin?.gitcrawl;

  assert.equal(typeof binPath, 'string');
  assert.equal(binPath, './bin/gitcrawl.js');
  assert.equal(existsSync(path.resolve(here, '..', binPath)), true);
});
