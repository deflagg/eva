import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

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

export const FrameMessageSchema = z.object({
  type: z.literal('frame'),
  v: z.literal(PROTOCOL_VERSION),
  frame_id: z.string().min(1),
  ts_ms: z.number().int().nonnegative(),
  mime: z.literal('image/jpeg'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  image_b64: z.string().min(1),
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
export type FrameMessage = z.infer<typeof FrameMessageSchema>;
export type DetectionsMessage = z.infer<typeof DetectionsMessageSchema>;
export type QuickVisionInboundMessage = z.infer<typeof QuickVisionInboundMessageSchema>;

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
