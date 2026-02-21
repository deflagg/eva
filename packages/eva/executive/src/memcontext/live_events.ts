import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const WorkingMemoryWmEventSchema = z
  .object({
    type: z.literal('wm_event'),
    ts_ms: z.number().int().nonnegative(),
    source: z.string().trim().min(1),
    name: z.string().trim().min(1),
    severity: z.enum(['low', 'medium', 'high']),
    track_id: z.number().int().optional(),
    summary: z.string().trim().min(1),
    data: z.record(z.unknown()),
  })
  .passthrough();

export type LiveWmEvent = z.infer<typeof WorkingMemoryWmEventSchema>;

export interface ReadRecentWmEventsOptions {
  logPath: string;
  nowMs: number;
  windowMs: number;
  maxItems: number;
}

export async function readRecentWmEvents(options: ReadRecentWmEventsOptions): Promise<LiveWmEvent[]> {
  const { logPath, nowMs, windowMs, maxItems } = options;

  if (windowMs <= 0 || maxItems <= 0) {
    return [];
  }

  let rawLog: string;
  try {
    rawLog = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const cutoffMs = nowMs - windowMs;
  const events: LiveWmEvent[] = [];

  const lines = rawLog
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    const normalized = WorkingMemoryWmEventSchema.safeParse(parsed);
    if (!normalized.success) {
      continue;
    }

    if (normalized.data.ts_ms < cutoffMs) {
      continue;
    }

    events.push(normalized.data);
  }

  events.sort((left, right) => left.ts_ms - right.ts_ms);

  if (events.length <= maxItems) {
    return events;
  }

  return events.slice(-maxItems);
}
