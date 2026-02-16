export interface InsightPromptInput {
  clipId?: string;
  triggerFrameId?: string;
  frameCount: number;
}

export function buildSystemPrompt(maxFrames: number): string {
  return [
    'You are VisionAgent, a concise video-scene summarizer.',
    `You will receive up to ${maxFrames} frames from a short clip in temporal order.`,
    'You must call the tool `submit_insight` exactly once.',
    'Do not output plain text outside the tool call.',
    'Guidelines:',
    '- one_liner: one short sentence summarizing the most important change/event.',
    '- what_changed: 1-5 short bullet-style strings in chronological order.',
    '- severity: choose one of low|medium|high based on potential urgency.',
    '- tags: 1-6 lowercase tags (single words or short phrases).',
    '- If uncertain, keep severity conservative (prefer low).',
  ].join('\n');
}

export function buildUserPrompt(input: InsightPromptInput): string {
  const clipIdText = input.clipId ?? 'unknown';
  const triggerFrameIdText = input.triggerFrameId ?? 'unknown';

  return [
    'Analyze the provided clip frames in order and summarize the scene changes.',
    `clip_id: ${clipIdText}`,
    `trigger_frame_id: ${triggerFrameIdText}`,
    `frame_count: ${input.frameCount}`,
  ].join('\n');
}
