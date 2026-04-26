import fs from 'node:fs';
import { existsSync } from 'node:fs';

import { optimizeResponseSchema, type OptimizeResponse, type RepositoryDto } from '@ghcrawl/api-contract';

import type { GitcrawlConfig } from './config.js';
import { openDb, type SqliteDatabase } from './db/sqlite.js';
import { requireFromHere } from './service-constants.js';
import type { SqliteMaintenanceStats } from './service-types.js';
import { nowIso } from './service-utils.js';
import { repositoryVectorStorePath, vectorStoreSidecarPath } from './vector/repository-store.js';
import type { VectorStore } from './vector/store.js';

type OptimizeTarget = OptimizeResponse['targets'][number];

export function optimizeStorageStores(params: {
  config: GitcrawlConfig;
  db: SqliteDatabase;
  vectorStore: VectorStore;
  repository?: RepositoryDto | null;
}): OptimizeResponse {
  const startedAt = nowIso();
  const repository = params.repository ?? null;

  const targets = [
    optimizeSqliteTarget({
      name: 'main',
      db: params.db,
      dbPath: params.config.dbPath,
    }),
  ];

  if (repository) {
    const storePath = repositoryVectorStorePath(params.config.configDir, repository.fullName);
    const sidecarPath = vectorStoreSidecarPath(storePath);
    if (existsSync(storePath)) {
      params.vectorStore.close();
      const vectorDb = openDb(storePath) as SqliteDatabase & { loadExtension: (extensionPath: string) => void };
      try {
        const vectorlite = requireFromHere('vectorlite') as { vectorlitePath: () => string };
        vectorDb.loadExtension(vectorlite.vectorlitePath());
        targets.push(
          optimizeSqliteTarget({
            name: 'vector',
            db: vectorDb,
            dbPath: storePath,
            sidecarPath,
          }),
        );
      } finally {
        vectorDb.close();
      }
    } else {
      targets.push(missingVectorStoreTarget(storePath, sidecarPath));
    }
  }

  const bytesReclaimed = targets.reduce((sum, target) => sum + target.bytesReclaimed, 0);
  return optimizeResponseSchema.parse({
    ok: true,
    repository,
    startedAt,
    finishedAt: nowIso(),
    targets,
    bytesReclaimed,
    message: `Optimized ${targets.filter((target) => target.existed).length} SQLite store(s); reclaimed ${bytesReclaimed} byte(s).`,
  });
}

export function missingVectorStoreTarget(storePath: string, sidecarPath: string): OptimizeTarget {
  const sidecarBytes = fileSize(sidecarPath);
  return {
    name: 'vector',
    path: storePath,
    existed: false,
    pageSize: 0,
    pageCountBefore: 0,
    pageCountAfter: 0,
    freelistPagesBefore: 0,
    freelistPagesAfter: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    walBytesBefore: 0,
    walBytesAfter: 0,
    shmBytesBefore: 0,
    shmBytesAfter: 0,
    sidecarBytesBefore: sidecarBytes,
    sidecarBytesAfter: sidecarBytes,
    bytesReclaimed: 0,
    operations: ['skipped_missing_vector_store'],
    durationMs: 0,
  };
}

export function optimizeSqliteTarget(params: {
  name: 'main' | 'vector';
  db: SqliteDatabase;
  dbPath: string;
  sidecarPath?: string;
}): OptimizeTarget {
  const startedAt = Date.now();
  const before = sqliteMaintenanceStats(params.db, params.dbPath, params.sidecarPath);
  const operations: string[] = [];

  runMaintenanceStep(params.db, 'wal_checkpoint_truncate_before', operations, () => {
    params.db.pragma('wal_checkpoint(TRUNCATE)');
  });
  runMaintenanceStep(params.db, 'analyze', operations, () => {
    params.db.exec('analyze');
  });
  runMaintenanceStep(params.db, 'pragma_optimize', operations, () => {
    params.db.pragma('optimize');
  });
  runMaintenanceStep(params.db, 'vacuum', operations, () => {
    params.db.exec('vacuum');
  });
  runMaintenanceStep(params.db, 'wal_checkpoint_truncate_after', operations, () => {
    params.db.pragma('wal_checkpoint(TRUNCATE)');
  });

  const after = sqliteMaintenanceStats(params.db, params.dbPath, params.sidecarPath);
  const bytesBefore = before.bytes + before.walBytes + before.shmBytes;
  const bytesAfter = after.bytes + after.walBytes + after.shmBytes;

  return {
    name: params.name,
    path: params.dbPath,
    existed: params.dbPath === ':memory:' || existsSync(params.dbPath),
    pageSize: after.pageSize || before.pageSize,
    pageCountBefore: before.pageCount,
    pageCountAfter: after.pageCount,
    freelistPagesBefore: before.freelistPages,
    freelistPagesAfter: after.freelistPages,
    bytesBefore: before.bytes,
    bytesAfter: after.bytes,
    walBytesBefore: before.walBytes,
    walBytesAfter: after.walBytes,
    shmBytesBefore: before.shmBytes,
    shmBytesAfter: after.shmBytes,
    sidecarBytesBefore: before.sidecarBytes,
    sidecarBytesAfter: after.sidecarBytes,
    bytesReclaimed: Math.max(0, bytesBefore - bytesAfter),
    operations,
    durationMs: Date.now() - startedAt,
  };
}

function runMaintenanceStep(db: SqliteDatabase, label: string, operations: string[], step: () => void): void {
  try {
    step();
    operations.push(label);
  } catch (error) {
    operations.push(`${label}_skipped:${error instanceof Error ? error.message : String(error)}`);
  }
}

function sqliteMaintenanceStats(db: SqliteDatabase, dbPath: string, sidecarPath?: string): SqliteMaintenanceStats {
  return {
    pageSize: safePragmaNumber(db, 'page_size'),
    pageCount: safePragmaNumber(db, 'page_count'),
    freelistPages: safePragmaNumber(db, 'freelist_count'),
    bytes: fileSize(dbPath),
    walBytes: fileSize(`${dbPath}-wal`),
    shmBytes: fileSize(`${dbPath}-shm`),
    sidecarBytes: sidecarPath ? fileSize(sidecarPath) : 0,
  };
}

function safePragmaNumber(db: SqliteDatabase, name: string): number {
  try {
    const value = db.pragma(name, { simple: true }) as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function fileSize(filePath: string): number {
  if (filePath === ':memory:') return 0;
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
