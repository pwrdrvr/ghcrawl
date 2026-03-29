#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const binDir = path.dirname(fileURLToPath(import.meta.url));
const distEntrypoint = path.join(binDir, '..', 'dist', 'main.js');
const sourceEntrypoint = path.join(binDir, '..', 'src', 'main.ts');

if (!existsSync(sourceEntrypoint) && existsSync(distEntrypoint)) {
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
