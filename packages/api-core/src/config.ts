import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

export type ConfigValueSource = 'env' | 'config' | 'dotenv' | 'default' | 'none';
export type SecretProvider = 'plaintext' | 'op';
export type TuiSortPreference = 'recent' | 'size';
export type TuiMinClusterSize = 0 | 1 | 10 | 20 | 50;
export type TuiWideLayoutPreference = 'columns' | 'right-stack';
export type EmbeddingBasis = 'title_original' | 'title_summary';
export type VectorBackend = 'vectorlite';

export type TuiRepositoryPreference = {
  minClusterSize: TuiMinClusterSize;
  sortMode: TuiSortPreference;
  wideLayout: TuiWideLayoutPreference;
};

export type PersistedGitcrawlConfig = {
  githubToken?: string;
  openaiApiKey?: string;
  secretProvider?: SecretProvider;
  opVaultName?: string;
  opItemName?: string;
  dbPath?: string;
  apiPort?: number;
  summaryModel?: string;
  embedModel?: string;
  embeddingBasis?: EmbeddingBasis;
  vectorBackend?: VectorBackend;
  embedBatchSize?: number;
  embedConcurrency?: number;
  embedMaxUnread?: number;
  openSearchUrl?: string;
  openSearchIndex?: string;
  tuiPreferences?: Record<string, TuiRepositoryPreference>;
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
  secretProvider: SecretProvider;
  opVaultName?: string;
  opItemName?: string;
  summaryModel: string;
  embedModel: string;
  embeddingBasis: EmbeddingBasis;
  vectorBackend: VectorBackend;
  embedBatchSize: number;
  embedConcurrency: number;
  embedMaxUnread: number;
  openSearchUrl?: string;
  openSearchIndex: string;
  tuiPreferences: Record<string, TuiRepositoryPreference>;
};

type LoadedStoredConfig = {
  configDir: string;
  configPath: string;
  exists: boolean;
  data: PersistedGitcrawlConfig;
};

export type LoadConfigOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  configPathOverride?: string;
  workspaceRootOverride?: string;
};

type LayeredValue<T> = {
  source: ConfigValueSource;
  value: T | undefined;
};

function pathModuleForPlatform(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path;
}

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
  if (options.configPathOverride) {
    return path.dirname(path.resolve(options.cwd ?? process.cwd(), options.configPathOverride));
  }
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathModule = pathModuleForPlatform(platform);
  if (env.XDG_CONFIG_HOME) {
    return pathModule.resolve(env.XDG_CONFIG_HOME, 'ghcrawl');
  }
  if (platform === 'win32' && env.APPDATA) {
    return pathModule.resolve(env.APPDATA, 'ghcrawl');
  }
  return pathModule.join(resolveHomeDirectory(env), '.config', 'ghcrawl');
}

export function getConfigPath(options: LoadConfigOptions = {}): string {
  if (options.configPathOverride) {
    return path.resolve(options.cwd ?? process.cwd(), options.configPathOverride);
  }
  const platform = options.platform ?? process.platform;
  const pathModule = pathModuleForPlatform(platform);
  return pathModule.join(getConfigDir(options), 'config.json');
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

function getEnvString(env: NodeJS.ProcessEnv, primary: string, legacy?: string): string | undefined {
  return getString(env[primary]) ?? (legacy ? getString(env[legacy]) : undefined);
}

function getDotenvString(values: Record<string, string>, primary: string, legacy?: string): string | undefined {
  return getString(values[primary]) ?? (legacy ? getString(values[legacy]) : undefined);
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getSecretProvider(value: unknown): SecretProvider | undefined {
  return value === 'plaintext' || value === 'op' ? value : undefined;
}

function getTuiSortPreference(value: unknown): TuiSortPreference | undefined {
  return value === 'recent' || value === 'size' ? value : undefined;
}

function getTuiMinClusterSize(value: unknown): TuiMinClusterSize | undefined {
  return value === 0 || value === 1 || value === 10 || value === 20 || value === 50 ? value : undefined;
}

function getTuiWideLayoutPreference(value: unknown): TuiWideLayoutPreference | undefined {
  return value === 'columns' || value === 'right-stack' ? value : undefined;
}

function getEmbeddingBasis(value: unknown): EmbeddingBasis | undefined {
  return value === 'title_original' || value === 'title_summary' ? value : undefined;
}

function getVectorBackend(value: unknown): VectorBackend | undefined {
  return value === 'vectorlite' ? value : undefined;
}

function getTuiPreferences(value: unknown): Record<string, TuiRepositoryPreference> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const preferences: Record<string, TuiRepositoryPreference> = {};
  for (const [fullName, preference] of Object.entries(value as Record<string, unknown>)) {
    if (!preference || typeof preference !== 'object') {
      continue;
    }
    const record = preference as Record<string, unknown>;
    const minClusterSize = getTuiMinClusterSize(record.minClusterSize);
    const sortMode = getTuiSortPreference(record.sortMode);
    const wideLayout = getTuiWideLayoutPreference(record.wideLayout) ?? 'columns';
    if (minClusterSize === undefined || sortMode === undefined) {
      continue;
    }
    preferences[fullName] = { minClusterSize, sortMode, wideLayout };
  }

  return preferences;
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
      secretProvider: getSecretProvider(raw.secretProvider),
      opVaultName: getString(raw.opVaultName),
      opItemName: getString(raw.opItemName),
      dbPath: getString(raw.dbPath),
      apiPort: getNumber(raw.apiPort),
      summaryModel: getString(raw.summaryModel),
      embedModel: getString(raw.embedModel),
      embeddingBasis: getEmbeddingBasis(raw.embeddingBasis),
      vectorBackend: getVectorBackend(raw.vectorBackend),
      embedBatchSize: getNumber(raw.embedBatchSize),
      embedConcurrency: getNumber(raw.embedConcurrency),
      embedMaxUnread: getNumber(raw.embedMaxUnread),
      openSearchUrl: getString(raw.openSearchUrl),
      openSearchIndex: getString(raw.openSearchIndex),
      tuiPreferences: getTuiPreferences(raw.tuiPreferences),
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

function getWorkspaceDbPath(workspaceRoot: string): string | null {
  const workspacePath = path.join(workspaceRoot, 'data', 'ghcrawl.db');
  return fs.existsSync(workspacePath) ? workspacePath : null;
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
  const platform = options.platform ?? process.platform;
  const workspaceRoot = options.workspaceRootOverride
    ? path.resolve(cwd, options.workspaceRootOverride)
    : findWorkspaceRoot(cwd);
  const stored = readPersistedConfig({
    cwd,
    env,
    platform,
    configPathOverride: options.configPathOverride,
    workspaceRootOverride: options.workspaceRootOverride,
  });
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
  const configuredDbPath = pickDefined<string>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_DB_PATH', 'GHCRAWL_DB_PATH') },
    { source: 'config', value: stored.data.dbPath },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_DB_PATH', 'GHCRAWL_DB_PATH') },
  );
  const workspaceDbPath = configuredDbPath.value === undefined ? getWorkspaceDbPath(workspaceRoot) : null;
  const dbPathValue =
    workspaceDbPath !== null
      ? { source: 'default' as const, value: workspaceDbPath }
      : pickDefined<string>(configuredDbPath, { source: 'default', value: 'ghcrawl.db' });
  const apiPortValue = pickDefined<string | number>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_API_PORT', 'GHCRAWL_API_PORT') },
    { source: 'config', value: stored.data.apiPort },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_API_PORT', 'GHCRAWL_API_PORT') },
    { source: 'default', value: '5179' },
  );
  const embedBatchSizeValue = pickDefined<string | number>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_EMBED_BATCH_SIZE', 'GHCRAWL_EMBED_BATCH_SIZE') },
    { source: 'config', value: stored.data.embedBatchSize },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_EMBED_BATCH_SIZE', 'GHCRAWL_EMBED_BATCH_SIZE') },
    { source: 'default', value: '8' },
  );
  const embedConcurrencyValue = pickDefined<string | number>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_EMBED_CONCURRENCY', 'GHCRAWL_EMBED_CONCURRENCY') },
    { source: 'config', value: stored.data.embedConcurrency },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_EMBED_CONCURRENCY', 'GHCRAWL_EMBED_CONCURRENCY') },
    { source: 'default', value: '10' },
  );
  const embedMaxUnreadValue = pickDefined<string | number>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_EMBED_MAX_UNREAD', 'GHCRAWL_EMBED_MAX_UNREAD') },
    { source: 'config', value: stored.data.embedMaxUnread },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_EMBED_MAX_UNREAD', 'GHCRAWL_EMBED_MAX_UNREAD') },
    { source: 'default', value: '20' },
  );
  const summaryModel = pickDefined<string>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_SUMMARY_MODEL', 'GHCRAWL_SUMMARY_MODEL') },
    { source: 'config', value: stored.data.summaryModel },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_SUMMARY_MODEL', 'GHCRAWL_SUMMARY_MODEL') },
    { source: 'default', value: 'gpt-5-mini' },
  );
  const embedModel = pickDefined<string>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_EMBED_MODEL', 'GHCRAWL_EMBED_MODEL') },
    { source: 'config', value: stored.data.embedModel },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_EMBED_MODEL', 'GHCRAWL_EMBED_MODEL') },
    { source: 'default', value: 'text-embedding-3-large' },
  );
  const embeddingBasis = pickDefined<EmbeddingBasis>(
    { source: 'env', value: getEmbeddingBasis(getEnvString(env, 'GHCRAWL_EMBEDDING_BASIS', 'GHCRAWL_EMBEDDING_BASIS')) },
    { source: 'config', value: stored.data.embeddingBasis },
    { source: 'dotenv', value: getEmbeddingBasis(getDotenvString(dotenvValues, 'GHCRAWL_EMBEDDING_BASIS', 'GHCRAWL_EMBEDDING_BASIS')) },
    { source: 'default', value: 'title_summary' },
  );
  const vectorBackend = pickDefined<VectorBackend>(
    { source: 'env', value: getVectorBackend(getEnvString(env, 'GHCRAWL_VECTOR_BACKEND', 'GHCRAWL_VECTOR_BACKEND')) },
    { source: 'config', value: stored.data.vectorBackend },
    { source: 'dotenv', value: getVectorBackend(getDotenvString(dotenvValues, 'GHCRAWL_VECTOR_BACKEND', 'GHCRAWL_VECTOR_BACKEND')) },
    { source: 'default', value: 'vectorlite' },
  );
  const openSearchUrl = pickDefined<string>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_OPENSEARCH_URL', 'GHCRAWL_OPENSEARCH_URL') },
    { source: 'config', value: stored.data.openSearchUrl },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_OPENSEARCH_URL', 'GHCRAWL_OPENSEARCH_URL') },
  );
  const openSearchIndex = pickDefined<string>(
    { source: 'env', value: getEnvString(env, 'GHCRAWL_OPENSEARCH_INDEX', 'GHCRAWL_OPENSEARCH_INDEX') },
    { source: 'config', value: stored.data.openSearchIndex },
    { source: 'dotenv', value: getDotenvString(dotenvValues, 'GHCRAWL_OPENSEARCH_INDEX', 'GHCRAWL_OPENSEARCH_INDEX') },
    { source: 'default', value: 'ghcrawl-threads' },
  );

  const dbPath =
    dbPathValue.value && path.isAbsolute(dbPathValue.value)
      ? dbPathValue.value
      : resolveConfiguredPath(stored.configDir, dbPathValue.value ?? 'ghcrawl.db');
  const apiPort = parseIntegerSetting('GHCRAWL_API_PORT', String(apiPortValue.value ?? '5179'));
  const embedBatchSize = parseIntegerSetting('GHCRAWL_EMBED_BATCH_SIZE', String(embedBatchSizeValue.value ?? '8'));
  const embedConcurrency = parseIntegerSetting('GHCRAWL_EMBED_CONCURRENCY', String(embedConcurrencyValue.value ?? '10'));
  const embedMaxUnread = parseIntegerSetting('GHCRAWL_EMBED_MAX_UNREAD', String(embedMaxUnreadValue.value ?? '20'));

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
    secretProvider: stored.data.secretProvider ?? 'plaintext',
    opVaultName: stored.data.opVaultName,
    opItemName: stored.data.opItemName,
    summaryModel: summaryModel.value ?? 'gpt-5-mini',
    embedModel: embedModel.value ?? 'text-embedding-3-large',
    embeddingBasis: embeddingBasis.value ?? 'title_summary',
    vectorBackend: vectorBackend.value ?? 'vectorlite',
    embedBatchSize,
    embedConcurrency,
    embedMaxUnread,
    openSearchUrl: openSearchUrl.value,
    openSearchIndex: openSearchIndex.value ?? 'ghcrawl-threads',
    tuiPreferences: stored.data.tuiPreferences ?? {},
  };
}

export function ensureRuntimeDirs(config: GitcrawlConfig): void {
  fs.mkdirSync(config.configDir, { recursive: true });
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(path.join(config.configDir, 'vectors'), { recursive: true });
}

export function getTuiRepositoryPreference(config: GitcrawlConfig, owner: string, repo: string): TuiRepositoryPreference {
  return config.tuiPreferences[`${owner}/${repo}`] ?? { minClusterSize: 10, sortMode: 'recent', wideLayout: 'columns' };
}

export function writeTuiRepositoryPreference(
  config: GitcrawlConfig,
  params: { owner: string; repo: string; minClusterSize: TuiMinClusterSize; sortMode: TuiSortPreference; wideLayout: TuiWideLayoutPreference },
): { configPath: string } {
  const fullName = `${params.owner}/${params.repo}`;
  const nextPreferences = {
    ...config.tuiPreferences,
    [fullName]: {
      minClusterSize: params.minClusterSize,
      sortMode: params.sortMode,
      wideLayout: params.wideLayout,
    },
  };
  config.tuiPreferences = nextPreferences;
  const next = fs.existsSync(config.configPath)
    ? ({
        ...(JSON.parse(fs.readFileSync(config.configPath, 'utf8')) as PersistedGitcrawlConfig),
        tuiPreferences: nextPreferences,
      } satisfies PersistedGitcrawlConfig)
    : ({
        tuiPreferences: nextPreferences,
      } satisfies PersistedGitcrawlConfig);
  fs.mkdirSync(config.configDir, { recursive: true });
  fs.writeFileSync(config.configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return { configPath: config.configPath };
}

export function requireGithubToken(config: GitcrawlConfig): string {
  if (!config.githubToken) {
    if (config.secretProvider === 'op' && config.opVaultName && config.opItemName) {
      throw new Error(
        `Missing GitHub token in the environment. This config is set to use 1Password CLI via ${config.opVaultName}/${config.opItemName}; run ghcrawl through your op wrapper or set GITHUB_TOKEN. Expected config at ${config.configPath}`,
      );
    }
    throw new Error(`Missing GitHub token. Run ghcrawl init or set GITHUB_TOKEN. Expected config at ${config.configPath}`);
  }
  return config.githubToken;
}

export function requireOpenAiKey(config: GitcrawlConfig): string {
  if (!config.openaiApiKey) {
    if (config.secretProvider === 'op' && config.opVaultName && config.opItemName) {
      throw new Error(
        `Missing OpenAI API key in the environment. This config is set to use 1Password CLI via ${config.opVaultName}/${config.opItemName}; run ghcrawl through your op wrapper or set OPENAI_API_KEY. Expected config at ${config.configPath}`,
      );
    }
    throw new Error(`Missing OpenAI API key. Run ghcrawl init or set OPENAI_API_KEY. Expected config at ${config.configPath}`);
  }
  return config.openaiApiKey;
}
