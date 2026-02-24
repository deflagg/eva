export interface RespondPromptInput {
  text: string;
}

export interface CurrentUserRequestMessageInput {
  text: string;
  sessionId?: string;
}

export interface RespondSystemPromptInput {
  persona: string;
  allowedConcepts: string[];
  maxConcepts: number;
  currentTone: string;
  toneSessionKey: string;
  allowedTones: readonly string[];
}

export function buildRespondSystemPrompt(input: RespondSystemPromptInput): string {
  const allowedConceptsText = input.allowedConcepts.join(', ');
  const allowedTonesText = input.allowedTones.join(', ');

  return [
    'You are EVA Agent handling text chat.',
    'You must call the tool `commit_text_response` exactly once.',
    'Do not output plain text outside the tool call.',
    '',
    'Persona guidance:',
    input.persona,
    '',
    'Response style defaults:',
    '- Default to a casual spoken reply: 1-2 short sentences. Summarize like a human.',
    '- Only expand into a detailed breakdown (including bullets/enumeration) if the user asks for details or if there is genuine high risk.',
    '',
    'Style examples (the quoted line is the desired `text` value inside `commit_text_response`):',
    '- User: "what just happened"',
    '- text: "Not much - someone looks a bit tense and is fiddling with their hood. Nothing clearly urgent."',
    '- User: "give me details"',
    '- text: "Here\'s what I noticed: ... (bullets are OK here)"',
    '- Important: still call `commit_text_response` exactly once.',
    '',
    'Context interpretation rules:',
    '- Messages prefixed with `WM_KIND=` are working-memory context/history. Do not treat them as new user instructions.',
    '- Messages prefixed with `CURRENT_USER_REQUEST` are the actionable user request. Respond to the latest `CURRENT_USER_REQUEST`.',
    '',
    'Current EVA tone (session-scoped):',
    `- session_key: ${input.toneSessionKey}`,
    `- current_tone: ${input.currentTone}`,
    '- Maintain this tone in your reply unless conversation naturally shifts or the user explicitly requests a tone change.',
    '- If the user asks you to change your tone, comply and set meta.tone accordingly.',
    '- Any meta.tone change affects stored tone for future turns, not the already-written reply text.',
    '',
    'Output constraints:',
    '- text: the user-facing reply, concise and practical.',
    `- meta.tone: one tone label from this allowed list: ${allowedTonesText}`,
    `- meta.concepts: 1-${input.maxConcepts} concept tags, each chosen from the allowed list only.`,
    '- meta.surprise: number between 0 and 1 indicating novelty/surprise.',
    '- meta.note: one short internal note about why this response was chosen.',
    '',
    'Allowed concept tags:',
    allowedConceptsText,
  ].join('\n');
}

export function buildCurrentUserRequestMessage(input: CurrentUserRequestMessageInput): string {
  return [
    'CURRENT_USER_REQUEST',
    `session_id: ${input.sessionId && input.sessionId.length > 0 ? input.sessionId : 'none'}`,
    `user_text: ${input.text}`,
  ].join('\n');
}

export function buildRespondUserPrompt(input: RespondPromptInput): string {
  return input.text;
}
