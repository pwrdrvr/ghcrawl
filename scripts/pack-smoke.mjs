import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const workspaceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-pack-smoke-'));
const tarballDir = path.join(tempRoot, 'tarballs');
const installDir = path.join(tempRoot, 'install');

mkdirSync(tarballDir, { recursive: true });
mkdirSync(installDir, { recursive: true });

try {
  const packageManifests = [
    loadPackageManifest('packages/api-contract/package.json'),
    loadPackageManifest('packages/api-core/package.json'),
    loadPackageManifest('apps/cli/package.json'),
  ];

  for (const manifest of packageManifests) {
    exec('pnpm', ['--filter', manifest.name, 'pack', '--pack-destination', tarballDir]);
  }

  const tarballs = readdirSync(tarballDir)
    .filter((entry) => entry.endsWith('.tgz'))
    .sort()
    .map((entry) => path.join(tarballDir, entry));

  if (tarballs.length !== packageManifests.length) {
    throw new Error(`Expected ${packageManifests.length} tarballs, found ${tarballs.length}`);
  }

  writeFileSync(
    path.join(installDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'ghcrawl-pack-smoke',
        private: true,
        version: '0.0.0',
        packageManager: 'npm@10.9.2',
      },
      null,
      2,
    )}\n`,
  );

  exec('npm', ['install', '--no-package-lock', ...tarballs], installDir);
  const cliManifest = packageManifests.find((manifest) => manifest.name === 'ghcrawl');
  if (!cliManifest || !cliManifest.bin || typeof cliManifest.bin.ghcrawl !== 'string') {
    throw new Error('Expected ghcrawl package with a ghcrawl bin');
  }
  exec('node', [path.join('node_modules', cliManifest.name, cliManifest.bin.ghcrawl), '--help'], installDir);

  process.stdout.write(`pack smoke ok (${tempRoot})\n`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function loadPackageManifest(relativePath) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  return JSON.parse(readFileSync(absolutePath, 'utf8'));
}

function exec(command, args, cwd = workspaceRoot) {
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
}
