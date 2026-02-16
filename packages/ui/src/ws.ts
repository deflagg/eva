export type WsConnectionState = 'connected' | 'disconnected';

export function describeWsState(state: WsConnectionState): string {
  return `websocket:${state}`;
}
