import { LLM_KEY_SUMMARY_PROMPT_VERSION } from '../cluster/llm-key-summary.js';
import type { GitcrawlConfig } from '../config.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import { isRepoVectorStateCurrent } from '../pipeline-state.js';
import { ACTIVE_EMBED_DIMENSIONS, SUMMARY_PROMPT_VERSION } from '../service-constants.js';
import type { EmbeddingWorkset } from '../service-types.js';
import { normalizeSummaryText } from '../service-utils.js';
import { buildActiveVectorTask } from './tasks.js';

export function getEmbeddingWorkset(params: {
  db: SqliteDatabase;
  config: GitcrawlConfig;
  repoId: number;
  threadNumber?: number;
}): EmbeddingWorkset {
  let sql =
    `select t.id, t.number, t.title, t.body
     from threads t
     where t.repo_id = ? and t.state = 'open' and t.closed_at_local is null
       and not exists (
         select 1
         from cluster_closures cc
         join cluster_memberships cm on cm.cluster_id = cc.cluster_id
         where cm.thread_id = t.id
           and cm.state <> 'removed_by_user'
       )`;
  const args: Array<string | number> = [params.repoId];
  if (params.threadNumber) {
    sql += ' and t.number = ?';
    args.push(params.threadNumber);
  }
  sql += ' order by t.number asc';
  const rows = params.db.prepare(sql).all(...args) as Array<{
    id: number;
    number: number;
    title: string;
    body: string | null;
  }>;
  const pipelineCurrent = isRepoVectorStateCurrent(params.db, params.config, params.repoId);
  const existingRows = params.db
    .prepare(
      `select tv.thread_id, tv.content_hash
       from thread_vectors tv
       join threads t on t.id = tv.thread_id
       where t.repo_id = ?
         and tv.model = ?
         and tv.basis = ?
         and tv.dimensions = ?`,
    )
    .all(params.repoId, params.config.embedModel, params.config.embeddingBasis, ACTIVE_EMBED_DIMENSIONS) as Array<{
      thread_id: number;
      content_hash: string;
    }>;
  const existing = new Map<string, string>();
  for (const row of existingRows) {
    existing.set(String(row.thread_id), row.content_hash);
  }
  const summaryTexts =
    params.config.embeddingBasis === 'title_summary'
      ? loadDedupeSummaryTextMap(params)
      : new Map<number, string>();
  const keySummaryTexts =
    params.config.embeddingBasis === 'llm_key_summary'
      ? loadKeySummaryTextMap(params)
      : new Map<number, string>();
  const missingSummaryThreadNumbers: number[] = [];
  const tasks = rows.flatMap((row) => {
    const task = buildActiveVectorTask({
      threadId: row.id,
      threadNumber: row.number,
      title: row.title,
      body: row.body,
      dedupeSummary: summaryTexts.get(row.id) ?? null,
      keySummary: keySummaryTexts.get(row.id) ?? null,
      embeddingBasis: params.config.embeddingBasis,
      embedModel: params.config.embedModel,
    });
    if (task) {
      return [task];
    }
    if (
      (params.config.embeddingBasis === 'title_summary' || params.config.embeddingBasis === 'llm_key_summary') &&
      (!pipelineCurrent || !existing.has(String(row.id)))
    ) {
      missingSummaryThreadNumbers.push(row.number);
    }
    return [];
  });
  const pending = pipelineCurrent
    ? tasks.filter((task) => existing.get(String(task.threadId)) !== task.contentHash)
    : tasks;
  return { rows, tasks, existing, pending, missingSummaryThreadNumbers };
}

function loadDedupeSummaryTextMap(params: {
  db: SqliteDatabase;
  config: GitcrawlConfig;
  repoId: number;
  threadNumber?: number;
}): Map<number, string> {
  let sql =
    `select s.thread_id, s.summary_text
     from document_summaries s
     join threads t on t.id = s.thread_id
     where t.repo_id = ?
       and t.state = 'open'
       and t.closed_at_local is null
       and s.model = ?
       and s.summary_kind = 'dedupe_summary'
       and s.prompt_version = ?`;
  const args: Array<number | string> = [params.repoId, params.config.summaryModel, SUMMARY_PROMPT_VERSION];
  if (params.threadNumber) {
    sql += ' and t.number = ?';
    args.push(params.threadNumber);
  }
  sql += ' order by t.number asc';

  const rows = params.db.prepare(sql).all(...args) as Array<{
    thread_id: number;
    summary_text: string;
  }>;
  const combined = new Map<number, string>();
  for (const row of rows) {
    const text = normalizeSummaryText(row.summary_text);
    if (text) {
      combined.set(row.thread_id, text);
    }
  }
  return combined;
}

function loadKeySummaryTextMap(params: {
  db: SqliteDatabase;
  config: GitcrawlConfig;
  repoId: number;
  threadNumber?: number;
}): Map<number, string> {
  let sql =
    `select tr.thread_id, ks.key_text
     from thread_key_summaries ks
     join thread_revisions tr on tr.id = ks.thread_revision_id
     join threads t on t.id = tr.thread_id
     where t.repo_id = ?
       and t.state = 'open'
       and t.closed_at_local is null
       and ks.summary_kind = 'llm_key_3line'
       and ks.prompt_version = ?
       and ks.model = ?`;
  const args: Array<number | string> = [params.repoId, LLM_KEY_SUMMARY_PROMPT_VERSION, params.config.summaryModel];
  if (params.threadNumber) {
    sql += ' and t.number = ?';
    args.push(params.threadNumber);
  }
  sql += ' order by tr.id asc';

  const rows = params.db.prepare(sql).all(...args) as Array<{
    thread_id: number;
    key_text: string;
  }>;
  const combined = new Map<number, string>();
  for (const row of rows) {
    const text = normalizeSummaryText(row.key_text);
    if (text) {
      combined.set(row.thread_id, text);
    }
  }
  return combined;
}
