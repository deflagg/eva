import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { complete, getModel, validateToolCall } from '@mariozechner/pi-ai';
import { z } from 'zod';

import type { AgentConfig, AgentSecrets } from './config.js';
import { buildInsightSystemPrompt, buildInsightUserPrompt } from './prompts/insight.js';
import { buildRespondSystemPrompt, buildRespondUserPrompt } from './prompts/respond.js';
import { INSIGHT_TOOL, INSIGHT_TOOL_NAME, type InsightSummary } from './tools/insight.js';
import { RESPOND_TOOL, RESPOND_TOOL_NAME, type RespondPayload } from './tools/respond.js';

const HARD_MAX_FRAMES = 6;
const WORKING_MEMORY_LOG_FILENAME = 'working_memory.log';
const SHORT_TERM_MEMORY_DB_FILENAME = 'short_term_memory.db';
const WORKING_MEMORY_WINDOW_MS = 60 * 60 * 1000;
const HOURLY_SUMMARY_MIN_BULLETS = 3;
const HOURLY_SUMMARY_MAX_BULLETS = 5;

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
    image_b64: z.string().min(1),
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

const HourlyJobRequestSchema = z
  .object({
    now_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

const WorkingMemoryRecordSchema = z
  .object({
    type: z.string().trim().min(1),
    ts_ms: z.number().int().nonnegative(),
  })
  .passthrough();

type InsightRequest = z.infer<typeof InsightRequestSchema>;
type RespondRequest = z.infer<typeof RespondRequestSchema>;
type HourlyJobRequest = z.infer<typeof HourlyJobRequestSchema>;

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

type WorkingMemoryEntry = WorkingMemoryTextInputEntry | WorkingMemoryTextOutputEntry;

type WorkingMemoryRecord = {
  type: string;
  ts_ms: number;
  [key: string]: unknown;
};

interface HourlySummaryResult {
  runAtMs: number;
  cutoffMs: number;
  sourceEntryCount: number;
  keptEntryCount: number;
  summaryCount: number;
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

async function readOptionalJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown | undefined> {
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
        resolve(undefined);
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

function parseRespondRequest(payload: unknown): RespondRequest {
  const parsed = RespondRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HttpRequestError(400, 'INVALID_REQUEST', `Invalid respond payload: ${details}`);
  }

  return parsed.data;
}

function parseHourlyJobRequest(payload: unknown | undefined): HourlyJobRequest {
  if (payload === undefined) {
    return {};
  }

  const parsed = HourlyJobRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new HttpRequestError(400, 'INVALID_REQUEST', `Invalid hourly job payload: ${details}`);
  }

  return parsed.data;
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

  const tone = payload.meta.tone.trim();
  if (!tone) {
    throw new HttpRequestError(502, 'MODEL_INVALID_TOOL_ARGS', 'Model returned empty tone.');
  }

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

    if (bullets.length >= HOURLY_SUMMARY_MAX_BULLETS) {
      break;
    }
  }

  for (const entry of entries) {
    if (bullets.length >= HOURLY_SUMMARY_MAX_BULLETS) {
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
    if (bullets.length >= HOURLY_SUMMARY_MAX_BULLETS) {
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

  pushBullet(`Hourly rollup: ${entries.length} entries processed from working memory.`);
  pushBullet(`Chat turns: ${textInputCount} inputs and ${textOutputCount} outputs summarized.`);
  if (insightCount > 0) {
    pushBullet(`Vision highlights observed: ${insightCount} insight events.`);
  }

  while (bullets.length < HOURLY_SUMMARY_MIN_BULLETS) {
    pushBullet(`Memory maintenance note: retained recent context window and archived older activity.`);
  }

  return bullets.slice(0, HOURLY_SUMMARY_MAX_BULLETS);
}

function initializeShortTermMemoryDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);

  try {
    db.exec(SHORT_TERM_MEMORY_SCHEMA_SQL);
  } finally {
    db.close();
  }
}

function insertHourlySummaries(
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

async function runHourlyMemoryJob(
  workingMemoryLogPath: string,
  shortTermMemoryDbPath: string,
  nowMs: number,
): Promise<HourlySummaryResult> {
  const cutoffMs = nowMs - WORKING_MEMORY_WINDOW_MS;
  const entries = await readWorkingMemoryLog(workingMemoryLogPath);

  const olderEntries = entries.filter((entry) => entry.ts_ms < cutoffMs);
  const keptEntries = entries.filter((entry) => entry.ts_ms >= cutoffMs);

  if (olderEntries.length === 0) {
    return {
      runAtMs: nowMs,
      cutoffMs,
      sourceEntryCount: 0,
      keptEntryCount: keptEntries.length,
      summaryCount: 0,
    };
  }

  const bullets = summarizeEntriesToBullets(olderEntries);

  await ensureParentDir(shortTermMemoryDbPath);
  const insertedCount = insertHourlySummaries(shortTermMemoryDbPath, {
    createdAtMs: nowMs,
    bucketStartMs: olderEntries[0]?.ts_ms ?? cutoffMs,
    bucketEndMs: cutoffMs,
    sourceEntryCount: olderEntries.length,
    bullets,
  });

  await rewriteWorkingMemoryLogAtomic(workingMemoryLogPath, keptEntries);

  return {
    runAtMs: nowMs,
    cutoffMs,
    sourceEntryCount: olderEntries.length,
    keptEntryCount: keptEntries.length,
    summaryCount: insertedCount,
  };
}

async function generateInsight(
  request: InsightRequest,
  config: AgentConfig,
  secrets: AgentSecrets,
  tagWhitelist: ExperienceTagWhitelist,
): Promise<InsightResult> {
  const model = getModel(config.model.provider as never, config.model.id as never);

  const messageContent = [
    {
      type: 'text',
      text: buildInsightUserPrompt({
        clipId: request.clip_id,
        triggerFrameId: request.trigger_frame_id,
        frameCount: request.frames.length,
      }),
    },
    ...request.frames.map((frame) => ({
      type: 'image',
      data: frame.image_b64,
      mimeType: frame.mime,
    })),
  ];

  const context = {
    systemPrompt: buildInsightSystemPrompt(config.insight.maxFrames),
    messages: [
      {
        role: 'user',
        content: messageContent,
      },
    ],
    tools: [INSIGHT_TOOL],
  };

  let assistantMessage: any;
  try {
    assistantMessage = await complete(model as never, context as never, { apiKey: secrets.openaiApiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpRequestError(502, 'MODEL_CALL_FAILED', `Insight model request failed: ${message}`);
  }

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
): Promise<{ text: string; meta: RespondMeta }> {
  const model = getModel(config.model.provider as never, config.model.id as never);

  const context = {
    systemPrompt: buildRespondSystemPrompt({
      persona: personaPrompt.text,
      allowedConcepts: tagWhitelist.allowedTags,
      maxConcepts: 6,
    }),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildRespondUserPrompt({
              text: request.text,
              sessionId: request.session_id,
            }),
          },
        ],
      },
    ],
    tools: [RESPOND_TOOL],
  };

  let assistantMessage: any;
  try {
    assistantMessage = await complete(model as never, context as never, { apiKey: secrets.openaiApiKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpRequestError(502, 'MODEL_CALL_FAILED', `Respond model request failed: ${message}`);
  }

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
  const shortTermMemoryDbPath = path.resolve(config.memoryDirPath, SHORT_TERM_MEMORY_DB_FILENAME);
  const personalityToneCachePath = path.resolve(config.memoryDirPath, 'cache', 'personality_tone.json');
  const workingMemoryWriteQueue = new SerialTaskQueue();

  mkdirSync(config.memoryDirPath, { recursive: true });
  initializeShortTermMemoryDb(shortTermMemoryDbPath);

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
          memory: {
            dir: config.memoryDirPath,
            experienceTagsPath: tagWhitelist.sourcePath,
            experienceTagCount: tagWhitelist.allowedTags.length,
            personaPath: personaPrompt.sourcePath,
            workingMemoryLogPath,
            shortTermMemoryDbPath,
            personalityToneCachePath,
          },
        });
        return;
      }

      if (method === 'POST' && requestUrl.pathname === '/jobs/hourly') {
        let body: unknown | undefined;
        try {
          body = await readOptionalJsonBody(req, config.insight.maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_BODY', message);
          return;
        }

        let parsedJobRequest: HourlyJobRequest;
        try {
          parsedJobRequest = parseHourlyJobRequest(body);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message, error.extra);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_REQUEST', message);
          return;
        }

        const runAtMs = parsedJobRequest.now_ms ?? Date.now();

        let result: HourlySummaryResult;
        try {
          result = await workingMemoryWriteQueue.run(async () =>
            runHourlyMemoryJob(workingMemoryLogPath, shortTermMemoryDbPath, runAtMs),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 500, 'HOURLY_JOB_FAILED', message);
          return;
        }

        sendJson(res, 200, {
          job: 'hourly',
          run_at_ms: result.runAtMs,
          cutoff_ms: result.cutoffMs,
          source_entry_count: result.sourceEntryCount,
          kept_entry_count: result.keptEntryCount,
          summary_count: result.summaryCount,
          short_term_memory_db: shortTermMemoryDbPath,
          working_memory_log: workingMemoryLogPath,
        });
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

        let generatedResponse: { text: string; meta: RespondMeta };
        try {
          generatedResponse = await generateRespond(respondRequest, config, secrets, tagWhitelist, personaPrompt);
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

        const toneCachePayload = {
          updated_at_ms: Date.now(),
          request_id: requestId,
          ...(respondRequest.session_id ? { session_id: respondRequest.session_id } : {}),
          tone: respondResult.meta.tone,
          concepts: respondResult.meta.concepts,
          surprise: respondResult.meta.surprise,
          note: respondResult.meta.note,
        };

        try {
          await workingMemoryWriteQueue.run(async () => {
            await appendWorkingMemoryEntries(workingMemoryLogPath, [inputEntry, outputEntry]);
            await writeJsonAtomic(personalityToneCachePath, toneCachePayload);
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
          const insight = await generateInsight(insightRequest, config, secrets, tagWhitelist);
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

  server.listen(config.server.port, () => {
    console.log(`[agent] listening on http://localhost:${config.server.port}`);
    console.log('[agent] health endpoint GET /health');
    console.log('[agent] jobs endpoint POST /jobs/hourly (working→sqlite rollup + trim)');
    console.log('[agent] respond endpoint POST /respond (model tool-call + memory writes)');
    console.log('[agent] insight endpoint POST /insight');
    console.log(`[agent] model: ${config.model.provider}/${config.model.id}`);
    console.log(`[agent] memory dir: ${config.memoryDirPath}`);
    console.log(`[agent] persona: ${personaPrompt.sourcePath}`);
    console.log(`[agent] working memory log: ${workingMemoryLogPath}`);
    console.log(`[agent] short-term memory db: ${shortTermMemoryDbPath}`);
    console.log(`[agent] personality tone cache: ${personalityToneCachePath}`);
    console.log(`[agent] experience tags: ${tagWhitelist.allowedTags.length} (${tagWhitelist.sourcePath})`);
  });

  return server;
}
