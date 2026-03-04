import { z } from 'zod';

export const PROTOCOL_VERSION = 2;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

const BINARY_META_LENGTH_BYTES = 4;

function getOptionalFrameId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const frameId = (payload as Record<string, unknown>).frame_id;
  return typeof frameId === 'string' ? frameId : undefined;
}

function getOptionalChunkId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const chunkId = (payload as Record<string, unknown>).chunk_id;
  return typeof chunkId === 'string' ? chunkId : undefined;
}

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  role: z.enum(['ui', 'eva', 'vision', 'audio']),
  ts_ms: z.number().int().nonnegative(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1).optional(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const CommandMessageSchema = z.object({
  type: z.literal('command'),
  v: z.literal(PROTOCOL_VERSION),
  name: z.string().min(1),
});

export const FrameBinaryMetaSchema = z.object({
  type: z.literal('frame_binary'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  mime: z.literal('image/jpeg'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  image_bytes: z.number().int().positive(),
});

export const AudioBinaryMetaSchema = z.object({
  type: z.literal('audio_binary'),
  v: z.literal(PROTOCOL_VERSION),
  chunk_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  mime: z.literal('audio/pcm_s16le'),
  sample_rate_hz: z.literal(16_000),
  channels: z.literal(1),
  audio_bytes: z.number().int().positive(),
});

export const InsightSeveritySchema = z.enum(['low', 'medium', 'high']);

export const FrameReceivedMotionSchema = z.object({
  mad: z.number().nonnegative(),
  triggered: z.boolean(),
});

export const FrameReceivedMessageSchema = z.object({
  type: z.literal('frame_received'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  accepted: z.boolean(),
  queue_depth: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  motion: FrameReceivedMotionSchema.optional(),
});

export const AudioReceivedMessageSchema = z.object({
  type: z.literal('audio_received'),
  v: z.literal(PROTOCOL_VERSION),
  chunk_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  accepted: z.boolean(),
  queue_depth: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
});

export const SpeechTranscriptMessageSchema = z.object({
  type: z.literal('speech_transcript'),
  v: z.literal(PROTOCOL_VERSION),
  ts_ms: z.number().int().nonnegative(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const EventEntrySchema = z.object({
  name: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  severity: InsightSeveritySchema,
  data: z.record(z.unknown()),
});

export const FrameEventsMessageSchema = z.object({
  type: z.literal('frame_events'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  events: z.array(EventEntrySchema),
});

export const InsightPresenceSchema = z.object({
  preson_present: z.boolean(),
  person_facing_me: z.boolean(),
});

export const InsightSummarySchema = z.object({
  one_liner: z.string().min(1),
  tts_response: z.string().min(1),
  what_changed: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
  presence: InsightPresenceSchema.optional(),
});

export const InsightUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});

export const InsightMessageSchema = z.object({
  type: z.literal('insight'),
  v: z.literal(PROTOCOL_VERSION),
  clip_id: z.string().min(1),
  trigger_frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  summary: InsightSummarySchema,
  usage: InsightUsageSchema,
});

export const VisionInboundMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  FrameEventsMessageSchema,
  ErrorMessageSchema,
  InsightMessageSchema,
]);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type FrameBinaryMeta = z.infer<typeof FrameBinaryMetaSchema>;
export type AudioBinaryMeta = z.infer<typeof AudioBinaryMetaSchema>;
export type FrameReceivedMotion = z.infer<typeof FrameReceivedMotionSchema>;
export type FrameReceivedMessage = z.infer<typeof FrameReceivedMessageSchema>;
export type AudioReceivedMessage = z.infer<typeof AudioReceivedMessageSchema>;
export type SpeechTranscriptMessage = z.infer<typeof SpeechTranscriptMessageSchema>;
export type EventEntry = z.infer<typeof EventEntrySchema>;
export type FrameEventsMessage = z.infer<typeof FrameEventsMessageSchema>;
export type InsightPresence = z.infer<typeof InsightPresenceSchema>;
export type InsightSummary = z.infer<typeof InsightSummarySchema>;
export type InsightUsage = z.infer<typeof InsightUsageSchema>;
export type InsightMessage = z.infer<typeof InsightMessageSchema>;
export type VisionInboundMessage = z.infer<typeof VisionInboundMessageSchema>;

export interface DecodedBinaryFrameEnvelope {
  meta: FrameBinaryMeta;
  imageBytes: Buffer;
}

export interface DecodedBinaryAudioEnvelope {
  meta: AudioBinaryMeta;
  audioBytes: Buffer;
}

export class BinaryFrameDecodeError extends Error {
  public readonly frameId?: string;

  constructor(message: string, frameId?: string) {
    super(message);
    this.name = 'BinaryFrameDecodeError';
    this.frameId = frameId;
  }
}

export class BinaryAudioDecodeError extends Error {
  public readonly chunkId?: string;

  constructor(message: string, chunkId?: string) {
    super(message);
    this.name = 'BinaryAudioDecodeError';
    this.chunkId = chunkId;
  }
}

export function decodeBinaryFrameEnvelope(binaryPayload: Buffer): DecodedBinaryFrameEnvelope {
  if (binaryPayload.length < BINARY_META_LENGTH_BYTES) {
    throw new BinaryFrameDecodeError('Binary frame payload is too short.');
  }

  const metadataLength = binaryPayload.readUInt32BE(0);
  if (metadataLength <= 0) {
    throw new BinaryFrameDecodeError('Binary frame metadata length must be greater than zero.');
  }

  const metadataStart = BINARY_META_LENGTH_BYTES;
  const metadataEnd = metadataStart + metadataLength;

  if (binaryPayload.length < metadataEnd) {
    throw new BinaryFrameDecodeError('Binary frame metadata length exceeds payload size.');
  }

  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(binaryPayload.subarray(metadataStart, metadataEnd).toString('utf8'));
  } catch {
    throw new BinaryFrameDecodeError('Binary frame metadata is not valid JSON.');
  }

  const frameId = getOptionalFrameId(metadataValue);

  const parsedMetadata = FrameBinaryMetaSchema.safeParse(metadataValue);
  if (!parsedMetadata.success) {
    throw new BinaryFrameDecodeError('Binary frame metadata is invalid.', frameId);
  }

  const imageBytes = binaryPayload.subarray(metadataEnd);
  if (imageBytes.length !== parsedMetadata.data.image_bytes) {
    throw new BinaryFrameDecodeError(
      `Binary frame image length mismatch (expected ${parsedMetadata.data.image_bytes}, got ${imageBytes.length}).`,
      parsedMetadata.data.frame_id,
    );
  }

  return {
    meta: parsedMetadata.data,
    imageBytes,
  };
}

export function decodeBinaryAudioEnvelope(binaryPayload: Buffer): DecodedBinaryAudioEnvelope {
  if (binaryPayload.length < BINARY_META_LENGTH_BYTES) {
    throw new BinaryAudioDecodeError('Binary audio payload is too short.');
  }

  const metadataLength = binaryPayload.readUInt32BE(0);
  if (metadataLength <= 0) {
    throw new BinaryAudioDecodeError('Binary audio metadata length must be greater than zero.');
  }

  const metadataStart = BINARY_META_LENGTH_BYTES;
  const metadataEnd = metadataStart + metadataLength;

  if (binaryPayload.length < metadataEnd) {
    throw new BinaryAudioDecodeError('Binary audio metadata length exceeds payload size.');
  }

  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(binaryPayload.subarray(metadataStart, metadataEnd).toString('utf8'));
  } catch {
    throw new BinaryAudioDecodeError('Binary audio metadata is not valid JSON.');
  }

  const chunkId = getOptionalChunkId(metadataValue);

  const parsedMetadata = AudioBinaryMetaSchema.safeParse(metadataValue);
  if (!parsedMetadata.success) {
    throw new BinaryAudioDecodeError('Binary audio metadata is invalid.', chunkId);
  }

  const audioBytes = binaryPayload.subarray(metadataEnd);
  if (audioBytes.length !== parsedMetadata.data.audio_bytes) {
    throw new BinaryAudioDecodeError(
      `Binary audio payload length mismatch (expected ${parsedMetadata.data.audio_bytes}, got ${audioBytes.length}).`,
      parsedMetadata.data.chunk_id,
    );
  }

  return {
    meta: parsedMetadata.data,
    audioBytes,
  };
}

export function makeFrameReceived(
  frame_id: string,
  options: {
    accepted: boolean;
    queue_depth: number;
    dropped: number;
    motion?: FrameReceivedMotion;
  },
): FrameReceivedMessage {
  return {
    type: 'frame_received',
    v: PROTOCOL_VERSION,
    frame_id,
    ts_ms: Date.now(),
    accepted: options.accepted,
    queue_depth: options.queue_depth,
    dropped: options.dropped,
    ...(options.motion ? { motion: options.motion } : {}),
  };
}

export function makeAudioReceived(
  chunk_id: string,
  options: {
    accepted: boolean;
    queue_depth: number;
    dropped: number;
  },
): AudioReceivedMessage {
  return {
    type: 'audio_received',
    v: PROTOCOL_VERSION,
    chunk_id,
    ts_ms: Date.now(),
    accepted: options.accepted,
    queue_depth: options.queue_depth,
    dropped: options.dropped,
  };
}

export function makeHello(role: HelloMessage['role']): HelloMessage {
  return {
    type: 'hello',
    v: PROTOCOL_VERSION,
    role,
    ts_ms: Date.now(),
  };
}

export function makeError(code: string, message: string, frame_id?: string): ErrorMessage {
  return {
    type: 'error',
    v: PROTOCOL_VERSION,
    code,
    message,
    ...(frame_id ? { frame_id } : {}),
  };
}
