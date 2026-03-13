import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const realBinPath = path.join(workspaceRoot, 'apps', 'cli', 'bin', 'ghcrawl.js');
const realBinSource = readFileSync(realBinPath, 'utf8');

function createFixture(): string {
  mkdirSync(path.join(workspaceRoot, 'tmp'), { recursive: true });
  const dir = mkdtempSync(path.join(workspaceRoot, 'tmp', 'ghcrawl-bin-test-'));
  mkdirSync(path.join(dir, 'bin'));
  writeFileSync(path.join(dir, 'bin', 'ghcrawl.js'), realBinSource, 'utf8');
  writeFileSync(path.join(dir, 'tsconfig.runtime.json'), JSON.stringify({ compilerOptions: { module: 'nodenext' } }), 'utf8');
  return dir;
}

function runFixture(binDir: string): string {
  return execFileSync(process.execPath, [path.join(binDir, 'bin', 'ghcrawl.js')], {
    cwd: binDir,
    encoding: 'utf8',
  }).trim();
}

test('bin launcher prefers source when source and dist are both present', () => {
  const fixtureDir = createFixture();
  try {
    mkdirSync(path.join(fixtureDir, 'src'));
    mkdirSync(path.join(fixtureDir, 'dist'));
    writeFileSync(path.join(fixtureDir, 'src', 'main.ts'), "process.stdout.write('source');\n", 'utf8');
    writeFileSync(path.join(fixtureDir, 'dist', 'main.js'), "export async function run() { process.stdout.write('dist'); }\n", 'utf8');

    assert.equal(runFixture(fixtureDir), 'source');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('bin launcher falls back to dist when source is absent', () => {
  const fixtureDir = createFixture();
  try {
    mkdirSync(path.join(fixtureDir, 'dist'));
    writeFileSync(path.join(fixtureDir, 'dist', 'main.js'), "export async function run() { process.stdout.write('dist'); }\n", 'utf8');

    assert.equal(runFixture(fixtureDir), 'dist');
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
