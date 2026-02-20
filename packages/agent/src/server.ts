import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { z } from 'zod';

import type { AgentConfig } from './config.js';

const InsightRequestSchema = z
  .object({
    frames: z.array(z.unknown()).min(1),
  })
  .passthrough();

type InsightRequest = z.infer<typeof InsightRequestSchema>;

type InsightSeverity = 'low' | 'medium' | 'high';

interface InsightSummary {
  one_liner: string;
  tts_response: string;
  tags: string[];
  what_changed: string[];
  severity: InsightSeverity;
}

interface InsightUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface InsightResponse {
  summary: InsightSummary;
  usage: InsightUsage;
}

export interface StartAgentServerOptions {
  config: AgentConfig;
}

class HttpRequestError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
    this.code = code;
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

function sendError(res: ServerResponse, statusCode: number, code: string, message: string): void {
  sendJson(res, statusCode, {
    error: {
      code,
      message,
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

function buildDeterministicInsightResponse(request: InsightRequest): InsightResponse {
  const frameCount = request.frames.length;
  const plural = frameCount === 1 ? '' : 's';

  return {
    summary: {
      severity: 'low',
      one_liner: `Stub insight generated for ${frameCount} frame${plural}.`,
      tts_response: `I reviewed ${frameCount} frame${plural}. This is a deterministic stub response for testing.`,
      tags: ['stub', 'insight_test'],
      what_changed: ['No model inference yet; deterministic insight stub is active.'],
    },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    },
  };
}

export function startAgentServer(options: StartAgentServerOptions): Server {
  const { config } = options;
  const startedAtMs = Date.now();

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (method === 'GET' && requestUrl.pathname === '/health') {
        sendJson(res, 200, {
          service: 'agent',
          status: 'ok',
          uptime_ms: Date.now() - startedAtMs,
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
          body = await readJsonBody(req, config.insight.maxBodyBytes);
        } catch (error) {
          if (error instanceof HttpRequestError) {
            sendError(res, error.statusCode, error.code, error.message);
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
            sendError(res, error.statusCode, error.code, error.message);
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          sendError(res, 400, 'INVALID_REQUEST', message);
          return;
        }

        sendJson(res, 200, buildDeterministicInsightResponse(insightRequest));
        return;
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
    console.log('[agent] insight endpoint POST /insight (deterministic stub)');
    console.log(`[agent] memory dir: ${config.memoryDirPath}`);
  });

  return server;
}
