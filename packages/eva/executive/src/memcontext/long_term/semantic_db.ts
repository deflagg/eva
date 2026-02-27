import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SEMANTIC_ITEM_KINDS = ['trait', 'preference', 'fact', 'project', 'rule'] as const;

export type SemanticItemKind = (typeof SEMANTIC_ITEM_KINDS)[number];

export type SemanticOrderBy = 'recent' | 'support';

export interface SemanticItemInput {
  id: string;
  kind: SemanticItemKind;
  text: string;
  confidence: number;
  supportCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  sourceSummaryIds: number[];
  updatedAtMs: number;
}

export interface SemanticItemRecord {
  id: string;
  kind: SemanticItemKind;
  text: string;
  confidence: number;
  supportCount: number;
  firstSeenMs: number;
  lastSeenMs: number;
  sourceSummaryIds: number[];
  updatedAtMs: number;
}

const SEMANTIC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS semantic_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    confidence REAL NOT NULL,
    support_count INTEGER NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    source_summary_ids_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_semantic_items_last_seen
    ON semantic_items(last_seen_ms DESC, updated_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_semantic_items_support
    ON semantic_items(support_count DESC, confidence DESC, last_seen_ms DESC);
`;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.round(value);
}

function normalizeSupportCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.round(value);
}

function normalizeSourceSummaryIds(sourceSummaryIds: number[]): number[] {
  const normalizedSet = new Set<number>();

  for (const sourceSummaryId of sourceSummaryIds) {
    if (!Number.isFinite(sourceSummaryId) || sourceSummaryId < 0) {
      continue;
    }

    normalizedSet.add(Math.round(sourceSummaryId));
  }

  return Array.from(normalizedSet).sort((a, b) => a - b);
}

function serializeSourceSummaryIds(sourceSummaryIds: number[]): string {
  return JSON.stringify(normalizeSourceSummaryIds(sourceSummaryIds));
}

function parseSourceSummaryIds(raw: unknown): number[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeSourceSummaryIds(
      parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)),
    );
  } catch {
    return [];
  }
}

function normalizeItemInput(item: SemanticItemInput): SemanticItemInput {
  const normalizedId = item.id.trim();
  if (!normalizedId) {
    throw new Error('semantic item id is required');
  }

  const normalizedText = item.text.trim();
  if (!normalizedText) {
    throw new Error(`semantic item text is required (id=${normalizedId})`);
  }

  const firstSeenMs = normalizeTimestamp(item.firstSeenMs);
  const lastSeenMs = normalizeTimestamp(item.lastSeenMs);

  return {
    id: normalizedId,
    kind: item.kind,
    text: normalizedText,
    confidence: clampConfidence(item.confidence),
    supportCount: normalizeSupportCount(item.supportCount),
    firstSeenMs: Math.min(firstSeenMs, lastSeenMs),
    lastSeenMs: Math.max(firstSeenMs, lastSeenMs),
    sourceSummaryIds: normalizeSourceSummaryIds(item.sourceSummaryIds),
    updatedAtMs: normalizeTimestamp(item.updatedAtMs),
  };
}

function ensureSemanticDbSchema(db: DatabaseSync): void {
  db.exec(SEMANTIC_SCHEMA_SQL);
}

export function initializeSemanticDb(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    ensureSemanticDbSchema(db);
  } finally {
    db.close();
  }
}

export function upsertSemanticItems(dbPath: string, items: SemanticItemInput[]): number {
  if (items.length === 0) {
    return 0;
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    ensureSemanticDbSchema(db);

    const statement = db.prepare(`
      INSERT INTO semantic_items (
        id,
        kind,
        text,
        confidence,
        support_count,
        first_seen_ms,
        last_seen_ms,
        source_summary_ids_json,
        updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        text = excluded.text,
        confidence = MAX(semantic_items.confidence, excluded.confidence),
        support_count = semantic_items.support_count + excluded.support_count,
        first_seen_ms = MIN(semantic_items.first_seen_ms, excluded.first_seen_ms),
        last_seen_ms = MAX(semantic_items.last_seen_ms, excluded.last_seen_ms),
        source_summary_ids_json = excluded.source_summary_ids_json,
        updated_at_ms = excluded.updated_at_ms
    `);

    db.exec('BEGIN');
    try {
      for (const rawItem of items) {
        const item = normalizeItemInput(rawItem);
        statement.run(
          item.id,
          item.kind,
          item.text,
          item.confidence,
          item.supportCount,
          item.firstSeenMs,
          item.lastSeenMs,
          serializeSourceSummaryIds(item.sourceSummaryIds),
          item.updatedAtMs,
        );
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return items.length;
  } finally {
    db.close();
  }
}

function orderByClause(orderBy: SemanticOrderBy): string {
  if (orderBy === 'support') {
    return 'support_count DESC, confidence DESC, last_seen_ms DESC, updated_at_ms DESC';
  }

  return 'last_seen_ms DESC, updated_at_ms DESC, support_count DESC, confidence DESC';
}

export function countSemanticItems(dbPath: string): number {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    ensureSemanticDbSchema(db);

    const row = db.prepare('SELECT COUNT(*) AS count FROM semantic_items').get() as { count?: unknown } | undefined;
    const countValue = typeof row?.count === 'number' ? row.count : Number(row?.count ?? 0);

    if (!Number.isFinite(countValue) || countValue < 0) {
      return 0;
    }

    return Math.round(countValue);
  } finally {
    db.close();
  }
}

export function selectTopSemanticItems(
  dbPath: string,
  limit: number,
  orderBy: SemanticOrderBy = 'recent',
): SemanticItemRecord[] {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) {
    return [];
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    ensureSemanticDbSchema(db);

    const statement = db.prepare(`
      SELECT
        id,
        kind,
        text,
        confidence,
        support_count,
        first_seen_ms,
        last_seen_ms,
        source_summary_ids_json,
        updated_at_ms
      FROM semantic_items
      ORDER BY ${orderByClause(orderBy)}
      LIMIT ?
    `);

    const rows = statement.all(normalizedLimit) as Array<Record<string, unknown>>;
    const semanticItemKindSet = new Set<string>(SEMANTIC_ITEM_KINDS);

    const records: SemanticItemRecord[] = [];

    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      const kind = typeof row.kind === 'string' ? row.kind.trim() : '';
      const text = typeof row.text === 'string' ? row.text.trim() : '';

      if (!id || !text || !semanticItemKindSet.has(kind)) {
        continue;
      }

      records.push({
        id,
        kind: kind as SemanticItemKind,
        text,
        confidence: clampConfidence(Number(row.confidence ?? 0)),
        supportCount: normalizeSupportCount(Number(row.support_count ?? 0)),
        firstSeenMs: normalizeTimestamp(Number(row.first_seen_ms ?? 0)),
        lastSeenMs: normalizeTimestamp(Number(row.last_seen_ms ?? 0)),
        sourceSummaryIds: parseSourceSummaryIds(row.source_summary_ids_json),
        updatedAtMs: normalizeTimestamp(Number(row.updated_at_ms ?? 0)),
      });
    }

    return records;
  } finally {
    db.close();
  }
}
