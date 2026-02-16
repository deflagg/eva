import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosmiconfigSync } from 'cosmiconfig';
import { z } from 'zod';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const InsightRelayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cooldownMs: z.number().int().nonnegative().default(10_000),
  dedupeWindowMs: z.number().int().nonnegative().default(60_000),
});

const EvaConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65_535),
    eyePath: z
      .string()
      .min(1)
      .default('/eye')
      .refine((value) => value.startsWith('/'), 'server.eyePath must start with "/"'),
  }),
  quickvision: z.object({
    wsUrl: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
        } catch {
          return false;
        }
      }, 'quickvision.wsUrl must be a valid ws:// or wss:// URL'),
  }),
  insightRelay: InsightRelayConfigSchema.default({
    enabled: true,
    cooldownMs: 10_000,
    dedupeWindowMs: 60_000,
  }),
});

export type EvaConfig = z.infer<typeof EvaConfigSchema>;

export function loadEvaConfig(): EvaConfig {
  const explorer = cosmiconfigSync('eva', {
    searchPlaces: ['eva.config.local.json', 'eva.config.json'],
    stopDir: packageRoot,
  });

  const result = explorer.search(packageRoot);

  if (!result || result.isEmpty) {
    throw new Error(
      '[eva] configuration file not found. Expected one of: eva.config.local.json or eva.config.json',
    );
  }

  const parsed = EvaConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`[eva] invalid config in ${result.filepath}: ${details}`);
  }

  return parsed.data;
}
