import { Type, type Static } from '@sinclair/typebox';

import type { Tool } from '@mariozechner/pi-ai';

export const WORKING_MEMORY_COMPACTION_BULLET_MIN = 3;
export const WORKING_MEMORY_COMPACTION_BULLET_MAX = 7;
export const WORKING_MEMORY_COMPACTION_BULLET_MAX_CHARS = 220;

export const WorkingMemoryCompactionPayloadSchema = Type.Object({
  bullets: Type.Array(Type.String({ minLength: 1, maxLength: WORKING_MEMORY_COMPACTION_BULLET_MAX_CHARS }), {
    minItems: WORKING_MEMORY_COMPACTION_BULLET_MIN,
    maxItems: WORKING_MEMORY_COMPACTION_BULLET_MAX,
  }),
});

export type WorkingMemoryCompactionPayload = Static<typeof WorkingMemoryCompactionPayloadSchema>;

export const WORKING_MEMORY_COMPACTION_TOOL_NAME = 'commit_working_memory_compaction';

export const WORKING_MEMORY_COMPACTION_TOOL: Tool = {
  name: WORKING_MEMORY_COMPACTION_TOOL_NAME,
  description:
    'Commit working-memory compaction bullets. Call exactly once with 3-7 concise, human-readable bullets (<=220 chars each); avoid raw telemetry dumps.',
  parameters: WorkingMemoryCompactionPayloadSchema,
};
