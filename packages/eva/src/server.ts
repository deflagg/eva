import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { makeError, makeHello } from './protocol.js';
import { createQuickVisionClient } from './quickvisionClient.js';

const EYE_PATH = '/eye';

export interface StartServerOptions {
  port: number;
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

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

export function startServer(options: StartServerOptions): Server {
  const { port, quickvisionWsUrl } = options;

  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: 'eva', status: 'ok' }));
  });

  let activeUiClient: WebSocket | null = null;

  const quickvisionClient = createQuickVisionClient({
    url: quickvisionWsUrl,
    handlers: {
      onOpen: () => {
        console.log(`[eva] connected to QuickVision at ${quickvisionWsUrl}`);
      },
      onClose: () => {
        console.warn('[eva] QuickVision connection closed');
      },
      onError: (error) => {
        console.error(`[eva] QuickVision connection error: ${error.message}`);
      },
      onMessage: (payload) => {
        if (!activeUiClient || activeUiClient.readyState !== WebSocket.OPEN) {
          return;
        }

        sendJson(activeUiClient, payload);
      },
      onInvalidMessage: (raw) => {
        console.warn(`[eva] received non-JSON payload from QuickVision: ${raw}`);
      },
    },
  });

  quickvisionClient.connect();

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (requestUrl.pathname !== EYE_PATH) {
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

    ws.on('message', (data) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(decodeRawData(data));
      } catch {
        sendJson(ws, makeError('INVALID_JSON', 'Expected valid JSON payload.'));
        return;
      }

      const forwarded = quickvisionClient.sendJson(parsed);
      if (!forwarded) {
        sendJson(ws, makeError('QV_UNAVAILABLE', 'QuickVision is not connected.'));
      }
    });

    ws.on('close', () => {
      if (activeUiClient === ws) {
        activeUiClient = null;
      }
    });

    ws.on('error', () => {
      if (activeUiClient === ws) {
        activeUiClient = null;
      }
    });
  });

  server.listen(port, () => {
    console.log(`[eva] listening on http://localhost:${port}`);
    console.log(`[eva] websocket endpoint ws://localhost:${port}${EYE_PATH}`);
    console.log(`[eva] QuickVision target ${quickvisionClient.getUrl()}`);
  });

  return server;
}
