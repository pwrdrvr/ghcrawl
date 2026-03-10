import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPersistedConfig, writePersistedConfig } from '@ghcrawl/api-core';

import { runInitWizard, type InitPrompter } from './init-wizard.js';

function makeTestEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: undefined,
    APPDATA: undefined,
    ...overrides,
  };
}

function makePrompter(overrides: Partial<InitPrompter> = {}): InitPrompter {
  return {
    intro: async () => undefined,
    note: async () => undefined,
    select: async () => 'plaintext',
    text: async () => {
      throw new Error('unexpected text prompt');
    },
    confirm: async () => true,
    password: async () => {
      throw new Error('unexpected password prompt');
    },
    outro: async () => undefined,
    cancel: () => undefined,
    ...overrides,
  };
}

test('runInitWizard skips prompting when config already has both API keys', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-init-test-'));
  const env = makeTestEnv({ HOME: home });
  writePersistedConfig(
    {
      githubToken: 'ghp_testtoken1234567890',
      openaiApiKey: 'sk-proj-testkey1234567890',
    },
    { env },
  );

  const result = await runInitWizard({
    env,
    prompter: makePrompter(),
    isInteractive: true,
  });

  assert.equal(result.changed, false);
  assert.equal(fs.existsSync(result.configPath), true);
});

test('runInitWizard prompts for missing keys and writes the config file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-init-test-'));
  const env = makeTestEnv({ HOME: home });
  const prompts: string[] = [];

  const result = await runInitWizard({
    env,
    prompter: makePrompter({
      select: async () => 'plaintext',
      password: async ({ message }) => {
        prompts.push(message);
        return message.includes('GitHub') ? 'ghp_testtoken1234567890' : 'sk-proj-testkey1234567890';
      },
    }),
    isInteractive: true,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(prompts, ['GitHub personal access token', 'OpenAI API key']);

  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.githubToken, 'ghp_testtoken1234567890');
  assert.equal(persisted.data.openaiApiKey, 'sk-proj-testkey1234567890');
});

test('runInitWizard can persist detected environment keys without prompting for secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-init-test-'));
  const env = makeTestEnv({
    HOME: home,
    GITHUB_TOKEN: 'ghp_envtoken1234567890',
    OPENAI_API_KEY: 'sk-proj-envkey1234567890',
  });

  const result = await runInitWizard({
    env,
    prompter: makePrompter({
      select: async () => 'plaintext',
      confirm: async () => true,
    }),
    isInteractive: true,
  });

  assert.equal(result.changed, true);
  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.githubToken, 'ghp_envtoken1234567890');
  assert.equal(persisted.data.openaiApiKey, 'sk-proj-envkey1234567890');
});

test('runInitWizard can configure 1Password CLI metadata without persisting plaintext keys', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-init-test-'));
  const env = makeTestEnv({ HOME: home });
  const notes: Array<{ title?: string; message: string }> = [];
  const confirms: string[] = [];

  const result = await runInitWizard({
    env,
    prompter: makePrompter({
      select: async () => 'op',
      text: async ({ message }) => (message.includes('vault') ? 'Private' : 'ghcrawl'),
      note: async (message, title) => {
        notes.push({ title, message });
      },
      confirm: async ({ message }) => {
        confirms.push(message);
        return true;
      },
    }),
    isInteractive: true,
  });

  assert.equal(result.changed, true);
  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.secretProvider, 'op');
  assert.equal(persisted.data.opVaultName, 'Private');
  assert.equal(persisted.data.opItemName, 'ghcrawl');
  assert.equal(persisted.data.githubToken, undefined);
  assert.equal(persisted.data.openaiApiKey, undefined);
  assert.equal(
    notes.some((entry) => entry.title === '1Password Setup' && entry.message.includes('op://Private/ghcrawl/GITHUB_TOKEN')),
    true,
  );
  assert.equal(notes.some((entry) => entry.title === 'Next Commands' && entry.message.includes('ghcrawl-op()')), true);
  assert.equal(notes.some((entry) => entry.title === 'Next Commands' && entry.message.includes('ghcrawl-op doctor')), true);
  assert.equal(notes.some((entry) => entry.title === 'Next Commands' && entry.message.includes('ghcrawl-op sync org/repo')), true);
  assert.equal(notes.some((entry) => entry.title === 'Responsibility' && entry.message.includes('accept no liability')), true);
  assert.equal(confirms.some((message) => message.includes('I created the Secure Note')), true);
  assert.equal(confirms.some((message) => message.includes('I copied those commands')), true);
  assert.equal(confirms.some((message) => message.includes('accept full responsibility')), true);
});

test('runInitWizard accepts empty 1Password vault and item input as defaults', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-init-test-'));
  const env = makeTestEnv({ HOME: home });

  await runInitWizard({
    env,
    prompter: makePrompter({
      select: async () => 'op',
      text: async () => '',
      confirm: async () => true,
    }),
    isInteractive: true,
  });

  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.opVaultName, 'Private');
  assert.equal(persisted.data.opItemName, 'ghcrawl');
});

test('runInitWizard accepts undefined 1Password text responses as defaults', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcrawl-init-test-'));
  const env = makeTestEnv({ HOME: home });

  await runInitWizard({
    env,
    prompter: makePrompter({
      select: async () => 'op',
      text: async () => undefined,
      confirm: async () => true,
    }),
    isInteractive: true,
  });

  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.opVaultName, 'Private');
  assert.equal(persisted.data.opItemName, 'ghcrawl');
});
