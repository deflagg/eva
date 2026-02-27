import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { formatInsightsForDebug, formatInsightsForPrompt, retrieveRecentInsights } from './retrieve_recent_insights.js';

const SHORT_TERM_MEMORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS short_term_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms INTEGER NOT NULL,
    bucket_start_ms INTEGER NOT NULL,
    bucket_end_ms INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    source_entry_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_short_term_summaries_created_at
    ON short_term_summaries(created_at_ms);
`;

const SHORT_TERM_SUMMARY_MAX_LINE_CHARS = 180;
const RECENT_SHORT_TERM_FALLBACK_ROWS = 3;

const ShortTermSummaryRowSchema = z
  .object({
    id: z.number().int().nonnegative(),
    created_at_ms: z.number().int().nonnegative(),
    bucket_start_ms: z.number().int().nonnegative(),
    bucket_end_ms: z.number().int().nonnegative(),
    summary_text: z.string().trim().min(1),
    source_entry_count: z.number().int().nonnegative(),
  })
  .strict();

type ShortTermSummaryRow = z.infer<typeof ShortTermSummaryRowSchema>;

interface TokenBudget {
  usedTokens: number;
  maxTokens: number;
}

export type ShortTermSelectionMode = 'tag-filter' | 'fallback' | 'none';

export interface BuildRespondShortTermContextInput {
  requestText: string;
  shortTermMemoryDbPath: string;
  workingMemoryLogPath: string;
  tokenBudget: number;
  maxShortTermRows: number;
  recentInsightsWindowMs: number;
  recentInsightsMaxItems: number;
  deriveQueryTags: (text: string) => string[];
  deriveSummaryTags: (text: string) => string[];
}

export interface RespondShortTermContextResult {
  text: string;
  lines: string[];
  approxTokens: number;
  tokenBudget: number;
  queryTags: string[];
  recentInsightsCount: number;
  debugRecentInsightsRaw: string;
  candidateShortTermRowsCount: number;
  selectedShortTermRowsCount: number;
  shortTermSelectionMode: ShortTermSelectionMode;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function truncateText(value: string, maxLength = SHORT_TERM_SUMMARY_MAX_LINE_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function appendLineWithinBudget(lines: string[], line: string, budget: TokenBudget): boolean {
  const normalized = line.trim();
  if (!normalized) {
    return false;
  }

  const lineTokens = estimateTokens(normalized) + 1;
  if (budget.usedTokens + lineTokens > budget.maxTokens) {
    return false;
  }

  lines.push(normalized);
  budget.usedTokens += lineTokens;
  return true;
}

function haveTagOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightSet = new Set(right);
  return left.some((tag) => rightSet.has(tag));
}

function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped;
}

function selectRecentShortTermSummaries(dbPath: string, limit: number): ShortTermSummaryRow[] {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(SHORT_TERM_MEMORY_SCHEMA_SQL);

    const statement = db.prepare(`
      SELECT
        id,
        created_at_ms,
        bucket_start_ms,
        bucket_end_ms,
        summary_text,
        source_entry_count
      FROM short_term_summaries
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ?
    `);

    const rows = statement.all(limit) as unknown[];
    const normalizedRows: ShortTermSummaryRow[] = [];

    for (const row of rows) {
      const parsed = ShortTermSummaryRowSchema.safeParse(row);
      if (!parsed.success) {
        console.warn('[agent] skipping invalid short-term summary row while building respond short-term context');
        continue;
      }

      normalizedRows.push(parsed.data);
    }

    return normalizedRows;
  } finally {
    db.close();
  }
}

/**
 * Build the short-term section of respond memory context.
 *
 * Contract:
 * - Deterministic formatting order: header -> recent observations -> short-term summaries.
 * - Bounded by token budget (approximate, char/4 heuristic).
 * - Returns debug metadata so callers can trace row selection behavior.
 */
export async function buildRespondShortTermContext(
  input: BuildRespondShortTermContextInput,
): Promise<RespondShortTermContextResult> {
  const tokenBudget = Math.max(1, Math.floor(input.tokenBudget));
  const budget: TokenBudget = {
    usedTokens: 0,
    maxTokens: tokenBudget,
  };

  const queryTags = dedupeTags(input.deriveQueryTags(input.requestText));

  const lines: string[] = [];
  appendLineWithinBudget(lines, 'Retrieved EVA memory context (bounded by token budget).', budget);
  appendLineWithinBudget(
    lines,
    `Context budget: ~${tokenBudget} tokens (approximation); used tags for filtering: ${
      queryTags.length > 0 ? queryTags.join(', ') : 'none'
    }.`,
    budget,
  );

  const nowTsMs = Date.now();
  const recentInsights = await retrieveRecentInsights({
    logPath: input.workingMemoryLogPath,
    sinceTsMs: nowTsMs - input.recentInsightsWindowMs,
    untilTsMs: nowTsMs,
    limit: input.recentInsightsMaxItems,
  });

  const debugRecentInsightsRaw =
    recentInsights.length === 0
      ? '- none'
      : formatInsightsForDebug(recentInsights, {
          maxItems: input.recentInsightsMaxItems,
          maxWhatChangedItems: 2,
          maxLineChars: 180,
        });

  appendLineWithinBudget(lines, 'Recent observations:', budget);
  if (recentInsights.length === 0) {
    appendLineWithinBudget(lines, '- Nothing notable was observed in the last ~2 minutes.', budget);
  } else {
    const formattedInsights = formatInsightsForPrompt(recentInsights, {
      maxItems: input.recentInsightsMaxItems,
      maxWhatChangedItems: 2,
      maxLineChars: 180,
    });

    for (const line of formattedInsights.split('\n')) {
      if (!appendLineWithinBudget(lines, line, budget)) {
        break;
      }
    }
  }

  const recentRows = selectRecentShortTermSummaries(input.shortTermMemoryDbPath, Math.max(0, input.maxShortTermRows));
  const recentRowsWithTags = recentRows.map((row) => ({
    row,
    tags: dedupeTags(input.deriveSummaryTags(row.summary_text)),
  }));

  let filteredRecentRows = recentRowsWithTags.filter((item) => haveTagOverlap(item.tags, queryTags));
  let selectionMode: ShortTermSelectionMode = 'none';

  if (filteredRecentRows.length > 0) {
    selectionMode = 'tag-filter';
  } else if (recentRowsWithTags.length > 0) {
    filteredRecentRows = recentRowsWithTags.slice(0, Math.min(RECENT_SHORT_TERM_FALLBACK_ROWS, recentRowsWithTags.length));
    selectionMode = 'fallback';
  }

  appendLineWithinBudget(lines, 'Recent short-term summaries (tag-filtered):', budget);
  if (filteredRecentRows.length === 0) {
    appendLineWithinBudget(lines, '- No short-term summaries available.', budget);
  } else {
    for (const item of filteredRecentRows) {
      const tagsText = item.tags.length > 0 ? item.tags.join(',') : 'none';
      const line = `- short_term#${item.row.id} tags=[${tagsText}] ${truncateText(item.row.summary_text)}`;
      if (!appendLineWithinBudget(lines, line, budget)) {
        break;
      }
    }
  }

  return {
    text: lines.join('\n'),
    lines,
    approxTokens: budget.usedTokens,
    tokenBudget: budget.maxTokens,
    queryTags,
    recentInsightsCount: recentInsights.length,
    debugRecentInsightsRaw,
    candidateShortTermRowsCount: recentRowsWithTags.length,
    selectedShortTermRowsCount: filteredRecentRows.length,
    shortTermSelectionMode: selectionMode,
  };
}
