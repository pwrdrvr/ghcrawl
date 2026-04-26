import { parentPort, workerData } from 'node:worker_threads';

import { openDb } from '../db/sqlite.js';
import { normalizeEmbedding } from '../search/exact.js';
import { buildSourceKindEdges } from './exact-edges.js';

type WorkerInput = {
  dbPath: string;
  repoId: number;
  sourceKind: 'title' | 'body' | 'dedupe_summary' | 'llm_key_summary';
  limit: number;
  minScore: number;
};

type Row = {
  id: number;
  embedding_json: string;
};

const port = parentPort;
if (!port) {
  throw new Error('edge-worker requires a parent port');
}

const { dbPath, repoId, sourceKind, limit, minScore } = workerData as WorkerInput;
const db = openDb(dbPath);

try {
  const rows = db
    .prepare(
      `select t.id, e.embedding_json
       from document_embeddings e
       join threads t on t.id = e.thread_id
       where t.repo_id = ?
         and t.state = 'open'
         and t.closed_at_local is null
         and e.source_kind = ?`,
    )
    .all(repoId, sourceKind) as Row[];

  const items = rows.map((row) => {
    const normalized = normalizeEmbedding(JSON.parse(row.embedding_json) as number[]);
    return {
      id: row.id,
      normalizedEmbedding: normalized.normalized,
    };
  });

  const edges = buildSourceKindEdges(items, {
    limit,
    minScore,
    onProgress: (progress) => {
      port.postMessage({
        type: 'progress',
        sourceKind,
        ...progress,
      });
    },
  });

  port.postMessage({
    type: 'result',
    sourceKind,
    edges,
  });
} finally {
  db.close();
}
