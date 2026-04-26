import type { RepositoryDto } from '@ghcrawl/api-contract';

import type { SqliteDatabase } from '../db/sqlite.js';

export const PORTABLE_SYNC_SCHEMA_VERSION = 'ghcrawl-portable-sync-v1';
export const DEFAULT_PORTABLE_BODY_CHARS = 512;
export type PortableSyncProfile = 'lean' | 'review';

export const PORTABLE_SYNC_TABLES = [
  'repositories',
  'threads',
  'thread_revisions',
  'thread_fingerprints',
  'thread_key_summaries',
  'repo_sync_state',
  'repo_pipeline_state',
  'cluster_groups',
  'cluster_memberships',
  'cluster_overrides',
  'cluster_aliases',
  'cluster_closures',
] as const;

export const PORTABLE_SYNC_EXCLUDED_TABLES = [
  'blobs',
  'comments',
  'documents',
  'documents_fts',
  'document_embeddings',
  'thread_vectors',
  'thread_code_snapshots',
  'thread_changed_files',
  'thread_hunk_signatures',
  'cluster_events',
  'pipeline_runs',
  'sync_runs',
  'summary_runs',
  'embedding_runs',
  'cluster_runs',
  'similarity_edges',
  'similarity_edge_evidence',
] as const;

export type PortableSyncExportOptions = {
  repository: RepositoryDto;
  sourceDb: SqliteDatabase;
  sourcePath: string;
  outputPath: string;
  bodyChars?: number;
  profile?: PortableSyncProfile;
  writeManifest?: boolean;
};

export type PortableSyncManifest = {
  schema: string;
  profile: PortableSyncProfile | 'default';
  exportedAt: string;
  outputPath: string;
  outputBytes: number;
  sha256: string;
  repository: {
    id: number;
    owner: string;
    name: string;
    fullName: string;
  };
  bodyChars: number;
  tables: Array<{ name: string; rows: number }>;
  excluded: string[];
  validationOk: boolean;
};

export type PortableSyncExportResponse = {
  ok: true;
  repository: {
    id: number;
    owner: string;
    name: string;
    fullName: string;
  };
  outputPath: string;
  sourcePath: string;
  sourceBytes: number;
  outputBytes: number;
  compressionRatio: number;
  bodyChars: number;
  profile: PortableSyncProfile | 'default';
  tables: Array<{ name: string; rows: number }>;
  excluded: string[];
  manifestPath: string | null;
  manifest: PortableSyncManifest;
};

export type PortableSyncValidationResponse = {
  ok: boolean;
  path: string;
  schema: string | null;
  metadata: Record<string, string>;
  integrity: string[];
  foreignKeyViolations: Array<Record<string, unknown>>;
  missingTables: string[];
  unexpectedExcludedTables: string[];
  tables: Array<{ name: string; rows: number }>;
  errors: string[];
};

export type PortableSyncSizeResponse = {
  ok: true;
  path: string;
  totalBytes: number;
  walBytes: number;
  shmBytes: number;
  tables: Array<{ name: string; bytes: number | null; rows: number | null }>;
};

export type PortableRepoSnapshot = {
  threads: {
    total: number;
    open: number;
    closed: number;
    issues: number;
    pullRequests: number;
    latestUpdatedAt: string | null;
  };
  clusters: {
    groups: number;
    memberships: number;
    overrides: number;
    aliases: number;
    closures: number;
  };
};

export type PortableSyncStatusResponse = {
  ok: true;
  repository: {
    id: number;
    owner: string;
    name: string;
    fullName: string;
  };
  portablePath: string;
  portableRepositoryFound: boolean;
  live: PortableRepoSnapshot;
  portable: PortableRepoSnapshot;
  drift: {
    liveOnlyThreads: number;
    portableOnlyThreads: number;
    changedThreads: number;
    liveOnlyClusters: number;
    portableOnlyClusters: number;
    changedClusters: number;
    liveOnlyMemberships: number;
    portableOnlyMemberships: number;
    changedMemberships: number;
  };
};

export type PortableSyncImportResponse = {
  ok: true;
  path: string;
  repository: {
    id: number;
    owner: string;
    name: string;
    fullName: string;
  };
  validationOk: boolean;
  imported: {
    repositories: number;
    threads: number;
    threadRevisions: number;
    threadFingerprints: number;
    threadKeySummaries: number;
    repoSyncState: number;
    repoPipelineState: number;
    clusterGroups: number;
    clusterMemberships: number;
    clusterOverrides: number;
    clusterAliases: number;
    clusterClosures: number;
  };
};
