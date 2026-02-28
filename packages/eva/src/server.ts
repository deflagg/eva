import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import {
  BinaryFrameDecodeError,
  CommandMessageSchema,
  decodeBinaryFrameEnvelope,
  makeError,
  makeFrameReceived,
  makeHello,
  PROTOCOL_VERSION,
  VisionInboundMessageSchema,
} from './protocol.js';
import { createVisionClient } from './visionClient.js';
import { FrameRouter } from './router.js';
import { FrameBroker } from './broker/frameBroker.js';
import { MotionGate } from './broker/motionGate.js';
import { synthesize } from './speech/edgeTts.js';

const FRAME_ROUTE_TTL_MS = 5_000;
const AGENT_EVENTS_INGEST_TIMEOUT_MS = 400;
const AGENT_EVENTS_INGEST_VERSION = 1;
const AGENT_EVENTS_INGEST_WARN_COOLDOWN_MS = 10_000;
const CAPTION_WARN_COOLDOWN_MS = 10_000;

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
  visionWsUrl: string;
  stream: {
    broker: {
      enabled: boolean;
      maxFrames: number;
      maxAgeMs: number;
      maxBytes: number;
    };
    visionForward: {
      enabled: boolean;
      sampleEveryN: number;
    };
  };
  caption: {
    enabled: boolean;
    baseUrl: string;
    timeoutMs: number;
    cooldownMs: number;
    periodicMs: number;
    dedupeWindowMs: number;
    minSceneSeverity: 'low' | 'medium' | 'high';
  };
  motionGate: {
    enabled: boolean;
    thumbW: number;
    thumbH: number;
    triggerThreshold: number;
    resetThreshold: number;
    cooldownMs: number;
    minPersistFrames: number;
  };
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
    data: z.record(z.unknown()),
  })
  .strict();

const AgentEventsIngestRequestSchema = z
  .object({
    v: z.literal(AGENT_EVENTS_INGEST_VERSION),
    source: z.string().trim().min(1),
    events: z.array(AgentEventsIngestEventSchema).min(1),
    meta: z
      .object({
        frame_id: z.string().trim().min(1).optional(),
      })
      .passthrough()
      .optional(),
  })
  .strict();

const CaptionResponseSchema = z
  .object({
    text: z.string(),
    latency_ms: z.number().int().nonnegative(),
    model: z.string().trim().min(1),
  })
  .strict();

type AgentRespondResponse = z.infer<typeof AgentRespondResponseSchema>;
type AgentEventsIngestRequest = z.infer<typeof AgentEventsIngestRequestSchema>;
type CaptionResponse = z.infer<typeof CaptionResponseSchema>;

interface TextOutputMessage {
  type: 'text_output';
  v: number;
  request_id: string;
  session_id?: string;
  ts_ms: number;
  text: string;
  meta: z.infer<typeof TextOutputMetaSchema>;
}

// Legacy high-severity push-alert message types were removed in Iteration 130.
// Iteration 135 keeps utterance emission insight-only (never directly from raw frame events).

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

function resolveCaptionUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL('caption', normalizedBaseUrl).toString();
}

async function callCaptionService(
  captionConfig: StartServerOptions['caption'],
  jpegBytes: Buffer,
): Promise<CaptionResponse> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, captionConfig.timeoutMs);

  let response: Response;
  try {
    response = await fetch(resolveCaptionUrl(captionConfig.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
      },
      body: new Uint8Array(jpegBytes),
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Caption request timed out after ${captionConfig.timeoutMs}ms.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Caption request failed: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Caption /caption returned HTTP ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Caption /caption returned non-JSON payload.');
  }

  const parsedPayload = CaptionResponseSchema.safeParse(payload);
  if (!parsedPayload.success) {
    throw new Error('Caption /caption response shape is invalid.');
  }

  return parsedPayload.data;
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
  const { port, eyePath, visionWsUrl, stream, caption, motionGate, insightRelay, agent, text, speech } = options;

  let lastSpeechRequestStartedAtMs: number | null = null;
  let activeUiClient: WebSocket | null = null;
  let lastAgentEventsIngestWarningAtMs: number | null = null;

  const speechCache = new Map<string, SpeechCacheEntry>();
  const inFlightSpeechSynthesis = new Map<string, Promise<Buffer>>();
  const emittedInsightUtteranceClipIds = new Set<string>();

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

  const emitInsightUtteranceToClient = (
    client: WebSocket | null,
    payload: {
      clipId: string;
      ttsResponse: string;
      oneLiner: string;
    },
  ): void => {
    if (!client || client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (emittedInsightUtteranceClipIds.has(payload.clipId)) {
      return;
    }

    const preferredText = payload.ttsResponse.trim();
    const fallbackText = payload.oneLiner.trim();
    const utteranceText = preferredText.length > 0 ? preferredText : fallbackText;

    if (utteranceText.length === 0) {
      return;
    }

    const textOutputMessage: TextOutputMessage = {
      type: 'text_output',
      v: PROTOCOL_VERSION,
      request_id: randomUUID(),
      session_id: 'system-insights',
      ts_ms: Date.now(),
      text: utteranceText,
      meta: {
        tone: 'conversational',
        concepts: ['insight'],
        surprise: 0,
        note: 'Auto utterance from insight.',
        trigger_kind: 'insight',
        trigger_id: payload.clipId,
      },
    };

    sendJson(client, textOutputMessage);
    emittedInsightUtteranceClipIds.add(payload.clipId);
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

    if (requestUrl.pathname === '/health') {
      const brokerStats = frameBroker.getStats();

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          service: 'eva',
          status: 'ok',
          stream: {
            broker: {
              enabled: brokerStats.enabled,
              max_frames: brokerStats.maxFrames,
              max_age_ms: brokerStats.maxAgeMs,
              max_bytes: brokerStats.maxBytes,
              queue_depth: brokerStats.queueDepth,
              dropped: brokerStats.dropped,
              total_bytes: brokerStats.totalBytes,
            },
          },
          caption: {
            enabled: caption.enabled,
            in_flight: inFlightCaption !== null,
            pending_frame_id: pendingCaptionFrameId,
            last_latency_ms: lastCaptionLatencyMs,
          },
        }),
      );
      return;
    }

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

  const frameBroker = new FrameBroker(stream.broker);
  const motionGateEngine = motionGate.enabled
    ? new MotionGate({
        thumbW: motionGate.thumbW,
        thumbH: motionGate.thumbH,
        triggerThreshold: motionGate.triggerThreshold,
        resetThreshold: motionGate.resetThreshold,
        cooldownMs: motionGate.cooldownMs,
        minPersistFrames: motionGate.minPersistFrames,
      })
    : null;
  let lastMotion: { ts_ms: number; mad: number; triggered: boolean } | null = null;

  const visionForwardSampleEveryN = Math.max(1, stream.visionForward.sampleEveryN);
  let visionForwardCounter = 0;

  let inFlightCaption: Promise<void> | null = null;
  let pendingCaptionFrameId: string | null = null;
  let captionCooldownTimer: NodeJS.Timeout | null = null;
  let lastCaptionStartedAtMs: number | null = null;
  let lastCaptionText: string | null = null;
  let lastCaptionTextAtMs: number | null = null;
  let lastCaptionLatencyMs: number | null = null;
  let lastCaptionWarningAtMs: number | null = null;

  const warnCaptionFailure = (reason: string): void => {
    const nowMs = Date.now();
    if (
      lastCaptionWarningAtMs !== null &&
      nowMs - lastCaptionWarningAtMs < CAPTION_WARN_COOLDOWN_MS
    ) {
      return;
    }

    lastCaptionWarningAtMs = nowMs;
    console.warn(`[eva] caption pipeline warning: ${reason}`);
  };

  const filterPersistableVisionEvents = (
    events: Array<{
      name: string;
      ts_ms: number;
      severity: 'low' | 'medium' | 'high';
      data: Record<string, unknown>;
    }>,
  ) => {
    return events.filter((event) => event.name === 'scene_caption');
  };

  const runCaptionForFrame = async (frameId: string): Promise<void> => {
    if (!caption.enabled) {
      return;
    }

    const brokerEntry = frameBroker.getByFrameId(frameId);
    if (!brokerEntry) {
      return;
    }

    lastCaptionStartedAtMs = Date.now();

    let captionResponse: CaptionResponse;
    try {
      captionResponse = await callCaptionService(caption, brokerEntry.jpegBytes);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnCaptionFailure(reason);
      return;
    }

    const captionText = captionResponse.text.trim();
    if (!captionText) {
      return;
    }

    const nowMs = Date.now();
    lastCaptionLatencyMs = captionResponse.latency_ms;

    if (
      caption.dedupeWindowMs > 0 &&
      lastCaptionText !== null &&
      lastCaptionTextAtMs !== null &&
      captionText === lastCaptionText &&
      nowMs - lastCaptionTextAtMs < caption.dedupeWindowMs
    ) {
      return;
    }

    lastCaptionText = captionText;
    lastCaptionTextAtMs = nowMs;

    const sceneCaptionEvent = {
      name: 'scene_caption',
      ts_ms: nowMs,
      severity: 'low' as const,
      data: {
        text: captionText,
        model: captionResponse.model,
        latency_ms: captionResponse.latency_ms,
      },
    };

    if (activeUiClient && activeUiClient.readyState === WebSocket.OPEN) {
      sendJson(activeUiClient, {
        type: 'frame_events',
        v: PROTOCOL_VERSION,
        frame_id: brokerEntry.frame_id,
        ts_ms: nowMs,
        width: brokerEntry.width,
        height: brokerEntry.height,
        events: [sceneCaptionEvent],
      });
    }

    const eventsPayload: AgentEventsIngestRequest = {
      v: AGENT_EVENTS_INGEST_VERSION,
      source: 'caption',
      events: [sceneCaptionEvent],
      meta: {
        frame_id: brokerEntry.frame_id,
      },
    };

    void callAgentEventsIngest(agent.baseUrl, eventsPayload).catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      warnAgentEventsIngestFailure(reason);
    });
  };

  const maybeStartCaptionWorker = (): void => {
    if (!caption.enabled) {
      pendingCaptionFrameId = null;
      return;
    }

    if (inFlightCaption !== null) {
      return;
    }

    if (!pendingCaptionFrameId) {
      return;
    }

    if (captionCooldownTimer !== null) {
      return;
    }

    if (caption.cooldownMs > 0 && lastCaptionStartedAtMs !== null) {
      const elapsedMs = Date.now() - lastCaptionStartedAtMs;
      if (elapsedMs < caption.cooldownMs) {
        const waitMs = caption.cooldownMs - elapsedMs;
        captionCooldownTimer = setTimeout(() => {
          captionCooldownTimer = null;
          maybeStartCaptionWorker();
        }, waitMs);
        captionCooldownTimer.unref?.();
        return;
      }
    }

    const frameId = pendingCaptionFrameId;
    pendingCaptionFrameId = null;

    inFlightCaption = runCaptionForFrame(frameId)
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        warnCaptionFailure(reason);
      })
      .finally(() => {
        inFlightCaption = null;
        if (pendingCaptionFrameId !== null) {
          maybeStartCaptionWorker();
        }
      });
  };

  const scheduleCaptionForFrame = (frameId: string): void => {
    if (!caption.enabled) {
      return;
    }

    pendingCaptionFrameId = frameId;
    maybeStartCaptionWorker();
  };

  const frameRouter = new FrameRouter({
    ttlMs: FRAME_ROUTE_TTL_MS,
    onExpire: (frameId) => {
      console.warn(`[eva] frame route expired after ${FRAME_ROUTE_TTL_MS}ms: ${frameId}`);
    },
  });

  const visionClient = createVisionClient({
    url: visionWsUrl,
    handlers: {
      onOpen: () => {
        console.log(`[eva] connected to Vision at ${visionWsUrl}`);
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
        const parsedMessage = VisionInboundMessageSchema.safeParse(payload);
        if (!parsedMessage.success) {
          console.warn('[eva] Vision message failed schema validation; dropping payload');
          return;
        }

        const message = parsedMessage.data;

        if (message.type === 'frame_events') {
          if (message.events.length > 0) {
            const persistableVisionEvents = filterPersistableVisionEvents(message.events);
            if (persistableVisionEvents.length > 0) {
              const eventsPayload: AgentEventsIngestRequest = {
                v: AGENT_EVENTS_INGEST_VERSION,
                source: 'vision',
                events: persistableVisionEvents,
                meta: {
                  frame_id: message.frame_id,
                },
              };

              void callAgentEventsIngest(agent.baseUrl, eventsPayload).catch((error) => {
                const reason = error instanceof Error ? error.message : String(error);
                warnAgentEventsIngestFailure(reason);
              });
            }

            // Intentionally no direct event-based text/speech output.
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
          emitInsightUtteranceToClient(activeUiClient, {
            clipId: message.clip_id,
            ttsResponse: message.summary.tts_response,
            oneLiner: message.summary.one_liner,
          });

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

  visionClient.connect();

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

    ws.on('message', async (data, isBinary) => {
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

        const brokerPush = frameBroker.push({
          frame_id: frameId,
          ts_ms: decodedFrame.meta.ts_ms,
          width: decodedFrame.meta.width,
          height: decodedFrame.meta.height,
          jpegBytes: decodedFrame.imageBytes,
          receivedAtMs: Date.now(),
        });

        let receiptMotion: { mad: number; triggered: boolean } | undefined;

        if (brokerPush.accepted && motionGateEngine !== null) {
          try {
            const motion = await motionGateEngine.process({
              tsMs: decodedFrame.meta.ts_ms,
              jpegBytes: decodedFrame.imageBytes,
            });

            lastMotion = {
              ts_ms: decodedFrame.meta.ts_ms,
              mad: motion.mad,
              triggered: motion.triggered,
            };

            receiptMotion = {
              mad: lastMotion.mad,
              triggered: lastMotion.triggered,
            };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`[eva] motion gate processing failed for frame ${frameId}: ${reason}`);
          }
        }

        sendJson(
          ws,
          makeFrameReceived(frameId, {
            accepted: brokerPush.accepted,
            queue_depth: brokerPush.queueDepth,
            dropped: brokerPush.dropped,
            ...(receiptMotion ? { motion: receiptMotion } : {}),
          }),
        );

        if (!brokerPush.accepted) {
          return;
        }

        if (receiptMotion?.triggered) {
          const latestFrame = frameBroker.getLatest();
          if (latestFrame) {
            scheduleCaptionForFrame(latestFrame.frame_id);
          }
        }

        if (!stream.visionForward.enabled) {
          return;
        }

        const shouldForwardSample = visionForwardCounter % visionForwardSampleEveryN === 0;
        visionForwardCounter += 1;
        if (!shouldForwardSample) {
          return;
        }

        if (!visionClient.isConnected()) {
          return;
        }

        frameRouter.set(frameId, ws);

        const forwarded = visionClient.sendBinary(binaryPayload);
        if (!forwarded) {
          frameRouter.delete(frameId);
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

        if (!visionClient.isConnected()) {
          sendJson(ws, makeError('QV_UNAVAILABLE', 'Vision is not connected.'));
          return;
        }

        const forwarded = visionClient.sendJson(parsedCommand.data);
        if (!forwarded) {
          sendJson(ws, makeError('QV_UNAVAILABLE', 'Vision is not connected.'));
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
    console.log(`[eva] Vision target ${visionClient.getUrl()}`);
    console.log(
      `[eva] stream broker enabled=${stream.broker.enabled} maxFrames=${stream.broker.maxFrames} maxAgeMs=${stream.broker.maxAgeMs} maxBytes=${stream.broker.maxBytes}`,
    );
    console.log(
      `[eva] vision forwarding enabled=${stream.visionForward.enabled} sampleEveryN=${visionForwardSampleEveryN}`,
    );
    console.log(
      `[eva] motion gate enabled=${motionGate.enabled} thumb=${motionGate.thumbW}x${motionGate.thumbH} triggerThreshold=${motionGate.triggerThreshold} resetThreshold=${motionGate.resetThreshold} cooldownMs=${motionGate.cooldownMs} minPersistFrames=${motionGate.minPersistFrames}`,
    );
    console.log(
      `[eva] caption enabled=${caption.enabled} baseUrl=${caption.baseUrl} timeoutMs=${caption.timeoutMs} triggerSource=motion_gate triggerCooldownMs=${caption.cooldownMs} dedupeWindowMs=${caption.dedupeWindowMs}`,
    );
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
    emittedInsightUtteranceClipIds.clear();
    speechCache.clear();
    inFlightSpeechSynthesis.clear();

    if (captionCooldownTimer) {
      clearTimeout(captionCooldownTimer);
      captionCooldownTimer = null;
    }

    pendingCaptionFrameId = null;

    visionClient.disconnect();
    wss.close();
  });

  return server;
}
