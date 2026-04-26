import test from 'node:test';
import assert from 'node:assert/strict';

import type { AiProvider } from '../openai/provider.js';
import type { ActiveVectorTask } from '../service-types.js';
import { embedBatchWithRecovery } from './batch-runner.js';

function task(overrides: Partial<ActiveVectorTask> = {}): ActiveVectorTask {
  return {
    threadId: 1,
    threadNumber: 42,
    basis: 'title_original',
    text: 'x'.repeat(4096),
    contentHash: 'hash',
    estimatedTokens: 2000,
    wasTruncated: false,
    ...overrides,
  };
}

test('embedBatchWithRecovery shrinks a single oversized embedding input and retries it', async () => {
  const calls: string[][] = [];
  const provider: AiProvider = {
    async embedTexts(params) {
      calls.push(params.texts);
      if (calls.length === 1) {
        throw new Error("This model's maximum input length is 1000 tokens. However, you requested 2000 tokens.");
      }
      return [[0.1, 0.2, 0.3]];
    },
    async summarizeThread() {
      throw new Error('not used');
    },
  };
  const progress: string[] = [];

  const [result] = await embedBatchWithRecovery({
    ai: provider,
    embedModel: 'text-embedding-3-small',
    batch: [task()],
    onProgress: (message) => progress.push(message),
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.[0]?.length < calls[0]?.[0]?.length);
  assert.equal(result?.task.wasTruncated, true);
  assert.deepEqual(result?.embedding, [0.1, 0.2, 0.3]);
  assert.match(progress.join('\n'), /shortened #42:title_original/);
});
