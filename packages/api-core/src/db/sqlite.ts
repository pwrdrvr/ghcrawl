import fs from 'node:fs';
import path from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

const BUSY_TIMEOUT_MS = 5_000;
const CACHE_SIZE_KIB = 64 * 1024;
const WAL_AUTOCHECKPOINT_PAGES = 1_000;
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const MMAP_SIZE_BYTES = 256 * 1024 * 1024;

export function openDb(dbPath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  configureDb(db, { persistent: dbPath !== ':memory:' });
  return db;
}

export function configureDb(db: SqliteDatabase, options: { persistent: boolean }): void {
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  if (options.persistent) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
    db.pragma(`mmap_size = ${MMAP_SIZE_BYTES}`);
  }
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY');
  db.pragma(`cache_size = -${CACHE_SIZE_KIB}`);
}

export function checkpointWal(db: SqliteDatabase): void {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // Other processes may hold the WAL; SQLite will checkpoint on a later connection.
  }
}
