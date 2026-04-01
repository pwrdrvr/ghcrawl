import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { openDb, type SqliteDatabase } from '../db/sqlite.js';
import type { VectorNeighbor, VectorQueryParams, VectorStore, VectorStoreHealth } from './store.js';

const requireFromHere = createRequire(import.meta.url);
const TABLE_NAME = 'thread_vectors_ann';
const META_TABLE_NAME = 'vector_store_meta';
const HNSW_MAX_ELEMENTS = 1_000_000;

type SqliteWithExtension = SqliteDatabase & {
  loadExtension: (extensionPath: string) => void;
};

type StoreHandle = {
  db: SqliteWithExtension;
  storePath: string;
  dimensions: number | null;
};

export class VectorliteStore implements VectorStore {
  private readonly handles = new Map<string, StoreHandle>();

  constructor(
    private readonly options: {
      extensionPathProvider?: () => string;
    } = {},
  ) {}

  checkRuntime(): VectorStoreHealth {
    try {
      this.resolveExtensionPath();
      const db = openDb(':memory:') as SqliteWithExtension;
      try {
        db.loadExtension(this.resolveExtensionPath());
        db.prepare('select vectorlite_info()').get();
      } finally {
        db.close();
      }
      return { ok: true, error: null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  resetRepository(params: { storePath: string; dimensions: number }): void {
    const handle = this.getHandle(params.storePath, params.dimensions);
    handle.db.exec(`drop table if exists ${TABLE_NAME}`);
    handle.db.exec(`delete from ${META_TABLE_NAME}`);
    fs.rmSync(this.indexPath(params.storePath), { force: true });
    handle.dimensions = null;
    this.ensureSchema(handle, params.dimensions);
  }

  upsertVector(params: { storePath: string; dimensions: number; threadId: number; vector: number[] }): void {
    const handle = this.getHandle(params.storePath, params.dimensions);
    handle.db.exec(`delete from ${TABLE_NAME} where rowid = ${Math.trunc(params.threadId)}`);
    handle.db
      .prepare(`insert into ${TABLE_NAME}(rowid, vec) values (?, ?)`)
      .run(params.threadId, this.vectorBuffer(params.vector));
  }

  deleteVector(params: { storePath: string; dimensions: number; threadId: number }): void {
    const handle = this.getHandle(params.storePath, params.dimensions);
    handle.db.exec(`delete from ${TABLE_NAME} where rowid = ${Math.trunc(params.threadId)}`);
  }

  queryNearest(params: VectorQueryParams): VectorNeighbor[] {
    const handle = this.getHandle(params.storePath, params.dimensions);
    const safeLimit = Math.max(1, params.limit);
    const safeCandidateK = Math.max(safeLimit, params.candidateK ?? safeLimit);
    const querySql =
      params.efSearch !== undefined
        ? `select rowid, distance from ${TABLE_NAME} where knn_search(vec, knn_param(?, ${safeCandidateK}, ${params.efSearch}))`
        : `select rowid, distance from ${TABLE_NAME} where knn_search(vec, knn_param(?, ${safeCandidateK}))`;
    const rows = handle.db.prepare(querySql).all([this.vectorBuffer(params.vector)]) as Array<{ rowid: number; distance: number }>;

    return rows
      .filter((row) => row.rowid !== params.excludeThreadId)
      .slice(0, safeLimit)
      .map((row) => ({
        threadId: row.rowid,
        score: this.distanceToScore(row.distance),
      }));
  }

  close(): void {
    for (const handle of this.handles.values()) {
      handle.db.close();
    }
    this.handles.clear();
  }

  private getHandle(storePath: string, dimensions: number): StoreHandle {
    const existing = this.handles.get(storePath);
    if (existing) {
      this.ensureSchema(existing, dimensions);
      return existing;
    }

    const db = openDb(storePath) as SqliteWithExtension;
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.loadExtension(this.resolveExtensionPath());
    const handle: StoreHandle = { db, storePath, dimensions: null };
    this.handles.set(storePath, handle);
    this.ensureSchema(handle, dimensions);
    return handle;
  }

  private ensureSchema(handle: StoreHandle, dimensions: number): void {
    handle.db.exec(`create table if not exists ${META_TABLE_NAME} (id integer primary key check (id = 1), dimensions integer not null)`);
    const meta = handle.db.prepare(`select dimensions from ${META_TABLE_NAME} where id = 1`).get() as { dimensions: number } | undefined;
    const tableExists = Boolean(
      handle.db.prepare("select 1 from sqlite_master where type = 'table' and name = ? limit 1").get(TABLE_NAME),
    );

    if (!meta || meta.dimensions !== dimensions || !tableExists) {
      handle.db.exec(`drop table if exists ${TABLE_NAME}`);
      handle.db.exec(`delete from ${META_TABLE_NAME}`);
      const indexPath = this.indexPath(handle.storePath);
      handle.db.exec(
        `create virtual table ${TABLE_NAME} using vectorlite(vec float32[${dimensions}], hnsw(max_elements=${HNSW_MAX_ELEMENTS}), '${this.escapeSqlString(indexPath)}')`,
      );
      handle.db.prepare(`insert into ${META_TABLE_NAME}(id, dimensions) values (1, ?)`).run(dimensions);
    }

    handle.dimensions = dimensions;
  }

  private resolveExtensionPath(): string {
    if (this.options.extensionPathProvider) {
      return this.options.extensionPathProvider();
    }
    const vectorlite = requireFromHere('vectorlite') as { vectorlitePath: () => string };
    return vectorlite.vectorlitePath();
  }

  private vectorBuffer(vector: number[]): Buffer {
    return Buffer.from(Float32Array.from(vector).buffer);
  }

  private distanceToScore(distance: number): number {
    return 1 - distance / 2;
  }

  private indexPath(storePath: string): string {
    return path.join(path.dirname(storePath), `${path.basename(storePath, path.extname(storePath))}.hnsw`);
  }

  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }
}
