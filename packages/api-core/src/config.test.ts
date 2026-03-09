import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getConfigPath,
  isLikelyGitHubToken,
  isLikelyOpenAiApiKey,
  loadConfig,
  readPersistedConfig,
  writePersistedConfig,
} from './config.js';

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-config-test-'));
}

test('loadConfig prefers persisted config and stores defaults under the user config directory', () => {
  const home = makeTempHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  const env = {
    ...process.env,
    HOME: home,
  };

  writePersistedConfig(
    {
      githubToken: 'ghp_testtoken1234567890',
      openaiApiKey: 'sk-proj-testkey1234567890',
      apiPort: 6123,
      embedConcurrency: 12,
    },
    { env },
  );

  const config = loadConfig({ cwd: workspace, env });
  assert.equal(config.configPath, path.join(home, '.config', 'gitcrawl', 'config.json'));
  assert.equal(config.configFileExists, true);
  assert.equal(config.apiPort, 6123);
  assert.equal(config.embedConcurrency, 12);
  assert.equal(config.githubTokenSource, 'config');
  assert.equal(config.openaiApiKeySource, 'config');
  assert.equal(config.dbPath, path.join(home, '.config', 'gitcrawl', 'gitcrawl.db'));
});

test('loadConfig lets environment variables override persisted config', () => {
  const home = makeTempHome();
  const env = {
    ...process.env,
    HOME: home,
    GITHUB_TOKEN: 'ghp_override1234567890',
    GITCRAWL_API_PORT: '7001',
  };

  writePersistedConfig(
    {
      githubToken: 'ghp_stored1234567890',
      openaiApiKey: 'sk-proj-stored1234567890',
      apiPort: 6123,
    },
    { env },
  );

  const config = loadConfig({ cwd: process.cwd(), env });
  assert.equal(config.githubToken, 'ghp_override1234567890');
  assert.equal(config.githubTokenSource, 'env');
  assert.equal(config.apiPort, 7001);
});

test('loadConfig falls back to repo .env.local when no persisted config exists', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  fs.writeFileSync(
    path.join(workspace, '.env.local'),
    ['GITHUB_TOKEN=ghp_dotenv1234567890', 'OPENAI_API_KEY=sk-proj-dotenv1234567890', 'GITCRAWL_API_PORT=6111'].join('\n'),
  );

  const config = loadConfig({
    cwd: workspace,
    env: {
      ...process.env,
      HOME: makeTempHome(),
    },
  });

  assert.equal(config.githubTokenSource, 'dotenv');
  assert.equal(config.openaiApiKeySource, 'dotenv');
  assert.equal(config.apiPort, 6111);
});

test('loadConfig reuses an existing legacy workspace database when no explicit db path is configured', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'data', 'gitcrawl.db'), '');

  const config = loadConfig({
    cwd: workspace,
    env: {
      ...process.env,
      HOME: makeTempHome(),
    },
  });

  assert.equal(config.dbPath, path.join(workspace, 'data', 'gitcrawl.db'));
});

test('writePersistedConfig creates a readable config file', () => {
  const home = makeTempHome();
  const env = {
    ...process.env,
    HOME: home,
  };

  const { configPath } = writePersistedConfig(
    {
      githubToken: 'ghp_testtoken1234567890',
      openaiApiKey: 'sk-proj-testkey1234567890',
    },
    { env },
  );

  assert.equal(configPath, getConfigPath({ env }));
  assert.equal(fs.existsSync(configPath), true);

  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.githubToken, 'ghp_testtoken1234567890');
  assert.equal(persisted.data.openaiApiKey, 'sk-proj-testkey1234567890');
});

test('getConfigPath uses APPDATA on Windows', () => {
  const configPath = getConfigPath({
    env: {
      ...process.env,
      APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
    },
    platform: 'win32',
  });

  assert.equal(configPath, path.resolve('C:\\Users\\example\\AppData\\Roaming', 'gitcrawl', 'config.json'));
});

test('loadConfig rejects invalid port', () => {
  const home = makeTempHome();
  assert.throws(() =>
    loadConfig({
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, GITCRAWL_API_PORT: 'abc' },
    }),
  );
});

test('loadConfig rejects invalid embed queue settings', () => {
  const home = makeTempHome();
  assert.throws(() =>
    loadConfig({
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, GITCRAWL_EMBED_CONCURRENCY: '0' },
    }),
  );
});

test('token format helpers match expected API key shapes', () => {
  assert.equal(isLikelyGitHubToken('ghp_testtoken1234567890'), true);
  assert.equal(isLikelyGitHubToken('github_pat_1234567890abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(isLikelyGitHubToken('not-a-token'), false);

  assert.equal(isLikelyOpenAiApiKey('sk-proj-testkey1234567890'), true);
  assert.equal(isLikelyOpenAiApiKey('sk-testkey1234567890'), true);
  assert.equal(isLikelyOpenAiApiKey('openai-key'), false);
});
