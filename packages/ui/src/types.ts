export interface HelloMessage {
  type: 'hello';
  v: 1;
  role: 'ui' | 'eva' | 'quickvision';
  ts_ms: number;
}

export interface FrameBinaryMeta {
  type: 'frame_binary';
  v: 1;
  frame_id: string;
  ts_ms: number;
  mime: 'image/jpeg';
  width: number;
  height: number;
  image_bytes: number;
}

export interface ErrorMessage {
  type: 'error';
  v: 1;
  frame_id?: string;
  code: string;
  message: string;
}

export interface DetectionEntry {
  cls: number;
  name: string;
  conf: number;
  box: [number, number, number, number];
}

export interface DetectionsMessage {
  type: 'detections';
  v: 1;
  frame_id: string;
  ts_ms: number;
  width: number;
  height: number;
  model: string;
  detections: DetectionEntry[];
}

export type ProtocolMessage = HelloMessage | DetectionsMessage | ErrorMessage;
