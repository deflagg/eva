import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const InsightSeveritySchema = z.enum(['low', 'medium', 'high']);

const InsightAssetRefSchema = z
  .object({
    frame_id: z.string().trim().min(1).optional(),
    ts_ms: z.number().int().nonnegative().optional(),
    mime: z.literal('image/jpeg').default('image/jpeg'),
    asset_rel_path: z.string().trim().min(1),
  })
  .strict();

const WorkingMemoryWmInsightSchema = z
  .object({
    type: z.literal('wm_insight'),
    ts_ms: z.number().int().nonnegative(),
    clip_id: z.string().trim().min(1),
    trigger_frame_id: z.string().trim().min(1),
    severity: InsightSeveritySchema,
    one_liner: z.string().trim().min(1),
    what_changed: z.array(z.string().trim().min(1)).default([]),
    tags: z.array(z.string().trim().min(1)).default([]),
    assets: z.array(InsightAssetRefSchema).optional(),
  })
  .passthrough();

export type InsightAssetRef = z.infer<typeof InsightAssetRefSchema>;

export interface InsightEntry {
  ts_ms: number;
  clip_id: string;
  trigger_frame_id: string;
  summary: {
    one_liner: string;
    what_changed: string[];
    severity: z.infer<typeof InsightSeveritySchema>;
    tags: string[];
  };
  assets?: InsightAssetRef[];
}

export interface RetrieveRecentInsightsOptions {
  logPath: string;
  sinceTsMs: number;
  untilTsMs: number;
  limit: number;
}

export interface FormatInsightsForPromptOptions {
  maxItems?: number;
  maxWhatChangedItems?: number;
  maxLineChars?: number;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatTimeHms(tsMs: number): string {
  const date = new Date(tsMs);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
}

export async function retrieveRecentInsights(options: RetrieveRecentInsightsOptions): Promise<InsightEntry[]> {
  const { logPath, sinceTsMs, untilTsMs, limit } = options;

  if (limit <= 0 || untilTsMs < sinceTsMs) {
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

  const entries: InsightEntry[] = [];

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

    const normalized = WorkingMemoryWmInsightSchema.safeParse(parsed);
    if (!normalized.success) {
      continue;
    }

    if (normalized.data.ts_ms < sinceTsMs || normalized.data.ts_ms > untilTsMs) {
      continue;
    }

    entries.push({
      ts_ms: normalized.data.ts_ms,
      clip_id: normalized.data.clip_id,
      trigger_frame_id: normalized.data.trigger_frame_id,
      summary: {
        one_liner: normalized.data.one_liner,
        what_changed: [...normalized.data.what_changed],
        severity: normalized.data.severity,
        tags: [...normalized.data.tags],
      },
      ...(normalized.data.assets && normalized.data.assets.length > 0
        ? {
            assets: normalized.data.assets.map((asset) => ({
              ...(asset.frame_id ? { frame_id: asset.frame_id } : {}),
              ...(typeof asset.ts_ms === 'number' ? { ts_ms: asset.ts_ms } : {}),
              mime: asset.mime,
              asset_rel_path: asset.asset_rel_path,
            })),
          }
        : {}),
    });
  }

  entries.sort((left, right) => left.ts_ms - right.ts_ms);

  if (entries.length <= limit) {
    return entries;
  }

  return entries.slice(-limit);
}

export function formatInsightsForPrompt(
  insights: InsightEntry[],
  options: FormatInsightsForPromptOptions = {},
): string {
  const maxItems = Math.max(1, options.maxItems ?? 10);
  const maxWhatChangedItems = Math.max(1, options.maxWhatChangedItems ?? 2);
  const maxLineChars = Math.max(80, options.maxLineChars ?? 180);

  const selected = insights.slice(-maxItems);
  const lines: string[] = [];

  for (const insight of selected) {
    lines.push(
      truncateText(
        `[${formatTimeHms(insight.ts_ms)}] (${insight.summary.severity}) ${insight.summary.one_liner}`,
        maxLineChars,
      ),
    );

    const changes = insight.summary.what_changed.slice(0, maxWhatChangedItems);
    for (const change of changes) {
      lines.push(truncateText(`- ${change}`, maxLineChars));
    }

    const omittedCount = insight.summary.what_changed.length - changes.length;
    if (omittedCount > 0) {
      lines.push(`- (+${omittedCount} more)`);
    }
  }

  return lines.join('\n');
}
