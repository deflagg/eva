import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const WorkingMemoryRecordSchema = z
  .object({
    type: z.string().trim().min(1),
    ts_ms: z.number(),
  })
  .passthrough();

export interface ReplayWorkingMemoryLogOptions {
  logPath: string;
}

export interface ReplayWorkingMemoryStats {
  total_lines: number;
  parsed_entries: number;
  skipped_invalid_json: number;
  skipped_invalid_shape: number;
}

export interface ReplayWorkingMemoryMessage {
  role: 'user' | 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
}

export interface ReplayWorkingMemoryLogResult {
  messages: ReplayWorkingMemoryMessage[];
  stats: ReplayWorkingMemoryStats;
}

interface ReplayableWorkingMemoryRecord {
  type: string;
  ts_ms: number;
  [key: string]: unknown;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code: string }).code === code
  );
}

function renderReplayRecord(record: ReplayableWorkingMemoryRecord): string {
  return [`WM_KIND=${record.type}`, `ts_ms: ${record.ts_ms}`, `WM_JSON: ${JSON.stringify(record)}`].join('\n');
}

function toReplayMessage(record: ReplayableWorkingMemoryRecord): ReplayWorkingMemoryMessage {
  return {
    role: record.type === 'text_output' ? 'assistant' : 'user',
    content: [
      {
        type: 'text',
        text: renderReplayRecord(record),
      },
    ],
  };
}

export async function replayWorkingMemoryLog(
  options: ReplayWorkingMemoryLogOptions,
): Promise<ReplayWorkingMemoryLogResult> {
  const stats: ReplayWorkingMemoryStats = {
    total_lines: 0,
    parsed_entries: 0,
    skipped_invalid_json: 0,
    skipped_invalid_shape: 0,
  };

  let rawLog: string;
  try {
    rawLog = await readFile(options.logPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return {
        messages: [],
        stats,
      };
    }

    throw error;
  }

  const lines = rawLog
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  stats.total_lines = lines.length;

  const records: ReplayableWorkingMemoryRecord[] = [];

  for (const line of lines) {
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line) as unknown;
    } catch {
      stats.skipped_invalid_json += 1;
      continue;
    }

    const normalized = WorkingMemoryRecordSchema.safeParse(parsedLine);
    if (!normalized.success) {
      stats.skipped_invalid_shape += 1;
      continue;
    }

    stats.parsed_entries += 1;
    records.push(normalized.data as ReplayableWorkingMemoryRecord);
  }

  records.sort((left, right) => left.ts_ms - right.ts_ms);

  return {
    messages: records.map(toReplayMessage),
    stats,
  };
}
