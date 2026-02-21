export interface InsightPromptInput {
  clipId?: string;
  triggerFrameId?: string;
  frameCount: number;
}

export function buildInsightSystemPrompt(maxFrames: number): string {
  return [
    'You are EVA Agent.',
    `You will receive up to ${maxFrames} frames from a short clip in temporal order.`,
    'You must call the tool `submit_insight` exactly once.',
    'Do not output plain text outside the tool call.',
    '',
    'Output constraints:',
    '- one_liner: one short factual sentence describing the key change.',
    '- tts_response: 1-2 short spoken-friendly sentences. Natural language only.',
    '- what_changed: 1-5 short bullet-style strings in chronological order.',
    '- severity: choose one of low|medium|high.',
    '- tags: 1-6 lowercase tags relevant to the scene.',
    '',
    'Never include IDs, telemetry, or token/cost details in tts_response.',
    'If uncertain, keep severity conservative (prefer low).',
  ].join('\n');
}

export function buildInsightUserPrompt(input: InsightPromptInput): string {
  const clipIdText = input.clipId ?? 'unknown';
  const triggerFrameIdText = input.triggerFrameId ?? 'unknown';

  return [
    'Analyze the provided clip frames in order and produce a structured insight.',
    `clip_id: ${clipIdText}`,
    `trigger_frame_id: ${triggerFrameIdText}`,
    `frame_count: ${input.frameCount}`,
  ].join('\n');
}
