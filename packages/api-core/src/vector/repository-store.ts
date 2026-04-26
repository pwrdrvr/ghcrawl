import path from 'node:path';

export function repositoryVectorStorePath(configDir: string, repoFullName: string): string {
  const safeName = repoFullName.replace(/[^a-zA-Z0-9._-]+/g, '__');
  return path.join(configDir, 'vectors', `${safeName}.sqlite`);
}

export function vectorStoreSidecarPath(storePath: string): string {
  return path.join(path.dirname(storePath), `${path.basename(storePath, path.extname(storePath))}.hnsw`);
}

export function isCorruptedVectorIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to load index from file|corrupted or unsupported/i.test(message);
}
