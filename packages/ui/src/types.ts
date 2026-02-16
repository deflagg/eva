export interface HelloMessage {
  type: 'hello';
  v: 1;
  role: 'ui' | 'eva' | 'quickvision';
  ts_ms: number;
}

export interface ErrorMessage {
  type: 'error';
  v: 1;
  frame_id?: string;
  code: string;
  message: string;
}

export type EvaInboundMessage = HelloMessage | ErrorMessage | Record<string, unknown>;
