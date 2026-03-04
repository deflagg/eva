import { Type, type Static } from '@sinclair/typebox';

import type { Tool } from '@mariozechner/pi-ai';

export const InsightPresenceSchema = Type.Object({
  preson_present: Type.Boolean(),
  person_facing_me: Type.Boolean(),
});

export type InsightPresence = Static<typeof InsightPresenceSchema>;

export const InsightSummarySchema = Type.Object({
  one_liner: Type.String({ minLength: 1 }),
  tts_response: Type.String({ minLength: 1 }),
  what_changed: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  presence: InsightPresenceSchema,
});

export type InsightSummary = Static<typeof InsightSummarySchema>;

export const INSIGHT_TOOL_NAME = 'submit_insight';

export const INSIGHT_TOOL: Tool = {
  name: INSIGHT_TOOL_NAME,
  description:
    'Return the structured insight summary for the provided clip. Call this tool exactly once with one_liner, tts_response, what_changed, tags, and required presence { preson_present, person_facing_me }.',
  parameters: InsightSummarySchema,
};
