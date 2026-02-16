export interface HelloMessage {
  type: 'hello';
  v: 1;
  role: 'ui' | 'eva' | 'quickvision';
  ts_ms: number;
}
