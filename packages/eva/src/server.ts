import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ErrorMessage, HelloMessage, JsonValue } from './protocol.js';

export interface EvaServerConfig {
  port: number;
  quickVisionWsUrl: string;
}

export interface EvaServer {
  start: () => void;
  stop: () => Promise<void>;
}

function sendJson(ws: WebSocket, payload: JsonValue): void {
  ws.send(JSON.stringify(payload));
}

function parseJson(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

function makeHello(): HelloMessage {
  return {
    type: 'hello',
    v: 1,
    role: 'eva',
    ts_ms: Date.now()
  };
}

function makeParseError(message: string): ErrorMessage {
  return {
    type: 'error',
    v: 1,
    code: 'INVALID_JSON',
    message
  };
}

export function createEvaServer(config: EvaServerConfig): EvaServer {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'eva',
        status: 'ok',
        websocket_path: '/eye',
        quickvision_ws_url: config.quickVisionWsUrl
      })
    );
  });

  const wsServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const host = request.headers.host ?? 'localhost';
    const requestUrl = new URL(request.url ?? '/', `http://${host}`);

    if (requestUrl.pathname !== '/eye') {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request);
    });
  });

  wsServer.on('connection', (ws) => {
    sendJson(ws, makeHello());

    ws.on('message', (rawData, isBinary) => {
      if (isBinary) {
        sendJson(ws, makeParseError('Expected UTF-8 JSON text message, received binary payload'));
        return;
      }

      const text = rawData.toString();

      try {
        const payload = parseJson(text);
        sendJson(ws, payload);
      } catch {
        sendJson(ws, makeParseError('Malformed JSON payload'));
      }
    });
  });

  return {
    start: () => {
      server.listen(config.port, () => {
        console.log(`[eva] listening on http://localhost:${config.port}`);
        console.log(`[eva] websocket endpoint ready at ws://localhost:${config.port}/eye`);
      });
    },
    stop: () =>
      new Promise((resolve, reject) => {
        wsServer.close((wsCloseError) => {
          if (wsCloseError) {
            reject(wsCloseError);
            return;
          }

          server.close((httpCloseError) => {
            if (httpCloseError) {
              reject(httpCloseError);
              return;
            }
            resolve();
          });
        });
      })
  };
}
