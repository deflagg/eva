import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { complete, getModel, validateToolCall } from '@mariozechner/pi-ai';
import { Field, FixedSizeList, Float32, Float64, List, Schema, Utf8 } from 'apache-arrow';
import { z } from 'zod';

import {
  ALLOWED_TONES,
  DEFAULT_TONE,
  getSessionKey,
  getToneForSession,
  loadToneState,
  normalizeToneLabel,
  saveToneStateAtomic,
  updateToneForSession,
} from './memcontext/tone.js';
import { replayWorkingMemoryLog } from './memcontext/working_memory_replay.js';
import { buildRespondLongTermContext } from './memcontext/respond_long_term_context.js';
import { buildRespondShortTermContext, type ShortTermSelectionMode } from './memcontext/respond_short_term_context.js';
import { logLlmTrace } from './llm_log.js';
import { startScheduler } from './jobs/scheduler.js';
import type { AgentConfig, AgentSecrets } from './config.js';
import {
  buildWorkingMemoryCompactionSystemPrompt,
  buildWorkingMemoryCompactionUserPrompt,
} from './prompts/working_memory_compaction.js';
import { buildInsightSystemPrompt, buildInsightUserPrompt } from './prompts/insight.js';
import { buildCurrentUserRequestMessage, buildRespondSystemPrompt } from './prompts/respond.js';
import {
  WORKING_MEMORY_COMPACTION_BULLET_MAX,
  WORKING_MEMORY_COMPACTION_BULLET_MAX_CHARS,
  WORKING_MEMORY_COMPACTION_BULLET_MIN,
  WORKING_MEMORY_COMPACTION_TOOL,
  WORKING_MEMORY_COMPACTION_TOOL_NAME,
  type WorkingMemoryCompactionPayload,
} from './tools/working_memory_compaction.js';
import { INSIGHT_TOOL, INSIGHT_TOOL_NAME, type InsightSummary } from './tools/insight.js';
import { RESPOND_TOOL, RESPOND_TOOL_NAME, type RespondPayload } from './tools/respond.js';
import { deriveLanceDbDir, getOrCreateTable, mergeUpsertById, openDb, queryTopK } from './memcontext/long_term/lancedb.js';
import {
  SEMANTIC_ITEM_KINDS,
  countSemanticItems,
  initializeSemanticDb,
  selectTopSemanticItems,
  upsertSemanticItems,
  type SemanticItemInput,
  type SemanticItemKind,
  type SemanticItemRecord,
} from './memcontext/long_term/semantic_db.js';

const HARD_MAX_FRAMES = 6;
const WORKING_MEMORY_LOG_FILENAME = 'working_memory.log';
const WORKING_MEMORY_ASSETS_DIRNAME = 'working_memory_assets';
const SHORT_TERM_MEMORY_DB_FILENAME = 'short_term_memory.db';
const SEMANTIC_MEMORY_DB_FILENAME = 'semantic_memory.db';
const LEGACY_LONG_TERM_MEMORY_DIRNAME = ['vector', 'db'].join('_');
const LONG_TERM_MEMORY_DB_DIRNAME = 'long_term_memory_db';
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPACTION_SUMMARY_MIN_BULLETS = 3;
const COMPACTION_SUMMARY_MAX_BULLETS = 5;
const VECTOR_EMBEDDING_DIMENSIONS = 64;
const CORE_EXPERIENCES_CACHE_LIMIT = 16;
const CORE_PERSONALITY_CACHE_LIMIT = 12;
const RESPOND_SHORT_TERM_MEMORY_TOKEN_BUDGET = 320;
const RESPOND_SHORT_TERM_MAX_ROWS = 8;
const RESPOND_LONG_TERM_TOP_K = 6;
const RESPOND_CORE_CACHE_ITEMS = 4;
const RESPOND_RECENT_INSIGHTS_WINDOW_MS = 2 * 60 * 1000;
const RESPOND_RECENT_INSIGHTS_MAX_ITEMS = 10;
const RESPOND_LONG_TERM_MEMORY_TOKEN_BUDGET = 320;
const WM_EVENT_SUMMARY_MAX_CHARS = 180;
const WM_EVENT_SUMMARY_MAX_DATA_FIELDS = 4;
const WM_EVENT_SUMMARY_MAX_VALUE_CHARS = 48;
const COMPACTION_PROMPT_MAX_ENTRIES = 240;
const COMPACTION_PROMPT_MAX_LINE_CHARS = 220;
const COMPACTION_PROMPT_MAX_TEXT_CHARS = 180;

const VECTOR_STORE_KINDS = {
  experiences: 'long_term_experiences',
  personality: 'long_term_personality',
} as const;

const EXPERIENCE_TAG_RULES: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bvision\b|\binsight\b/i, tag: 'awareness' },
  { pattern: /\bhigh[-\s]?surprise\b|\bsurprise\b/i, tag: 'anomaly' },
  { pattern: /\bchat\b/i, tag: 'chat' },
  { pattern: /\bquestion\b/i, tag: 'question' },
  { pattern: /\banswer\b/i, tag: 'answer' },
  { pattern: /\bdecision\b/i, tag: 'decision' },
  { pattern: /\bfollow[-_\s]?up\b/i, tag: 'follow_up' },
  { pattern: /\bplan\b|\bplanning\b/i, tag: 'planning' },
  { pattern: /\bimplement\b/i, tag: 'implementation' },
  { pattern: /\bdebug\b/i, tag: 'debugging' },
  { pattern: /\bsafety\b/i, tag: 'safety' },
  { pattern: /\burgent\b/i, tag: 'tone_urgent' },
  { pattern: /\bcalm\b/i, tag: 'tone_calm' },
  { pattern: /\btask\b/i, tag: 'task' },
  { pattern: /\bnear[-_\s]?collision\b/i, tag: 'near_collision' },
  { pattern: /\broi[-_\s]?dwell\b|\bloiter\w*\b/i, tag: 'roi_dwell' },
  { pattern: /\bline[-_\s]?cross\b/i, tag: 'line_cross' },
  { pattern: /\btrack[-_\s]?stop\b/i, tag: 'track_stop' },
  { pattern: /\bsudden\s+motion\b/i, tag: 'sudden_motion' },
];

const PERSONALITY_TAG_RULES: Array<{ pattern: RegExp; tag: string }> = [
  { pattern: /\bprefer\w*\b|\bpreference\b/i, tag: 'preference' },
  { pattern: /\bdecision\b/i, tag: 'decision' },
  { pattern: /\bfollow[-_\s]?up\b/i, tag: 'follow_up' },
  { pattern: /\bplan\b|\bplanning\b/i, tag: 'planning' },
  { pattern: /\bcalm\b/i, tag: 'tone_calm' },
  { pattern: /\burgent\b/i, tag: 'tone_urgent' },
  { pattern: /\bsafety\b/i, tag: 'safety' },
];

const PERSONALITY_SIGNAL_PATTERN = /\b(prefer\w*|preference|tone|calm|urgent|decision|follow[-_\s]?up|planning|safety)\b/i;

const EXPLICIT_TONE_CHANGE_PATTERNS: RegExp[] = [
  /\b(change|switch|adjust)\s+(your\s+)?tone\b/i,
  /\b(be|sound|talk|write)\s+(more|less)\s+(serious|calm|friendly|playful|technical|empathetic|urgent|formal|casual)\b/i,
  /\b(use|keep)\s+(a\s+)?(more\s+|less\s+)?(serious|calm|friendly|playful|technical|empathetic|urgent|formal|casual)\s+tone\b/i,
  /\b(in|with)\s+a\s+(more\s+|less\s+)?(serious|calm|friendly|playful|technical|empathetic|urgent|formal|casual)\s+tone\b/i,
  /\b(no\s+jokes|stop\s+joking)\b/i,
];

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

const ClipFrameSchema = z
  .object({
    frame_id: z.string().min(1).optional(),
    ts_ms: z.number().int().nonnegative().optional(),
    mime: z.literal('image/jpeg').default('image/jpeg'),
    asset_rel_path: z.string().min(1),
  })
  .strict();

const InsightRequestSchema = z
  .object({
    clip_id: z.string().min(1).optional(),
    trigger_frame_id: z.string().min(1).optional(),
    frames: z.array(ClipFrameSchema).min(1),
  })
  .strict();

const RespondRequestSchema = z
  .object({
    text: z.string().trim().min(1),
    session_id: z.string().trim().min(1).optional(),
  })
  .strict();

const RunJobRequestSchema = z
  .object({
    job: z.enum(['compaction', 'promotion']),
    now_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

const WmEventSeveritySchema = z.enum(['low', 'medium', 'high']);

const EventsIngestItemSchema = z
  .object({
    name: z.string().trim().min(1),
    ts_ms: z.number().int().nonnegative(),
    severity: WmEventSeveritySchema,
    track_id: z.number().int().optional(),
    data: z.record(z.unknown()),
  })
  .strict();

const EventsIngestRequestSchema = z
  .object({
    v: z.literal(1),
    source: z.string().trim().min(1),
    events: z.array(EventsIngestItemSchema).min(1),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();

const WorkingMemoryRecordSchema = z
  .object({
    type: z.string().trim().min(1),
    ts_ms: z.number().int().nonnegative(),
  })
  .passthrough();

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

type InsightRequest = z.infer<typeof InsightRequestSchema>;
type RespondRequest = z.infer<typeof RespondRequestSchema>;
type RunJobRequest = z.infer<typeof RunJobRequestSchema>;
type EventsIngestRequest = z.infer<typeof EventsIngestRequestSchema>;
type WmEventSeverity = z.infer<typeof WmEventSeveritySchema>;

interface InsightModelFrame {
  frame_id?: string;
  ts_ms?: number;
  mime: 'image/jpeg';
  image_b64: string;
}

interface WorkingMemoryInsightAssetRef {
  frame_id?: string;
  ts_ms?: number;
  mime: 'image/jpeg';
  asset_rel_path: string;
}

type VectorStoreKind = (typeof VECTOR_STORE_KINDS)[keyof typeof VECTOR_STORE_KINDS];

const VectorStoreEntrySchema = z.object({
  id: z.string().trim().min(1),
  source_summary_id: z.number().int().nonnegative(),
  source_created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1)).min(1),
  embedding: z.array(z.number()).length(VECTOR_EMBEDDING_DIMENSIONS),
});

type VectorStoreEntry = z.infer<typeof VectorStoreEntrySchema>;

interface VectorStoreFile {
  version: 1;
  kind: VectorStoreKind;
  dimensions: number;
  entries: VectorStoreEntry[];
}

interface InsightUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface InsightResult {
  summary: InsightSummary;
  usage: InsightUsage;
}

type RespondMeta = RespondPayload['meta'];

interface RespondResult {
  request_id: string;
  text: string;
  session_id?: string;
  meta: RespondMeta;
}

interface ExperienceTagWhitelist {
  sourcePath: string;
  allowedTags: string[];
  allowedTagSet: Set<string>;
  fallbackTag: string;
  fallbackConcept: string;
}

interface PersonaPrompt {
  sourcePath: string;
  text: string;
}

interface WorkingMemoryTextInputEntry {
  type: 'text_input';
  ts_ms: number;
  request_id: string;
  session_id?: string;
  text: string;
}

interface WorkingMemoryTextOutputEntry {
  type: 'text_output';
  ts_ms: number;
  request_id: string;
  session_id?: string;
  text: string;
  meta: RespondMeta;
}

interface WorkingMemoryWmEventEntry {
  type: 'wm_event';
  ts_ms: number;
  source: string;
  name: string;
  severity: WmEventSeverity;
  track_id?: number;
  summary: string;
  data: Record<string, unknown>;
}

interface WorkingMemoryWmInsightEntry {
  type: 'wm_insight';
  ts_ms: number;
  source: 'vision';
  clip_id: string;
  trigger_frame_id: string;
  severity: InsightSummary['severity'];
  one_liner: string;
  what_changed: string[];
  tags: string[];
  assets: WorkingMemoryInsightAssetRef[];
  narration?: string;
  usage: InsightUsage;
}

type WorkingMemoryEntry =
  | WorkingMemoryTextInputEntry
  | WorkingMemoryTextOutputEntry
  | WorkingMemoryWmEventEntry
  | WorkingMemoryWmInsightEntry;

type WorkingMemoryRecord = {
  type: string;
  ts_ms: number;
  [key: string]: unknown;
};

interface CompactionJobResult {
  runAtMs: number;
  cutoffMs: number;
  sourceEntryCount: number;
  keptEntryCount: number;
  summaryCount: number;
}

interface ShortTermSummaryRow {
  id: number;
  created_at_ms: number;
  bucket_start_ms: number;
  bucket_end_ms: number;
  summary_text: string;
  source_entry_count: number;
}

interface PromotionJobResult {
  runAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  sourceRowCount: number;
  experienceUpsertCount: number;
  personalityUpsertCount: number;
  totalExperienceCount: number;
  totalPersonalityCount: number;
}

type CanonicalRunJobName = RunJobRequest['job'];
type RunJobName = CanonicalRunJobName;

type RunJobResult =
  | {
      job: 'compaction';
      result: CompactionJobResult;
    }
  | {
      job: 'promotion';
      result: PromotionJobResult;
    };

type ParsedRunJobRequest = RunJobRequest;

interface JobRuntimeState {
  lastRequestedRunAtMs: number | null;
  lastStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  lastFailedAtMs: number | null;
  lastError: string | null;
}

type JobsRuntimeState = Record<RunJobName, JobRuntimeState>;

interface RespondMemorySources {
  workingMemoryLogPath: string;
  shortTermMemoryDbPath: string;
  lancedbDir: string;
  coreExperiencesCachePath: string;
  corePersonalityCachePath: string;
}

interface RespondMemoryContextResult {
  text: string;
  approxTokens: number;
  tokenBudget: number;
  recentInsightsCount: number;
  debugRecentInsightsRaw: string;
  candidateShortTermRowsCount: number;
  selectedShortTermRowsCount: number;
  shortTermSelectionMode: ShortTermSelectionMode;
}

interface RetrievedVectorHit {
  kind: VectorStoreKind;
  entry: VectorStoreEntry;
  score: number;
}

export interface StartAgentServerOptions {
  config: AgentConfig;
  secrets: AgentSecrets;
}

class HttpRequestError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly extra: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const runPromise = this.tail.then(task, task);

    this.tail = runPromise.then(
      () => undefined,
      () => undefined,
    );

    return runPromise;
  }
}

function createEmptyJobRuntimeState(): JobRuntimeState {
  return {
    lastRequestedRunAtMs: null,
    lastStartedAtMs: null,
    lastCompletedAtMs: null,
    lastFailedAtMs: null,
    lastError: null,
  };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.writableEnded) {
    return;
  }

  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  sendJson(res, statusCode, {
    error: {
      code,
      message,
      ...(extra ? { extra } : {}),
    },
  });
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let totalBytes = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer | string) => {
      const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += bufferChunk.length;

      if (totalBytes > maxBodyBytes) {
        tooLarge = true;
        return;
      }

      chunks.push(bufferChunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(
          new HttpRequestError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds maxBodyBytes (${maxBodyBytes} bytes).`),
        );
        return;
      }

      const rawBody = Buffer.concat(chunks).toString('utf8');
      if (rawBody.trim().length === 0) {
        reject(new HttpRequestError(400, 'EMPTY_BODY', 'Request body is required.'));
        return;
      }

      try {
        resolve(JSON.parse(rawBody) as unknown);
      } catch {
        reject(new HttpRequestError(400, 'INVALID_JSON', 'Request body must be valid JSON.'));
      }
    });

    req.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      reject(new HttpRequestError(400, 'READ_ERROR', `Failed to read request body: ${message}`));
    });
  });
}

function parseInsightRequest(payload: unknown): InsightRequest {
  const parsed = InsightRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HttpRequestError(400, 'INVALID_REQUEST', `Invalid insight payload: ${details}`);
  }

  return parsed.data;
}

function resolveInsightAssetPath(assetsDirPath: string, assetRelPath: string): string {
  const assetsDirResolved = path.resolve(assetsDirPath);
  const resolvedAssetPath = path.resolve(assetsDirResolved, assetRelPath);
  const assetsDirPrefix = `${assetsDirResolved}${path.sep}`;

  if (resolvedAssetPath !== assetsDirResolved && !resolvedAssetPath.startsWith(assetsDirPrefix)) {
    throw new HttpRequestError(
      400,
      'INSIGHT_ASSET_INVALID_PATH',
      'Insight frame asset path must stay within working_memory_assets.',
      { assetRelPath },
    );
  }

  return resolvedAssetPath;
}

async function loadInsightModelFrames(
  frames: InsightRequest['frames'],
  assetsDirPath: string,
): Promise<InsightModelFrame[]> {
  return await Promise.all(
    frames.map(async (frame) => {
      const resolvedAssetPath = resolveInsightAssetPath(assetsDirPath, frame.asset_rel_path);

      let assetBytes: Buffer;
      try {
        assetBytes = await readFile(resolvedAssetPath);
      } catch (error) {
        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: string }).code ?? '')
            : undefined;

        if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
          throw new HttpRequestError(400, 'INSIGHT_ASSET_MISSING', `Insight frame asset not found: ${frame.asset_rel_path}`, {
            assetRelPath: frame.asset_rel_path,
          });
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new HttpRequestError(
          400,
          'INSIGHT_ASSET_READ_FAILED',
          `Failed to read insight frame asset: ${frame.asset_rel_path}`,
          {
            assetRelPath: frame.asset_rel_path,
            reason: message,
          },
        );
      }

      return {
        ...(frame.frame_id ? { frame_id: frame.frame_id } : {}),
        ...(typeof frame.ts_ms === 'number' ? { ts_ms: frame.ts_ms } : {}),
        mime: frame.mime,
        image_b64: assetBytes.toString('base64'),
      };
    }),
  );
}

function parseRespondRequest(payload: unknown): RespondRequest {
  const parsed = RespondRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HttpRequestError(400, 'INVALID_REQUEST', `Invalid respond payload: ${details}`);
  }

  return parsed.data;
}

function isExplicitToneChangeRequest(text: string): boolean {
  const candidate = text.trim();
  if (!candidate) {
    return false;
  }

  return EXPLICIT_TONE_CHANGE_PATTERNS.some((pattern) => pattern.test(candidate));
}

function parseRunJobRequest(payload: unknown): ParsedRunJobRequest {
  const parsed = RunJobRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HttpRequestError(
      400,
      'INVALID_REQUEST',
      `Invalid run job payload: ${details}. job must be one of: compaction, promotion.`,
    );
  }

  return parsed.data;
}

function parseEventsIngestRequest(payload: unknown): EventsIngestRequest {
  const parsed = EventsIngestRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HttpRequestError(400, 'INVALID_REQUEST', `Invalid events ingest payload: ${details}`);
  }

  return parsed.data;
}

function migrateLegacyLongTermMemoryDir(memoryDirPath: string): void {
  const legacyLongTermMemoryDir = path.resolve(memoryDirPath, LEGACY_LONG_TERM_MEMORY_DIRNAME);
  const longTermMemoryDbDir = path.resolve(memoryDirPath, LONG_TERM_MEMORY_DB_DIRNAME);

  if (!existsSync(legacyLongTermMemoryDir) || existsSync(longTermMemoryDbDir)) {
    return;
  }

  try {
    renameSync(legacyLongTermMemoryDir, longTermMemoryDbDir);
    console.log('[agent] migrated legacy long-term memory dir -> long_term_memory_db');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[agent] failed to migrate legacy long-term memory dir -> long_term_memory_db: ${message}`);
  }
}

function toNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

function extractUsage(message: any): InsightUsage {
  return {
    input_tokens: Math.round(toNonNegativeNumber(message?.usage?.input)),
    output_tokens: Math.round(toNonNegativeNumber(message?.usage?.output)),
    cost_usd: toNonNegativeNumber(message?.usage?.cost?.total),
  };
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function sanitizeAllowedTags(
  tags: string[],
  allowedTagSet: Set<string>,
  fallbackTag: string,
  label: string,
): string[] {
  const normalizedUnique: string[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedUnique.push(normalized);
  }

  const unknownTags = normalizedUnique.filter((tag) => !allowedTagSet.has(tag));
  if (unknownTags.length > 0) {
    console.warn(`[agent] dropping unknown ${label}: ${unknownTags.join(', ')}`);
  }

  const allowedTags = normalizedUnique.filter((tag) => allowedTagSet.has(tag));
  if (allowedTags.length > 0) {
    return allowedTags;
  }

  console.warn(`[agent] no allowed ${label} produced by model; using fallback ${label}: ${fallbackTag}`);
  return [fallbackTag];
}

function loadExperienceTagWhitelist(memoryDirPath: string): ExperienceTagWhitelist {
  const sourcePath = path.resolve(memoryDirPath, 'experience_tags.json');

  let raw: string;
  try {
    raw = readFileSync(sourcePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agent] failed to read experience tags file ${sourcePath}: ${message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`[agent] experience tags file is not valid JSON: ${sourcePath}`);
  }

  const parsed = z.array(z.string().trim().min(1)).min(1).safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`[agent] invalid experience tags in ${sourcePath}: ${details}`);
  }

  const uniqueTags: string[] = [];
  const uniqueTagSet = new Set<string>();

  for (const tag of parsed.data) {
    const normalized = normalizeTag(tag);
    if (!normalized || uniqueTagSet.has(normalized)) {
      continue;
    }

    uniqueTagSet.add(normalized);
    uniqueTags.push(normalized);
  }

  if (uniqueTags.length === 0) {
    throw new Error(`[agent] experience tags whitelist is empty after normalization: ${sourcePath}`);
  }

  const fallbackTag = uniqueTagSet.has('awareness') ? 'awareness' : uniqueTags[0];
  const fallbackConcept = uniqueTagSet.has('chat') ? 'chat' : fallbackTag;

  return {
    sourcePath,
    allowedTags: uniqueTags,
    allowedTagSet: uniqueTagSet,
    fallbackTag,
    fallbackConcept,
  };
}

function loadPersonaPrompt(memoryDirPath: string): PersonaPrompt {
  const sourcePath = path.resolve(memoryDirPath, 'persona.md');

  let text: string;
  try {
    text = readFileSync(sourcePath, 'utf8').trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agent] failed to read persona file ${sourcePath}: ${message}`);
  }

  if (!text) {
    throw new Error(`[agent] persona file is empty: ${sourcePath}`);
  }

  return {
    sourcePath,
    text,
  };
}

function sanitizeInsightTags(
  tags: string[],
  allowedTagSet: Set<string>,
  fallbackTag: string,
): string[] {
  return sanitizeAllowedTags(tags, allowedTagSet, fallbackTag, 'insight tags');
}

function sanitizeRespondConcepts(
  concepts: string[],
  allowedTagSet: Set<string>,
  fallbackConcept: string,
): string[] {
  return sanitizeAllowedTags(concepts, allowedTagSet, fallbackConcept, 'respond concepts');
}

function clampUnitInterval(value: number): number {
  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function sanitizeRespondPayload(
  payload: RespondPayload,
  tagWhitelist: ExperienceTagWhitelist,
): { text: string; meta: RespondMeta } {
  const text = payload.text.trim();
  if (!text) {
    throw new HttpRequestError(502, 'MODEL_INVALID_TOOL_ARGS', 'Model returned empty respond text.');
  }

  const rawTone = payload.meta.tone.trim();
  if (!rawTone) {
    throw new HttpRequestError(502, 'MODEL_INVALID_TOOL_ARGS', 'Model returned empty tone.');
  }

  const tone = normalizeToneLabel(rawTone, 'respond meta.tone');

  const note = payload.meta.note.trim();
  if (!note) {
    throw new HttpRequestError(502, 'MODEL_INVALID_TOOL_ARGS', 'Model returned empty note.');
  }

  const concepts = sanitizeRespondConcepts(
    payload.meta.concepts,
    tagWhitelist.allowedTagSet,
    tagWhitelist.fallbackConcept,
  );

  return {
    text,
    meta: {
      tone,
      concepts,
      surprise: clampUnitInterval(payload.meta.surprise),
      note,
    },
  };
}

function extractAssistantTextContent(assistantMessage: unknown): string | null {
  if (!assistantMessage || typeof assistantMessage !== 'object') {
    return null;
  }

  const content = (assistantMessage as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }

  const textBlocks = content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return null;
      }

      if ((block as { type?: unknown }).type !== 'text') {
        return null;
      }

      const text = (block as { text?: unknown }).text;
      if (typeof text !== 'string') {
        return null;
      }

      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    })
    .filter((value): value is string => typeof value === 'string');

  if (textBlocks.length === 0) {
    return null;
  }

  return textBlocks.join('\n').trim();
}

async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function appendWorkingMemoryEntries(logPath: string, entries: WorkingMemoryEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await ensureParentDir(logPath);
  const payload = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  await appendFile(logPath, payload, 'utf8');
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await ensureParentDir(filePath);

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  await writeFile(tempPath, serialized, 'utf8');
  await rename(tempPath, filePath);
}

async function rewriteWorkingMemoryLogAtomic(logPath: string, entries: WorkingMemoryRecord[]): Promise<void> {
  await ensureParentDir(logPath);

  const tempPath = `${logPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const serialized = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n` : '';

  await writeFile(tempPath, serialized, 'utf8');
  await rename(tempPath, logPath);
}

async function readWorkingMemoryLog(logPath: string): Promise<WorkingMemoryRecord[]> {
  let raw: string;
  try {
    raw = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const entries: WorkingMemoryRecord[] = [];

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      console.warn('[agent] skipping invalid JSON line in working memory log');
      continue;
    }

    const normalized = WorkingMemoryRecordSchema.safeParse(parsed);
    if (!normalized.success) {
      console.warn('[agent] skipping invalid working memory entry (missing type/ts_ms)');
      continue;
    }

    entries.push(normalized.data as WorkingMemoryRecord);
  }

  entries.sort((a, b) => a.ts_ms - b.ts_ms);
  return entries;
}

function truncateText(value: string, maxLength = 160): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatWmEventSummaryValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }

    return truncateText(normalized, WM_EVENT_SUMMARY_MAX_VALUE_CHARS);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return null;
}

function buildWmEventSummary(event: EventsIngestRequest['events'][number]): string {
  const parts = [event.name];

  if (typeof event.track_id === 'number') {
    parts.push(`track_id=${event.track_id}`);
  }

  const keys = Object.keys(event.data).sort();
  let dataFieldCount = 0;

  for (const key of keys) {
    if (dataFieldCount >= WM_EVENT_SUMMARY_MAX_DATA_FIELDS) {
      break;
    }

    const valueText = formatWmEventSummaryValue(event.data[key]);
    if (valueText === null) {
      continue;
    }

    parts.push(`${key}=${valueText}`);
    dataFieldCount += 1;
  }

  return truncateText(parts.join(' '), WM_EVENT_SUMMARY_MAX_CHARS);
}

function buildWorkingMemoryEventEntries(payload: EventsIngestRequest): WorkingMemoryWmEventEntry[] {
  return payload.events.map((event) => ({
    type: 'wm_event',
    ts_ms: event.ts_ms,
    source: payload.source,
    name: event.name,
    severity: event.severity,
    ...(typeof event.track_id === 'number' ? { track_id: event.track_id } : {}),
    summary: buildWmEventSummary(event),
    data: event.data,
  }));
}

function buildWorkingMemoryInsightEntry(
  request: InsightRequest,
  insight: InsightResult,
  tsMs: number,
): WorkingMemoryWmInsightEntry {
  const clipId = request.clip_id?.trim() || `clip-${randomUUID()}`;
  const triggerFrameId = request.trigger_frame_id?.trim() || request.frames[0]?.frame_id?.trim() || 'trigger-unknown';

  const rawNarration = insight.summary.tts_response?.trim();

  return {
    type: 'wm_insight',
    ts_ms: tsMs,
    source: 'vision',
    clip_id: clipId,
    trigger_frame_id: triggerFrameId,
    severity: insight.summary.severity,
    one_liner: insight.summary.one_liner,
    what_changed: [...insight.summary.what_changed],
    tags: [...insight.summary.tags],
    assets: request.frames.map((frame) => ({
      ...(frame.frame_id ? { frame_id: frame.frame_id } : {}),
      ...(typeof frame.ts_ms === 'number' ? { ts_ms: frame.ts_ms } : {}),
      mime: frame.mime,
      asset_rel_path: frame.asset_rel_path,
    })),
    ...(rawNarration ? { narration: rawNarration } : {}),
    usage: {
      input_tokens: insight.usage.input_tokens,
      output_tokens: insight.usage.output_tokens,
      cost_usd: insight.usage.cost_usd,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as Record<string, unknown>;
}

function getStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function getNumberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizeEntriesToBullets(entries: WorkingMemoryRecord[]): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();

  const pushBullet = (text: string): void => {
    const normalized = text.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    bullets.push(normalized);
  };

  for (const entry of entries) {
    if (entry.type !== 'vision_insight' && entry.type !== 'insight') {
      continue;
    }

    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const summary = asRecord(record.summary);
    const oneLiner = summary ? getStringField(summary, 'one_liner') : null;
    const fallbackText = getStringField(record, 'text');
    const candidate = oneLiner ?? fallbackText;

    if (candidate) {
      pushBullet(`Vision insight: ${truncateText(candidate)}`);
    }

    if (bullets.length >= COMPACTION_SUMMARY_MAX_BULLETS) {
      break;
    }
  }

  for (const entry of entries) {
    if (bullets.length >= COMPACTION_SUMMARY_MAX_BULLETS) {
      break;
    }

    if (entry.type !== 'text_output') {
      continue;
    }

    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const meta = asRecord(record.meta);
    const surprise = meta ? getNumberField(meta, 'surprise') : null;
    if (surprise === null || surprise < 0.7) {
      continue;
    }

    const text = getStringField(record, 'text');
    if (!text) {
      continue;
    }

    pushBullet(`High-surprise chat: ${truncateText(text)}`);
  }

  const textOutputs = entries.filter((entry) => entry.type === 'text_output').slice(-2);
  for (const entry of textOutputs) {
    if (bullets.length >= COMPACTION_SUMMARY_MAX_BULLETS) {
      break;
    }

    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const text = getStringField(record, 'text');
    if (!text) {
      continue;
    }

    pushBullet(`Chat highlight: ${truncateText(text)}`);
  }

  const textInputCount = entries.filter((entry) => entry.type === 'text_input').length;
  const textOutputCount = entries.filter((entry) => entry.type === 'text_output').length;
  const insightCount = entries.filter((entry) => entry.type === 'vision_insight' || entry.type === 'insight').length;

  pushBullet(`Compaction rollup: ${entries.length} entries processed from working memory.`);
  pushBullet(`Chat turns: ${textInputCount} inputs and ${textOutputCount} outputs summarized.`);
  if (insightCount > 0) {
    pushBullet(`Vision highlights observed: ${insightCount} insight events.`);
  }

  while (bullets.length < COMPACTION_SUMMARY_MIN_BULLETS) {
    pushBullet(`Memory maintenance note: retained recent context window and archived older activity.`);
  }

  return bullets.slice(0, COMPACTION_SUMMARY_MAX_BULLETS);
}

function initializeShortTermMemoryDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(SHORT_TERM_MEMORY_SCHEMA_SQL);
  } finally {
    db.close();
  }
}

function insertCompactionSummaries(
  dbPath: string,
  params: {
    createdAtMs: number;
    bucketStartMs: number;
    bucketEndMs: number;
    sourceEntryCount: number;
    bullets: string[];
  },
): number {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(SHORT_TERM_MEMORY_SCHEMA_SQL);

    const insertStatement = db.prepare(`
      INSERT INTO short_term_summaries (
        created_at_ms,
        bucket_start_ms,
        bucket_end_ms,
        summary_text,
        source_entry_count
      ) VALUES (?, ?, ?, ?, ?)
    `);

    db.exec('BEGIN');
    try {
      for (const bullet of params.bullets) {
        insertStatement.run(
          params.createdAtMs,
          params.bucketStartMs,
          params.bucketEndMs,
          bullet,
          params.sourceEntryCount,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return params.bullets.length;
  } finally {
    db.close();
  }
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function compactForPrompt(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildCompactionRecordDetail(entry: WorkingMemoryRecord): string {
  const record = asRecord(entry);
  if (!record) {
    return 'detail=unavailable';
  }

  if (entry.type === 'text_input') {
    const text = getStringField(record, 'text') ?? '';
    return `user_input="${compactForPrompt(text, COMPACTION_PROMPT_MAX_TEXT_CHARS)}"`;
  }

  if (entry.type === 'text_output') {
    const text = getStringField(record, 'text') ?? '';
    const parts = [`assistant_output="${compactForPrompt(text, COMPACTION_PROMPT_MAX_TEXT_CHARS)}"`];

    const meta = asRecord(record.meta);
    const tone = meta ? getStringField(meta, 'tone') : null;
    const surprise = meta ? getNumberField(meta, 'surprise') : null;

    if (tone) {
      parts.push(`tone=${tone}`);
    }

    if (surprise !== null) {
      parts.push(`surprise=${surprise.toFixed(2)}`);
    }

    return parts.join(' ');
  }

  if (entry.type === 'wm_insight') {
    const oneLiner = getStringField(record, 'one_liner') ?? '';
    const severity = getStringField(record, 'severity') ?? 'unknown';
    const tags = toStringList(record.tags).slice(0, 4);
    const changed = toStringList(record.what_changed).slice(0, 2);

    const parts = [
      `insight="${compactForPrompt(oneLiner, COMPACTION_PROMPT_MAX_TEXT_CHARS)}"`,
      `severity=${severity}`,
    ];

    if (tags.length > 0) {
      parts.push(`tags=${tags.join(',')}`);
    }

    if (changed.length > 0) {
      parts.push(`what_changed="${compactForPrompt(changed.join(' | '), COMPACTION_PROMPT_MAX_TEXT_CHARS)}"`);
    }

    return parts.join(' ');
  }

  if (entry.type === 'wm_event') {
    const source = getStringField(record, 'source') ?? 'unknown';
    const name = getStringField(record, 'name') ?? 'unknown';
    const severity = getStringField(record, 'severity') ?? 'unknown';
    const summary = getStringField(record, 'summary') ?? '';

    return [
      `event=${name}`,
      `source=${source}`,
      `severity=${severity}`,
      `summary="${compactForPrompt(summary, COMPACTION_PROMPT_MAX_TEXT_CHARS)}"`,
    ].join(' ');
  }

  const summary = getStringField(record, 'summary') ?? getStringField(record, 'text');
  if (summary) {
    return `summary="${compactForPrompt(summary, COMPACTION_PROMPT_MAX_TEXT_CHARS)}"`;
  }

  const keys = Object.keys(record).sort();
  return keys.length > 0 ? `fields=${keys.slice(0, 6).join(',')}` : 'fields=none';
}

function renderWorkingMemoryEntriesForCompaction(entries: WorkingMemoryRecord[]): string {
  const selectedEntries = entries.slice(-COMPACTION_PROMPT_MAX_ENTRIES);
  const omittedCount = entries.length - selectedEntries.length;
  const startIndex = entries.length - selectedEntries.length;

  const lines: string[] = [];

  if (omittedCount > 0) {
    lines.push(`NOTE: omitted ${omittedCount} oldest records to keep prompt bounded.`);
  }

  for (let index = 0; index < selectedEntries.length; index += 1) {
    const entry = selectedEntries[index]!;
    const line = `#${startIndex + index + 1} ts_ms=${entry.ts_ms} type=${entry.type} ${buildCompactionRecordDetail(entry)}`;
    lines.push(compactForPrompt(line, COMPACTION_PROMPT_MAX_LINE_CHARS));
  }

  return lines.join('\n');
}

function isLikelyTelemetryDumpBullet(text: string): boolean {
  if (/[{}]/.test(text)) {
    return true;
  }

  if (/"[^"\n]+"\s*:/.test(text)) {
    return true;
  }

  if (/\b(ts_ms|frame_id|request_id|track_id|asset_rel_path|wm_kind|wm_json|clip_id)\b/i.test(text)) {
    return true;
  }

  return /\b[a-z_]+=[^\s]+\b.*\b[a-z_]+=[^\s]+\b/i.test(text);
}

function normalizeCompactionBullets(rawBullets: string[]): string[] {
  const normalizedBullets: string[] = [];
  const seen = new Set<string>();

  for (const rawBullet of rawBullets) {
    const withoutPrefix = rawBullet.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '');
    const normalized = compactForPrompt(withoutPrefix, WORKING_MEMORY_COMPACTION_BULLET_MAX_CHARS);
    if (!normalized) {
      continue;
    }

    if (isLikelyTelemetryDumpBullet(normalized)) {
      continue;
    }

    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalizedBullets.push(normalized);

    if (normalizedBullets.length >= WORKING_MEMORY_COMPACTION_BULLET_MAX) {
      break;
    }
  }

  if (normalizedBullets.length < WORKING_MEMORY_COMPACTION_BULLET_MIN) {
    throw new Error(
      `model returned ${normalizedBullets.length} valid bullets; expected at least ${WORKING_MEMORY_COMPACTION_BULLET_MIN}.`,
    );
  }

  return normalizedBullets;
}

async function summarizeEntriesToBulletsWithModel(params: {
  entries: WorkingMemoryRecord[];
  windowStartMs: number;
  windowEndMs: number;
  config: AgentConfig;
  secrets: AgentSecrets;
}): Promise<string[]> {
  const model = getModel(params.config.model.provider as never, params.config.model.id as never);

  const context = {
    systemPrompt: buildWorkingMemoryCompactionSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildWorkingMemoryCompactionUserPrompt({
              windowStartMs: params.windowStartMs,
              windowEndMs: params.windowEndMs,
              sourceEntryCount: params.entries.length,
              recordsText: renderWorkingMemoryEntriesForCompaction(params.entries),
            }),
          },
        ],
      },
    ],
    tools: [WORKING_MEMORY_COMPACTION_TOOL],
  };

  let assistantMessage: any;
  try {
    assistantMessage = await complete(model as never, context as never, { apiKey: params.secrets.openaiApiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`compaction model call failed: ${message}`);
  }

  if (assistantMessage?.stopReason === 'error' || assistantMessage?.stopReason === 'aborted') {
    const message =
      typeof assistantMessage?.errorMessage === 'string' && assistantMessage.errorMessage.length > 0
        ? assistantMessage.errorMessage
        : 'model returned an error response';
    throw new Error(`compaction model response error: ${message}`);
  }

  const toolCall = Array.isArray(assistantMessage?.content)
    ? assistantMessage.content.find(
        (block: any) => block?.type === 'toolCall' && block.name === WORKING_MEMORY_COMPACTION_TOOL_NAME,
      )
    : undefined;

  if (!toolCall) {
    throw new Error(`model did not call required tool: ${WORKING_MEMORY_COMPACTION_TOOL_NAME}`);
  }

  let payload: WorkingMemoryCompactionPayload;
  try {
    payload = validateToolCall([WORKING_MEMORY_COMPACTION_TOOL], toolCall as never) as WorkingMemoryCompactionPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid compaction tool payload: ${message}`);
  }

  return normalizeCompactionBullets(payload.bullets);
}

async function runCompactionJob(params: {
  workingMemoryLogPath: string;
  shortTermMemoryDbPath: string;
  nowMs: number;
  compactionWindowMs: number;
  config: AgentConfig;
  secrets: AgentSecrets;
}): Promise<CompactionJobResult> {
  const cutoffMs = params.nowMs - params.compactionWindowMs;
  console.log(
    `[agent] compaction: run_at_ms=${params.nowMs} window_ms=${params.compactionWindowMs} cutoff_ms=${cutoffMs}`,
  );
  const entries = await readWorkingMemoryLog(params.workingMemoryLogPath);

  const olderEntries = entries.filter((entry) => entry.ts_ms < cutoffMs);
  const keptEntries = entries.filter((entry) => entry.ts_ms >= cutoffMs);

  if (olderEntries.length === 0) {
    return {
      runAtMs: params.nowMs,
      cutoffMs,
      sourceEntryCount: 0,
      keptEntryCount: keptEntries.length,
      summaryCount: 0,
    };
  }

  let bullets: string[];
  try {
    bullets = await summarizeEntriesToBulletsWithModel({
      entries: olderEntries,
      windowStartMs: olderEntries[0]?.ts_ms ?? cutoffMs,
      windowEndMs: cutoffMs,
      config: params.config,
      secrets: params.secrets,
    });
    console.log(`[agent] compaction: model path success bullet_count=${bullets.length}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[agent] compaction: fallback path used (${reason}).`);
    bullets = summarizeEntriesToBullets(olderEntries);
  }

  await ensureParentDir(params.shortTermMemoryDbPath);
  const insertedCount = insertCompactionSummaries(params.shortTermMemoryDbPath, {
    createdAtMs: params.nowMs,
    bucketStartMs: olderEntries[0]?.ts_ms ?? cutoffMs,
    bucketEndMs: cutoffMs,
    sourceEntryCount: olderEntries.length,
    bullets,
  });

  await rewriteWorkingMemoryLogAtomic(params.workingMemoryLogPath, keptEntries);

  return {
    runAtMs: params.nowMs,
    cutoffMs,
    sourceEntryCount: olderEntries.length,
    keptEntryCount: keptEntries.length,
    summaryCount: insertedCount,
  };
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function tokenizeTextForEmbedding(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_]+/g);
  return matches ?? [];
}

function buildHashedEmbedding(text: string, dimensions = VECTOR_EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenizeTextForEmbedding(text);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    const sign = (hash & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function deriveTagsFromSummary(
  summaryText: string,
  rules: Array<{ pattern: RegExp; tag: string }>,
  tagWhitelist: ExperienceTagWhitelist,
  fallbackTag: string,
  label: string,
): string[] {
  const candidateTags: string[] = [];

  for (const rule of rules) {
    if (rule.pattern.test(summaryText)) {
      candidateTags.push(rule.tag);
    }
  }

  return sanitizeAllowedTags(candidateTags, tagWhitelist.allowedTagSet, fallbackTag, label);
}

function shouldPromoteToPersonality(summaryText: string): boolean {
  if (PERSONALITY_SIGNAL_PATTERN.test(summaryText)) {
    return true;
  }

  const normalized = summaryText.trim().toLowerCase();
  const isChatNarrative = normalized.startsWith('chat highlight:') || normalized.startsWith('high-surprise chat:');

  if (!isChatNarrative) {
    return false;
  }

  return /\b(should|must|need|please|prefer|avoid|don't|do not)\b/i.test(normalized);
}

function deriveSemanticKind(summaryText: string): SemanticItemKind {
  if (/\bprefer\w*\b/i.test(summaryText)) {
    return 'preference';
  }

  return 'trait';
}

function deriveSemanticItemId(kind: SemanticItemKind, text: string): string {
  const normalizedText = text.trim().toLowerCase();
  const hash = createHash('sha256').update(`${kind}|${normalizedText}`).digest('hex');
  return hash;
}

function buildSemanticItemsFromPromotionRows(rows: ShortTermSummaryRow[], nowMs: number): SemanticItemInput[] {
  const byId = new Map<string, SemanticItemInput>();

  for (const row of rows) {
    if (!shouldPromoteToPersonality(row.summary_text)) {
      continue;
    }

    const kind = deriveSemanticKind(row.summary_text);
    const text = row.summary_text.trim();
    if (!text) {
      continue;
    }

    const id = deriveSemanticItemId(kind, text);
    const confidence = kind === 'preference' ? 0.82 : 0.7;

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        kind,
        text,
        confidence,
        supportCount: 1,
        firstSeenMs: row.created_at_ms,
        lastSeenMs: row.created_at_ms,
        sourceSummaryIds: [row.id],
        updatedAtMs: nowMs,
      });
      continue;
    }

    existing.supportCount += 1;
    existing.confidence = Math.max(existing.confidence, confidence);
    existing.firstSeenMs = Math.min(existing.firstSeenMs, row.created_at_ms);
    existing.lastSeenMs = Math.max(existing.lastSeenMs, row.created_at_ms);
    if (!existing.sourceSummaryIds.includes(row.id)) {
      existing.sourceSummaryIds.push(row.id);
      existing.sourceSummaryIds.sort((a, b) => a - b);
    }
    existing.updatedAtMs = nowMs;
  }

  return Array.from(byId.values());
}

function buildExperienceVectorEntry(
  row: ShortTermSummaryRow,
  nowMs: number,
  tagWhitelist: ExperienceTagWhitelist,
): VectorStoreEntry {
  const tags = deriveTagsFromSummary(
    row.summary_text,
    EXPERIENCE_TAG_RULES,
    tagWhitelist,
    tagWhitelist.fallbackTag,
    'promotion experience tags',
  );

  const embeddingInput = `${row.summary_text}\n${tags.join(' ')}`;

  return {
    id: `short-term-experience-${row.id}`,
    source_summary_id: row.id,
    source_created_at_ms: row.created_at_ms,
    updated_at_ms: nowMs,
    text: row.summary_text,
    tags,
    embedding: buildHashedEmbedding(embeddingInput),
  };
}

function buildPersonalityVectorEntry(
  row: ShortTermSummaryRow,
  nowMs: number,
  tagWhitelist: ExperienceTagWhitelist,
): VectorStoreEntry {
  const personalityFallbackTag = tagWhitelist.allowedTagSet.has('preference') ? 'preference' : tagWhitelist.fallbackTag;
  const tags = deriveTagsFromSummary(
    row.summary_text,
    PERSONALITY_TAG_RULES,
    tagWhitelist,
    personalityFallbackTag,
    'promotion personality tags',
  );

  const embeddingInput = `${row.summary_text}\n${tags.join(' ')}`;

  return {
    id: `short-term-personality-${row.id}`,
    source_summary_id: row.id,
    source_created_at_ms: row.created_at_ms,
    updated_at_ms: nowMs,
    text: row.summary_text,
    tags,
    embedding: buildHashedEmbedding(embeddingInput),
  };
}

function getLanceTableSchema(): Schema {
  return new Schema([
    new Field('id', new Utf8(), false),
    new Field('ts_ms', new Float64(), false),
    new Field('source_summary_id', new Float64(), false),
    new Field('source_created_at_ms', new Float64(), false),
    new Field('updated_at_ms', new Float64(), false),
    new Field('text', new Utf8(), false),
    new Field('tags', new List(new Field('item', new Utf8(), true)), false),
    new Field('vector', new FixedSizeList(VECTOR_EMBEDDING_DIMENSIONS, new Field('item', new Float32(), true)), false),
  ]);
}

function vectorEntryToLanceRow(entry: VectorStoreEntry): Record<string, unknown> {
  return {
    id: entry.id,
    ts_ms: entry.source_created_at_ms,
    source_summary_id: entry.source_summary_id,
    source_created_at_ms: entry.source_created_at_ms,
    updated_at_ms: entry.updated_at_ms,
    text: entry.text,
    tags: entry.tags,
    vector: entry.embedding,
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeVector(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => toFiniteNumber(item)).filter((item): item is number => item !== null);
    return normalized.length === VECTOR_EMBEDDING_DIMENSIONS ? normalized : null;
  }

  if (ArrayBuffer.isView(value) && 'length' in value) {
    const normalized = Array.from(value as unknown as ArrayLike<unknown>)
      .map((item) => toFiniteNumber(item))
      .filter((item): item is number => item !== null);
    return normalized.length === VECTOR_EMBEDDING_DIMENSIONS ? normalized : null;
  }

  return null;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }

    const normalized = item.trim().toLowerCase();
    if (normalized.length === 0 || tags.includes(normalized)) {
      continue;
    }

    tags.push(normalized);
  }

  return tags;
}

function normalizeLanceRow(row: unknown, kind: VectorStoreKind): VectorStoreEntry | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const vector = normalizeVector(record.vector);
  const tags = normalizeTags(record.tags);

  if (!id || !text || !vector || tags.length === 0) {
    console.warn(`[agent] skipping invalid LanceDB ${kind} row`);
    return null;
  }

  const sourceSummaryId = toFiniteNumber(record.source_summary_id);
  const sourceCreatedAtMs = toFiniteNumber(record.source_created_at_ms) ?? toFiniteNumber(record.ts_ms);
  const updatedAtMs = toFiniteNumber(record.updated_at_ms) ?? sourceCreatedAtMs;

  if (sourceSummaryId === null || sourceCreatedAtMs === null || updatedAtMs === null) {
    console.warn(`[agent] skipping LanceDB ${kind} row with missing numeric metadata`);
    return null;
  }

  return {
    id,
    source_summary_id: Math.max(0, Math.round(sourceSummaryId)),
    source_created_at_ms: Math.max(0, Math.round(sourceCreatedAtMs)),
    updated_at_ms: Math.max(0, Math.round(updatedAtMs)),
    text,
    tags,
    embedding: vector,
  };
}

function summarizeTagCounts(entries: VectorStoreEntry[], maxTags = 12): Record<string, number> {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    for (const tag of entry.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTags);

  return Object.fromEntries(sorted);
}

function buildCoreExperiencesCache(vectorStore: VectorStoreFile, nowMs: number): Record<string, unknown> {
  const recentEntries = [...vectorStore.entries]
    .sort((a, b) => b.source_created_at_ms - a.source_created_at_ms || b.id.localeCompare(a.id))
    .slice(0, CORE_EXPERIENCES_CACHE_LIMIT)
    .map((entry) => ({
      id: entry.id,
      source_summary_id: entry.source_summary_id,
      source_created_at_ms: entry.source_created_at_ms,
      tags: entry.tags,
      summary_text: truncateText(entry.text, 220),
    }));

  return {
    updated_at_ms: nowMs,
    store_kind: vectorStore.kind,
    dimensions: vectorStore.dimensions,
    total_entries: vectorStore.entries.length,
    tag_counts: summarizeTagCounts(vectorStore.entries),
    highlights: recentEntries,
  };
}

function buildCorePersonalityCacheFromSemantic(
  items: SemanticItemRecord[],
  nowMs: number,
  totalItemCount = items.length,
): Record<string, unknown> {
  const recentItems = [...items]
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs || b.updatedAtMs - a.updatedAtMs || b.id.localeCompare(a.id))
    .slice(0, CORE_PERSONALITY_CACHE_LIMIT)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      confidence: item.confidence,
      support_count: item.supportCount,
      text: truncateText(item.text, 220),
      first_seen_ms: item.firstSeenMs,
      last_seen_ms: item.lastSeenMs,
    }));

  const kindCountsEntries: Array<[SemanticItemKind, number]> = [];

  for (const kind of SEMANTIC_ITEM_KINDS) {
    const count = items.filter((item) => item.kind === kind).length;
    if (count > 0) {
      kindCountsEntries.push([kind, count]);
    }
  }

  const kindCounts = Object.fromEntries(kindCountsEntries);

  return {
    updated_at_ms: nowMs,
    source: 'semantic_memory_db',
    total_entries: totalItemCount,
    kind_counts: kindCounts,
    items: recentItems,
  };
}

function getYesterdayBounds(nowMs: number): { windowStartMs: number; windowEndMs: number } {
  const localMidnight = new Date(nowMs);
  localMidnight.setHours(0, 0, 0, 0);
  const windowEndMs = localMidnight.getTime();

  return {
    windowStartMs: windowEndMs - DAY_WINDOW_MS,
    windowEndMs,
  };
}

function selectShortTermSummariesForWindow(
  dbPath: string,
  windowStartMs: number,
  windowEndMs: number,
): ShortTermSummaryRow[] {
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
      WHERE created_at_ms >= ? AND created_at_ms < ?
      ORDER BY created_at_ms ASC, id ASC
    `);

    const rows = statement.all(windowStartMs, windowEndMs) as unknown[];
    const normalizedRows: ShortTermSummaryRow[] = [];

    for (const row of rows) {
      const parsed = ShortTermSummaryRowSchema.safeParse(row);
      if (!parsed.success) {
        console.warn('[agent] skipping invalid short-term summary row while running promotion job');
        continue;
      }

      normalizedRows.push(parsed.data);
    }

    return normalizedRows;
  } finally {
    db.close();
  }
}

async function runPromotionJob(params: {
  shortTermMemoryDbPath: string;
  semanticMemoryDbPath: string;
  lancedbDir: string;
  coreExperiencesCachePath: string;
  corePersonalityCachePath: string;
  nowMs: number;
  tagWhitelist: ExperienceTagWhitelist;
}): Promise<PromotionJobResult> {
  const { windowStartMs, windowEndMs } = getYesterdayBounds(params.nowMs);

  await ensureParentDir(params.shortTermMemoryDbPath);
  const promotionRows = selectShortTermSummariesForWindow(params.shortTermMemoryDbPath, windowStartMs, windowEndMs);

  const experienceEntries = promotionRows.map((row) => buildExperienceVectorEntry(row, params.nowMs, params.tagWhitelist));
  const semanticItems = buildSemanticItemsFromPromotionRows(promotionRows, params.nowMs);

  const db = await openDb(params.lancedbDir);
  let experienceTable: Awaited<ReturnType<typeof getOrCreateTable>> | null = null;

  try {
    const tableSchema = getLanceTableSchema();

    experienceTable = await getOrCreateTable(db, VECTOR_STORE_KINDS.experiences, tableSchema);

    const experienceMergeResult = await mergeUpsertById(
      experienceTable,
      experienceEntries.map((entry) => vectorEntryToLanceRow(entry)),
    );

    const experienceRowsRaw = await experienceTable.query().toArray();

    const experienceEntriesFromLance = experienceRowsRaw
      .map((row) => normalizeLanceRow(row, VECTOR_STORE_KINDS.experiences))
      .filter((entry): entry is VectorStoreEntry => entry !== null)
      .sort((a, b) => a.source_created_at_ms - b.source_created_at_ms || a.id.localeCompare(b.id));

    const experienceStoreForCache: VectorStoreFile = {
      version: 1,
      kind: VECTOR_STORE_KINDS.experiences,
      dimensions: VECTOR_EMBEDDING_DIMENSIONS,
      entries: experienceEntriesFromLance,
    };

    const semanticUpsertCount = upsertSemanticItems(params.semanticMemoryDbPath, semanticItems);
    const semanticItemsForCache = selectTopSemanticItems(
      params.semanticMemoryDbPath,
      CORE_PERSONALITY_CACHE_LIMIT,
      'recent',
    );
    const totalSemanticItems = countSemanticItems(params.semanticMemoryDbPath);

    await Promise.all([
      writeJsonAtomic(
        params.coreExperiencesCachePath,
        buildCoreExperiencesCache(experienceStoreForCache, params.nowMs),
      ),
      writeJsonAtomic(
        params.corePersonalityCachePath,
        buildCorePersonalityCacheFromSemantic(semanticItemsForCache, params.nowMs, totalSemanticItems),
      ),
    ]);

    return {
      runAtMs: params.nowMs,
      windowStartMs,
      windowEndMs,
      sourceRowCount: promotionRows.length,
      experienceUpsertCount:
        (experienceMergeResult?.numInsertedRows ?? 0) + (experienceMergeResult?.numUpdatedRows ?? 0),
      personalityUpsertCount: semanticUpsertCount,
      totalExperienceCount: experienceEntriesFromLance.length,
      totalPersonalityCount: totalSemanticItems,
    };
  } finally {
    if (experienceTable) {
      experienceTable.close();
    }

    db.close();
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function appendLineWithinBudget(
  lines: string[],
  line: string,
  budget: { usedTokens: number; maxTokens: number },
): boolean {
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

function deriveAllowedTagsFromText(
  text: string,
  rules: Array<{ pattern: RegExp; tag: string }>,
  allowedTagSet: Set<string>,
): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (!rule.pattern.test(text)) {
      continue;
    }

    const normalized = normalizeTag(rule.tag);
    if (!allowedTagSet.has(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tags.push(normalized);
  }

  return tags;
}

function haveTagOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const rightSet = new Set(right);
  return left.some((tag) => rightSet.has(tag));
}

function dotProduct(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let total = 0;

  for (let index = 0; index < length; index += 1) {
    total += left[index]! * right[index]!;
  }

  return total;
}

async function readJsonObjectIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    console.warn(`[agent] invalid JSON in cache file: ${filePath}`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

function getArrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value;
}

function getStringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

async function buildRespondMemoryContext(params: {
  request: RespondRequest;
  memorySources: RespondMemorySources;
  tagWhitelist: ExperienceTagWhitelist;
}): Promise<RespondMemoryContextResult> {
  const { request, memorySources, tagWhitelist } = params;

  const shortTermContext = await buildRespondShortTermContext({
    requestText: request.text,
    shortTermMemoryDbPath: memorySources.shortTermMemoryDbPath,
    workingMemoryLogPath: memorySources.workingMemoryLogPath,
    tokenBudget: RESPOND_SHORT_TERM_MEMORY_TOKEN_BUDGET,
    maxShortTermRows: RESPOND_SHORT_TERM_MAX_ROWS,
    recentInsightsWindowMs: RESPOND_RECENT_INSIGHTS_WINDOW_MS,
    recentInsightsMaxItems: RESPOND_RECENT_INSIGHTS_MAX_ITEMS,
    deriveQueryTags: (text) => {
      const tags = deriveAllowedTagsFromText(text, [...EXPERIENCE_TAG_RULES, ...PERSONALITY_TAG_RULES], tagWhitelist.allowedTagSet);
      if (tags.length === 0 && tagWhitelist.allowedTagSet.has('chat')) {
        tags.push('chat');
      }

      return tags;
    },
    deriveSummaryTags: (text) => deriveAllowedTagsFromText(text, EXPERIENCE_TAG_RULES, tagWhitelist.allowedTagSet),
  });

  const budget = {
    usedTokens: shortTermContext.approxTokens,
    maxTokens: shortTermContext.tokenBudget,
  };

  const queryTags = [...shortTermContext.queryTags];
  const lines = [...shortTermContext.lines];

  const queryEmbedding = buildHashedEmbedding(`${request.text}\n${queryTags.join(' ')}`);

  let longTermHits: RetrievedVectorHit[] = [];
  const lancedb = await openDb(memorySources.lancedbDir);
  let experiencesTable: Awaited<ReturnType<typeof getOrCreateTable>> | null = null;
  let personalityTable: Awaited<ReturnType<typeof getOrCreateTable>> | null = null;

  try {
    const tableSchema = getLanceTableSchema();
    experiencesTable = await getOrCreateTable(lancedb, VECTOR_STORE_KINDS.experiences, tableSchema);
    personalityTable = await getOrCreateTable(lancedb, VECTOR_STORE_KINDS.personality, tableSchema);

    const [experienceRowsRaw, personalityRowsRaw] = await Promise.all([
      queryTopK(experiencesTable, queryEmbedding, RESPOND_LONG_TERM_TOP_K),
      queryTopK(personalityTable, queryEmbedding, Math.max(1, Math.floor(RESPOND_LONG_TERM_TOP_K / 2))),
    ]);

    const experienceEntries = experienceRowsRaw
      .map((row) => normalizeLanceRow(row, VECTOR_STORE_KINDS.experiences))
      .filter((entry): entry is VectorStoreEntry => entry !== null);

    const personalityEntries = personalityRowsRaw
      .map((row) => normalizeLanceRow(row, VECTOR_STORE_KINDS.personality))
      .filter((entry): entry is VectorStoreEntry => entry !== null);

    longTermHits = [
      ...experienceEntries
        .filter((entry) => queryTags.length === 0 || haveTagOverlap(entry.tags, queryTags))
        .map((entry) => ({
          kind: VECTOR_STORE_KINDS.experiences,
          entry,
          score: dotProduct(entry.embedding, queryEmbedding),
        })),
      ...personalityEntries
        .filter((entry) => queryTags.length === 0 || haveTagOverlap(entry.tags, queryTags))
        .map((entry) => ({
          kind: VECTOR_STORE_KINDS.personality,
          entry,
          score: dotProduct(entry.embedding, queryEmbedding),
        })),
    ]
      .sort((a, b) => b.score - a.score || b.entry.source_created_at_ms - a.entry.source_created_at_ms)
      .slice(0, RESPOND_LONG_TERM_TOP_K);
  } finally {
    if (experiencesTable) {
      experiencesTable.close();
    }

    if (personalityTable) {
      personalityTable.close();
    }

    lancedb.close();
  }

  appendLineWithinBudget(lines, 'Long-term retrieval hits (top-K from LanceDB):', budget);
  if (longTermHits.length === 0) {
    appendLineWithinBudget(lines, '- no relevant long-term memory found', budget);
  }

  for (const hit of longTermHits) {
    const tagsText = hit.entry.tags.join(',');
    const line = `- ${hit.kind}#${hit.entry.source_summary_id} score=${hit.score.toFixed(3)} tags=[${tagsText}] ${truncateText(hit.entry.text, 180)}`;
    if (!appendLineWithinBudget(lines, line, budget)) {
      break;
    }
  }

  const [coreExperiencesCache, corePersonalityCache] = await Promise.all([
    readJsonObjectIfExists(memorySources.coreExperiencesCachePath),
    readJsonObjectIfExists(memorySources.corePersonalityCachePath),
  ]);

  if (coreExperiencesCache) {
    const totalEntries = getNumberField(coreExperiencesCache, 'total_entries') ?? 0;
    appendLineWithinBudget(lines, `Core experiences cache: total_entries=${Math.round(totalEntries)}.`, budget);

    const highlights = getArrayField(coreExperiencesCache, 'highlights');
    for (const highlight of highlights.slice(0, RESPOND_CORE_CACHE_ITEMS)) {
      const highlightRecord = asRecord(highlight);
      if (!highlightRecord) {
        continue;
      }

      const summaryText = getStringField(highlightRecord, 'summary_text');
      if (!summaryText) {
        continue;
      }

      const tags = getStringArrayField(highlightRecord, 'tags');
      const line = `- core_experience tags=[${tags.join(',') || 'none'}] ${truncateText(summaryText, 160)}`;
      if (!appendLineWithinBudget(lines, line, budget)) {
        break;
      }
    }
  }

  if (corePersonalityCache) {
    const totalEntries = getNumberField(corePersonalityCache, 'total_entries') ?? 0;
    appendLineWithinBudget(lines, `Core personality cache: total_entries=${Math.round(totalEntries)}.`, budget);

    const signals = getArrayField(corePersonalityCache, 'signals');
    for (const signal of signals.slice(0, RESPOND_CORE_CACHE_ITEMS)) {
      const signalRecord = asRecord(signal);
      if (!signalRecord) {
        continue;
      }

      const signalText = getStringField(signalRecord, 'signal');
      if (!signalText) {
        continue;
      }

      const tags = getStringArrayField(signalRecord, 'tags');
      const line = `- core_personality tags=[${tags.join(',') || 'none'}] ${truncateText(signalText, 160)}`;
      if (!appendLineWithinBudget(lines, line, budget)) {
        break;
      }
    }
  }

  if (lines.length <= 2) {
    appendLineWithinBudget(lines, 'No relevant memory snippets were available for this turn.', budget);
  }

  return {
    text: lines.join('\n'),
    approxTokens: budget.usedTokens,
    tokenBudget: budget.maxTokens,
    recentInsightsCount: shortTermContext.recentInsightsCount,
    debugRecentInsightsRaw: shortTermContext.debugRecentInsightsRaw,
    candidateShortTermRowsCount: shortTermContext.candidateShortTermRowsCount,
    selectedShortTermRowsCount: shortTermContext.selectedShortTermRowsCount,
    shortTermSelectionMode: shortTermContext.shortTermSelectionMode,
  };
}

async function generateInsight(
  request: InsightRequest,
  assetsDirPath: string,
  config: AgentConfig,
  secrets: AgentSecrets,
  tagWhitelist: ExperienceTagWhitelist,
): Promise<InsightResult> {
  const model = getModel(config.model.provider as never, config.model.id as never);

  const modelFrames = await loadInsightModelFrames(request.frames, assetsDirPath);

  const messageContent = [
    {
      type: 'text',
      text: buildInsightUserPrompt({
        clipId: request.clip_id,
        triggerFrameId: request.trigger_frame_id,
        frameCount: request.frames.length,
      }),
    },
    ...modelFrames.map((frame) => ({
      type: 'image',
      data: frame.image_b64,
      mimeType: frame.mime,
    })),
  ];

  const context = {
    systemPrompt: buildInsightSystemPrompt(config.insight.maxFrames, config.insight.ttsStyle),
    messages: [
      {
        role: 'user',
        content: messageContent,
      },
    ],
    tools: [INSIGHT_TOOL],
  };

  const traceId = `insight-${randomUUID()}`;
  const traceModel = {
    provider: config.model.provider,
    id: config.model.id,
  };

  await logLlmTrace({
    memoryDirPath: config.memoryDirPath,
    kind: 'insight',
    phase: 'request',
    traceId,
    model: traceModel,
    payload: {
      request: {
        clip_id: request.clip_id,
        trigger_frame_id: request.trigger_frame_id,
        frame_count: request.frames.length,
      },
      context,
    },
  });

  let assistantMessage: any;
  try {
    assistantMessage = await complete(model as never, context as never, { apiKey: secrets.openaiApiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logLlmTrace({
      memoryDirPath: config.memoryDirPath,
      kind: 'insight',
      phase: 'error',
      traceId,
      model: traceModel,
      payload: {
        message,
        error,
      },
    });
    throw new HttpRequestError(502, 'MODEL_CALL_FAILED', `Insight model request failed: ${message}`);
  }

  await logLlmTrace({
    memoryDirPath: config.memoryDirPath,
    kind: 'insight',
    phase: 'response',
    traceId,
    model: traceModel,
    payload: {
      assistantMessage,
    },
  });

  if (assistantMessage?.stopReason === 'error' || assistantMessage?.stopReason === 'aborted') {
    const message =
      typeof assistantMessage?.errorMessage === 'string' && assistantMessage.errorMessage.length > 0
        ? assistantMessage.errorMessage
        : 'Insight model returned an error response.';
    throw new HttpRequestError(502, 'MODEL_RESPONSE_ERROR', message);
  }

  const toolCall = Array.isArray(assistantMessage?.content)
    ? assistantMessage.content.find((block: any) => block?.type === 'toolCall' && block.name === INSIGHT_TOOL_NAME)
    : undefined;

  if (!toolCall) {
    throw new HttpRequestError(502, 'MODEL_NO_TOOL_CALL', `Model did not call required tool: ${INSIGHT_TOOL_NAME}`);
  }

  let summary: InsightSummary;
  try {
    summary = validateToolCall([INSIGHT_TOOL], toolCall as never) as InsightSummary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpRequestError(502, 'MODEL_INVALID_TOOL_ARGS', `Invalid tool arguments from model: ${message}`);
  }

  const filteredTags = sanitizeInsightTags(summary.tags, tagWhitelist.allowedTagSet, tagWhitelist.fallbackTag);

  return {
    summary: {
      ...summary,
      tags: filteredTags,
    },
    usage: extractUsage(assistantMessage),
  };
}

async function generateRespond(
  request: RespondRequest,
  config: AgentConfig,
  secrets: AgentSecrets,
  tagWhitelist: ExperienceTagWhitelist,
  personaPrompt: PersonaPrompt,
  memorySources: {
    workingMemoryLogPath: string;
    shortTermMemoryDbPath: string;
    semanticMemoryDbPath: string;
    lancedbDir: string;
  },
  toneContext: {
    sessionKey: string;
    currentTone: string;
  },
): Promise<{ text: string; meta: RespondMeta }> {
  const model = getModel(config.model.provider as never, config.model.id as never);

  const replayedWorkingMemory = await replayWorkingMemoryLog({
    logPath: memorySources.workingMemoryLogPath,
  });

  const longTermContext = await buildRespondLongTermContext({
    semanticDbPath: memorySources.semanticMemoryDbPath,
    lancedbDir: memorySources.lancedbDir,
    userText: request.text,
    tokenBudget: RESPOND_LONG_TERM_MEMORY_TOKEN_BUDGET,
  });

  let shortTermContext: Awaited<ReturnType<typeof buildRespondShortTermContext>> | null = null;
  let shortTermContextError: string | null = null;

  try {
    shortTermContext = await buildRespondShortTermContext({
      requestText: request.text,
      shortTermMemoryDbPath: memorySources.shortTermMemoryDbPath,
      workingMemoryLogPath: memorySources.workingMemoryLogPath,
      tokenBudget: RESPOND_SHORT_TERM_MEMORY_TOKEN_BUDGET,
      maxShortTermRows: RESPOND_SHORT_TERM_MAX_ROWS,
      recentInsightsWindowMs: RESPOND_RECENT_INSIGHTS_WINDOW_MS,
      recentInsightsMaxItems: RESPOND_RECENT_INSIGHTS_MAX_ITEMS,
      deriveQueryTags: (text) => {
        const tags = deriveAllowedTagsFromText(text, [...EXPERIENCE_TAG_RULES, ...PERSONALITY_TAG_RULES], tagWhitelist.allowedTagSet);
        if (tags.length === 0 && tagWhitelist.allowedTagSet.has('chat')) {
          tags.push('chat');
        }

        return tags;
      },
      deriveSummaryTags: (text) => deriveAllowedTagsFromText(text, EXPERIENCE_TAG_RULES, tagWhitelist.allowedTagSet),
    });
  } catch (error) {
    shortTermContextError = error instanceof Error ? error.message : String(error);
    console.warn(
      `[agent] respond: short-term context unavailable; continuing with long-term context only (${shortTermContextError}).`,
    );
  }

  const shortTermContextText = shortTermContext?.text.trim() ?? '';
  const longTermContextText = longTermContext.trim();

  const combinedMemoryContext = [
    'Short-term memory context (recent + compacted; reference only):',
    shortTermContextText.length > 0
      ? shortTermContextText
      : shortTermContextError
        ? `- Unavailable this turn (${shortTermContextError}).`
        : '- No short-term memory context available.',
    '',
    'Long-term memory context (reference only):',
    longTermContextText.length > 0
      ? longTermContextText
      : 'Traits (long-term):\n- No long-term memory context available.\nRelevant experiences (retrieved):\n- No relevant long-term experiences found.',
  ].join('\n');

  const memoryContextDebug = {
    short_term: {
      included: shortTermContextText.length > 0,
      token_budget: shortTermContext?.tokenBudget ?? RESPOND_SHORT_TERM_MEMORY_TOKEN_BUDGET,
      approx_tokens: shortTermContext?.approxTokens ?? 0,
      char_length: shortTermContextText.length,
      byte_length: Buffer.byteLength(shortTermContextText, 'utf8'),
      query_tags: shortTermContext?.queryTags ?? [],
      recent_insights_count: shortTermContext?.recentInsightsCount ?? 0,
      candidate_rows: shortTermContext?.candidateShortTermRowsCount ?? 0,
      selected_rows: shortTermContext?.selectedShortTermRowsCount ?? 0,
      selection_mode: shortTermContext?.shortTermSelectionMode ?? 'none',
      fallback_used: shortTermContext?.shortTermSelectionMode === 'fallback',
      error: shortTermContextError,
    },
    long_term: {
      included: longTermContextText.length > 0,
      token_budget: RESPOND_LONG_TERM_MEMORY_TOKEN_BUDGET,
      approx_tokens: estimateTokens(longTermContextText),
      char_length: longTermContextText.length,
      byte_length: Buffer.byteLength(longTermContextText, 'utf8'),
    },
    combined: {
      approx_tokens: estimateTokens(combinedMemoryContext),
      char_length: combinedMemoryContext.length,
      byte_length: Buffer.byteLength(combinedMemoryContext, 'utf8'),
    },
  };

  console.log(
    `[agent] respond retrieval: short_term candidate_rows=${memoryContextDebug.short_term.candidate_rows} selected_rows=${memoryContextDebug.short_term.selected_rows} selection_mode=${memoryContextDebug.short_term.selection_mode} fallback_used=${memoryContextDebug.short_term.fallback_used} query_tags=[${memoryContextDebug.short_term.query_tags.join(',') || 'none'}]`,
  );

  const context = {
    systemPrompt: buildRespondSystemPrompt({
      persona: personaPrompt.text,
      allowedConcepts: tagWhitelist.allowedTags,
      maxConcepts: 6,
      currentTone: toneContext.currentTone,
      toneSessionKey: toneContext.sessionKey,
      allowedTones: ALLOWED_TONES,
      memoryContext: combinedMemoryContext,
    }),
    messages: [
      ...replayedWorkingMemory.messages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildCurrentUserRequestMessage({
              text: request.text,
              sessionId: request.session_id,
            }),
          },
        ],
      },
    ],
    tools: [RESPOND_TOOL],
  };

  const traceId = `respond-${randomUUID()}`;
  const traceModel = {
    provider: config.model.provider,
    id: config.model.id,
  };

  await logLlmTrace({
    memoryDirPath: config.memoryDirPath,
    kind: 'respond',
    phase: 'request',
    traceId,
    model: traceModel,
    payload: {
      request: {
        user_text: request.text,
        session_id: request.session_id,
      },
      context,
      memory_context_debug: memoryContextDebug,
      replay_stats: replayedWorkingMemory.stats,
    },
  });

  let assistantMessage: any;
  try {
    assistantMessage = await complete(model as never, context as never, { apiKey: secrets.openaiApiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logLlmTrace({
      memoryDirPath: config.memoryDirPath,
      kind: 'respond',
      phase: 'error',
      traceId,
      model: traceModel,
      payload: {
        message,
        error,
      },
    });
    throw new HttpRequestError(502, 'MODEL_CALL_FAILED', `Respond model request failed: ${message}`);
  }

  await logLlmTrace({
    memoryDirPath: config.memoryDirPath,
    kind: 'respond',
    phase: 'response',
    traceId,
    model: traceModel,
    payload: {
      assistantMessage,
    },
  });

  if (assistantMessage?.stopReason === 'error' || assistantMessage?.stopReason === 'aborted') {
    const message =
      typeof assistantMessage?.errorMessage === 'string' && assistantMessage.errorMessage.length > 0
        ? assistantMessage.errorMessage
        : 'Respond model returned an error response.';
    throw new HttpRequestError(502, 'MODEL_RESPONSE_ERROR', message);
  }

  const toolCall = Array.isArray(assistantMessage?.content)
    ? assistantMessage.content.find((block: any) => block?.type === 'toolCall' && block.name === RESPOND_TOOL_NAME)
    : undefined;

  if (!toolCall) {
    const fallbackText = extractAssistantTextContent(assistantMessage);
    if (fallbackText) {
      console.warn(
        `[agent] respond model returned plain text without ${RESPOND_TOOL_NAME}; using extracted text fallback to avoid user-visible failure.`,
      );

      return sanitizeRespondPayload(
        {
          text: fallbackText,
          meta: {
            tone: toneContext.currentTone,
            concepts: [tagWhitelist.fallbackConcept],
            surprise: 0,
            note: `Fallback path: model omitted ${RESPOND_TOOL_NAME}; preserved plain-text response.`,
          },
        },
        tagWhitelist,
      );
    }

    throw new HttpRequestError(502, 'MODEL_NO_TOOL_CALL', `Model did not call required tool: ${RESPOND_TOOL_NAME}`);
  }

  let payload: RespondPayload;
  try {
    payload = validateToolCall([RESPOND_TOOL], toolCall as never) as RespondPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpRequestError(502, 'MODEL_INVALID_TOOL_ARGS', `Invalid tool arguments from model: ${message}`);
  }

  return sanitizeRespondPayload(payload, tagWhitelist);
}

export function startAgentServer(options: StartAgentServerOptions): Server {
  const { config, secrets } = options;

  const maxFrames = Math.min(config.insight.maxFrames, HARD_MAX_FRAMES);
  const tagWhitelist = loadExperienceTagWhitelist(config.memoryDirPath);
  const personaPrompt = loadPersonaPrompt(config.memoryDirPath);

  const workingMemoryLogPath = path.resolve(config.memoryDirPath, WORKING_MEMORY_LOG_FILENAME);
  const assetsDirPath = path.join(config.memoryDirPath, WORKING_MEMORY_ASSETS_DIRNAME);
  const shortTermMemoryDbPath = path.resolve(config.memoryDirPath, SHORT_TERM_MEMORY_DB_FILENAME);
  const semanticMemoryDbPath = path.resolve(config.memoryDirPath, LONG_TERM_MEMORY_DB_DIRNAME, SEMANTIC_MEMORY_DB_FILENAME);
  const personalityToneCachePath = path.resolve(config.memoryDirPath, 'cache', 'personality_tone.json');
  const coreExperiencesCachePath = path.resolve(config.memoryDirPath, 'cache', 'core_experiences.json');
  const corePersonalityCachePath = path.resolve(config.memoryDirPath, 'cache', 'core_personality.json');
  const lancedbDir = deriveLanceDbDir(config.memoryDirPath);
  const workingMemoryWriteQueue = new SerialTaskQueue();
  const jobsRuntimeState: JobsRuntimeState = {
    compaction: createEmptyJobRuntimeState(),
    promotion: createEmptyJobRuntimeState(),
  };

  mkdirSync(config.memoryDirPath, { recursive: true });
  mkdirSync(assetsDirPath, { recursive: true });
  migrateLegacyLongTermMemoryDir(config.memoryDirPath);
  initializeShortTermMemoryDb(shortTermMemoryDbPath);
  initializeSemanticDb(semanticMemoryDbPath);

  const runCompactionJobAt = async (runAtMs: number): Promise<CompactionJobResult> =>
    await workingMemoryWriteQueue.run(async () =>
      runCompactionJob({
        workingMemoryLogPath,
        shortTermMemoryDbPath,
        nowMs: runAtMs,
        compactionWindowMs: config.jobs.compaction.windowMs,
        config,
        secrets,
      }),
    );

  const runPromotionJobAt = async (runAtMs: number): Promise<PromotionJobResult> =>
    await workingMemoryWriteQueue.run(async () =>
      runPromotionJob({
        shortTermMemoryDbPath,
        semanticMemoryDbPath,
        lancedbDir,
        coreExperiencesCachePath,
        corePersonalityCachePath,
        nowMs: runAtMs,
        tagWhitelist,
      }),
    );

  const buildCompactionJobResponsePayload = (result: CompactionJobResult): Record<string, unknown> => ({
    job: 'compaction',
    run_at_ms: result.runAtMs,
    cutoff_ms: result.cutoffMs,
    source_entry_count: result.sourceEntryCount,
    kept_entry_count: result.keptEntryCount,
    summary_count: result.summaryCount,
    short_term_memory_db: shortTermMemoryDbPath,
    working_memory_log: workingMemoryLogPath,
  });

  const buildPromotionJobResponsePayload = (result: PromotionJobResult): Record<string, unknown> => ({
    job: 'promotion',
    run_at_ms: result.runAtMs,
    window_start_ms: result.windowStartMs,
    window_end_ms: result.windowEndMs,
    source_row_count: result.sourceRowCount,
    experience_upsert_count: result.experienceUpsertCount,
    personality_upsert_count: result.personalityUpsertCount,
    total_experience_count: result.totalExperienceCount,
    total_personality_count: result.totalPersonalityCount,
    short_term_memory_db: shortTermMemoryDbPath,
    semantic_memory_db: semanticMemoryDbPath,
    lancedb: {
      dir: lancedbDir,
      tables: {
        experiences: VECTOR_STORE_KINDS.experiences,
        personality: VECTOR_STORE_KINDS.personality,
      },
    },
    cache: {
      core_experiences: coreExperiencesCachePath,
      core_personality: corePersonalityCachePath,
    },
  });

  const buildRunJobResponsePayload = (runJobResult: RunJobResult): Record<string, unknown> => {
    return runJobResult.job === 'compaction'
      ? buildCompactionJobResponsePayload(runJobResult.result)
      : buildPromotionJobResponsePayload(runJobResult.result);
  };

  const runJob = async (jobName: RunJobName, runAtMs: number): Promise<RunJobResult> => {
    const runtimeState = jobsRuntimeState[jobName];
    runtimeState.lastRequestedRunAtMs = runAtMs;
    runtimeState.lastStartedAtMs = Date.now();

    try {
      if (jobName === 'compaction') {
        const result = await runCompactionJobAt(runAtMs);
        runtimeState.lastCompletedAtMs = Date.now();
        runtimeState.lastFailedAtMs = null;
        runtimeState.lastError = null;
        return {
          job: 'compaction',
          result,
        };
      }

      const result = await runPromotionJobAt(runAtMs);
      runtimeState.lastCompletedAtMs = Date.now();
      runtimeState.lastFailedAtMs = null;
      runtimeState.lastError = null;
      return {
        job: 'promotion',
        result,
      };
    } catch (error) {
      runtimeState.lastFailedAtMs = Date.now();
      runtimeState.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const toJobFailureCode = (jobName: RunJobName): string =>
    jobName === 'compaction' ? 'COMPACTION_JOB_FAILED' : 'PROMOTION_JOB_FAILED';

  let lastInsightRequestAt: number | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(res, 200, {
          service: 'agent',
          status: 'ok',
          model: {
            provider: config.model.provider,
            id: config.model.id,
          },
          guardrails: {
            cooldownMs: config.insight.cooldownMs,
            maxFrames,
            maxBodyBytes: config.insight.maxBodyBytes,
          },
          jobs: {
            enabled: config.jobs.enabled,
            timezone: config.jobs.timezone,
            compaction: {
              enabled: config.jobs.compaction.enabled,
              cron: config.jobs.compaction.cron,
              window_ms: config.jobs.compaction.windowMs,
              last_requested_run_at_ms: jobsRuntimeState.compaction.lastRequestedRunAtMs,
              last_started_at_ms: jobsRuntimeState.compaction.lastStartedAtMs,
              last_completed_at_ms: jobsRuntimeState.compaction.lastCompletedAtMs,
              last_failed_at_ms: jobsRuntimeState.compaction.lastFailedAtMs,
              last_error: jobsRuntimeState.compaction.lastError,
            },
            promotion: {
              enabled: config.jobs.promotion.enabled,
              cron: config.jobs.promotion.cron,
              last_requested_run_at_ms: jobsRuntimeState.promotion.lastRequestedRunAtMs,
              last_started_at_ms: jobsRuntimeState.promotion.lastStartedAtMs,
              last_completed_at_ms: jobsRuntimeState.promotion.lastCompletedAtMs,
              last_failed_at_ms: jobsRuntimeState.promotion.lastFailedAtMs,
              last_error: jobsRuntimeState.promotion.lastError,
            },
          },
          memory: {
            dir: config.memoryDirPath,
            experienceTagsPath: tagWhitelist.sourcePath,
            experienceTagCount: tagWhitelist.allowedTags.length,
            personaPath: personaPrompt.sourcePath,
            workingMemoryLogPath,
            workingMemoryAssetsDirPath: assetsDirPath,
            shortTermMemoryDbPath,
            semanticMemoryDbPath,
            personalityToneCachePath,
            coreExperiencesCachePath,
            corePersonalityCachePath,
            lancedbDir,
            lancedbTables: [VECTOR_STORE_KINDS.experiences, VECTOR_STORE_KINDS.personality],
          },
        });
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/events') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          sendError(res, 415, 'UNSUPPORTED_CONTENT_TYPE', 'Content-Type must be application/json.');
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req, config.insight.maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_BODY', message);
          return;
        }

        let ingestRequest: EventsIngestRequest;
        try {
          ingestRequest = parseEventsIngestRequest(body);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_REQUEST', message);
          return;
        }

        const wmEventEntries = buildWorkingMemoryEventEntries(ingestRequest);

        try {
          await workingMemoryWriteQueue.run(async () => {
            await appendWorkingMemoryEntries(workingMemoryLogPath, wmEventEntries);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 500, 'MEMORY_WRITE_FAILED', `Failed to persist wm_event entries: ${message}`);
          return;
        }

        sendJson(res, 200, {
          accepted: wmEventEntries.length,
          ts_ms: Date.now(),
        });
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/jobs/run') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          sendError(res, 415, 'UNSUPPORTED_CONTENT_TYPE', 'Content-Type must be application/json.');
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req, config.insight.maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_BODY', message);
          return;
        }

        let parsedRunJobRequest: ParsedRunJobRequest;
        try {
          parsedRunJobRequest = parseRunJobRequest(body);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_REQUEST', message);
          return;
        }

        const runAtMs = parsedRunJobRequest.now_ms ?? Date.now();

        let runJobResult: RunJobResult;
        try {
          runJobResult = await runJob(parsedRunJobRequest.job, runAtMs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 500, toJobFailureCode(parsedRunJobRequest.job), message);
          return;
        }

        if (runJobResult.job === 'promotion') {
          console.log(
            `[agent] promotion job wrote long-term rows: experiences=${runJobResult.result.experienceUpsertCount}, characteristics=${runJobResult.result.personalityUpsertCount}, lancedb=${lancedbDir}, semantic_db=${semanticMemoryDbPath}`,
          );
        }

        sendJson(res, 200, buildRunJobResponsePayload(runJobResult));
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/respond') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          sendError(res, 415, 'UNSUPPORTED_CONTENT_TYPE', 'Content-Type must be application/json.');
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req, config.insight.maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_BODY', message);
          return;
        }

        let respondRequest: RespondRequest;
        try {
          respondRequest = parseRespondRequest(body);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_REQUEST', message);
          return;
        }

        const requestId = randomUUID();
        const toneSessionKey = getSessionKey(respondRequest.session_id);
        const userRequestedToneChange = isExplicitToneChangeRequest(respondRequest.text);

        let currentTone = DEFAULT_TONE;
        try {
          const toneState = await loadToneState(config.memoryDirPath);
          currentTone = getToneForSession(toneState, toneSessionKey, Date.now()).tone;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[agent] failed to load tone cache at request start: ${message}`);
        }

        let generatedResponse: { text: string; meta: RespondMeta };
        try {
          generatedResponse = await generateRespond(
            respondRequest,
            config,
            secrets,
            tagWhitelist,
            personaPrompt,
            {
              workingMemoryLogPath,
              shortTermMemoryDbPath,
              semanticMemoryDbPath,
              lancedbDir,
            },
            {
              sessionKey: toneSessionKey,
              currentTone,
            },
          );
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 500, 'INTERNAL_ERROR', message);
          return;
        }

        const tsMs = Date.now();

        const respondResult: RespondResult = {
          request_id: requestId,
          text: generatedResponse.text,
          ...(respondRequest.session_id ? { session_id: respondRequest.session_id } : {}),
          meta: generatedResponse.meta,
        };

        const inputEntry: WorkingMemoryTextInputEntry = {
          type: 'text_input',
          ts_ms: tsMs,
          request_id: requestId,
          ...(respondRequest.session_id ? { session_id: respondRequest.session_id } : {}),
          text: respondRequest.text,
        };

        const outputEntry: WorkingMemoryTextOutputEntry = {
          type: 'text_output',
          ts_ms: Date.now(),
          request_id: requestId,
          ...(respondRequest.session_id ? { session_id: respondRequest.session_id } : {}),
          text: respondResult.text,
          meta: respondResult.meta,
        };

        try {
          await workingMemoryWriteQueue.run(async () => {
            await appendWorkingMemoryEntries(workingMemoryLogPath, [inputEntry, outputEntry]);

            const toneState = await loadToneState(config.memoryDirPath);
            updateToneForSession(toneState, toneSessionKey, respondResult.meta.tone, Date.now(), {
              reason: respondResult.meta.note,
              userRequestedToneChange,
            });
            await saveToneStateAtomic(config.memoryDirPath, toneState);
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 500, 'MEMORY_WRITE_FAILED', `Failed to persist working memory artifacts: ${message}`);
          return;
        }

        sendJson(res, 200, respondResult);
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/insight') {
        const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('application/json')) {
          sendError(res, 415, 'UNSUPPORTED_CONTENT_TYPE', 'Content-Type must be application/json.');
          return;
        }

        let body: unknown;
        try {
          body = await readJsonBody(req, config.insight.maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_BODY', message);
          return;
        }

        let insightRequest: InsightRequest;
        try {
          insightRequest = parseInsightRequest(body);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_REQUEST', message);
          return;
        }

        if (insightRequest.frames.length > maxFrames) {
          sendError(
            res,
            400,
            'TOO_MANY_FRAMES',
            `Insight clip exceeds max frame limit (${maxFrames}).`,
            {
              maxFrames,
              frameCount: insightRequest.frames.length,
            },
          );
          return;
        }

        const now = Date.now();
        if (lastInsightRequestAt !== null) {
          const elapsedMs = now - lastInsightRequestAt;
          if (elapsedMs < config.insight.cooldownMs) {
            const retryAfterMs = config.insight.cooldownMs - elapsedMs;
            sendError(res, 429, 'COOLDOWN_ACTIVE', 'Insight request cooldown active.', {
              retryAfterMs,
            });
            return;
          }
        }

        lastInsightRequestAt = now;

        try {
          const insight = await generateInsight(insightRequest, assetsDirPath, config, secrets, tagWhitelist);
          const wmInsightEntry = buildWorkingMemoryInsightEntry(insightRequest, insight, Date.now());

          await workingMemoryWriteQueue.run(async () => {
            await appendWorkingMemoryEntries(workingMemoryLogPath, [wmInsightEntry]);
          });

          sendJson(res, 200, {
            summary: insight.summary,
            usage: insight.usage,
          });
          return;
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 500, 'INTERNAL_ERROR', message);
          return;
        }
      }

      sendError(res, 404, 'NOT_FOUND', 'Route not found.');
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, 'UNHANDLED_ERROR', message);
    });
  });

  const schedulerHandle = config.jobs.enabled
    ? startScheduler({
        config,
        runCompaction: async () => {
          const runJobResult = await runJob('compaction', Date.now());
          if (runJobResult.job === 'compaction') {
            console.log(
              `[agent] scheduler: compaction job completed source_entry_count=${runJobResult.result.sourceEntryCount} summary_count=${runJobResult.result.summaryCount}.`,
            );
          }
        },
        runPromotion: async () => {
          const runJobResult = await runJob('promotion', Date.now());
          if (runJobResult.job === 'promotion') {
            console.log(
              `[agent] scheduler: promotion job completed source_row_count=${runJobResult.result.sourceRowCount} experience_upsert_count=${runJobResult.result.experienceUpsertCount} personality_upsert_count=${runJobResult.result.personalityUpsertCount}.`,
            );
          }
        },
      })
    : null;

  server.on('close', () => {
    schedulerHandle?.stop();
  });

  server.listen(config.server.port, () => {
    console.log(`[agent] listening on http://localhost:${config.server.port}`);
    console.log('[agent] health endpoint GET /health');
    console.log('[agent] events endpoint POST /events (wm_event ingest via serial write queue)');
    console.log('[agent] jobs endpoint POST /jobs/run (canonical request values: compaction|promotion)');
    console.log('[agent] respond endpoint POST /respond (model tool-call + memory writes)');
    console.log('[agent] insight endpoint POST /insight');
    console.log(`[agent] model: ${config.model.provider}/${config.model.id}`);
    console.log(`[agent] memory dir: ${config.memoryDirPath}`);
    console.log(`[agent] persona: ${personaPrompt.sourcePath}`);
    console.log(`[agent] working memory log: ${workingMemoryLogPath}`);
    console.log(`[agent] working memory assets dir: ${assetsDirPath}`);
    console.log(`[agent] short-term memory db: ${shortTermMemoryDbPath}`);
    console.log(`[agent] semantic memory db: ${semanticMemoryDbPath}`);
    console.log(`[agent] personality tone cache: ${personalityToneCachePath}`);
    console.log(`[agent] core experiences cache: ${coreExperiencesCachePath}`);
    console.log(`[agent] core personality cache: ${corePersonalityCachePath}`);
    console.log(`[agent] lancedb dir: ${lancedbDir}`);
    console.log(`[agent] lancedb table (experiences): ${VECTOR_STORE_KINDS.experiences}`);
    console.log(`[agent] lancedb table (personality): ${VECTOR_STORE_KINDS.personality}`);
    console.log(`[agent] experience tags: ${tagWhitelist.allowedTags.length} (${tagWhitelist.sourcePath})`);
    console.log(
      `[agent] scheduler: jobs.enabled=${config.jobs.enabled} timezone=${config.jobs.timezone} compaction.cron="${config.jobs.compaction.cron}" promotion.cron="${config.jobs.promotion.cron}"`,
    );
  });

  return server;
}
