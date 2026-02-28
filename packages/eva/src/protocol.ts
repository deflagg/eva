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

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  role: z.enum(['ui', 'eva', 'vision']),
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

export const InsightSeveritySchema = z.enum(['low', 'medium', 'high']);

export const FrameReceivedMessageSchema = z.object({
  type: z.literal('frame_received'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  accepted: z.boolean(),
  queue_depth: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
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

export const InsightSummarySchema = z.object({
  one_liner: z.string().min(1),
  tts_response: z.string().min(1),
  what_changed: z.array(z.string().min(1)),
  severity: InsightSeveritySchema,
  tags: z.array(z.string().min(1)),
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
export type FrameReceivedMessage = z.infer<typeof FrameReceivedMessageSchema>;
export type EventEntry = z.infer<typeof EventEntrySchema>;
export type FrameEventsMessage = z.infer<typeof FrameEventsMessageSchema>;
export type InsightSummary = z.infer<typeof InsightSummarySchema>;
export type InsightUsage = z.infer<typeof InsightUsageSchema>;
export type InsightMessage = z.infer<typeof InsightMessageSchema>;
export type VisionInboundMessage = z.infer<typeof VisionInboundMessageSchema>;

export interface DecodedBinaryFrameEnvelope {
  meta: FrameBinaryMeta;
  imageBytes: Buffer;
}

export class BinaryFrameDecodeError extends Error {
  public readonly frameId?: string;

  constructor(message: string, frameId?: string) {
    super(message);
    this.name = 'BinaryFrameDecodeError';
    this.frameId = frameId;
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

export function makeFrameReceived(
  frame_id: string,
  options: {
    accepted: boolean;
    queue_depth: number;
    dropped: number;
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
