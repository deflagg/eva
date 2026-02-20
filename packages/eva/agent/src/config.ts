import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosmiconfigSync } from 'cosmiconfig';
import { z } from 'zod';

const HARD_MAX_FRAMES = 6;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ModelConfigSchema = z.object({
  provider: z.string().trim().min(1).default('openai'),
  id: z.string().trim().min(1).default('gpt-4o-mini'),
});

const InsightConfigSchema = z.object({
  cooldownMs: z.number().int().nonnegative().default(5_000),
  maxFrames: z.number().int().min(1).max(HARD_MAX_FRAMES).default(HARD_MAX_FRAMES),
  maxBodyBytes: z.number().int().positive().default(8_388_608),
});

const AgentConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65_535),
  }),
  memory: z.object({
    dir: z.string().trim().min(1),
  }),
  model: ModelConfigSchema.default({
    provider: 'openai',
    id: 'gpt-4o-mini',
  }),
  insight: InsightConfigSchema.default({
    cooldownMs: 5_000,
    maxFrames: HARD_MAX_FRAMES,
    maxBodyBytes: 8_388_608,
  }),
  secretsFile: z.string().trim().min(1),
});

const AgentSecretsSchema = z.object({
  openaiApiKey: z.string().trim().min(1),
});

type AgentConfigData = z.infer<typeof AgentConfigSchema>;

export type AgentConfig = AgentConfigData & {
  configFilePath: string;
  memoryDirPath: string;
  secretsFilePath: string;
};

export type AgentSecrets = z.infer<typeof AgentSecretsSchema>;

function resolveRelativeToConfig(rawPath: string, configFilePath: string): string {
  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }

  return path.resolve(path.dirname(configFilePath), rawPath);
}

export function loadAgentConfig(): AgentConfig {
  const explorer = cosmiconfigSync('agent', {
    searchPlaces: ['agent.config.local.json', 'agent.config.json'],
    stopDir: packageRoot,
  });

  const result = explorer.search(packageRoot);

  if (!result || result.isEmpty) {
    throw new Error(
      '[agent] configuration file not found. Expected one of: agent.config.local.json or agent.config.json',
    );
  }

  const parsed = AgentConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`[agent] invalid config in ${result.filepath}: ${details}`);
  }

  return {
    ...parsed.data,
    configFilePath: result.filepath,
    memoryDirPath: resolveRelativeToConfig(parsed.data.memory.dir, result.filepath),
    secretsFilePath: resolveRelativeToConfig(parsed.data.secretsFile, result.filepath),
  };
}

export function loadAgentSecrets(secretsFilePath: string): AgentSecrets {
  let raw: string;

  try {
    raw = readFileSync(secretsFilePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agent] failed to read secrets file ${secretsFilePath}: ${message}`);
  }

  let json: unknown;

  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`[agent] secrets file is not valid JSON: ${secretsFilePath}`);
  }

  const parsed = AgentSecretsSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`[agent] invalid secrets in ${secretsFilePath}: ${details}`);
  }

  return parsed.data;
}
