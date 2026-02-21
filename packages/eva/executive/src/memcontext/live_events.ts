import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const WorkingMemoryWmEventSchema = z
  .object({
    type: z.literal('wm_event'),
    ts_ms: z.number().int().nonnegative(),
    source: z.string().trim().min(1),
    name: z.string().trim().min(1),
    severity: z.enum(['low', 'medium', 'high']),
    track_id: z.number().int().optional(),
    summary: z.string().trim().min(1),
    data: z.record(z.unknown()),
  })
  .passthrough();

export type LiveWmEvent = z.infer<typeof WorkingMemoryWmEventSchema>;

export interface ReadRecentWmEventsOptions {
  logPath: string;
  nowMs: number;
  windowMs: number;
  maxItems: number;
}

export interface EnvironmentSnapshot {
  paragraph: string;
  bullets: string[];
}

const EVENT_LABELS: Record<string, string> = {
  roi_enter: 'entry into a monitored region',
  roi_exit: 'exit from a monitored region',
  roi_dwell: 'lingering in a monitored region',
  line_cross: 'boundary line crossing',
  sudden_motion: 'sudden movement',
  track_stop: 'subject stopping',
  near_collision: 'near-collision risk',
  abandoned_object: 'possible abandoned object',
};

function normalizeEventName(name: string): string {
  return name.trim().toLowerCase();
}

function eventLabel(name: string): string {
  const normalized = normalizeEventName(name);
  const mapped = EVENT_LABELS[normalized];
  if (mapped) {
    return mapped;
  }

  return normalized.replace(/[_-]+/g, ' ');
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function formatTopKinds(kindCounts: Map<string, number>, limit: number): string {
  const ranked = [...kindCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, Math.max(1, limit));

  if (ranked.length === 0) {
    return 'none';
  }

  return ranked.map(([kind, count]) => `${kind} (${count})`).join(', ');
}

function describeEvent(event: LiveWmEvent): string {
  const base = eventLabel(event.name);
  const severity = event.severity;
  const trackedSubjectText = typeof event.track_id === 'number' ? ' involving a tracked subject' : '';

  return `${base} (${severity} severity)${trackedSubjectText}`;
}

function describeActivityLevel(total: number, highSeverityCount: number): string {
  if (highSeverityCount > 0) {
    return 'elevated';
  }

  if (total >= 12) {
    return 'active';
  }

  if (total >= 5) {
    return 'steady';
  }

  return 'light';
}

function ensureBulletRange(bullets: string[]): string[] {
  const normalized = bullets
    .map((bullet) => bullet.replace(/\s+/g, ' ').trim())
    .filter((bullet, index, array) => bullet.length > 0 && array.indexOf(bullet) === index);

  if (normalized.length >= 3) {
    return normalized.slice(0, 7);
  }

  const fallback = [
    'No clear dominant event pattern is established in this window.',
    'No immediate high-severity alert burst is visible right now.',
    'Use short-term and long-term memory context for broader historical context.',
  ];

  for (const bullet of fallback) {
    if (normalized.length >= 3) {
      break;
    }

    if (!normalized.includes(bullet)) {
      normalized.push(bullet);
    }
  }

  return normalized.slice(0, 7);
}

export function buildEnvironmentSnapshot(events: LiveWmEvent[]): EnvironmentSnapshot {
  if (events.length === 0) {
    return {
      paragraph: 'No live events were observed in the last ~2 minutes, so the environment appears quiet right now.',
      bullets: ensureBulletRange([
        'No motion/region detector alerts were logged in this window.',
        'No high-severity event pressure is currently visible.',
        'If the user asks for current activity, report that nothing notable happened recently.',
      ]),
    };
  }

  const severityCounts = {
    high: 0,
    medium: 0,
    low: 0,
  };

  const kindCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const trackIds = new Set<number>();

  for (const event of events) {
    severityCounts[event.severity] += 1;
    incrementCount(kindCounts, eventLabel(event.name));
    incrementCount(sourceCounts, event.source);

    if (typeof event.track_id === 'number') {
      trackIds.add(event.track_id);
    }
  }

  const sourceList = [...sourceCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([source]) => source);

  const sourceText = sourceList.length === 1 ? sourceList[0] : sourceList.join(', ');
  const activityLevel = describeActivityLevel(events.length, severityCounts.high);
  const topKindsText = formatTopKinds(kindCounts, 2);

  const latest = events[events.length - 1];
  const earliest = events[0];
  const latestHigh = [...events].reverse().find((event) => event.severity === 'high');

  const paragraph = `In the last ~2 minutes, ${events.length} live events were observed from ${sourceText}. Activity appears ${activityLevel}, with the most common patterns being ${topKindsText}.`;

  const bullets = ensureBulletRange([
    `Severity mix is ${severityCounts.high} high, ${severityCounts.medium} medium, and ${severityCounts.low} low events.`,
    `Primary event patterns: ${formatTopKinds(kindCounts, 3)}.`,
    `Sources involved: ${sourceText}.`,
    trackIds.size > 0
      ? `${trackIds.size} tracked subject${trackIds.size === 1 ? '' : 's'} were involved in recent events.`
      : 'Recent events were scene-level and did not include tracked-subject IDs.',
    `Latest event: ${describeEvent(latest)}.`,
    latestHigh ? `Most recent high-severity event: ${describeEvent(latestHigh)}.` : 'No high-severity events were observed in this window.',
    `Window opened with: ${describeEvent(earliest)}.`,
  ]);

  return {
    paragraph,
    bullets,
  };
}

export async function readRecentWmEvents(options: ReadRecentWmEventsOptions): Promise<LiveWmEvent[]> {
  const { logPath, nowMs, windowMs, maxItems } = options;

  if (windowMs <= 0 || maxItems <= 0) {
    return [];
  }

  let rawLog: string;
  try {
    rawLog = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const cutoffMs = nowMs - windowMs;
  const events: LiveWmEvent[] = [];

  const lines = rawLog
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }

    const normalized = WorkingMemoryWmEventSchema.safeParse(parsed);
    if (!normalized.success) {
      continue;
    }

    if (normalized.data.ts_ms < cutoffMs) {
      continue;
    }

    events.push(normalized.data);
  }

  events.sort((left, right) => left.ts_ms - right.ts_ms);

  if (events.length <= maxItems) {
    return events;
  }

  return events.slice(-maxItems);
}
