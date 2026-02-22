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
}, 'must be a valid ws:// or wss:// URL');

const VisionWsConfigSchema = z.object({
  wsUrl: WsUrlSchema,
});

const CommandSchema = z
  .array(z.string().trim().min(1, 'command entries must be non-empty strings'))
  .min(1, 'command must contain at least one entry');

const PositiveTimeoutMsSchema = z.number().int().positive('timeout must be a positive integer');

const InsightRelayConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cooldownMs: z.number().int().nonnegative().default(10_000),
  dedupeWindowMs: z.number().int().nonnegative().default(60_000),
});

const SpeechCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ttlMs: z.number().int().nonnegative().default(600_000),
  maxEntries: z.number().int().positive().default(64),
});

const SpeechConfigSchema = z.object({
  enabled: z.boolean().default(false),
  path: z
    .string()
    .min(1)
    .default('/speech')
    .refine((value) => value.startsWith('/'), 'speech.path must start with "/"'),
  defaultVoice: z.string().trim().min(1).default('en-US-JennyNeural'),
  maxTextChars: z.number().int().positive().default(1_000),
  maxBodyBytes: z.number().int().positive().default(65_536),
  cooldownMs: z.number().int().nonnegative().default(0),
  cache: SpeechCacheConfigSchema.default({
    enabled: true,
    ttlMs: 600_000,
    maxEntries: 64,
  }),
});

const AgentConfigSchema = z.object({
  baseUrl: HttpUrlSchema.default('http://127.0.0.1:8791'),
  timeoutMs: PositiveTimeoutMsSchema.default(30_000),
});

const TextConfigSchema = z.object({
  enabled: z.boolean().default(true),
  path: z
    .string()
    .min(1)
    .default('/text')
    .refine((value) => value.startsWith('/'), 'text.path must start with "/"'),
  maxBodyBytes: z.number().int().positive().default(16_384),
  maxTextChars: z.number().int().positive().default(4_000),
});

const AgentSubprocessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cwd: z.string().trim().min(1).default('packages/eva/executive'),
  command: CommandSchema.default(['npm', 'run', 'dev']),
  healthUrl: HttpUrlSchema.default('http://127.0.0.1:8791/health'),
  readyTimeoutMs: PositiveTimeoutMsSchema.default(30_000),
  shutdownTimeoutMs: PositiveTimeoutMsSchema.default(5_000),
});

const VisionSubprocessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  cwd: z.string().trim().min(1).default('packages/eva/vision'),
  command: CommandSchema.default(['.venv/bin/python', '-m', 'app.run']),
  healthUrl: HttpUrlSchema.default('http://127.0.0.1:8000/health'),
  readyTimeoutMs: PositiveTimeoutMsSchema.default(60_000),
  shutdownTimeoutMs: PositiveTimeoutMsSchema.default(10_000),
});

const SubprocessesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  agent: AgentSubprocessConfigSchema.default({
    enabled: true,
    cwd: 'packages/eva/executive',
    command: ['npm', 'run', 'dev'],
    healthUrl: 'http://127.0.0.1:8791/health',
    readyTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
  }),
  vision: VisionSubprocessConfigSchema.default({
    enabled: true,
    cwd: 'packages/eva/vision',
    command: ['.venv/bin/python', '-m', 'app.run'],
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
  vision: VisionWsConfigSchema,
  insightRelay: InsightRelayConfigSchema.default({
    enabled: true,
    cooldownMs: 10_000,
    dedupeWindowMs: 60_000,
  }),
  speech: SpeechConfigSchema.default({
    enabled: false,
    path: '/speech',
    defaultVoice: 'en-US-JennyNeural',
    maxTextChars: 1_000,
    maxBodyBytes: 65_536,
    cooldownMs: 0,
    cache: {
      enabled: true,
      ttlMs: 600_000,
      maxEntries: 64,
    },
  }),
  agent: AgentConfigSchema.default({
    baseUrl: 'http://127.0.0.1:8791',
    timeoutMs: 30_000,
  }),
  text: TextConfigSchema.default({
    enabled: true,
    path: '/text',
    maxBodyBytes: 16_384,
    maxTextChars: 4_000,
  }),
  subprocesses: SubprocessesConfigSchema.default({
    enabled: false,
    agent: {
      enabled: true,
      cwd: 'packages/eva/executive',
      command: ['npm', 'run', 'dev'],
      healthUrl: 'http://127.0.0.1:8791/health',
      readyTimeoutMs: 30_000,
      shutdownTimeoutMs: 5_000,
    },
    vision: {
      enabled: true,
      cwd: 'packages/eva/vision',
      command: ['.venv/bin/python', '-m', 'app.run'],
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
      .map((issue) => {
        if (issue.path.length === 1 && issue.path[0] === 'vision') {
          return 'vision.wsUrl: Required';
        }

        return `${issue.path.join('.') || '(root)'}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`[eva] invalid config in ${result.filepath}: ${details}`);
  }

  return parsed.data;
}

