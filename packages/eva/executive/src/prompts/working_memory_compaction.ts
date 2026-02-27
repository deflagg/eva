export interface WorkingMemoryCompactionPromptInput {
  windowStartMs: number;
  windowEndMs: number;
  sourceEntryCount: number;
  recordsText: string;
}

function toIso(tsMs: number): string {
  const date = new Date(tsMs);
  if (Number.isNaN(date.getTime())) {
    return 'invalid-date';
  }

  return date.toISOString();
}

export function buildWorkingMemoryCompactionSystemPrompt(): string {
  return [
    'You are EVA Executive working-memory compactor.',
    'You will receive compacted working-memory records from the previous hour window.',
    'You must call the tool `commit_working_memory_compaction` exactly once.',
    'Do not output plain text outside the tool call.',
    '',
    'Output contract (hard rules):',
    '- Return bullets: 3-7 items.',
    '- Each bullet must be concise, human-readable, and <= 220 characters.',
    '- Remove noise and repetition; keep only durable useful context.',
    '- Never output raw telemetry dumps, JSON blobs, IDs, or key/value logs.',
    '',
    'Prioritize these signals:',
    '1) Stable preferences, trait signals, and user style guidance.',
    '2) Decisions made, plans, and unresolved follow-up loops.',
    '3) Notable insight activity and meaningful scene observations.',
    '4) Unusual or high-surprise chat outputs.',
    '',
    'If little happened, still produce useful concise bullets that preserve continuity.',
  ].join('\n');
}

export function buildWorkingMemoryCompactionUserPrompt(input: WorkingMemoryCompactionPromptInput): string {
  return [
    'Summarize the following older working-memory records into compaction bullets.',
    `window_start_ms: ${input.windowStartMs}`,
    `window_start_iso: ${toIso(input.windowStartMs)}`,
    `window_end_ms: ${input.windowEndMs}`,
    `window_end_iso: ${toIso(input.windowEndMs)}`,
    `source_entry_count: ${input.sourceEntryCount}`,
    'records:',
    input.recordsText || '(no records provided)',
  ].join('\n');
}
