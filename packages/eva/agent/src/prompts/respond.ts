export interface RespondPromptInput {
  text: string;
  sessionId?: string;
}

export interface RespondSystemPromptInput {
  persona: string;
  allowedConcepts: string[];
  maxConcepts: number;
}

export function buildRespondSystemPrompt(input: RespondSystemPromptInput): string {
  const allowedConceptsText = input.allowedConcepts.join(', ');

  return [
    'You are EVA Agent handling text chat.',
    'You must call the tool `commit_text_response` exactly once.',
    'Do not output plain text outside the tool call.',
    '',
    'Persona guidance:',
    input.persona,
    '',
    'Output constraints:',
    '- text: the user-facing reply, concise and practical.',
    '- meta.tone: a short tone label (for example calm, urgent, informative).',
    `- meta.concepts: 1-${input.maxConcepts} concept tags, each chosen from the allowed list only.`,
    '- meta.surprise: number between 0 and 1 indicating novelty/surprise.',
    '- meta.note: one short internal note about why this response was chosen.',
    '',
    'Allowed concept tags:',
    allowedConceptsText,
  ].join('\n');
}

export function buildRespondUserPrompt(input: RespondPromptInput): string {
  return [
    'Generate a direct response for the user message.',
    `session_id: ${input.sessionId ?? 'none'}`,
    `user_text: ${input.text}`,
  ].join('\n');
}
