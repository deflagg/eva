import { z } from 'zod';

export const HelloSchema = z.object({
  type: z.literal('hello'),
  v: z.literal(1),
  role: z.enum(['ui', 'eva', 'quickvision']),
  ts_ms: z.number().int().nonnegative()
});

export type HelloMessage = z.infer<typeof HelloSchema>;
