import type { ActiveVectorTask } from '../service-types.js';

export function chunkEmbeddingTasks(items: ActiveVectorTask[], maxItems: number, maxEstimatedTokens: number): ActiveVectorTask[][] {
  const chunks: ActiveVectorTask[][] = [];
  let current: ActiveVectorTask[] = [];
  let currentEstimatedTokens = 0;

  for (const item of items) {
    const wouldExceedItemCount = current.length >= maxItems;
    const wouldExceedTokenBudget = current.length > 0 && currentEstimatedTokens + item.estimatedTokens > maxEstimatedTokens;
    if (wouldExceedItemCount || wouldExceedTokenBudget) {
      chunks.push(current);
      current = [];
      currentEstimatedTokens = 0;
    }

    current.push(item);
    currentEstimatedTokens += item.estimatedTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
