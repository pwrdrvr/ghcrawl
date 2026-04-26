import type { GHCrawlService } from '@ghcrawl/api-core';

export type DoctorResult = Awaited<ReturnType<GHCrawlService['doctor']>>;
export type DoctorReport = DoctorResult & {
  version: string;
  vectorlite?: {
    configured: boolean;
    runtimeOk: boolean;
    error: string | null;
  };
};

export type ConfigureReport = {
  configPath: string;
  updated: boolean;
  summaryModel: 'gpt-5.4' | 'gpt-5-mini' | 'gpt-5.4-mini';
  embeddingBasis: 'title_original' | 'title_summary' | 'llm_key_summary';
  vectorBackend: 'vectorlite';
  costEstimateUsd: {
    sampleThreads: number;
    pricingDate: string;
    gpt54: number | null;
    gpt5Mini: number;
    gpt54Mini: number;
  };
};

export function buildConfigureReport(options: {
  configPath: string;
  updated: boolean;
  summaryModel: 'gpt-5.4' | 'gpt-5-mini' | 'gpt-5.4-mini';
  embeddingBasis: 'title_original' | 'title_summary' | 'llm_key_summary';
  vectorBackend: 'vectorlite';
}): ConfigureReport {
  return {
    ...options,
    costEstimateUsd: {
      sampleThreads: 20_000,
      pricingDate: 'April 1, 2026',
      gpt54: null,
      gpt5Mini: 12,
      gpt54Mini: 30,
    },
  };
}

export function formatDoctorReport(result: DoctorReport): string {
  const lines = [
    'ghcrawl doctor',
    `version: ${result.version}`,
    '',
    'Health',
    `  ok: ${formatBooleanStatus(result.health.ok)}`,
    `  config path: ${result.health.configPath}`,
    `  config file exists: ${formatBooleanStatus(result.health.configFileExists)}`,
    `  db path: ${result.health.dbPath}`,
    `  api port: ${result.health.apiPort}`,
    '',
    'GitHub',
    `  configured: ${formatBooleanStatus(result.github.configured)}`,
    `  source: ${result.github.source}`,
    `  token present: ${formatBooleanStatus(result.github.tokenPresent)}`,
  ];
  if (result.github.error) {
    lines.push(`  note: ${result.github.error}`);
  }
  lines.push(
    '',
    'OpenAI',
    `  configured: ${formatBooleanStatus(result.openai.configured)}`,
    `  source: ${result.openai.source}`,
    `  token present: ${formatBooleanStatus(result.openai.tokenPresent)}`,
  );
  if (result.openai.error) {
    lines.push(`  note: ${result.openai.error}`);
  }
  lines.push(
    '',
    'Vectorlite',
    `  configured: ${formatBooleanStatus(result.vectorlite?.configured ?? false)}`,
    `  runtime ok: ${formatBooleanStatus(result.vectorlite?.runtimeOk ?? false)}`,
  );
  if (result.vectorlite?.error) {
    lines.push(`  note: ${result.vectorlite.error}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatConfigureReport(result: ConfigureReport): string {
  const basisLabel =
    result.embeddingBasis === 'title_summary'
      ? 'title + dedupe summary'
      : result.embeddingBasis === 'llm_key_summary'
        ? 'title + structured LLM key summary'
        : 'title + original body';
  const summaryModeNote =
    result.embeddingBasis === 'title_summary'
      ? 'enabled automatically during refresh'
      : result.embeddingBasis === 'llm_key_summary'
        ? 'requires key-summaries before embedding'
        : 'disabled by default; enable title_summary or llm_key_summary before embedding';
  const lines = [
    'ghcrawl configure',
    `config path: ${result.configPath}`,
    `updated: ${result.updated ? 'yes' : 'no'}`,
    '',
    'Active settings',
    `  summary model: ${result.summaryModel}`,
    `  embedding basis: ${result.embeddingBasis} (${basisLabel})`,
    `  llm summaries: ${summaryModeNote}`,
    `  vector backend: ${result.vectorBackend}`,
    '',
    `Estimated one-time summary cost for ~${result.costEstimateUsd.sampleThreads.toLocaleString()} threads`,
    `  pricing date: ${result.costEstimateUsd.pricingDate}`,
    `  gpt-5.4: ${result.costEstimateUsd.gpt54 === null ? 'not estimated locally' : `~$${result.costEstimateUsd.gpt54.toFixed(0)} USD`}`,
    `  gpt-5-mini: ~$${result.costEstimateUsd.gpt5Mini.toFixed(0)} USD`,
    `  gpt-5.4-mini: ~$${result.costEstimateUsd.gpt54Mini.toFixed(0)} USD`,
    '',
    'Changing summary model or embedding basis will make the next refresh rebuild vectors and clusters.',
  ];
  return `${lines.join('\n')}\n`;
}

function formatBooleanStatus(value: boolean): string {
  return value ? 'yes' : 'no';
}
