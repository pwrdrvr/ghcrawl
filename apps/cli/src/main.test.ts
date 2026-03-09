import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOwnerRepo, parseRepoFlags, run } from './main.js';

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
