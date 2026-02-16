import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { complete, getModel, validateToolCall } from '@mariozechner/pi-ai';
import { z } from 'zod';

import type { VisionAgentConfig, VisionAgentSecrets } from './config.js';
import { buildSystemPrompt, buildUserPrompt } from './prompts.js';
import { INSIGHT_TOOL, INSIGHT_TOOL_NAME, type InsightSummary } from './tools.js';

const HARD_MAX_FRAMES = 6;

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

type InsightRequest = z.infer<typeof InsightRequestSchema>;

interface InsightUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface InsightResult {
  summary: InsightSummary;
  usage: InsightUsage;
}

export interface StartVisionAgentServerOptions {
  config: VisionAgentConfig;
  secrets: VisionAgentSecrets;
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

async function generateInsight(
  request: InsightRequest,
  config: VisionAgentConfig,
  secrets: VisionAgentSecrets,
): Promise<InsightResult> {
  const model = getModel(config.model.provider as never, config.model.id as never);

  const messageContent = [
    {
      type: 'text',
      text: buildUserPrompt({
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
    systemPrompt: buildSystemPrompt(config.guardrails.maxFrames),
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
    throw new HttpRequestError(502, 'MODEL_CALL_FAILED', `Vision model request failed: ${message}`);
  }

  if (assistantMessage?.stopReason === 'error' || assistantMessage?.stopReason === 'aborted') {
    const message =
      typeof assistantMessage?.errorMessage === 'string' && assistantMessage.errorMessage.length > 0
        ? assistantMessage.errorMessage
        : 'Vision model returned an error response.';
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

  return {
    summary,
    usage: extractUsage(assistantMessage),
  };
}

export function startVisionAgentServer(options: StartVisionAgentServerOptions): Server {
  const { config, secrets } = options;

  const maxFrames = Math.min(config.guardrails.maxFrames, HARD_MAX_FRAMES);
  let lastInsightRequestAt: number | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(res, 200, {
          service: 'vision-agent',
          status: 'ok',
          model: {
            provider: config.model.provider,
            id: config.model.id,
          },
          guardrails: {
            cooldownMs: config.guardrails.cooldownMs,
            maxFrames,
            maxBodyBytes: config.guardrails.maxBodyBytes,
          },
        });
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
          body = await readJsonBody(req, config.guardrails.maxBodyBytes);
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
          if (elapsedMs < config.guardrails.cooldownMs) {
            const retryAfterMs = config.guardrails.cooldownMs - elapsedMs;
            sendError(res, 429, 'COOLDOWN_ACTIVE', 'Insight request cooldown active.', {
              retryAfterMs,
            });
            return;
          }
        }

        lastInsightRequestAt = now;

        try {
          const insight = await generateInsight(insightRequest, config, secrets);
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
    console.log(`[vision-agent] listening on http://localhost:${config.server.port}`);
    console.log('[vision-agent] health endpoint GET /health');
    console.log('[vision-agent] insight endpoint POST /insight');
  });

  return server;
}
