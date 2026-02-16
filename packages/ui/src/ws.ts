import type { EvaInboundMessage } from './types';

export type WsConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface EvaWsHandlers {
  onStatus?: (status: WsConnectionState) => void;
  onMessage?: (raw: string, payload: EvaInboundMessage) => void;
  onError?: (message: string) => void;
}

export interface EvaWsClient {
  sendJson: (payload: unknown) => boolean;
  close: () => void;
}

export function connectEvaWs(url: string, handlers: EvaWsHandlers): EvaWsClient {
  handlers.onStatus?.('connecting');

  const socket = new WebSocket(url);

  socket.addEventListener('open', () => {
    handlers.onStatus?.('connected');
  });

  socket.addEventListener('close', () => {
    handlers.onStatus?.('disconnected');
  });

  socket.addEventListener('error', () => {
    handlers.onError?.('WebSocket error');
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      handlers.onError?.('Received non-text message');
      return;
    }

    try {
      const parsed = JSON.parse(event.data) as EvaInboundMessage;
      handlers.onMessage?.(event.data, parsed);
    } catch {
      handlers.onError?.(`Received malformed JSON: ${event.data}`);
    }
  });

  return {
    sendJson: (payload) => {
      if (socket.readyState !== WebSocket.OPEN) {
        handlers.onError?.('Cannot send; socket is not open');
        return false;
      }

      socket.send(JSON.stringify(payload));
      return true;
    },
    close: () => {
      socket.close();
    }
  };
}
