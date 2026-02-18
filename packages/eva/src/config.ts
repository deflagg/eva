import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosmiconfigSync } from 'cosmiconfig';
import { z } from 'zod';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HttpUrlSchema = z.string().min(1).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be a valid http:// or https:// URL');

const WsUrlSchema = z.string().min(1).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  } catch {
    return false;
  }
}, 'quickvision.wsUrl must be a valid ws:// or wss:// URL');

const CommandSchema = z
  .array(z.string().trim().min(1, 'command entries must be non-empty strings'))
  .min(1, 'command must contain at least one entry');

const PositiveTimeoutMsSchema = z.number().int().positive('timeout must be a positive integer');

const InsightRelayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cooldownMs: z.number().int().nonnegative().default(10_000),
  dedupeWindowMs: z.number().int().nonnegative().default(60_000),
});

const VisionAgentSubprocessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cwd: z.string().trim().min(1).default('packages/vision-agent'),
  command: CommandSchema.default(['npm', 'run', 'dev']),
  healthUrl: HttpUrlSchema.default('http://127.0.0.1:8790/health'),
  readyTimeoutMs: PositiveTimeoutMsSchema.default(30_000),
  shutdownTimeoutMs: PositiveTimeoutMsSchema.default(5_000),
});

const QuickVisionSubprocessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cwd: z.string().trim().min(1).default('packages/quickvision'),
  command: CommandSchema.default(['python', '-m', 'app.run']),
  healthUrl: HttpUrlSchema.default('http://127.0.0.1:8000/health'),
  readyTimeoutMs: PositiveTimeoutMsSchema.default(60_000),
  shutdownTimeoutMs: PositiveTimeoutMsSchema.default(10_000),
});

const SubprocessesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  visionAgent: VisionAgentSubprocessConfigSchema.default({
    enabled: true,
    cwd: 'packages/vision-agent',
    command: ['npm', 'run', 'dev'],
    healthUrl: 'http://127.0.0.1:8790/health',
    readyTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
  }),
  quickvision: QuickVisionSubprocessConfigSchema.default({
    enabled: true,
    cwd: 'packages/quickvision',
    command: ['python', '-m', 'app.run'],
    healthUrl: 'http://127.0.0.1:8000/health',
    readyTimeoutMs: 60_000,
    shutdownTimeoutMs: 10_000,
  }),
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
    wsUrl: WsUrlSchema,
  }),
  insightRelay: InsightRelayConfigSchema.default({
    enabled: true,
    cooldownMs: 10_000,
    dedupeWindowMs: 60_000,
  }),
  subprocesses: SubprocessesConfigSchema.default({
    enabled: false,
    visionAgent: {
      enabled: true,
      cwd: 'packages/vision-agent',
      command: ['npm', 'run', 'dev'],
      healthUrl: 'http://127.0.0.1:8790/health',
      readyTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
    },
    quickvision: {
      enabled: true,
      cwd: 'packages/quickvision',
      command: ['python', '-m', 'app.run'],
      healthUrl: 'http://127.0.0.1:8000/health',
      readyTimeoutMs: 60_000,
      shutdownTimeoutMs: 10_000,
    },
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
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`[eva] invalid config in ${result.filepath}: ${details}`);
  }

  return parsed.data;
}
