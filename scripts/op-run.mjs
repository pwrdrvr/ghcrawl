#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

function resolveHomeDirectory(env) {
  return path.resolve(env.HOME ?? env.USERPROFILE ?? os.homedir());
}

function getConfigPath(env = process.env) {
  if (env.XDG_CONFIG_HOME) {
    return path.resolve(env.XDG_CONFIG_HOME, 'ghcrawl', 'config.json');
  }
  if (process.platform === 'win32' && env.APPDATA) {
    return path.resolve(env.APPDATA, 'ghcrawl', 'config.json');
  }
  return path.join(resolveHomeDirectory(env), '.config', 'ghcrawl', 'config.json');
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ghcrawl config at ${configPath}. Run pnpm bootstrap first.`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function requireOpConfig(config, configPath) {
  if (config.secretProvider !== 'op') {
    throw new Error(
      `ghcrawl is not configured for 1Password CLI in ${configPath}. Re-run pnpm bootstrap and choose the 1Password CLI option.`,
    );
  }
  if (!config.opVaultName || !config.opItemName) {
    throw new Error(`Missing opVaultName/opItemName in ${configPath}. Re-run pnpm bootstrap.`);
  }
  return {
    vaultName: config.opVaultName,
    itemName: config.opItemName,
  };
}

function readSecret(reference) {
  return execFileSync('op', ['read', reference], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function tryReadSecret(reference) {
  try {
    return readSecret(reference);
  } catch {
    return undefined;
  }
}

function loadOpEnv(env = process.env) {
  const configPath = getConfigPath(env);
  const config = readConfig(configPath);
  const { vaultName, itemName } = requireOpConfig(config, configPath);
  return {
    ...env,
    GITHUB_TOKEN: readSecret(`op://${vaultName}/${itemName}/GITHUB_TOKEN`),
    OPENAI_API_KEY: tryReadSecret(`op://${vaultName}/${itemName}/OPENAI_API_KEY`),
  };
}

function runWithEnv(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: loadOpEnv(env),
    shell: false,
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

function runShell(env = process.env) {
  const shell =
    process.platform === 'win32'
      ? env.ComSpec ?? 'cmd.exe'
      : env.SHELL ?? '/bin/zsh';
  runWithEnv(shell, [], env);
}

function main(argv = process.argv.slice(2)) {
  const [mode, ...rest] = argv;
  if (!mode || mode === '--help' || mode === '-h') {
    process.stdout.write(
      [
        'Usage:',
        '  node scripts/op-run.mjs exec -- <ghcrawl args...>',
        '  node scripts/op-run.mjs shell',
        '',
        'Examples:',
        '  pnpm op:doctor',
        '  pnpm op:tui',
        '  pnpm op:exec -- sync openclaw/openclaw',
        '  pnpm op:shell',
        '',
      ].join('\n'),
    );
    return;
  }

  if (mode === 'shell') {
    runShell();
    return;
  }

  if (mode === 'exec') {
    const args = rest[0] === '--' ? rest.slice(1) : rest;
    if (args.length === 0) {
      throw new Error('Missing ghcrawl arguments. Example: pnpm op:exec -- doctor');
    }
    runWithEnv('pnpm', ['--filter', 'ghcrawl', 'cli', ...args]);
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
