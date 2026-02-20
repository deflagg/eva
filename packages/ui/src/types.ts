export type InsightSeverity = 'low' | 'medium' | 'high';

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

export interface CommandMessage {
  type: 'command';
  v: 1;
  name: string;
}

export interface DetectionEntry {
  cls: number;
  name: string;
  conf: number;
  box: [number, number, number, number];
  track_id?: number;
}

export interface EventEntry {
  name: string;
  ts_ms: number;
  severity: InsightSeverity;
  track_id?: number;
  data: Record<string, unknown>;
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
  events?: EventEntry[];
}

export interface InsightSummary {
  one_liner: string;
  tts_response: string;
  what_changed: string[];
  severity: InsightSeverity;
  tags: string[];
}

export interface InsightUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface InsightMessage {
  type: 'insight';
  v: 1;
  clip_id: string;
  trigger_frame_id: string;
  ts_ms: number;
  summary: InsightSummary;
  usage: InsightUsage;
}

export interface TextOutputMeta {
  tone: string;
  concepts: string[];
  surprise: number;
  note: string;
  [key: string]: unknown;
}

export interface TextOutputMessage {
  type: 'text_output';
  v: 1;
  request_id: string;
  session_id?: string;
  ts_ms: number;
  text: string;
  meta: TextOutputMeta;
}

export type ProtocolMessage =
  | HelloMessage
  | DetectionsMessage
  | ErrorMessage
  | InsightMessage
  | TextOutputMessage
  | CommandMessage;
