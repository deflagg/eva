import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

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
  role: z.enum(['ui', 'eva', 'quickvision']),
  ts_ms: z.number().int().nonnegative(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1).optional(),
  code: z.string().min(1),
  message: z.string().min(1),
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

export const DetectionEntrySchema = z.object({
  cls: z.number().int().nonnegative(),
  name: z.string().min(1),
  conf: z.number().min(0).max(1),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

export const DetectionsMessageSchema = z.object({
  type: z.literal('detections'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  model: z.string().min(1),
  detections: z.array(DetectionEntrySchema),
});

export const QuickVisionInboundMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  DetectionsMessageSchema,
  ErrorMessageSchema,
]);

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type FrameBinaryMeta = z.infer<typeof FrameBinaryMetaSchema>;
export type DetectionsMessage = z.infer<typeof DetectionsMessageSchema>;
export type QuickVisionInboundMessage = z.infer<typeof QuickVisionInboundMessageSchema>;

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
