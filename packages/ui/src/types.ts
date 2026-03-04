export type InsightSeverity = 'low' | 'medium' | 'high';

export interface HelloMessage {
  type: 'hello';
  v: 2;
  role: 'ui' | 'eva' | 'vision' | 'audio';
  ts_ms: number;
}

export interface FrameBinaryMeta {
  type: 'frame_binary';
  v: 2;
  frame_id: string;
  ts_ms: number;
  mime: 'image/jpeg';
  width: number;
  height: number;
  image_bytes: number;
}

export interface AudioBinaryMeta {
  type: 'audio_binary';
  v: 2;
  chunk_id: string;
  ts_ms: number;
  mime: 'audio/pcm_s16le';
  sample_rate_hz: 16000;
  channels: 1;
  audio_bytes: number;
}

export interface FrameReceivedMessage {
  type: 'frame_received';
  v: 2;
  frame_id: string;
  ts_ms: number;
  accepted: boolean;
  queue_depth: number;
  dropped: number;
  motion?: {
    mad: number;
    triggered: boolean;
  };
}

export interface AudioReceivedMessage {
  type: 'audio_received';
  v: 2;
  chunk_id: string;
  ts_ms: number;
  accepted: boolean;
  queue_depth: number;
  dropped: number;
}

export interface ErrorMessage {
  type: 'error';
  v: 2;
  frame_id?: string;
  code: string;
  message: string;
}

export interface CommandMessage {
  type: 'command';
  v: 2;
  name: string;
}

export interface EventEntry {
  name: string;
  ts_ms: number;
  severity: InsightSeverity;
  data: Record<string, unknown>;
}

export interface FrameEventsMessage {
  type: 'frame_events';
  v: 2;
  frame_id: string;
  ts_ms: number;
  width: number;
  height: number;
  events: EventEntry[];
}

export interface InsightPresence {
  preson_present: boolean;
  person_facing_me: boolean;
}

export interface InsightSummary {
  one_liner: string;
  tts_response: string;
  what_changed: string[];
  tags: string[];
  presence?: InsightPresence;
}

export interface InsightUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface InsightMessage {
  type: 'insight';
  v: 2;
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
  v: 2;
  request_id: string;
  session_id?: string;
  ts_ms: number;
  text: string;
  meta: TextOutputMeta;
}

export interface SpeechOutputMeta {
  trigger_kind: 'insight' | 'wm_event';
  trigger_id: string;
  severity: 'high';
  [key: string]: unknown;
}

export interface SpeechOutputMessage {
  type: 'speech_output';
  v: 2;
  request_id: string;
  session_id: string;
  ts_ms: number;
  mime: 'audio/mpeg';
  voice: string;
  rate: number;
  text: string;
  audio_b64: string;
  meta: SpeechOutputMeta;
}

export type ProtocolMessage =
  | HelloMessage
  | FrameReceivedMessage
  | AudioReceivedMessage
  | FrameEventsMessage
  | ErrorMessage
  | InsightMessage
  | TextOutputMessage
  | SpeechOutputMessage
  | CommandMessage;
