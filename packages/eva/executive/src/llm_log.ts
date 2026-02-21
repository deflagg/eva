import path from 'node:path';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';

import { z } from 'zod';

const DEFAULT_LLM_LOG_CONFIG = {
  enabled: false,
  log_dir: 'packages/eva/llm_logs',
  log_file: 'openai-requests.log',
  include_request: true,
  include_response: true,
  include_errors: true,
  omit_image_b64: true,
  truncate_chars: 20_000,
  max_file_bytes: 20_000_000,
  rotate_count: 3,
} as const;

const LlmLogConfigSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_LLM_LOG_CONFIG.enabled),
    log_dir: z.string().trim().min(1).default(DEFAULT_LLM_LOG_CONFIG.log_dir),
    log_file: z.string().trim().min(1).default(DEFAULT_LLM_LOG_CONFIG.log_file),
    include_request: z.boolean().default(DEFAULT_LLM_LOG_CONFIG.include_request),
    include_response: z.boolean().default(DEFAULT_LLM_LOG_CONFIG.include_response),
    include_errors: z.boolean().default(DEFAULT_LLM_LOG_CONFIG.include_errors),
    omit_image_b64: z.boolean().default(DEFAULT_LLM_LOG_CONFIG.omit_image_b64),
    truncate_chars: z.number().int().positive().default(DEFAULT_LLM_LOG_CONFIG.truncate_chars),
    max_file_bytes: z.number().int().positive().default(DEFAULT_LLM_LOG_CONFIG.max_file_bytes),
    rotate_count: z.number().int().nonnegative().default(DEFAULT_LLM_LOG_CONFIG.rotate_count),
  })
  .passthrough();

type LlmLogConfig = z.infer<typeof LlmLogConfigSchema>;

type LlmTraceKind = 'respond' | 'insight';
type LlmTracePhase = 'request' | 'response' | 'error';

interface LlmTraceModel {
  provider: string;
  id: string;
}

interface LlmTraceRecord {
  ts: string;
  kind: LlmTraceKind;
  phase: LlmTracePhase;
  trace_id: string;
  model: LlmTraceModel;
  payload: unknown;
}

interface LlmLogConfigRuntime extends LlmLogConfig {
  configPath: string;
  logDirPath: string;
  logFilePath: string;
}

interface LlmLogConfigCacheEntry {
  mtimeMs: number | null;
  config: LlmLogConfigRuntime;
}

interface SanitizeOptions {
  omitImageB64: boolean;
  truncateChars: number;
}

export interface LogLlmTraceParams {
  memoryDirPath: string;
  kind: LlmTraceKind;
  phase: LlmTracePhase;
  traceId: string;
  model: LlmTraceModel;
  payload: unknown;
}

const llmLogConfigCache = new Map<string, LlmLogConfigCacheEntry>();

function getLlmLogConfigPath(memoryDirPath: string): string {
  return path.resolve(memoryDirPath, '..', 'llm_logs', 'config.json');
}

function buildRepoRootPath(memoryDirPath: string): string {
  return path.resolve(memoryDirPath, '..', '..', '..');
}

function resolveLogDirPath(memoryDirPath: string, configPath: string, configuredLogDir: string): string {
  if (path.isAbsolute(configuredLogDir)) {
    return path.normalize(configuredLogDir);
  }

  if (configuredLogDir.startsWith('.')) {
    return path.resolve(path.dirname(configPath), configuredLogDir);
  }

  return path.resolve(buildRepoRootPath(memoryDirPath), configuredLogDir);
}

function resolveRuntimeConfig(memoryDirPath: string, configPath: string, config: LlmLogConfig): LlmLogConfigRuntime {
  const logDirPath = resolveLogDirPath(memoryDirPath, configPath, config.log_dir);
  const logFilePath = path.resolve(logDirPath, config.log_file);

  return {
    ...config,
    configPath,
    logDirPath,
    logFilePath,
  };
}

function buildDisabledRuntimeConfig(memoryDirPath: string, configPath: string): LlmLogConfigRuntime {
  return resolveRuntimeConfig(memoryDirPath, configPath, {
    ...DEFAULT_LLM_LOG_CONFIG,
    enabled: false,
  });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}

async function loadLlmLogRuntimeConfig(memoryDirPath: string): Promise<LlmLogConfigRuntime> {
  const configPath = getLlmLogConfigPath(memoryDirPath);

  let configStats: Awaited<ReturnType<typeof stat>>;
  try {
    configStats = await stat(configPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      const cached = llmLogConfigCache.get(configPath);
      if (cached && cached.mtimeMs === null) {
        return cached.config;
      }

      const disabledConfig = buildDisabledRuntimeConfig(memoryDirPath, configPath);
      llmLogConfigCache.set(configPath, {
        mtimeMs: null,
        config: disabledConfig,
      });
      return disabledConfig;
    }

    const disabledConfig = buildDisabledRuntimeConfig(memoryDirPath, configPath);
    llmLogConfigCache.set(configPath, {
      mtimeMs: null,
      config: disabledConfig,
    });
    return disabledConfig;
  }

  if (!configStats.isFile()) {
    const disabledConfig = buildDisabledRuntimeConfig(memoryDirPath, configPath);
    llmLogConfigCache.set(configPath, {
      mtimeMs: null,
      config: disabledConfig,
    });
    return disabledConfig;
  }

  const cached = llmLogConfigCache.get(configPath);
  if (cached && cached.mtimeMs === configStats.mtimeMs) {
    return cached.config;
  }

  let parsedJson: unknown;
  try {
    const raw = await readFile(configPath, 'utf8');
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    const disabledConfig = buildDisabledRuntimeConfig(memoryDirPath, configPath);
    llmLogConfigCache.set(configPath, {
      mtimeMs: configStats.mtimeMs,
      config: disabledConfig,
    });
    return disabledConfig;
  }

  const parsedConfig = LlmLogConfigSchema.safeParse(parsedJson);
  if (!parsedConfig.success) {
    const disabledConfig = buildDisabledRuntimeConfig(memoryDirPath, configPath);
    llmLogConfigCache.set(configPath, {
      mtimeMs: configStats.mtimeMs,
      config: disabledConfig,
    });
    return disabledConfig;
  }

  const runtimeConfig = resolveRuntimeConfig(memoryDirPath, configPath, parsedConfig.data);
  llmLogConfigCache.set(configPath, {
    mtimeMs: configStats.mtimeMs,
    config: runtimeConfig,
  });

  return runtimeConfig;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const kept = Math.max(0, maxChars);
  const omitted = Math.max(0, value.length - kept);
  return `${value.slice(0, kept)}… [truncated ${omitted} chars]`;
}

function formatImagePlaceholder(charLength: number): string {
  const safeLength = Number.isFinite(charLength) && charLength >= 0 ? Math.floor(charLength) : 0;
  return `[omitted base64 image: ${safeLength} chars]`;
}

function sanitizePrimitive(value: unknown, options: SanitizeOptions): unknown {
  if (typeof value === 'string') {
    return truncateString(value, options.truncateChars);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return '[undefined]';
  }

  if (typeof value === 'symbol') {
    return String(value);
  }

  if (typeof value === 'function') {
    return `[function ${value.name || 'anonymous'}]`;
  }

  return undefined;
}

function sanitizeObjectValue(value: unknown, options: SanitizeOptions, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 24) {
    return '[max_depth]';
  }

  const primitive = sanitizePrimitive(value, options);
  if (primitive !== undefined) {
    return primitive;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message, options.truncateChars),
      ...(typeof value.stack === 'string'
        ? {
            stack: truncateString(value.stack, options.truncateChars),
          }
        : {}),
    };
  }

  if (Buffer.isBuffer(value)) {
    return `[binary buffer: ${value.byteLength} bytes]`;
  }

  if (ArrayBuffer.isView(value)) {
    return `[binary view: ${value.byteLength} bytes]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObjectValue(item, options, seen, depth + 1));
  }

  if (value instanceof Set) {
    return Array.from(value).map((item) => sanitizeObjectValue(item, options, seen, depth + 1));
  }

  if (value instanceof Map) {
    const mapped: Record<string, unknown> = {};
    for (const [key, entryValue] of value.entries()) {
      mapped[String(key)] = sanitizeObjectValue(entryValue, options, seen, depth + 1);
    }
    return mapped;
  }

  if (!value || typeof value !== 'object') {
    return '[unserializable]';
  }

  const objectValue = value as Record<string, unknown>;

  if (seen.has(objectValue)) {
    return '[circular]';
  }
  seen.add(objectValue);

  const result: Record<string, unknown> = {};
  const isImageBlock =
    options.omitImageB64 &&
    typeof objectValue.type === 'string' &&
    objectValue.type.trim().toLowerCase() === 'image';

  for (const [key, entryValue] of Object.entries(objectValue)) {
    const normalizedKey = key.toLowerCase();

    if (normalizedKey === 'secrets') {
      result[key] = '[omitted secrets]';
      continue;
    }

    if (normalizedKey.includes('apikey') || normalizedKey === 'api_key') {
      result[key] = '[omitted api key]';
      continue;
    }

    const isImagePayloadField =
      options.omitImageB64 &&
      (normalizedKey === 'image_b64' || (isImageBlock && (normalizedKey === 'data' || normalizedKey === 'b64' || normalizedKey === 'base64')));

    if (isImagePayloadField) {
      if (typeof entryValue === 'string') {
        result[key] = formatImagePlaceholder(entryValue.length);
      } else if (Buffer.isBuffer(entryValue)) {
        result[key] = formatImagePlaceholder(entryValue.toString('base64').length);
      } else if (ArrayBuffer.isView(entryValue)) {
        const bufferView = Buffer.from(entryValue.buffer, entryValue.byteOffset, entryValue.byteLength);
        result[key] = formatImagePlaceholder(bufferView.toString('base64').length);
      } else {
        result[key] = '[omitted base64 image]';
      }
      continue;
    }

    result[key] = sanitizeObjectValue(entryValue, options, seen, depth + 1);
  }

  seen.delete(objectValue);
  return result;
}

function shouldLogPhase(config: LlmLogConfigRuntime, phase: LlmTracePhase): boolean {
  if (phase === 'request') {
    return config.include_request;
  }

  if (phase === 'response') {
    return config.include_response;
  }

  if (phase === 'error') {
    return config.include_errors;
  }

  return false;
}

async function maybeRotateLogFile(logFilePath: string, maxFileBytes: number, rotateCount: number, incomingBytes: number): Promise<void> {
  let stats;
  try {
    stats = await stat(logFilePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    return;
  }

  if (!stats.isFile()) {
    return;
  }

  if (stats.size + incomingBytes <= maxFileBytes) {
    return;
  }

  if (rotateCount <= 0) {
    await rm(logFilePath, { force: true });
    return;
  }

  for (let index = rotateCount; index >= 1; index -= 1) {
    const sourcePath = index === 1 ? logFilePath : `${logFilePath}.${index - 1}`;
    const targetPath = `${logFilePath}.${index}`;

    try {
      await stat(sourcePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }

      continue;
    }

    await rm(targetPath, { force: true });
    await rename(sourcePath, targetPath);
  }
}

export async function logLlmTrace(params: LogLlmTraceParams): Promise<void> {
  try {
    const runtimeConfig = await loadLlmLogRuntimeConfig(params.memoryDirPath);
    if (!runtimeConfig.enabled || !shouldLogPhase(runtimeConfig, params.phase)) {
      return;
    }

    const sanitizeOptions: SanitizeOptions = {
      omitImageB64: runtimeConfig.omit_image_b64,
      truncateChars: runtimeConfig.truncate_chars,
    };

    const record: LlmTraceRecord = {
      ts: new Date().toISOString(),
      kind: params.kind,
      phase: params.phase,
      trace_id: params.traceId,
      model: {
        provider: params.model.provider,
        id: params.model.id,
      },
      payload: sanitizeObjectValue(params.payload, sanitizeOptions, new WeakSet<object>(), 0),
    };

    const line = `${JSON.stringify(record)}\n`;

    await mkdir(runtimeConfig.logDirPath, { recursive: true });
    await maybeRotateLogFile(
      runtimeConfig.logFilePath,
      runtimeConfig.max_file_bytes,
      runtimeConfig.rotate_count,
      Buffer.byteLength(line),
    );
    await appendFile(runtimeConfig.logFilePath, line, 'utf8');
  } catch {
    // Best-effort observability: logging failures must never affect runtime behavior.
  }
}
