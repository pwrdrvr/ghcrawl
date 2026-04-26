#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const binDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(binDir, '..', '..', '..');
const distEntrypoint = path.join(binDir, '..', 'dist', 'main.js');
const sourceEntrypoint = path.join(binDir, '..', 'src', 'main.ts');
const nodeVersionPath = path.join(repoRoot, '.node-version');

if (!process.env.GHCRAWL_NODE_REEXEC && existsSync(nodeVersionPath)) {
  const desiredNodeVersion = readFileSync(nodeVersionPath, 'utf8').trim();
  if (desiredNodeVersion) {
    const nodenvResult = spawnSync('nodenv', ['which', 'node'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODENV_VERSION: desiredNodeVersion,
      },
    });
    const nodenvNode = nodenvResult.status === 0 ? nodenvResult.stdout.trim() : '';
    if (nodenvNode && path.resolve(nodenvNode) !== path.resolve(process.execPath)) {
      const child = spawn(nodenvNode, process.argv.slice(1), {
        stdio: 'inherit',
        env: {
          ...process.env,
          GHCRAWL_NODE_REEXEC: '1',
          NODENV_VERSION: desiredNodeVersion,
        },
      });

      child.on('exit', (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 0);
      });

      child.on('error', (error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });

      await new Promise(() => undefined);
    }
  }
}

function isDistFresh() {
  if (!existsSync(distEntrypoint)) return false;
  if (!existsSync(sourceEntrypoint)) return true;
  try {
    return statSync(distEntrypoint).mtimeMs >= statSync(sourceEntrypoint).mtimeMs;
  } catch {
    return false;
  }
}

if (process.env.GHCRAWL_DEV_SOURCE !== '1' && isDistFresh()) {
  const entrypoint = await import(pathToFileURL(distEntrypoint).href);
  const exitCode =
    typeof entrypoint.runCli === 'function'
      ? await entrypoint.runCli(process.argv.slice(2))
      : (await entrypoint.run(process.argv.slice(2)), 0);
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
} else {
  const require = createRequire(import.meta.url);
  const tsxLoader = require.resolve('tsx');
  const child = spawn(process.execPath, ['--conditions=development', '--import', tsxLoader, sourceEntrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
