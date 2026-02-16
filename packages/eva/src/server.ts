import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import {
  BinaryFrameDecodeError,
  CommandMessageSchema,
  decodeBinaryFrameEnvelope,
  makeError,
  makeHello,
  QuickVisionInboundMessageSchema,
} from './protocol.js';
import { createQuickVisionClient } from './quickvisionClient.js';
import { FrameRouter } from './router.js';

const FRAME_ROUTE_TTL_MS = 5_000;

export interface StartServerOptions {
  port: number;
  eyePath: string;
  quickvisionWsUrl: string;
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

export function startServer(options: StartServerOptions): Server {
  const { port, eyePath, quickvisionWsUrl } = options;

  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'eva', status: 'ok' }));
  });

  let activeUiClient: WebSocket | null = null;

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
        console.log(`[eva] connected to QuickVision at ${quickvisionWsUrl}`);
      },
      onClose: () => {
        console.warn('[eva] QuickVision connection closed');
      },
      onReconnectScheduled: (delayMs) => {
        console.warn(`[eva] scheduling QuickVision reconnect in ${delayMs}ms`);
      },
      onError: (error) => {
        console.error(`[eva] QuickVision connection error: ${error.message}`);
      },
      onMessage: (payload) => {
        const parsedMessage = QuickVisionInboundMessageSchema.safeParse(payload);
        if (!parsedMessage.success) {
          console.warn('[eva] QuickVision message failed schema validation; dropping payload');
          return;
        }

        const message = parsedMessage.data;

        if (message.type === 'detections') {
          const targetClient = frameRouter.take(message.frame_id);

          if (!targetClient) {
            console.warn(`[eva] no route for frame_id ${message.frame_id}; dropping QuickVision response`);
            return;
          }

          sendJson(targetClient, message);
          return;
        }

        if (message.type === 'error' && message.frame_id) {
          const targetClient = frameRouter.take(message.frame_id);

          if (!targetClient) {
            console.warn(`[eva] no route for frame_id ${message.frame_id}; dropping QuickVision response`);
            return;
          }

          sendJson(targetClient, message);
          return;
        }

        if (!activeUiClient || activeUiClient.readyState !== WebSocket.OPEN) {
          return;
        }

        sendJson(activeUiClient, message);
      },
      onInvalidMessage: (raw) => {
        console.warn(`[eva] received non-JSON payload from QuickVision: ${raw}`);
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
    console.log(`[eva] QuickVision target ${quickvisionClient.getUrl()}`);
  });

  server.on('close', () => {
    frameRouter.clear();
    quickvisionClient.disconnect();
    wss.close();
  });

  return server;
}
