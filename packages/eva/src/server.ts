import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import {
  BinaryFrameDecodeError,
  CommandMessageSchema,
  decodeBinaryFrameEnvelope,
  makeError,
  makeHello,
  PROTOCOL_VERSION,
  QuickVisionInboundMessageSchema,
} from './protocol.js';
import { createQuickVisionClient } from './quickvisionClient.js';
import { FrameRouter } from './router.js';
import { synthesize } from './speech/edgeTts.js';

const FRAME_ROUTE_TTL_MS = 5_000;
const AGENT_EVENTS_INGEST_TIMEOUT_MS = 400;
const AGENT_EVENTS_INGEST_WARN_COOLDOWN_MS = 10_000;

class RequestBodyTooLargeError extends Error {
  constructor(maxBodyBytes: number) {
    super(`Request body exceeded maxBodyBytes (${maxBodyBytes})`);
    this.name = 'RequestBodyTooLargeError';
  }
}

class SpeechRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechRequestValidationError';
  }
}

class TextRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextRequestValidationError';
  }
}

class AgentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRequestError';
  }
}

class AgentRequestTimeoutError extends AgentRequestError {
  constructor(timeoutMs: number) {
    super(`Agent request timed out after ${timeoutMs}ms.`);
    this.name = 'AgentRequestTimeoutError';
  }
}

export interface StartServerOptions {
  port: number;
  eyePath: string;
  quickvisionWsUrl: string;
  insightRelay: {
    enabled: boolean;
    cooldownMs: number;
    dedupeWindowMs: number;
  };
  agent: {
    baseUrl: string;
    timeoutMs: number;
  };
  text: {
    enabled: boolean;
    path: string;
    maxBodyBytes: number;
    maxTextChars: number;
  };
  speech: {
    enabled: boolean;
    path: string;
    defaultVoice: string;
    maxTextChars: number;
    maxBodyBytes: number;
    cooldownMs: number;
    cache: {
      enabled: boolean;
      ttlMs: number;
      maxEntries: number;
    };
  };
}

function decodeRawData(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (typeof data === 'string') {
    return Buffer.from(data, 'utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }

  return Buffer.from(data);
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getOptionalFrameId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const frameId = payload.frame_id;
  return typeof frameId === 'string' ? frameId : undefined;
}

const TextOutputMetaSchema = z
  .object({
    tone: z.string().trim().min(1),
    concepts: z.array(z.string().trim().min(1)),
    surprise: z.number(),
    note: z.string().trim().min(1),
  })
  .passthrough();

const AgentRespondResponseSchema = z
  .object({
    request_id: z.string().trim().min(1),
    session_id: z.string().trim().min(1).optional(),
    text: z.string(),
    meta: TextOutputMetaSchema,
  })
  .passthrough();

const AgentEventsIngestEventSchema = z
  .object({
    name: z.string().trim().min(1),
    ts_ms: z.number().int().nonnegative(),
    severity: z.enum(['low', 'medium', 'high']),
    track_id: z.number().int().optional(),
    data: z.record(z.unknown()),
  })
  .strict();

const AgentEventsIngestRequestSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    source: z.string().trim().min(1),
    events: z.array(AgentEventsIngestEventSchema).min(1),
    meta: z
      .object({
        frame_id: z.string().trim().min(1).optional(),
        model: z.string().trim().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

type AgentRespondResponse = z.infer<typeof AgentRespondResponseSchema>;
type AgentEventsIngestRequest = z.infer<typeof AgentEventsIngestRequestSchema>;

interface TextOutputMessage {
  type: 'text_output';
  v: number;
  request_id: string;
  session_id?: string;
  ts_ms: number;
  text: string;
  meta: z.infer<typeof TextOutputMetaSchema>;
}

function setSpeechCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function setTextCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function sendServiceOk(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ service: 'eva', status: 'ok' }));
}

function sendTextJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.writableEnded) {
    return;
  }

  setTextCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function sendTextJsonError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  sendTextJson(res, statusCode, {
    error: {
      code,
      message,
    },
  });
}

function sendSpeechJsonError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  if (res.writableEnded) {
    return;
  }

  setSpeechCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      error: {
        code,
        message,
      },
    }),
  );
}

async function readRequestBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    const onData = (chunk: Buffer | string): void => {
      const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += chunkBuffer.length;

      if (totalBytes > maxBodyBytes) {
        cleanup();
        req.resume();
        reject(new RequestBodyTooLargeError(maxBodyBytes));
        return;
      }

      chunks.push(chunkBuffer);
    };

    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onAborted = (): void => {
      cleanup();
      reject(new Error('Request aborted by client.'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function parseSpeechPayload(payload: unknown, speechConfig: StartServerOptions['speech']) {
  if (!isRecord(payload)) {
    throw new SpeechRequestValidationError('Expected JSON object payload.');
  }

  const textValue = payload.text;
  if (typeof textValue !== 'string') {
    throw new SpeechRequestValidationError('text must be a string.');
  }

  const text = textValue.trim();
  if (text.length === 0) {
    throw new SpeechRequestValidationError('text must be non-empty.');
  }

  if (text.length > speechConfig.maxTextChars) {
    throw new SpeechRequestValidationError(`text exceeds maxTextChars (${speechConfig.maxTextChars}).`);
  }

  let voice = speechConfig.defaultVoice;
  if (payload.voice !== undefined) {
    if (typeof payload.voice !== 'string' || payload.voice.trim().length === 0) {
      throw new SpeechRequestValidationError('voice must be a non-empty string when provided.');
    }

    voice = payload.voice.trim();
  }

  let rate: number | undefined;
  if (payload.rate !== undefined) {
    if (typeof payload.rate !== 'number' || !Number.isFinite(payload.rate) || payload.rate <= 0) {
      throw new SpeechRequestValidationError('rate must be a positive finite number when provided.');
    }

    rate = payload.rate;
  }

  return {
    text,
    voice,
    rate,
  };
}

interface ParsedTextRequest {
  text: string;
  session_id?: string;
  source?: string;
}

function parseTextPayload(payload: unknown, textConfig: StartServerOptions['text']): ParsedTextRequest {
  if (!isRecord(payload)) {
    throw new TextRequestValidationError('Expected JSON object payload.');
  }

  const textValue = payload.text;
  if (typeof textValue !== 'string') {
    throw new TextRequestValidationError('text must be a string.');
  }

  const text = textValue.trim();
  if (text.length === 0) {
    throw new TextRequestValidationError('text must be non-empty.');
  }

  if (text.length > textConfig.maxTextChars) {
    throw new TextRequestValidationError(`text exceeds maxTextChars (${textConfig.maxTextChars}).`);
  }

  let sessionId: string | undefined;
  if (payload.session_id !== undefined) {
    if (typeof payload.session_id !== 'string') {
      throw new TextRequestValidationError('session_id must be a string when provided.');
    }

    const normalizedSessionId = payload.session_id.trim();
    if (normalizedSessionId.length === 0) {
      throw new TextRequestValidationError('session_id must be non-empty when provided.');
    }

    sessionId = normalizedSessionId;
  }

  let source: string | undefined;
  if (payload.source !== undefined) {
    if (typeof payload.source !== 'string') {
      throw new TextRequestValidationError('source must be a string when provided.');
    }

    const normalizedSource = payload.source.trim();
    if (normalizedSource.length === 0) {
      throw new TextRequestValidationError('source must be non-empty when provided.');
    }

    source = normalizedSource;
  }

  return {
    text,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(source ? { source } : {}),
  };
}

function makeTextOutputMessage(response: AgentRespondResponse, fallbackSessionId?: string): TextOutputMessage {
  const sessionId = response.session_id ?? fallbackSessionId;

  return {
    type: 'text_output',
    v: PROTOCOL_VERSION,
    request_id: response.request_id,
    ...(sessionId ? { session_id: sessionId } : {}),
    ts_ms: Date.now(),
    text: response.text,
    meta: response.meta,
  };
}

type SpeechInput = ReturnType<typeof parseSpeechPayload>;

interface SpeechCacheEntry {
  audio: Buffer;
  createdAtMs: number;
}

function createSpeechCacheKey(input: SpeechInput): string {
  const hash = createHash('sha256');
  hash.update(input.voice);
  hash.update('\u001f');
  hash.update(input.rate === undefined ? 'default' : String(input.rate));
  hash.update('\u001f');
  hash.update(input.text);
  return hash.digest('hex');
}

function sendSpeechAudio(res: ServerResponse, audioBytes: Buffer, cacheStatus: 'HIT' | 'MISS'): void {
  setSpeechCorsHeaders(res);
  res.statusCode = 200;
  res.setHeader('content-type', 'audio/mpeg');
  res.setHeader('content-length', String(audioBytes.length));
  res.setHeader('X-Eva-TTS-Cache', cacheStatus);
  res.end(audioBytes);
}

function resolveAgentRespondUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('respond', normalizedBaseUrl).toString();
}

function resolveAgentEventsIngestUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('events', normalizedBaseUrl).toString();
}

async function callAgentRespond(
  agentConfig: StartServerOptions['agent'],
  request: ParsedTextRequest,
): Promise<AgentRespondResponse> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, agentConfig.timeoutMs);

  let response: Response;
  try {
    response = await fetch(resolveAgentRespondUrl(agentConfig.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: request.text,
        ...(request.session_id ? { session_id: request.session_id } : {}),
      }),
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AgentRequestTimeoutError(agentConfig.timeoutMs);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new AgentRequestError(`Agent request failed: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new AgentRequestError(`Agent /respond returned HTTP ${response.status}.`);
  }

  let parsedPayload: unknown;
  try {
    parsedPayload = await response.json();
  } catch {
    throw new AgentRequestError('Agent /respond returned non-JSON payload.');
  }

  const parsedResponse = AgentRespondResponseSchema.safeParse(parsedPayload);
  if (!parsedResponse.success) {
    throw new AgentRequestError('Agent /respond response shape is invalid.');
  }

  return parsedResponse.data;
}

async function callAgentEventsIngest(agentBaseUrl: string, payload: AgentEventsIngestRequest): Promise<void> {
  const parsedPayload = AgentEventsIngestRequestSchema.safeParse(payload);
  if (!parsedPayload.success) {
    throw new AgentRequestError('Agent /events request payload shape is invalid.');
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, AGENT_EVENTS_INGEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(resolveAgentEventsIngestUrl(agentBaseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(parsedPayload.data),
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AgentRequestTimeoutError(AGENT_EVENTS_INGEST_TIMEOUT_MS);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new AgentRequestError(`Agent /events request failed: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new AgentRequestError(`Agent /events returned HTTP ${response.status}.`);
  }
}

export function startServer(options: StartServerOptions): Server {
  const { port, eyePath, quickvisionWsUrl, insightRelay, agent, text, speech } = options;

  let lastSpeechRequestStartedAtMs: number | null = null;
  let activeUiClient: WebSocket | null = null;
  let lastAgentEventsIngestWarningAtMs: number | null = null;

  const speechCache = new Map<string, SpeechCacheEntry>();
  const inFlightSpeechSynthesis = new Map<string, Promise<Buffer>>();

  const warnAgentEventsIngestFailure = (reason: string): void => {
    const nowMs = Date.now();

    if (
      lastAgentEventsIngestWarningAtMs !== null &&
      nowMs - lastAgentEventsIngestWarningAtMs < AGENT_EVENTS_INGEST_WARN_COOLDOWN_MS
    ) {
      return;
    }

    lastAgentEventsIngestWarningAtMs = nowMs;
    console.warn(`[eva] failed to forward events to agent /events: ${reason}`);
  };

  const evictExpiredSpeechCacheEntries = (nowMs: number): void => {
    if (!speech.cache.enabled || speech.cache.ttlMs <= 0) {
      speechCache.clear();
      return;
    }

    for (const [key, entry] of speechCache.entries()) {
      if (nowMs - entry.createdAtMs >= speech.cache.ttlMs) {
        speechCache.delete(key);
      }
    }
  };

  const writeSpeechCacheEntry = (cacheKey: string, audioBytes: Buffer): void => {
    if (!speech.cache.enabled || speech.cache.ttlMs <= 0 || speech.cache.maxEntries <= 0) {
      return;
    }

    speechCache.set(cacheKey, {
      audio: audioBytes,
      createdAtMs: Date.now(),
    });

    while (speechCache.size > speech.cache.maxEntries) {
      const oldestKey = speechCache.keys().next().value;
      if (!oldestKey) {
        break;
      }

      speechCache.delete(oldestKey);
    }
  };

  const parseSpeechInputFromRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<SpeechInput | null> => {
    let requestBodyBuffer: Buffer;
    try {
      requestBodyBuffer = await readRequestBody(req, speech.maxBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendSpeechJsonError(res, 413, 'PAYLOAD_TOO_LARGE', error.message);
        return null;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendSpeechJsonError(res, 400, 'INVALID_REQUEST', message);
      return null;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(requestBodyBuffer.toString('utf8'));
    } catch {
      sendSpeechJsonError(res, 400, 'INVALID_JSON', 'Expected valid JSON payload.');
      return null;
    }

    try {
      return parseSpeechPayload(parsedBody, speech);
    } catch (error) {
      if (error instanceof SpeechRequestValidationError) {
        sendSpeechJsonError(res, 400, 'INVALID_REQUEST', error.message);
        return null;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendSpeechJsonError(res, 400, 'INVALID_REQUEST', message);
      return null;
    }
  };

  const tryEnterSpeechCooldown = (res: ServerResponse): boolean => {
    const nowMs = Date.now();
    if (speech.cooldownMs > 0 && lastSpeechRequestStartedAtMs !== null) {
      const elapsedMs = nowMs - lastSpeechRequestStartedAtMs;
      if (elapsedMs < speech.cooldownMs) {
        sendSpeechJsonError(
          res,
          429,
          'COOLDOWN_ACTIVE',
          `Speech cooldown active. Retry in ${speech.cooldownMs - elapsedMs}ms.`,
        );
        return false;
      }
    }

    lastSpeechRequestStartedAtMs = nowMs;
    return true;
  };

  const resolveSpeechAudio = async (
    speechInput: SpeechInput,
  ): Promise<{ audioBytes: Buffer; cacheStatus: 'HIT' | 'MISS' }> => {
    const speechCacheKey = createSpeechCacheKey(speechInput);
    const cacheNowMs = Date.now();
    evictExpiredSpeechCacheEntries(cacheNowMs);

    const cachedEntry = speechCache.get(speechCacheKey);
    if (cachedEntry) {
      return {
        audioBytes: cachedEntry.audio,
        cacheStatus: 'HIT',
      };
    }

    let synthesisPromise = inFlightSpeechSynthesis.get(speechCacheKey);
    if (!synthesisPromise) {
      synthesisPromise = synthesize(speechInput)
        .then((audioBytes) => {
          writeSpeechCacheEntry(speechCacheKey, audioBytes);
          return audioBytes;
        })
        .finally(() => {
          inFlightSpeechSynthesis.delete(speechCacheKey);
        });

      inFlightSpeechSynthesis.set(speechCacheKey, synthesisPromise);
    }

    const audioBytes = await synthesisPromise;

    return {
      audioBytes,
      cacheStatus: 'MISS',
    };
  };

  const parseTextInputFromRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<ParsedTextRequest | null> => {
    let requestBodyBuffer: Buffer;
    try {
      requestBodyBuffer = await readRequestBody(req, text.maxBodyBytes);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        sendTextJsonError(res, 413, 'PAYLOAD_TOO_LARGE', error.message);
        return null;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendTextJsonError(res, 400, 'INVALID_REQUEST', message);
      return null;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(requestBodyBuffer.toString('utf8'));
    } catch {
      sendTextJsonError(res, 400, 'INVALID_JSON', 'Expected valid JSON payload.');
      return null;
    }

    try {
      return parseTextPayload(parsedBody, text);
    } catch (error) {
      if (error instanceof TextRequestValidationError) {
        sendTextJsonError(res, 400, 'INVALID_REQUEST', error.message);
        return null;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendTextJsonError(res, 400, 'INVALID_REQUEST', message);
      return null;
    }
  };

  const handleTextRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      setTextCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method !== 'POST') {
      sendTextJsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      return;
    }

    const textInput = await parseTextInputFromRequest(req, res);
    if (!textInput) {
      return;
    }

    let agentResponse: AgentRespondResponse;
    try {
      agentResponse = await callAgentRespond(agent, textInput);
    } catch (error) {
      if (error instanceof AgentRequestTimeoutError) {
        sendTextJsonError(res, 504, 'AGENT_TIMEOUT', error.message);
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      sendTextJsonError(res, 502, 'AGENT_ERROR', message);
      return;
    }

    const textOutputMessage = makeTextOutputMessage(agentResponse, textInput.session_id);

    if (activeUiClient && activeUiClient.readyState === WebSocket.OPEN) {
      sendJson(activeUiClient, textOutputMessage);
    }

    sendTextJson(res, 200, textOutputMessage);
  };

  const handleSpeechRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      setSpeechCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method !== 'POST') {
      sendServiceOk(res);
      return;
    }

    const speechInput = await parseSpeechInputFromRequest(req, res);
    if (!speechInput) {
      return;
    }

    if (!tryEnterSpeechCooldown(res)) {
      return;
    }

    let resolved;
    try {
      resolved = await resolveSpeechAudio(speechInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[eva] speech synthesis failed: ${message}`);
      sendSpeechJsonError(res, 500, 'SYNTHESIS_FAILED', 'Speech synthesis failed.');
      return;
    }

    sendSpeechAudio(res, resolved.audioBytes, resolved.cacheStatus);
  };

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (text.enabled && requestUrl.pathname === text.path) {
      void handleTextRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[eva] text request failed: ${message}`);
        sendTextJsonError(res, 500, 'INTERNAL_ERROR', 'Internal server error.');
      });
      return;
    }

    if (speech.enabled && requestUrl.pathname === speech.path) {
      void handleSpeechRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[eva] speech request failed: ${message}`);
        sendSpeechJsonError(res, 500, 'INTERNAL_ERROR', 'Internal server error.');
      });
      return;
    }

    sendServiceOk(res);
  });

  let lastRelayedInsightTsMs: number | null = null;
  const seenInsightClipIds = new Map<string, number>();

  const evictExpiredInsightClipIds = (nowMs: number): void => {
    if (insightRelay.dedupeWindowMs <= 0) {
      seenInsightClipIds.clear();
      return;
    }

    for (const [clipId, seenAtMs] of seenInsightClipIds.entries()) {
      if (nowMs - seenAtMs >= insightRelay.dedupeWindowMs) {
        seenInsightClipIds.delete(clipId);
      }
    }
  };

  const shouldRelayInsight = (clipId: string): boolean => {
    if (!insightRelay.enabled) {
      return false;
    }

    const nowMs = Date.now();
    evictExpiredInsightClipIds(nowMs);

    const alreadySeenAt = seenInsightClipIds.get(clipId);
    if (alreadySeenAt !== undefined && nowMs - alreadySeenAt < insightRelay.dedupeWindowMs) {
      return false;
    }

    seenInsightClipIds.set(clipId, nowMs);

    if (lastRelayedInsightTsMs !== null && insightRelay.cooldownMs > 0) {
      const elapsedMs = nowMs - lastRelayedInsightTsMs;
      if (elapsedMs < insightRelay.cooldownMs) {
        return false;
      }
    }

    lastRelayedInsightTsMs = nowMs;
    return true;
  };

  const frameRouter = new FrameRouter({
    ttlMs: FRAME_ROUTE_TTL_MS,
    onExpire: (frameId) => {
      console.warn(`[eva] frame route expired after ${FRAME_ROUTE_TTL_MS}ms: ${frameId}`);
    },
  });

  const quickvisionClient = createQuickVisionClient({
    url: quickvisionWsUrl,
    handlers: {
      onOpen: () => {
        console.log(`[eva] connected to Vision at ${quickvisionWsUrl}`);
      },
      onClose: () => {
        console.warn('[eva] Vision connection closed');
      },
      onReconnectScheduled: (delayMs) => {
        console.warn(`[eva] scheduling Vision reconnect in ${delayMs}ms`);
      },
      onError: (error) => {
        console.error(`[eva] Vision connection error: ${error.message}`);
      },
      onMessage: (payload) => {
        const parsedMessage = QuickVisionInboundMessageSchema.safeParse(payload);
        if (!parsedMessage.success) {
          console.warn('[eva] Vision message failed schema validation; dropping payload');
          return;
        }

        const message = parsedMessage.data;

        if (message.type === 'detections') {
          if (Array.isArray(message.events) && message.events.length > 0) {
            const eventsPayload: AgentEventsIngestRequest = {
              v: PROTOCOL_VERSION,
              source: 'vision',
              events: message.events,
              meta: {
                frame_id: message.frame_id,
                model: message.model,
              },
            };

            void callAgentEventsIngest(agent.baseUrl, eventsPayload).catch((error) => {
              const reason = error instanceof Error ? error.message : String(error);
              warnAgentEventsIngestFailure(reason);
            });
          }

          const targetClient = frameRouter.take(message.frame_id);

          if (!targetClient) {
            console.warn(`[eva] no route for frame_id ${message.frame_id}; dropping Vision response`);
            return;
          }

          sendJson(targetClient, message);
          return;
        }

        if (message.type === 'error' && message.frame_id) {
          const targetClient = frameRouter.take(message.frame_id);

          if (!targetClient) {
            console.warn(`[eva] no route for frame_id ${message.frame_id}; dropping Vision response`);
            return;
          }

          sendJson(targetClient, message);
          return;
        }

        if (message.type === 'insight') {
          const shouldRelay = shouldRelayInsight(message.clip_id);
          if (!shouldRelay) {
            console.warn(`[eva] insight relay suppressed for clip_id ${message.clip_id}`);
            return;
          }
        }

        if (!activeUiClient || activeUiClient.readyState !== WebSocket.OPEN) {
          return;
        }

        sendJson(activeUiClient, message);
      },
      onInvalidMessage: (raw) => {
        console.warn(`[eva] received non-JSON payload from Vision: ${raw}`);
      },
    },
  });

  quickvisionClient.connect();

  const wss = new WebSocketServer({ noServer: true });

  const cleanupClientRoutes = (client: WebSocket, reason: string): void => {
    const removed = frameRouter.deleteByClient(client);
    if (removed > 0) {
      console.log(`[eva] cleaned up ${removed} frame route(s) on ${reason}`);
    }
  };

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (requestUrl.pathname !== eyePath) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    if (activeUiClient && activeUiClient.readyState === WebSocket.OPEN) {
      sendJson(ws, makeError('SINGLE_CLIENT_ONLY', 'Only one UI client is supported in this iteration.'));
      ws.close(1008, 'single-client-only');
      return;
    }

    activeUiClient = ws;
    sendJson(ws, makeHello('eva'));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const binaryPayload = rawDataToBuffer(data);

        let decodedFrame;
        try {
          decodedFrame = decodeBinaryFrameEnvelope(binaryPayload);
        } catch (error) {
          const frameId = error instanceof BinaryFrameDecodeError ? error.frameId : undefined;
          const message = error instanceof Error ? error.message : 'Invalid binary frame payload.';
          sendJson(ws, makeError('INVALID_FRAME_BINARY', message, frameId));
          return;
        }

        const frameId = decodedFrame.meta.frame_id;

        if (!quickvisionClient.isConnected()) {
          sendJson(ws, makeError('QV_UNAVAILABLE', 'QuickVision is not connected.', frameId));
          return;
        }

        frameRouter.set(frameId, ws);

        const forwarded = quickvisionClient.sendBinary(binaryPayload);
        if (!forwarded) {
          frameRouter.delete(frameId);
          sendJson(ws, makeError('QV_UNAVAILABLE', 'QuickVision is not connected.', frameId));
        }

        return;
      }

      let parsedPayload: unknown;

      try {
        parsedPayload = JSON.parse(decodeRawData(data));
      } catch {
        sendJson(ws, makeError('INVALID_JSON', 'Expected valid JSON payload.'));
        return;
      }

      if (!isRecord(parsedPayload)) {
        sendJson(ws, makeError('INVALID_PAYLOAD', 'Expected JSON object payload.'));
        return;
      }

      if (parsedPayload.type === 'command') {
        const parsedCommand = CommandMessageSchema.safeParse(parsedPayload);
        if (!parsedCommand.success) {
          sendJson(ws, makeError('INVALID_COMMAND', 'Invalid command payload.'));
          return;
        }

        if (!quickvisionClient.isConnected()) {
          sendJson(ws, makeError('QV_UNAVAILABLE', 'QuickVision is not connected.'));
          return;
        }

        const forwarded = quickvisionClient.sendJson(parsedCommand.data);
        if (!forwarded) {
          sendJson(ws, makeError('QV_UNAVAILABLE', 'QuickVision is not connected.'));
        }

        return;
      }

      const frameId = getOptionalFrameId(parsedPayload);

      if (parsedPayload.type === 'frame') {
        sendJson(
          ws,
          makeError('FRAME_BINARY_REQUIRED', 'Frame messages must use binary WebSocket payloads.', frameId),
        );
        return;
      }

      sendJson(
        ws,
        makeError('UNSUPPORTED_TYPE', `Eva currently expects binary frame payloads on ${eyePath}.`, frameId),
      );
    });

    ws.on('close', () => {
      cleanupClientRoutes(ws, 'UI disconnect');

      if (activeUiClient === ws) {
        activeUiClient = null;
      }
    });

    ws.on('error', () => {
      cleanupClientRoutes(ws, 'UI socket error');

      if (activeUiClient === ws) {
        activeUiClient = null;
      }
    });
  });

  server.listen(port, () => {
    console.log(`[eva] listening on http://localhost:${port}`);
    console.log(`[eva] websocket endpoint ws://localhost:${port}${eyePath}`);
    console.log(`[eva] Vision target ${quickvisionClient.getUrl()}`);
    console.log(
      `[eva] insight relay enabled=${insightRelay.enabled} cooldownMs=${insightRelay.cooldownMs} dedupeWindowMs=${insightRelay.dedupeWindowMs}`,
    );
    console.log(`[eva] agent respond target ${resolveAgentRespondUrl(agent.baseUrl)} timeoutMs=${agent.timeoutMs}`);
    console.log(
      `[eva] agent events ingest target ${resolveAgentEventsIngestUrl(agent.baseUrl)} timeoutMs=${AGENT_EVENTS_INGEST_TIMEOUT_MS}`,
    );
    console.log(
      `[eva] text endpoint enabled=${text.enabled} path=${text.path} maxBodyBytes=${text.maxBodyBytes} maxTextChars=${text.maxTextChars}`,
    );
    console.log(
      `[eva] speech endpoint enabled=${speech.enabled} path=${speech.path} maxTextChars=${speech.maxTextChars} maxBodyBytes=${speech.maxBodyBytes} cooldownMs=${speech.cooldownMs}`,
    );
    console.log(
      `[eva] speech cache enabled=${speech.cache.enabled} ttlMs=${speech.cache.ttlMs} maxEntries=${speech.cache.maxEntries}`,
    );
  });

  server.on('close', () => {
    frameRouter.clear();
    seenInsightClipIds.clear();
    speechCache.clear();
    inFlightSpeechSynthesis.clear();
    quickvisionClient.disconnect();
    wss.close();
  });

  return server;
}
