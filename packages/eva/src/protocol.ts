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
  frame_id: z.string().optional(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

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
