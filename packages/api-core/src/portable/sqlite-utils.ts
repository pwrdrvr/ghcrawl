import crypto from 'node:crypto';
import fs from 'node:fs';

import BetterSqlite3 from 'better-sqlite3';

import type { SqliteDatabase } from '../db/sqlite.js';

export function openReadonlyDb(dbPath: string): SqliteDatabase {
  return new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
}

export function listTables(db: SqliteDatabase): Set<string> {
  const rows = db
    .prepare("select name from sqlite_master where type in ('table', 'view') and name not like 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

export function readPortableMetadata(db: SqliteDatabase): Record<string, string> {
  const rows = db.prepare('select key, value from portable_metadata order by key').all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function readIntegrityCheck(db: SqliteDatabase): string[] {
  const rows = db.prepare('pragma integrity_check').all() as Array<{ integrity_check: string }>;
  return rows.map((row) => row.integrity_check);
}

export function readForeignKeyViolations(db: SqliteDatabase): Array<Record<string, unknown>> {
  return db.prepare('pragma foreign_key_check').all() as Array<Record<string, unknown>>;
}

export function readDbstatSizes(db: SqliteDatabase): Array<{ name: string; bytes: number | null; rows: number | null }> {
  try {
    const rows = db
      .prepare(
        `select
           s.name as name,
           s.bytes as bytes,
           coalesce(t.row_count, 0) as rows
         from (
           select name, sum(pgsize) as bytes
           from dbstat
           where name not like 'sqlite_%'
           group by name
         ) s
         left join (
           select name, null as row_count
           from sqlite_master
           where 0
         ) t on t.name = s.name
         order by s.bytes desc, s.name asc`,
      )
      .all() as Array<{ name: string; bytes: number; rows: number | null }>;
    return rows.map((row) => ({ name: row.name, bytes: row.bytes, rows: safeCountRows(db, row.name) }));
  } catch {
    const tableNames = [...listTables(db)].sort();
    return tableNames.map((name) => ({ name, bytes: null, rows: safeCountRows(db, name) }));
  }
}

export function countRows(db: SqliteDatabase, tableName: string): number {
  const row = db.prepare(`select count(*) as count from "${tableName}"`).get() as { count: number };
  return row.count;
}

export function safeCountRows(db: SqliteDatabase, tableName: string): number | null {
  try {
    return countRows(db, tableName);
  } catch {
    return null;
  }
}

export function attachedTableHasColumn(db: SqliteDatabase, schemaName: string, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`pragma ${schemaName}.table_info("${tableName}")`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
