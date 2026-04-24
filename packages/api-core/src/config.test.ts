import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getConfigPath,
  getTuiRepositoryPreference,
  loadConfig,
  readPersistedConfig,
  writeTuiRepositoryPreference,
  writePersistedConfig,
} from './config.js';

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-config-test-'));
}

function makeTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: undefined,
    APPDATA: undefined,
    ...overrides,
  };
}

test('loadConfig prefers persisted config and stores defaults under the user config directory', () => {
  const home = makeTempHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  const env = {
    ...makeTestEnv(),
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
  assert.equal(config.configPath, path.join(home, '.config', 'ghcrawl', 'config.json'));
  assert.equal(config.configFileExists, true);
  assert.equal(config.apiPort, 6123);
  assert.equal(config.embedConcurrency, 12);
  assert.equal(config.githubTokenSource, 'config');
  assert.equal(config.openaiApiKeySource, 'config');
  assert.equal(config.dbPath, path.join(home, '.config', 'ghcrawl', 'ghcrawl.db'));
  assert.equal(config.summaryModel, 'gpt-5-mini');
  assert.equal(config.embeddingBasis, 'title_original');
  assert.equal(config.vectorBackend, 'vectorlite');
});

test('loadConfig lets environment variables override persisted config', () => {
  const home = makeTempHome();
  const env = {
    ...makeTestEnv(),
    HOME: home,
    GITHUB_TOKEN: 'ghp_override1234567890',
    GHCRAWL_API_PORT: '7001',
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  fs.writeFileSync(
    path.join(workspace, '.env.local'),
    ['GITHUB_TOKEN=ghp_dotenv1234567890', 'OPENAI_API_KEY=sk-proj-dotenv1234567890', 'GHCRAWL_API_PORT=6111'].join('\n'),
  );

  const config = loadConfig({
    cwd: workspace,
    env: {
      ...makeTestEnv(),
      HOME: makeTempHome(),
    },
  });

  assert.equal(config.githubTokenSource, 'dotenv');
  assert.equal(config.openaiApiKeySource, 'dotenv');
  assert.equal(config.apiPort, 6111);
});

test('loadConfig reuses an existing workspace database when no explicit db path is configured', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'data', 'ghcrawl.db'), '');

  const config = loadConfig({
    cwd: workspace,
    env: {
      ...makeTestEnv(),
      HOME: makeTempHome(),
    },
  });

  assert.equal(config.dbPath, path.join(workspace, 'data', 'ghcrawl.db'));
});

test('workspace root override changes dotenv and workspace database discovery', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-cwd-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, '.env.local'), 'GHCRAWL_API_PORT=6222\n');
  fs.mkdirSync(path.join(workspace, 'data'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'data', 'ghcrawl.db'), '');

  const config = loadConfig({
    cwd,
    workspaceRootOverride: workspace,
    env: {
      ...makeTestEnv(),
      HOME: makeTempHome(),
    },
  });

  assert.equal(config.workspaceRoot, workspace);
  assert.equal(config.apiPort, 6222);
  assert.equal(config.dbPath, path.join(workspace, 'data', 'ghcrawl.db'));
});

test('writePersistedConfig creates a readable config file', () => {
  const home = makeTempHome();
  const env = {
    ...makeTestEnv(),
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

test('persisted config round-trips summary model, embedding basis, and vector backend', () => {
  const home = makeTempHome();
  const env = {
    ...makeTestEnv(),
    HOME: home,
  };

  writePersistedConfig(
    {
      githubToken: 'ghp_testtoken1234567890',
      openaiApiKey: 'sk-proj-testkey1234567890',
      summaryModel: 'gpt-5.4-mini',
      embeddingBasis: 'title_original',
      vectorBackend: 'vectorlite',
    },
    { env },
  );

  const loaded = loadConfig({ env, cwd: process.cwd() });
  assert.equal(loaded.summaryModel, 'gpt-5.4-mini');
  assert.equal(loaded.embeddingBasis, 'title_original');
  assert.equal(loaded.vectorBackend, 'vectorlite');
});

test('config path override redirects persisted config reads and writes', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  const overridePath = path.join(workspace, '.tmp-config', 'custom-config.json');
  const env = {
    ...makeTestEnv(),
    HOME: makeTempHome(),
  };

  const { configPath } = writePersistedConfig(
    {
      githubToken: 'ghp_override1234567890',
      openaiApiKey: 'sk-proj-override1234567890',
    },
    { env, cwd: workspace, configPathOverride: overridePath },
  );

  assert.equal(configPath, overridePath);
  assert.equal(fs.existsSync(overridePath), true);

  const persisted = readPersistedConfig({ env, cwd: workspace, configPathOverride: overridePath });
  assert.equal(persisted.configPath, overridePath);
  assert.equal(persisted.data.githubToken, 'ghp_override1234567890');

  const loaded = loadConfig({ env, cwd: workspace, configPathOverride: overridePath });
  assert.equal(loaded.configPath, overridePath);
  assert.equal(loaded.configDir, path.dirname(overridePath));
});

test('loadConfig restores repository tui preferences', () => {
  const home = makeTempHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  const env = {
    ...makeTestEnv(),
    HOME: home,
  };

  writePersistedConfig(
    {
      tuiPreferences: {
        'openclaw/openclaw': {
          minClusterSize: 1,
          sortMode: 'size',
          wideLayout: 'right-stack',
        },
      },
    },
    { env },
  );

  const config = loadConfig({ cwd: workspace, env });
  assert.deepEqual(getTuiRepositoryPreference(config, 'openclaw', 'openclaw'), {
    minClusterSize: 1,
    sortMode: 'size',
    wideLayout: 'right-stack',
  });
});

test('writeTuiRepositoryPreference persists sort and min cluster size by repository', () => {
  const home = makeTempHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-workspace-'));
  fs.writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  const env = {
    ...makeTestEnv(),
    HOME: home,
  };

  const config = loadConfig({ cwd: workspace, env });
  writeTuiRepositoryPreference(config, {
    owner: 'openclaw',
    repo: 'openclaw',
    minClusterSize: 1,
    sortMode: 'size',
    wideLayout: 'right-stack',
  });

  const reloaded = loadConfig({ cwd: workspace, env });
  assert.deepEqual(getTuiRepositoryPreference(reloaded, 'openclaw', 'openclaw'), {
    minClusterSize: 1,
    sortMode: 'size',
    wideLayout: 'right-stack',
  });
  assert.deepEqual(getTuiRepositoryPreference(reloaded, 'other', 'repo'), {
    minClusterSize: 1,
    sortMode: 'recent',
    wideLayout: 'columns',
  });
});

test('getConfigPath uses APPDATA on Windows', () => {
  const configPath = getConfigPath({
    env: {
      ...makeTestEnv(),
      APPDATA: 'C:\\Users\\example\\AppData\\Roaming',
    },
    platform: 'win32',
  });

  assert.equal(configPath, path.win32.resolve('C:\\Users\\example\\AppData\\Roaming', 'ghcrawl', 'config.json'));
});

test('loadConfig rejects invalid port', () => {
  const home = makeTempHome();
  assert.throws(() =>
    loadConfig({
      cwd: process.cwd(),
      env: { ...makeTestEnv(), HOME: home, GHCRAWL_API_PORT: 'abc' },
    }),
  );
});

test('loadConfig rejects invalid embed queue settings', () => {
  const home = makeTempHome();
  assert.throws(() =>
    loadConfig({
      cwd: process.cwd(),
      env: { ...makeTestEnv(), HOME: home, GHCRAWL_EMBED_CONCURRENCY: '0' },
    }),
  );
});
