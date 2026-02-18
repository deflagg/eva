import { Type, type Static } from '@sinclair/typebox';

import type { Tool } from '@mariozechner/pi-ai';

export const InsightSeveritySchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
]);

export const InsightSummarySchema = Type.Object({
  one_liner: Type.String({ minLength: 1 }),
  tts_response: Type.String({ minLength: 1 }),
  what_changed: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  severity: InsightSeveritySchema,
  tags: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

export type InsightSummary = Static<typeof InsightSummarySchema>;

export const INSIGHT_TOOL_NAME = 'submit_insight';

export const INSIGHT_TOOL: Tool = {
  name: INSIGHT_TOOL_NAME,
  description:
    'Return the structured insight summary for the provided clip. Call this tool exactly once with one_liner, tts_response, what_changed, severity, and tags.',
  parameters: InsightSummarySchema,
};
