import { buildRespondSystemPrompt, buildRespondUserPrompt } from '../src/prompts/respond.ts';
import { formatInsightsForPrompt, type InsightEntry } from '../src/memcontext/retrieve_recent_insights.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function run(): void {
  const rawUserText = 'what just happened';
  const userPrompt = buildRespondUserPrompt({ text: rawUserText });

  assert(userPrompt === rawUserText, 'User prompt must be raw user_text exactly.');
  assert(
    !userPrompt.includes('Generate a direct response for the user message'),
    'User prompt must not contain the old wrapper instruction.',
  );
  assert(!userPrompt.includes('user_text:'), 'User prompt must not contain user_text wrapper field.');

  const systemPrompt = buildRespondSystemPrompt({
    persona: 'test persona',
    allowedConcepts: ['chat', 'awareness'],
    maxConcepts: 6,
    currentTone: 'neutral',
    toneSessionKey: 'default',
    allowedTones: ['neutral', 'friendly'] as const,
  });

  assert(
    !systemPrompt.includes('Describe what changed, why it matters, and what to do next.'),
    'System prompt must not contain removed incident-report rubric.',
  );

  const sampleInsights: InsightEntry[] = [
    {
      ts_ms: Date.now(),
      clip_id: 'clip-1',
      trigger_frame_id: 'frame-1',
      summary: {
        one_liner: 'Someone looked tense and adjusted their hood.',
        what_changed: ['They stayed mostly still, then fidgeted briefly.'],
        severity: 'medium',
        tags: ['person'],
      },
    },
  ];

  const promptInsights = formatInsightsForPrompt(sampleInsights, {
    maxItems: 10,
    maxWhatChangedItems: 2,
    maxLineChars: 180,
  });

  const reportPattern = /\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] \((low|medium|high)\)/;
  assert(
    !reportPattern.test(promptInsights),
    'Prompt insights block must not include [HH:MM:SS] (severity) report formatting.',
  );

  console.log('PASS: respond prompt regression checks');
}

run();
