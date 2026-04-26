import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveEdgeWorkerRuntime(): { url: URL } | null {
  const jsUrl = new URL('./edge-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(jsUrl))) {
    return { url: jsUrl };
  }
  // Source-mode runs do not have a compiled worker entrypoint, so keep clustering in-process.
  return null;
}
