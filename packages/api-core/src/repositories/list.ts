import { repositoriesResponseSchema, type RepositoriesResponse } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';
import { repositoryToDto } from '../service-utils.js';

export function listStoredRepositories(db: SqliteDatabase): RepositoriesResponse {
  const rows = db.prepare('select * from repositories order by full_name asc').all() as Array<Record<string, unknown>>;
  return repositoriesResponseSchema.parse({ repositories: rows.map(repositoryToDto) });
}
