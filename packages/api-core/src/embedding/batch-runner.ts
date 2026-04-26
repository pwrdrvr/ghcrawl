import { ACTIVE_EMBED_DIMENSIONS, EMBED_CONTEXT_RETRY_ATTEMPTS } from '../service-constants.js';
import type { ActiveVectorTask } from '../service-types.js';
import type { AiProvider } from '../openai/provider.js';
import { isEmbeddingContextError, parseEmbeddingContextError, shrinkEmbeddingTask } from './retry.js';

export async function embedBatchWithRecovery(params: {
  ai: AiProvider;
  embedModel: string;
  batch: ActiveVectorTask[];
  onProgress?: (message: string) => void;
}): Promise<Array<{ task: ActiveVectorTask; embedding: number[] }>> {
  try {
    const embeddings = await params.ai.embedTexts({
      model: params.embedModel,
      texts: params.batch.map((task) => task.text),
      dimensions: ACTIVE_EMBED_DIMENSIONS,
    });
    return params.batch.map((task, index) => ({ task, embedding: embeddings[index] }));
  } catch (error) {
    const context = parseEmbeddingContextError(error);
    if (!context || params.batch.length === 1) {
      if (params.batch.length === 1 && context) {
        const recovered = await embedSingleTaskWithRecovery({
          ai: params.ai,
          embedModel: params.embedModel,
          task: params.batch[0],
          initialContext: context,
          onProgress: params.onProgress,
        });
        return [recovered];
      }
      throw error;
    }

    params.onProgress?.(`[embed] batch context error; isolating ${params.batch.length} item(s) to find oversized input(s)`);

    const recovered: Array<{ task: ActiveVectorTask; embedding: number[] }> = [];
    for (const task of params.batch) {
      recovered.push(
        await embedSingleTaskWithRecovery({
          ai: params.ai,
          embedModel: params.embedModel,
          task,
          onProgress: params.onProgress,
        }),
      );
    }
    return recovered;
  }
}

async function embedSingleTaskWithRecovery(params: {
  ai: AiProvider;
  embedModel: string;
  task: ActiveVectorTask;
  initialContext?: NonNullable<ReturnType<typeof parseEmbeddingContextError>>;
  onProgress?: (message: string) => void;
}): Promise<{ task: ActiveVectorTask; embedding: number[] }> {
  let current = params.initialContext
    ? shrinkForRetry(params.task, { embedModel: params.embedModel, context: params.initialContext, onProgress: params.onProgress })
    : params.task;

  for (let attempt = 0; attempt < EMBED_CONTEXT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const [embedding] = await params.ai.embedTexts({
        model: params.embedModel,
        texts: [current.text],
        dimensions: ACTIVE_EMBED_DIMENSIONS,
      });
      return { task: current, embedding };
    } catch (error) {
      const context = parseEmbeddingContextError(error);
      if (!context) {
        throw error;
      }

      current = shrinkForRetry(current, { embedModel: params.embedModel, context, onProgress: params.onProgress });
    }
  }

  throw new Error(`Unable to shrink embedding input for #${params.task.threadNumber}:${params.task.basis} below model limits`);
}

function shrinkForRetry(
  task: ActiveVectorTask,
  params: {
    embedModel: string;
    context: NonNullable<ReturnType<typeof parseEmbeddingContextError>>;
    onProgress?: (message: string) => void;
  },
): ActiveVectorTask {
  const next = shrinkEmbeddingTask(task, { embedModel: params.embedModel, context: params.context });
  if (!next || next.text === task.text) {
    throw new Error(`Unable to shrink embedding input for #${task.threadNumber}:${task.basis} below model limits`);
  }
  params.onProgress?.(
    `[embed] shortened #${task.threadNumber}:${task.basis} after context error est_tokens=${task.estimatedTokens}->${next.estimatedTokens}`,
  );
  return next;
}
