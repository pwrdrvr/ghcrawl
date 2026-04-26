import path from 'node:path';

import type { RepositoryDto } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';
import {
  countRows,
  fileSize,
  listTables,
  openReadonlyDb,
  readDbstatSizes,
  readForeignKeyViolations,
  readIntegrityCheck,
  readPortableMetadata,
} from './sqlite-utils.js';
import {
  PORTABLE_SYNC_EXCLUDED_TABLES,
  PORTABLE_SYNC_SCHEMA_VERSION,
  PORTABLE_SYNC_TABLES,
  type PortableRepoSnapshot,
  type PortableSyncSizeResponse,
  type PortableSyncStatusResponse,
  type PortableSyncValidationResponse,
} from './types.js';

export function validatePortableSyncDatabase(dbPath: string): PortableSyncValidationResponse {
  const resolvedPath = path.resolve(dbPath);
  const db = openReadonlyDb(resolvedPath);
  try {
    const tableNames = listTables(db);
    const missingTables = PORTABLE_SYNC_TABLES.filter((name) => !tableNames.has(name));
    const unexpectedExcludedTables = PORTABLE_SYNC_EXCLUDED_TABLES.filter((name) => tableNames.has(name));
    const metadata = tableNames.has('portable_metadata') ? readPortableMetadata(db) : {};
    const integrity = readIntegrityCheck(db);
    const foreignKeyViolations = readForeignKeyViolations(db);
    const schema = metadata.schema ?? null;
    const errors = [
      ...missingTables.map((name) => `missing required table: ${name}`),
      ...unexpectedExcludedTables.map((name) => `excluded cache table is present: ${name}`),
      ...(schema === PORTABLE_SYNC_SCHEMA_VERSION ? [] : [`unexpected schema: ${schema ?? 'missing'}`]),
      ...integrity.filter((message) => message !== 'ok').map((message) => `integrity_check: ${message}`),
      ...foreignKeyViolations.map((violation) => `foreign_key_check: ${JSON.stringify(violation)}`),
    ];

    return {
      ok: errors.length === 0,
      path: resolvedPath,
      schema,
      metadata,
      integrity,
      foreignKeyViolations,
      missingTables,
      unexpectedExcludedTables,
      tables: PORTABLE_SYNC_TABLES.filter((name) => tableNames.has(name)).map((name) => ({ name, rows: countRows(db, name) })),
      errors,
    };
  } finally {
    db.close();
  }
}

export function portableSyncSizeReport(dbPath: string): PortableSyncSizeResponse {
  const resolvedPath = path.resolve(dbPath);
  const db = openReadonlyDb(resolvedPath);
  try {
    const tables = readDbstatSizes(db);
    return {
      ok: true,
      path: resolvedPath,
      totalBytes: fileSize(resolvedPath),
      walBytes: fileSize(`${resolvedPath}-wal`),
      shmBytes: fileSize(`${resolvedPath}-shm`),
      tables,
    };
  } finally {
    db.close();
  }
}

export function portableSyncStatusReport(params: {
  liveDb: SqliteDatabase;
  repository: RepositoryDto;
  portablePath: string;
}): PortableSyncStatusResponse {
  const resolvedPath = path.resolve(params.portablePath);
  const portableDb = openReadonlyDb(resolvedPath);
  try {
    const portableRepo = portableDb
      .prepare('select id from repositories where full_name = ?')
      .get(params.repository.fullName) as { id: number } | undefined;
    const portableRepoId = portableRepo?.id ?? null;
    const liveSnapshot = readRepoSnapshot(params.liveDb, params.repository.id);
    const portableSnapshot = portableRepoId === null ? emptyRepoSnapshot() : readRepoSnapshot(portableDb, portableRepoId);

    const liveThreads = readThreadComparableRows(params.liveDb, params.repository.id);
    const portableThreads = portableRepoId === null ? [] : readThreadComparableRows(portableDb, portableRepoId);
    const liveClusters = readClusterComparableRows(params.liveDb, params.repository.id);
    const portableClusters = portableRepoId === null ? [] : readClusterComparableRows(portableDb, portableRepoId);
    const liveMemberships = readMembershipComparableRows(params.liveDb, params.repository.id);
    const portableMemberships = portableRepoId === null ? [] : readMembershipComparableRows(portableDb, portableRepoId);
    const threadDrift = compareComparableRows(liveThreads, portableThreads);
    const clusterDrift = compareComparableRows(liveClusters, portableClusters);
    const membershipDrift = compareComparableRows(liveMemberships, portableMemberships);

    return {
      ok: true,
      repository: {
        id: params.repository.id,
        owner: params.repository.owner,
        name: params.repository.name,
        fullName: params.repository.fullName,
      },
      portablePath: resolvedPath,
      portableRepositoryFound: portableRepoId !== null,
      live: liveSnapshot,
      portable: portableSnapshot,
      drift: {
        liveOnlyThreads: threadDrift.liveOnly,
        portableOnlyThreads: threadDrift.portableOnly,
        changedThreads: threadDrift.changed,
        liveOnlyClusters: clusterDrift.liveOnly,
        portableOnlyClusters: clusterDrift.portableOnly,
        changedClusters: clusterDrift.changed,
        liveOnlyMemberships: membershipDrift.liveOnly,
        portableOnlyMemberships: membershipDrift.portableOnly,
        changedMemberships: membershipDrift.changed,
      },
    };
  } finally {
    portableDb.close();
  }
}

function emptyRepoSnapshot(): PortableRepoSnapshot {
  return {
    threads: {
      total: 0,
      open: 0,
      closed: 0,
      issues: 0,
      pullRequests: 0,
      latestUpdatedAt: null,
    },
    clusters: {
      groups: 0,
      memberships: 0,
      overrides: 0,
      aliases: 0,
      closures: 0,
    },
  };
}

function readRepoSnapshot(db: SqliteDatabase, repoId: number): PortableRepoSnapshot {
  const threads = db
    .prepare(
      `select
         count(*) as total,
         sum(case when state = 'open' and closed_at_local is null then 1 else 0 end) as open,
         sum(case when state <> 'open' or closed_at_local is not null then 1 else 0 end) as closed,
         sum(case when kind = 'issue' then 1 else 0 end) as issues,
         sum(case when kind = 'pull_request' then 1 else 0 end) as pull_requests,
         max(coalesce(updated_at_gh, updated_at)) as latest_updated_at
       from threads
       where repo_id = ?`,
    )
    .get(repoId) as {
    total: number;
    open: number | null;
    closed: number | null;
    issues: number | null;
    pull_requests: number | null;
    latest_updated_at: string | null;
  };
  const clusters = db
    .prepare(
      `select
         (select count(*) from cluster_groups where repo_id = ?) as groups_count,
         (select count(*)
          from cluster_memberships cm
          join cluster_groups cg on cg.id = cm.cluster_id
          where cg.repo_id = ?) as memberships_count,
         (select count(*) from cluster_overrides where repo_id = ?) as overrides_count,
         (select count(*)
          from cluster_aliases ca
          join cluster_groups cg on cg.id = ca.cluster_id
          where cg.repo_id = ?) as aliases_count,
         (select count(*)
          from cluster_closures cc
          join cluster_groups cg on cg.id = cc.cluster_id
          where cg.repo_id = ?) as closures_count`,
    )
    .get(repoId, repoId, repoId, repoId, repoId) as {
    groups_count: number;
    memberships_count: number;
    overrides_count: number;
    aliases_count: number;
    closures_count: number;
  };

  return {
    threads: {
      total: threads.total,
      open: threads.open ?? 0,
      closed: threads.closed ?? 0,
      issues: threads.issues ?? 0,
      pullRequests: threads.pull_requests ?? 0,
      latestUpdatedAt: threads.latest_updated_at,
    },
    clusters: {
      groups: clusters.groups_count,
      memberships: clusters.memberships_count,
      overrides: clusters.overrides_count,
      aliases: clusters.aliases_count,
      closures: clusters.closures_count,
    },
  };
}

type ComparableRow = { key: string; value: string };

function readThreadComparableRows(db: SqliteDatabase, repoId: number): ComparableRow[] {
  const rows = db
    .prepare(
      `select kind, number, state, title, content_hash, updated_at_gh, closed_at_gh, closed_at_local
       from threads
       where repo_id = ?
       order by kind, number`,
    )
    .all(repoId) as Array<{
    kind: string;
    number: number;
    state: string;
    title: string;
    content_hash: string;
    updated_at_gh: string | null;
    closed_at_gh: string | null;
    closed_at_local: string | null;
  }>;
  return rows.map((row) => ({
    key: `${row.kind}:${row.number}`,
    value: JSON.stringify([row.state, row.title, row.content_hash, row.updated_at_gh, row.closed_at_gh, row.closed_at_local]),
  }));
}

function readClusterComparableRows(db: SqliteDatabase, repoId: number): ComparableRow[] {
  const rows = db
    .prepare(
      `select stable_key, stable_slug, status, cluster_type, title, closed_at
       from cluster_groups
       where repo_id = ?
       order by stable_key`,
    )
    .all(repoId) as Array<{
    stable_key: string;
    stable_slug: string;
    status: string;
    cluster_type: string | null;
    title: string | null;
    closed_at: string | null;
  }>;
  return rows.map((row) => ({
    key: row.stable_key,
    value: JSON.stringify([row.stable_slug, row.status, row.cluster_type, row.title, row.closed_at]),
  }));
}

function readMembershipComparableRows(db: SqliteDatabase, repoId: number): ComparableRow[] {
  const rows = db
    .prepare(
      `select cg.stable_key, t.kind, t.number, cm.role, cm.state, cm.score_to_representative, cm.added_by, cm.removed_by, cm.removed_at
       from cluster_memberships cm
       join cluster_groups cg on cg.id = cm.cluster_id
       join threads t on t.id = cm.thread_id
       where cg.repo_id = ?
       order by cg.stable_key, t.kind, t.number`,
    )
    .all(repoId) as Array<{
    stable_key: string;
    kind: string;
    number: number;
    role: string;
    state: string;
    score_to_representative: number | null;
    added_by: string;
    removed_by: string | null;
    removed_at: string | null;
  }>;
  return rows.map((row) => ({
    key: `${row.stable_key}:${row.kind}:${row.number}`,
    value: JSON.stringify([row.role, row.state, row.score_to_representative, row.added_by, row.removed_by, row.removed_at]),
  }));
}

function compareComparableRows(liveRows: ComparableRow[], portableRows: ComparableRow[]): { liveOnly: number; portableOnly: number; changed: number } {
  const live = new Map(liveRows.map((row) => [row.key, row.value]));
  const portable = new Map(portableRows.map((row) => [row.key, row.value]));
  let liveOnly = 0;
  let portableOnly = 0;
  let changed = 0;

  for (const [key, value] of live) {
    if (!portable.has(key)) {
      liveOnly += 1;
    } else if (portable.get(key) !== value) {
      changed += 1;
    }
  }
  for (const key of portable.keys()) {
    if (!live.has(key)) portableOnly += 1;
  }

  return { liveOnly, portableOnly, changed };
}
