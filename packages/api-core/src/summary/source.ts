import type { SqliteDatabase } from '../db/sqlite.js';
import { isBotLikeAuthor } from '../documents/normalize.js';
import { KEY_SUMMARY_MAX_BODY_CHARS, SUMMARY_PROMPT_VERSION } from '../service-constants.js';
import { normalizeSummaryText, stableContentHash } from '../service-utils.js';

export function buildKeySummaryInputText(params: { title: string; labels: string[]; body: string | null }): string {
  const body = normalizeSummaryText(params.body ?? '');
  const truncatedBody =
    body.length > KEY_SUMMARY_MAX_BODY_CHARS
      ? `${body.slice(0, KEY_SUMMARY_MAX_BODY_CHARS)}\n\n[truncated for key summary]`
      : body;
  return [`title: ${params.title}`, `labels: ${params.labels.join(', ')}`, `body: ${truncatedBody}`].join('\n');
}

export function buildSummarySource(
  db: SqliteDatabase,
  params: {
    threadId: number;
    title: string;
    body: string | null;
    labels: string[];
    includeComments: boolean;
  },
): { summaryInput: string; summaryContentHash: string } {
  const parts = [`title: ${normalizeSummaryText(params.title)}`];
  const normalizedBody = normalizeSummaryText(params.body ?? '');
  if (normalizedBody) {
    parts.push(`body: ${normalizedBody}`);
  }
  if (params.labels.length > 0) {
    parts.push(`labels: ${params.labels.join(', ')}`);
  }

  if (params.includeComments) {
    const comments = db
      .prepare(
        `select body, author_login, author_type, is_bot
         from comments
         where thread_id = ?
         order by coalesce(created_at_gh, updated_at_gh) asc, id asc`,
      )
      .all(params.threadId) as Array<{ body: string; author_login: string | null; author_type: string | null; is_bot: number }>;

    const humanComments = comments
      .filter((comment) =>
        !isBotLikeAuthor({
          authorLogin: comment.author_login,
          authorType: comment.author_type,
          isBot: comment.is_bot === 1,
        }),
      )
      .map((comment) => {
        const author = comment.author_login ? `@${comment.author_login}` : 'unknown';
        const normalized = normalizeSummaryText(comment.body);
        return normalized ? `${author}: ${normalized}` : '';
      })
      .filter(Boolean);

    if (humanComments.length > 0) {
      parts.push(`discussion:\n${humanComments.join('\n')}`);
    }
  }

  const summaryInput = parts.join('\n\n');
  const summaryContentHash = stableContentHash(
    `summary:${SUMMARY_PROMPT_VERSION}:${params.includeComments ? 'with-comments' : 'metadata-only'}\n${summaryInput}`,
  );
  return { summaryInput, summaryContentHash };
}
