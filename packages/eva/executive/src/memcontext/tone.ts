import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

import { z } from 'zod';

export const ALLOWED_TONES = [
  'neutral',
  'calm',
  'friendly',
  'playful',
  'serious',
  'technical',
  'empathetic',
  'urgent',
] as const;

const ALLOWED_TONE_SET = new Set<string>(ALLOWED_TONES);

export type EvaTone = (typeof ALLOWED_TONES)[number];

export const DEFAULT_TONE: EvaTone = 'neutral';
export const TONE_SESSION_TTL_MS = 15 * 60 * 1000;
export const TONE_SMOOTHING_REPEAT_TURNS = 2;
const TONE_HISTORY_MAX_ENTRIES = 20;
const TONE_CACHE_RELATIVE_PATH = path.join('cache', 'personality_tone.json');

const ToneEnumSchema = z.enum(ALLOWED_TONES);

const ToneHistoryEntrySchema = z
  .object({
    ts_ms: z.number().int().nonnegative(),
    tone: ToneEnumSchema,
    reason: z.string().trim().min(1).max(240).optional(),
  })
  .strict();

const PendingToneSchema = z
  .object({
    tone: ToneEnumSchema,
    count: z.number().int().min(1),
    updated_ts_ms: z.number().int().nonnegative(),
  })
  .strict();

const ToneSessionSchema = z
  .object({
    tone: ToneEnumSchema,
    intensity: z.number().min(0).max(1),
    updated_ts_ms: z.number().int().nonnegative(),
    expires_ts_ms: z.number().int().nonnegative(),
    history: z.array(ToneHistoryEntrySchema),
    pending: PendingToneSchema.optional(),
  })
  .strict();

const ToneStateSchema = z
  .object({
    v: z.literal(1),
    default_tone: ToneEnumSchema,
    updated_ts_ms: z.number().int().nonnegative(),
    sessions: z.record(ToneSessionSchema),
  })
  .strict();

export type ToneHistoryEntry = z.infer<typeof ToneHistoryEntrySchema>;
export type ToneSessionState = z.infer<typeof ToneSessionSchema>;
export type ToneState = z.infer<typeof ToneStateSchema>;

export interface UpdateToneForSessionOptions {
  reason?: string;
  userRequestedToneChange?: boolean;
  repeatTurns?: number;
  intensity?: number;
}

function createDefaultToneState(nowMs = Date.now()): ToneState {
  return {
    v: 1,
    default_tone: DEFAULT_TONE,
    updated_ts_ms: nowMs,
    sessions: {},
  };
}

function getToneCachePath(memoryDir: string): string {
  return path.resolve(memoryDir, TONE_CACHE_RELATIVE_PATH);
}

function getDefaultSessionState(defaultTone: EvaTone, nowMs: number): ToneSessionState {
  return {
    tone: defaultTone,
    intensity: 0,
    updated_ts_ms: nowMs,
    expires_ts_ms: nowMs,
    history: [],
  };
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function clampUnitInterval(value: number): number {
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

function buildHistoryReason(baseReason: string | undefined, smoothingReason: string): string {
  const parts = [smoothingReason, baseReason?.trim()]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .map((part) => part.replace(/\s+/g, ' '));

  if (parts.length === 0) {
    return 'tone_update';
  }

  return parts.join(' | ').slice(0, 240);
}

function resolveStoredIntensity(
  candidateTone: EvaTone,
  previousIntensity: number,
  options: UpdateToneForSessionOptions,
  defaultTone: EvaTone,
): number {
  if (typeof options.intensity === 'number') {
    return clampUnitInterval(options.intensity);
  }

  if (candidateTone === defaultTone) {
    return 0;
  }

  return previousIntensity > 0 ? previousIntensity : 0.35;
}

export function normalizeToneLabel(rawTone: string, context = 'model output'): EvaTone {
  const normalizedTone = rawTone.trim().toLowerCase();
  if (ALLOWED_TONE_SET.has(normalizedTone)) {
    return normalizedTone as EvaTone;
  }

  console.warn(`[agent] unknown tone "${rawTone}" from ${context}; using ${DEFAULT_TONE}`);
  return DEFAULT_TONE;
}

export async function loadToneState(memoryDir: string): Promise<ToneState> {
  const toneCachePath = getToneCachePath(memoryDir);

  let raw: string;
  try {
    raw = await readFile(toneCachePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return createDefaultToneState();
    }

    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    console.warn(`[agent] tone cache is invalid JSON; resetting to defaults: ${toneCachePath}`);
    return createDefaultToneState();
  }

  const parsed = ToneStateSchema.safeParse(parsedJson);
  if (!parsed.success) {
    console.warn(`[agent] tone cache schema mismatch; resetting to defaults: ${formatZodIssues(parsed.error)}`);
    return createDefaultToneState();
  }

  return parsed.data;
}

export function getSessionKey(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'default';
}

export function getToneForSession(state: ToneState, sessionKey: string, nowMs: number): ToneSessionState {
  const session = state.sessions[sessionKey];
  if (!session) {
    return getDefaultSessionState(state.default_tone, nowMs);
  }

  if (session.expires_ts_ms <= nowMs) {
    return {
      ...session,
      tone: state.default_tone,
      intensity: 0,
      pending: undefined,
    };
  }

  return session;
}

export function updateToneForSession(
  state: ToneState,
  sessionKey: string,
  tone: string,
  nowMs: number,
  options: UpdateToneForSessionOptions = {},
): ToneState {
  const normalizedTone = normalizeToneLabel(tone, 'respond meta.tone');
  const repeatTurns = Math.max(1, Math.floor(options.repeatTurns ?? TONE_SMOOTHING_REPEAT_TURNS));
  const currentSession = getToneForSession(state, sessionKey, nowMs);

  let nextTone = currentSession.tone;
  let nextIntensity = currentSession.intensity;
  let nextPending = currentSession.pending;
  let smoothingReason = 'tone_stable';

  if (normalizedTone === currentSession.tone) {
    nextTone = normalizedTone;
    nextIntensity = resolveStoredIntensity(normalizedTone, currentSession.intensity, options, state.default_tone);
    nextPending = undefined;
    smoothingReason = options.userRequestedToneChange ? 'explicit_tone_change_confirmed' : 'tone_stable';
  } else if (options.userRequestedToneChange) {
    nextTone = normalizedTone;
    nextIntensity = resolveStoredIntensity(normalizedTone, currentSession.intensity, options, state.default_tone);
    nextPending = undefined;
    smoothingReason = 'explicit_tone_change';
  } else {
    const previousPending = currentSession.pending;
    const pendingCount = previousPending && previousPending.tone === normalizedTone ? previousPending.count + 1 : 1;

    if (pendingCount >= repeatTurns) {
      nextTone = normalizedTone;
      nextIntensity = resolveStoredIntensity(normalizedTone, currentSession.intensity, options, state.default_tone);
      nextPending = undefined;
      smoothingReason = `smoothing_commit_${pendingCount}/${repeatTurns}`;
    } else {
      nextTone = currentSession.tone;
      nextIntensity = currentSession.intensity;
      nextPending = {
        tone: normalizedTone,
        count: pendingCount,
        updated_ts_ms: nowMs,
      };
      smoothingReason = `smoothing_hold_${normalizedTone}_${pendingCount}/${repeatTurns}`;
    }
  }

  const historyEntry: ToneHistoryEntry = {
    ts_ms: nowMs,
    tone: nextTone,
    reason: buildHistoryReason(options.reason, smoothingReason),
  };

  const nextHistory = [...currentSession.history, historyEntry].slice(-TONE_HISTORY_MAX_ENTRIES);

  state.sessions[sessionKey] = {
    tone: nextTone,
    intensity: clampUnitInterval(nextIntensity),
    updated_ts_ms: nowMs,
    expires_ts_ms: nowMs + TONE_SESSION_TTL_MS,
    history: nextHistory,
    ...(nextPending ? { pending: nextPending } : {}),
  };

  state.updated_ts_ms = nowMs;
  return state;
}

export async function saveToneStateAtomic(memoryDir: string, state: ToneState): Promise<void> {
  const toneCachePath = getToneCachePath(memoryDir);
  const cacheDir = path.dirname(toneCachePath);

  await mkdir(cacheDir, { recursive: true });

  const parsed = ToneStateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`[agent] refusing to write invalid tone state: ${formatZodIssues(parsed.error)}`);
  }

  const tempPath = `${toneCachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const serialized = `${JSON.stringify(parsed.data, null, 2)}\n`;

  await writeFile(tempPath, serialized, 'utf8');
  await rename(tempPath, toneCachePath);
}
