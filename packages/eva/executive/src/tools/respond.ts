import { Type, type Static } from '@sinclair/typebox';

import type { Tool } from '@mariozechner/pi-ai';

export const RespondMetaSchema = Type.Object({
  tone: Type.String({ minLength: 1 }),
  concepts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  surprise: Type.Number({ minimum: 0, maximum: 1 }),
  note: Type.String({ minLength: 1 }),
});

export const RespondPayloadSchema = Type.Object({
  text: Type.String({ minLength: 1 }),
  meta: RespondMetaSchema,
});

export type RespondPayload = Static<typeof RespondPayloadSchema>;

export const RESPOND_TOOL_NAME = 'commit_text_response';

export const RESPOND_TOOL: Tool = {
  name: RESPOND_TOOL_NAME,
  description:
    'Return the final chat response and metadata. Call this tool exactly once with text and meta {tone, concepts, surprise, note}.',
  parameters: RespondPayloadSchema,
};
