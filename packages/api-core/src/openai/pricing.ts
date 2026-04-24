/**
 * OpenAI pricing catalog for cost estimation.
 *
 * Prices as of April 2026. To add a model, insert one entry in CATALOG.
 * Automated catalog refresh is tracked in issue #23.
 */

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
};

export type CostResult = {
  estimatedCostUsd: number;
};

type ModelPricing = {
  inputPer1MTokens: number;
  outputPer1MTokens: number;
  cachedInputPer1MTokens?: number;
};

const CATALOG: Record<string, ModelPricing> = {
  'text-embedding-3-large': { inputPer1MTokens: 0.13, outputPer1MTokens: 0 },
  'text-embedding-3-small': { inputPer1MTokens: 0.02, outputPer1MTokens: 0 },
  'gpt-5-mini': { inputPer1MTokens: 0.40, outputPer1MTokens: 1.60, cachedInputPer1MTokens: 0.10 },
};

/**
 * Compute estimated cost for a model invocation.
 * Returns null when the model is not in the catalog.
 */
export function computeCost(model: string, usage: TokenUsage): CostResult | null {
  const pricing = CATALOG[model];
  if (!pricing) {
    return null;
  }

  const cached = usage.cachedPromptTokens ?? 0;
  const nonCachedInput = usage.promptTokens - cached;
  const cachedRate = pricing.cachedInputPer1MTokens ?? pricing.inputPer1MTokens;

  const inputCost = (nonCachedInput * pricing.inputPer1MTokens) / 1_000_000;
  const cachedCost = (cached * cachedRate) / 1_000_000;
  const outputCost = (usage.completionTokens * pricing.outputPer1MTokens) / 1_000_000;

  return { estimatedCostUsd: inputCost + cachedCost + outputCost };
}
