import { cancel, confirm, intro, isCancel, note, outro, password } from '@clack/prompts';
import {
  loadConfig,
  readPersistedConfig,
  writePersistedConfig,
  isLikelyGitHubToken,
  isLikelyOpenAiApiKey,
} from '@gitcrawl/api-core';

export type InitWizardResult = {
  configPath: string;
  changed: boolean;
};

export type InitPrompter = {
  intro: (message: string) => Promise<void> | void;
  note: (message: string, title?: string) => Promise<void> | void;
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
  password: (options: { message: string; validate?: (value: string) => string | undefined }) => Promise<string | symbol>;
  outro: (message: string) => Promise<void> | void;
  cancel: (message: string) => void;
};

export function createClackInitPrompter(): InitPrompter {
  return {
    intro,
    note,
    confirm,
    password,
    outro,
    cancel,
  };
}

export async function runInitWizard(
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    reconfigure?: boolean;
    prompter?: InitPrompter;
    isInteractive?: boolean;
  } = {},
): Promise<InitWizardResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const reconfigure = options.reconfigure ?? false;
  const prompter = options.prompter ?? createClackInitPrompter();
  const current = loadConfig({ cwd, env });
  const stored = readPersistedConfig({ cwd, env });

  const hasStoredGithub = Boolean(stored.data.githubToken);
  const hasStoredOpenAi = Boolean(stored.data.openaiApiKey);
  if (!reconfigure && hasStoredGithub && hasStoredOpenAi) {
    return { configPath: current.configPath, changed: false };
  }

  const isInteractive = options.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    throw new Error(`gitcrawl init requires a TTY. Create ${current.configPath} manually or set environment variables first.`);
  }

  await prompter.intro('gitcrawl init');
  await prompter.note(
    [
      `Config file: ${current.configPath}`,
      '',
      'GitHub token recommendation:',
      '- Fine-grained PAT scoped to the repos you want to crawl',
      '- Repository permissions: Metadata (read), Issues (read), Pull requests (read)',
      '- For private repos with a classic PAT, repo is the safe fallback',
      '',
      'OpenAI key recommendation:',
      '- Standard API key for the project/account you want to bill',
    ].join('\n'),
    'Setup',
  );

  const nextConfig = { ...stored.data };
  let changed = false;

  if (reconfigure || !hasStoredGithub) {
    const detectedGithub = env.GITHUB_TOKEN;
    let githubToken = stored.data.githubToken;
    let usedDetectedGithub = false;
    if (detectedGithub && (!githubToken || reconfigure)) {
      const useDetected = await prompter.confirm({
        message: 'Persist the detected GITHUB_TOKEN environment value to the gitcrawl config file?',
        initialValue: true,
      });
      if (isCancel(useDetected)) {
        prompter.cancel('init cancelled');
        throw new Error('init cancelled');
      }
      if (useDetected) {
        if (isLikelyGitHubToken(detectedGithub)) {
          githubToken = detectedGithub;
          usedDetectedGithub = true;
        } else {
          await prompter.note('The detected GITHUB_TOKEN value does not look like a GitHub PAT, so init will prompt for it instead.', 'GitHub token');
        }
      }
    }
    if (!githubToken || (reconfigure && !usedDetectedGithub)) {
      const value = await prompter.password({
        message: 'GitHub personal access token',
        validate: (candidate) => (isLikelyGitHubToken(candidate) ? undefined : 'Enter a GitHub PAT like ghp_... or github_pat_...'),
      });
      if (isCancel(value)) {
        prompter.cancel('init cancelled');
        throw new Error('init cancelled');
      }
      githubToken = value;
    }
    nextConfig.githubToken = githubToken;
    changed = true;
  }

  if (reconfigure || !hasStoredOpenAi) {
    const detectedOpenAi = env.OPENAI_API_KEY;
    let openaiApiKey = stored.data.openaiApiKey;
    let usedDetectedOpenAi = false;
    if (detectedOpenAi && (!openaiApiKey || reconfigure)) {
      const useDetected = await prompter.confirm({
        message: 'Persist the detected OPENAI_API_KEY environment value to the gitcrawl config file?',
        initialValue: true,
      });
      if (isCancel(useDetected)) {
        prompter.cancel('init cancelled');
        throw new Error('init cancelled');
      }
      if (useDetected) {
        if (isLikelyOpenAiApiKey(detectedOpenAi)) {
          openaiApiKey = detectedOpenAi;
          usedDetectedOpenAi = true;
        } else {
          await prompter.note('The detected OPENAI_API_KEY value does not look like an OpenAI API key, so init will prompt for it instead.', 'OpenAI key');
        }
      }
    }
    if (!openaiApiKey || (reconfigure && !usedDetectedOpenAi)) {
      const value = await prompter.password({
        message: 'OpenAI API key',
        validate: (candidate) => (isLikelyOpenAiApiKey(candidate) ? undefined : 'Enter an OpenAI API key like sk-...'),
      });
      if (isCancel(value)) {
        prompter.cancel('init cancelled');
        throw new Error('init cancelled');
      }
      openaiApiKey = value;
    }
    nextConfig.openaiApiKey = openaiApiKey;
    changed = true;
  }

  const result = writePersistedConfig(nextConfig, { cwd, env });
  await prompter.outro(`Saved gitcrawl config to ${result.configPath}`);
  return { configPath: result.configPath, changed };
}
