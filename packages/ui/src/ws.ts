const EVA_WS_URL = 'ws://localhost:8787/eye';

export type WsConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface EvaWsHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage?: (message: unknown, raw: string) => void;
  onParseError?: (raw: string) => void;
  onError?: (event: Event) => void;
}

export interface EvaWsClient {
  connect: () => void;
  disconnect: () => void;
  sendJson: (payload: unknown) => boolean;
  sendBinary: (payload: ArrayBuffer | Blob | ArrayBufferView) => boolean;
  getStatus: () => WsConnectionStatus;
}

export function getEvaWsUrl(): string {
  return EVA_WS_URL;
}

async function decodeMessageData(data: MessageEvent['data']): Promise<string> {
  if (typeof data === 'string') {
    return data;
  }

  if (data instanceof Blob) {
    return data.text();
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }

  return String(data);
}

export function createEvaWsClient(handlers: EvaWsHandlers = {}): EvaWsClient {
  let ws: WebSocket | null = null;
  let status: WsConnectionStatus = 'disconnected';

  return {
    connect() {
      if (ws) {
        return;
      }

      status = 'connecting';
      ws = new WebSocket(EVA_WS_URL);

      ws.addEventListener('open', () => {
        status = 'connected';
        handlers.onOpen?.();
      });

      ws.addEventListener('close', () => {
        status = 'disconnected';
        ws = null;
        handlers.onClose?.();
      });

      ws.addEventListener('error', (event) => {
        handlers.onError?.(event);
      });

      ws.addEventListener('message', (event) => {
        void decodeMessageData(event.data)
          .then((raw) => {
            try {
              const parsed = JSON.parse(raw) as unknown;
              handlers.onMessage?.(parsed, raw);
            } catch {
              handlers.onParseError?.(raw);
            }
          })
          .catch(() => {
            handlers.onParseError?.('<failed to decode websocket message>');
          });
      });
    },

    disconnect() {
      if (!ws) {
        status = 'disconnected';
        return;
      }

      ws.close();
    },

    sendJson(payload: unknown): boolean {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      ws.send(JSON.stringify(payload));
      return true;
    },

    sendBinary(payload: ArrayBuffer | Blob | ArrayBufferView): boolean {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
      }

      ws.send(payload);
      return true;
    },

    getStatus(): WsConnectionStatus {
      return status;
    },
  };
}
