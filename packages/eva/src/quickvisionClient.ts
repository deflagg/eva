import WebSocket, { type RawData } from 'ws';

export interface QuickVisionClientHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onMessage?: (payload: unknown, raw: string) => void;
  onInvalidMessage?: (raw: string) => void;
}

export interface QuickVisionClientOptions {
  url: string;
  handlers?: QuickVisionClientHandlers;
}

export interface QuickVisionClient {
  connect: () => void;
  disconnect: () => void;
  sendJson: (payload: unknown) => boolean;
  isConnected: () => boolean;
  getUrl: () => string;
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

export function createQuickVisionClient(options: QuickVisionClientOptions): QuickVisionClient {
  const handlers = options.handlers ?? {};

  let ws: WebSocket | null = null;
  let connected = false;

  return {
    connect() {
      if (ws) {
        return;
      }

      ws = new WebSocket(options.url);

      ws.on('open', () => {
        connected = true;
        handlers.onOpen?.();
      });

      ws.on('close', () => {
        connected = false;
        ws = null;
        handlers.onClose?.();
      });

      ws.on('error', (error) => {
        handlers.onError?.(error);
      });

      ws.on('message', (data) => {
        const raw = decodeRawData(data);

        try {
          const parsed = JSON.parse(raw) as unknown;
          handlers.onMessage?.(parsed, raw);
        } catch {
          handlers.onInvalidMessage?.(raw);
        }
      });
    },

    disconnect() {
      if (!ws) {
        connected = false;
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

    isConnected(): boolean {
      return connected;
    },

    getUrl(): string {
      return options.url;
    },
  };
}
