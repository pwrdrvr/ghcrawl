import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

export type ConfigValueSource = 'env' | 'config' | 'dotenv' | 'default' | 'none';

export type PersistedGitcrawlConfig = {
  githubToken?: string;
  openaiApiKey?: string;
  dbPath?: string;
  apiPort?: number;
  summaryModel?: string;
  embedModel?: string;
  embedBatchSize?: number;
  embedConcurrency?: number;
  embedMaxUnread?: number;
  openSearchUrl?: string;
  openSearchIndex?: string;
};

export type GitcrawlConfig = {
  workspaceRoot: string;
  configDir: string;
  configPath: string;
  configFileExists: boolean;
  dbPath: string;
  dbPathSource: ConfigValueSource;
  apiPort: number;
  githubToken?: string;
  githubTokenSource: ConfigValueSource;
  openaiApiKey?: string;
  openaiApiKeySource: ConfigValueSource;
  summaryModel: string;
  embedModel: string;
  embedBatchSize: number;
  embedConcurrency: number;
  embedMaxUnread: number;
  openSearchUrl?: string;
  openSearchIndex: string;
};

type LoadedStoredConfig = {
  configDir: string;
  configPath: string;
  exists: boolean;
  data: PersistedGitcrawlConfig;
};

type LoadConfigOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type LayeredValue<T> = {
  source: ConfigValueSource;
  value: T | undefined;
};

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function resolveHomeDirectory(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.resolve(home);
}

export function getConfigDir(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.XDG_CONFIG_HOME) {
    return path.resolve(env.XDG_CONFIG_HOME, 'gitcrawl');
  }
  return path.join(resolveHomeDirectory(env), '.config', 'gitcrawl');
}

export function getConfigPath(options: LoadConfigOptions = {}): string {
  return path.join(getConfigDir(options), 'config.json');
}

function readDotenvFile(workspaceRoot: string): Record<string, string> {
  const dotenvPath = path.join(workspaceRoot, '.env.local');
  if (!fs.existsSync(dotenvPath)) {
    return {};
  }
  return dotenv.parse(fs.readFileSync(dotenvPath, 'utf8'));
}

function pickDefined<T>(...values: Array<LayeredValue<T>>): LayeredValue<T> {
  for (const entry of values) {
    if (entry.value !== undefined && entry.value !== null) {
      return entry;
    }
  }
  return { source: 'none', value: undefined };
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readPersistedConfig(options: LoadConfigOptions = {}): LoadedStoredConfig {
  const configDir = getConfigDir(options);
  const configPath = getConfigPath(options);
  if (!fs.existsSync(configPath)) {
    return { configDir, configPath, exists: false, data: {} };
  }

  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  return {
    configDir,
    configPath,
    exists: true,
    data: {
      githubToken: getString(raw.githubToken),
      openaiApiKey: getString(raw.openaiApiKey),
      dbPath: getString(raw.dbPath),
      apiPort: getNumber(raw.apiPort),
      summaryModel: getString(raw.summaryModel),
      embedModel: getString(raw.embedModel),
      embedBatchSize: getNumber(raw.embedBatchSize),
      embedConcurrency: getNumber(raw.embedConcurrency),
      embedMaxUnread: getNumber(raw.embedMaxUnread),
      openSearchUrl: getString(raw.openSearchUrl),
      openSearchIndex: getString(raw.openSearchIndex),
    },
  };
}

export function writePersistedConfig(values: PersistedGitcrawlConfig, options: LoadConfigOptions = {}): { configPath: string } {
  const current = readPersistedConfig(options);
  fs.mkdirSync(current.configDir, { recursive: true });
  const next = {
    ...current.data,
    ...values,
  };
  fs.writeFileSync(current.configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { configPath: current.configPath };
}

function resolveConfiguredPath(configDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(configDir, value);
}

function parseIntegerSetting(name: string, raw: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

export function isLikelyGitHubToken(value: string): boolean {
  return /^(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)$/.test(value.trim());
}

export function isLikelyOpenAiApiKey(value: string): boolean {
  return /^sk-[A-Za-z0-9._-]+$/.test(value.trim());
}

export function loadConfig(options: LoadConfigOptions = {}): GitcrawlConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const workspaceRoot = findWorkspaceRoot(cwd);
  const stored = readPersistedConfig({ cwd, env });
  const dotenvValues = readDotenvFile(workspaceRoot);

  const githubToken = pickDefined<string>(
    { source: 'env', value: getString(env.GITHUB_TOKEN) },
    { source: 'config', value: stored.data.githubToken },
    { source: 'dotenv', value: getString(dotenvValues.GITHUB_TOKEN) },
  );
  const openaiApiKey = pickDefined<string>(
    { source: 'env', value: getString(env.OPENAI_API_KEY) },
    { source: 'config', value: stored.data.openaiApiKey },
    { source: 'dotenv', value: getString(dotenvValues.OPENAI_API_KEY) },
  );
  const dbPathValue = pickDefined<string>(
    { source: 'env', value: getString(env.GITCRAWL_DB_PATH) },
    { source: 'config', value: stored.data.dbPath },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_DB_PATH) },
    { source: 'default', value: 'gitcrawl.db' },
  );
  const apiPortValue = pickDefined<string | number>(
    { source: 'env', value: getString(env.GITCRAWL_API_PORT) },
    { source: 'config', value: stored.data.apiPort },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_API_PORT) },
    { source: 'default', value: '5179' },
  );
  const embedBatchSizeValue = pickDefined<string | number>(
    { source: 'env', value: getString(env.GITCRAWL_EMBED_BATCH_SIZE) },
    { source: 'config', value: stored.data.embedBatchSize },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_EMBED_BATCH_SIZE) },
    { source: 'default', value: '8' },
  );
  const embedConcurrencyValue = pickDefined<string | number>(
    { source: 'env', value: getString(env.GITCRAWL_EMBED_CONCURRENCY) },
    { source: 'config', value: stored.data.embedConcurrency },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_EMBED_CONCURRENCY) },
    { source: 'default', value: '10' },
  );
  const embedMaxUnreadValue = pickDefined<string | number>(
    { source: 'env', value: getString(env.GITCRAWL_EMBED_MAX_UNREAD) },
    { source: 'config', value: stored.data.embedMaxUnread },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_EMBED_MAX_UNREAD) },
    { source: 'default', value: '20' },
  );
  const summaryModel = pickDefined<string>(
    { source: 'env', value: getString(env.GITCRAWL_SUMMARY_MODEL) },
    { source: 'config', value: stored.data.summaryModel },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_SUMMARY_MODEL) },
    { source: 'default', value: 'gpt-5-mini' },
  );
  const embedModel = pickDefined<string>(
    { source: 'env', value: getString(env.GITCRAWL_EMBED_MODEL) },
    { source: 'config', value: stored.data.embedModel },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_EMBED_MODEL) },
    { source: 'default', value: 'text-embedding-3-large' },
  );
  const openSearchUrl = pickDefined<string>(
    { source: 'env', value: getString(env.GITCRAWL_OPENSEARCH_URL) },
    { source: 'config', value: stored.data.openSearchUrl },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_OPENSEARCH_URL) },
  );
  const openSearchIndex = pickDefined<string>(
    { source: 'env', value: getString(env.GITCRAWL_OPENSEARCH_INDEX) },
    { source: 'config', value: stored.data.openSearchIndex },
    { source: 'dotenv', value: getString(dotenvValues.GITCRAWL_OPENSEARCH_INDEX) },
    { source: 'default', value: 'gitcrawl-threads' },
  );

  const dbPath = resolveConfiguredPath(stored.configDir, dbPathValue.value ?? 'gitcrawl.db');
  const apiPort = parseIntegerSetting('GITCRAWL_API_PORT', String(apiPortValue.value ?? '5179'));
  const embedBatchSize = parseIntegerSetting('GITCRAWL_EMBED_BATCH_SIZE', String(embedBatchSizeValue.value ?? '8'));
  const embedConcurrency = parseIntegerSetting('GITCRAWL_EMBED_CONCURRENCY', String(embedConcurrencyValue.value ?? '10'));
  const embedMaxUnread = parseIntegerSetting('GITCRAWL_EMBED_MAX_UNREAD', String(embedMaxUnreadValue.value ?? '20'));

  return {
    workspaceRoot,
    configDir: stored.configDir,
    configPath: stored.configPath,
    configFileExists: stored.exists,
    dbPath,
    dbPathSource: dbPathValue.source,
    apiPort,
    githubToken: githubToken.value,
    githubTokenSource: githubToken.source,
    openaiApiKey: openaiApiKey.value,
    openaiApiKeySource: openaiApiKey.source,
    summaryModel: summaryModel.value ?? 'gpt-5-mini',
    embedModel: embedModel.value ?? 'text-embedding-3-large',
    embedBatchSize,
    embedConcurrency,
    embedMaxUnread,
    openSearchUrl: openSearchUrl.value,
    openSearchIndex: openSearchIndex.value ?? 'gitcrawl-threads',
  };
}

export function ensureRuntimeDirs(config: GitcrawlConfig): void {
  fs.mkdirSync(config.configDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}

export function requireGithubToken(config: GitcrawlConfig): string {
  if (!config.githubToken) {
    throw new Error(`Missing GitHub token. Run gitcrawl init or set GITHUB_TOKEN. Expected config at ${config.configPath}`);
  }
  return config.githubToken;
}

export function requireOpenAiKey(config: GitcrawlConfig): string {
  if (!config.openaiApiKey) {
    throw new Error(`Missing OpenAI API key. Run gitcrawl init or set OPENAI_API_KEY. Expected config at ${config.configPath}`);
  }
  return config.openaiApiKey;
}
