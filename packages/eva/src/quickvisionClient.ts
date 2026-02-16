import WebSocket, { type RawData } from 'ws';

const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;

export interface QuickVisionClientHandlers {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
  onMessage?: (payload: unknown, raw: string) => void;
  onInvalidMessage?: (raw: string) => void;
  onReconnectScheduled?: (delayMs: number) => void;
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
  let shouldReconnect = true;
  let reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const clearReconnectTimer = (): void => {
    if (!reconnectTimer) {
      return;
    }

    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleReconnect = (): void => {
    if (!shouldReconnect || reconnectTimer || ws) {
      return;
    }

    const delayMs = reconnectDelayMs;
    handlers.onReconnectScheduled?.(delayMs);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSocket();
    }, delayMs);
    reconnectTimer.unref?.();

    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
  };

  const connectSocket = (): void => {
    if (ws) {
      return;
    }

    ws = new WebSocket(options.url);

    ws.on('open', () => {
      connected = true;
      reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
      handlers.onOpen?.();
    });

    ws.on('close', () => {
      connected = false;
      ws = null;
      handlers.onClose?.();
      scheduleReconnect();
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
  };

  return {
    connect() {
      shouldReconnect = true;
      clearReconnectTimer();
      connectSocket();
    },

    disconnect() {
      shouldReconnect = false;
      clearReconnectTimer();

      if (!ws) {
        connected = false;
        return;
      }

      ws.close();
      ws = null;
      connected = false;
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
