import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPersistedConfig, writePersistedConfig } from '@gitcrawl/api-core';

import { runInitWizard, type InitPrompter } from './init-wizard.js';

function makePrompter(overrides: Partial<InitPrompter> = {}): InitPrompter {
  return {
    intro: async () => undefined,
    note: async () => undefined,
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-init-test-'));
  const env = { ...process.env, HOME: home };
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-init-test-'));
  const env = { ...process.env, HOME: home };
  const prompts: string[] = [];

  const result = await runInitWizard({
    env,
    prompter: makePrompter({
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcrawl-init-test-'));
  const env = {
    ...process.env,
    HOME: home,
    GITHUB_TOKEN: 'ghp_envtoken1234567890',
    OPENAI_API_KEY: 'sk-proj-envkey1234567890',
  };

  const result = await runInitWizard({
    env,
    prompter: makePrompter({
      confirm: async () => true,
    }),
    isInteractive: true,
  });

  assert.equal(result.changed, true);
  const persisted = readPersistedConfig({ env });
  assert.equal(persisted.data.githubToken, 'ghp_envtoken1234567890');
  assert.equal(persisted.data.openaiApiKey, 'sk-proj-envkey1234567890');
});
