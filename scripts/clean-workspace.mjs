#!/usr/bin/env node
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetKinds = new Set(process.argv.slice(2));

if (targetKinds.size === 0) {
  process.stderr.write('Usage: node ./scripts/clean-workspace.mjs <dist|tsbuildinfo> [...targets]\n');
  process.exit(1);
}

const skipDirNames = new Set(['.git', 'node_modules']);
const removed = [];

async function walk(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (skipDirNames.has(entry.name)) {
        continue;
      }
      if (entry.name === 'dist' && targetKinds.has('dist')) {
        await rm(entryPath, { recursive: true, force: true });
        removed.push(path.relative(rootDir, entryPath) || '.');
        continue;
      }
      await walk(entryPath);
      continue;
    }

    if (entry.isFile() && entry.name === 'tsconfig.tsbuildinfo' && targetKinds.has('tsbuildinfo')) {
      await rm(entryPath, { force: true });
      removed.push(path.relative(rootDir, entryPath));
    }
  }
}

await walk(rootDir);

if (removed.length === 0) {
  process.stdout.write('No matching build artifacts found.\n');
} else {
  for (const relativePath of removed.sort()) {
    process.stdout.write(`Removed ${relativePath}\n`);
  }
}
