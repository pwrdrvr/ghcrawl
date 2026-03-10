import { cancel, confirm, intro, isCancel, note, outro, password, select, text } from '@clack/prompts';
import {
  loadConfig,
  readPersistedConfig,
  writePersistedConfig,
  isLikelyGitHubToken,
  isLikelyOpenAiApiKey,
} from '@ghcrawl/api-core';

type InitSecretMode = 'plaintext' | 'op';

export type InitWizardResult = {
  configPath: string;
  changed: boolean;
};

export type InitPrompter = {
  intro: (message: string) => Promise<void> | void;
  note: (message: string, title?: string) => Promise<void> | void;
  select: (options: {
    message: string;
    initialValue?: string;
    options: Array<{ value: string; label: string; hint?: string }>;
  }) => Promise<string | symbol>;
  text: (options: {
    message: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }) => Promise<string | symbol | undefined>;
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
  password: (options: { message: string; validate?: (value: string) => string | undefined }) => Promise<string | symbol>;
  outro: (message: string) => Promise<void> | void;
  cancel: (message: string) => void;
};

function resolveTextValue(value: string | symbol | undefined, fallback: string): string | symbol {
  if (isCancel(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function createClackInitPrompter(): InitPrompter {
  return {
    intro,
    note,
    select,
    text,
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
    throw new Error(`ghcrawl init requires a TTY. Create ${current.configPath} manually or set environment variables first.`);
  }

  await prompter.intro('ghcrawl init');
  await prompter.note(
    [
      `Config file: ${current.configPath}`,
      '',
      'Secret storage modes:',
      '- Plaintext config: writes both keys to ~/.config/ghcrawl/config.json',
      '- 1Password CLI: keeps keys out of the config file and expects you to run ghcrawl through an op wrapper',
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

  const secretMode = await prompter.select({
    message: 'How should ghcrawl get your GitHub and OpenAI secrets?',
    initialValue: stored.data.secretProvider ?? (hasStoredGithub && hasStoredOpenAi ? 'plaintext' : 'op'),
    options: [
      {
        value: 'plaintext',
        label: 'Store plaintext keys in ~/.config/ghcrawl/config.json',
        hint: 'simpler, but you are responsible for any bills caused by misuse',
      },
      {
        value: 'op',
        label: 'Keep keys in 1Password CLI and run through op',
        hint: 'recommended if you already use op',
      },
    ],
  });
  if (isCancel(secretMode) || (secretMode !== 'plaintext' && secretMode !== 'op')) {
    prompter.cancel('init cancelled');
    throw new Error('init cancelled');
  }

  if (secretMode === 'plaintext') {
    await prompter.note(
      [
        'Plaintext storage warning:',
        '- ghcrawl will write both API keys to ~/.config/ghcrawl/config.json',
        '- anyone who can read that file can use your keys',
        '- any OpenAI/API bills caused by misuse are your responsibility',
      ].join('\n'),
      'Security',
    );

    if (reconfigure || !hasStoredGithub) {
      const detectedGithub = env.GITHUB_TOKEN;
      let githubToken = stored.data.githubToken;
      let usedDetectedGithub = false;
      if (detectedGithub && (!githubToken || reconfigure)) {
        const useDetected = await prompter.confirm({
          message: 'Persist the detected GITHUB_TOKEN environment value to the ghcrawl config file?',
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
          message: 'Persist the detected OPENAI_API_KEY environment value to the ghcrawl config file?',
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

    nextConfig.secretProvider = 'plaintext';
    nextConfig.opVaultName = undefined;
    nextConfig.opItemName = undefined;
  } else {
    const defaultVaultName = stored.data.opVaultName ?? 'Private';
    const vaultNameInput = await prompter.text({
      message: '1Password vault name',
      placeholder: defaultVaultName,
    });
    const vaultName = resolveTextValue(vaultNameInput, defaultVaultName);
    if (isCancel(vaultName)) {
      prompter.cancel('init cancelled');
      throw new Error('init cancelled');
    }
    const defaultItemName = stored.data.opItemName ?? 'ghcrawl';
    const itemNameInput = await prompter.text({
      message: '1Password item name',
      placeholder: defaultItemName,
    });
    const itemName = resolveTextValue(itemNameInput, defaultItemName);
    if (isCancel(itemName)) {
      prompter.cancel('init cancelled');
      throw new Error('init cancelled');
    }

    nextConfig.secretProvider = 'op';
    nextConfig.opVaultName = vaultName.trim();
    nextConfig.opItemName = itemName.trim();
    nextConfig.githubToken = undefined;
    nextConfig.openaiApiKey = undefined;
    changed = true;

    const opReferenceBase = `op://${nextConfig.opVaultName}/${nextConfig.opItemName}`;
    await prompter.note(
      [
        'Create a 1Password Secure Note with:',
        `- Vault: ${nextConfig.opVaultName}`,
        `- Item: ${nextConfig.opItemName}`,
        '',
        'Add concealed fields named exactly:',
        '- GITHUB_TOKEN',
        '- OPENAI_API_KEY',
        '',
        'Secret refs:',
        `- ${opReferenceBase}/GITHUB_TOKEN`,
        `- ${opReferenceBase}/OPENAI_API_KEY`,
      ].join('\n'),
      '1Password Setup',
    );
    const readyNote = await prompter.confirm({
      message: 'I created the Secure Note with those exact field names and secret refs.',
      initialValue: true,
    });
    if (isCancel(readyNote) || readyNote !== true) {
      prompter.cancel('init cancelled');
      throw new Error('init cancelled');
    }

    await prompter.note(
      [
        'After saving that Secure Note, run ghcrawl through an op-backed shell helper:',
        '',
        'ghcrawl-op() {',
        `  env GITHUB_TOKEN=\"$(op read '${opReferenceBase}/GITHUB_TOKEN')\" \\`,
        `      OPENAI_API_KEY=\"$(op read '${opReferenceBase}/OPENAI_API_KEY')\" \\`,
        '      ghcrawl "$@"',
        '}',
        '',
        'Examples:',
        '- ghcrawl-op doctor',
        '- ghcrawl-op tui',
        '- ghcrawl-op sync org/repo',
      ].join('\n'),
      'Next Commands',
    );
    const readyCommands = await prompter.confirm({
      message: 'I copied those commands and I am ready to save this ghcrawl config.',
      initialValue: true,
    });
    if (isCancel(readyCommands) || readyCommands !== true) {
      prompter.cancel('init cancelled');
      throw new Error('init cancelled');
    }
  }

  await prompter.note(
    [
      'Responsibility attestation:',
      '- You are responsible for obtaining and using GitHub and OpenAI API keys in compliance with the agreements and usage policies for those platforms.',
      '- You and any employer or organization you operate this tool for accept full responsibility for monitoring API usage, spend, and access.',
      '- You are fully responsible for storing your API keys securely and for any misuse, theft, or unexpected spend caused by those keys.',
      '- The creators and contributors of ghcrawl accept no liability for API charges, account actions, data loss, or misuse resulting from operation of this tool.',
    ].join('\n'),
    'Responsibility',
  );
  const acceptResponsibility = await prompter.confirm({
    message: 'I understand and accept full responsibility for using ghcrawl and for securing any API keys it uses.',
    initialValue: false,
  });
  if (isCancel(acceptResponsibility) || acceptResponsibility !== true) {
    prompter.cancel('init cancelled');
    throw new Error('init cancelled');
  }

  const result = writePersistedConfig(nextConfig, { cwd, env });
  await prompter.outro(`Saved ghcrawl config to ${result.configPath}`);
  return { configPath: result.configPath, changed };
}
