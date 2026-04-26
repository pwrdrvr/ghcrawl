import type { HealthResponse } from '@ghcrawl/api-contract';

import type { GitcrawlConfig } from './config.js';
import type { DoctorResult } from './service-types.js';
import type { VectorStore } from './vector/store.js';

export function buildDoctorResult(params: { health: HealthResponse; config: GitcrawlConfig; vectorStore: VectorStore }): DoctorResult {
  const github = {
    configured: Boolean(params.config.githubToken),
    source: params.config.githubTokenSource,
    tokenPresent: Boolean(params.config.githubToken),
    error: null as string | null,
  };
  const openai = {
    configured: Boolean(params.config.openaiApiKey),
    source: params.config.openaiApiKeySource,
    tokenPresent: Boolean(params.config.openaiApiKey),
    error: null as string | null,
  };
  if (!github.configured) {
    github.error = 'Set GITHUB_TOKEN to crawl GitHub data.';
  }
  if (!openai.configured) {
    openai.error = 'Set OPENAI_API_KEY only for summary or embedding commands.';
  }

  const vectorliteHealth = params.vectorStore.checkRuntime();

  return {
    health: params.health,
    github,
    openai,
    vectorlite: {
      configured: params.config.vectorBackend === 'vectorlite',
      runtimeOk: vectorliteHealth.ok,
      error: vectorliteHealth.error,
    },
  };
}
