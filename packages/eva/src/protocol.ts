import { z } from 'zod';

export const HelloSchema = z.object({
  type: z.literal('hello'),
  v: z.literal(1),
  role: z.enum(['ui', 'eva', 'quickvision']),
  ts_ms: z.number().int().nonnegative()
});

export const ErrorSchema = z.object({
  type: z.literal('error'),
  v: z.literal(1),
  frame_id: z.string().optional(),
  code: z.string().min(1),
  message: z.string().min(1)
});

export type HelloMessage = z.infer<typeof HelloSchema>;
export type ErrorMessage = z.infer<typeof ErrorSchema>;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
