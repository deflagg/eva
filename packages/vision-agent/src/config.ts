import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import { cosmiconfigSync } from 'cosmiconfig';
import { z } from 'zod';

const HARD_MAX_FRAMES = 6;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VisionAgentConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65_535),
  }),
  model: z.object({
    provider: z.string().min(1),
    id: z.string().min(1),
  }),
  guardrails: z.object({
    cooldownMs: z.number().int().nonnegative(),
    maxFrames: z.number().int().min(1).max(HARD_MAX_FRAMES),
    maxBodyBytes: z.number().int().positive(),
  }),
  secretsFile: z.string().min(1),
});

const VisionAgentSecretsSchema = z.object({
  openaiApiKey: z.string().min(1),
});

export type VisionAgentConfig = z.infer<typeof VisionAgentConfigSchema> & {
  secretsFilePath: string;
};

export type VisionAgentSecrets = z.infer<typeof VisionAgentSecretsSchema>;

export function loadVisionAgentConfig(): VisionAgentConfig {
  const explorer = cosmiconfigSync('vision-agent', {
    searchPlaces: ['vision-agent.config.local.json', 'vision-agent.config.json'],
    stopDir: packageRoot,
  });

  const result = explorer.search(packageRoot);

  if (!result || result.isEmpty) {
    throw new Error(
      '[vision-agent] configuration file not found. Expected one of: vision-agent.config.local.json or vision-agent.config.json',
    );
  }

  const parsed = VisionAgentConfigSchema.safeParse(result.config);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`[vision-agent] invalid config in ${result.filepath}: ${details}`);
  }

  const secretsFilePath = path.isAbsolute(parsed.data.secretsFile)
    ? parsed.data.secretsFile
    : path.resolve(packageRoot, parsed.data.secretsFile);

  return {
    ...parsed.data,
    secretsFilePath,
  };
}

export function loadVisionAgentSecrets(secretsFilePath: string): VisionAgentSecrets {
  let raw: string;

  try {
    raw = readFileSync(secretsFilePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[vision-agent] failed to read secrets file ${secretsFilePath}: ${message}`);
  }

  let json: unknown;

  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`[vision-agent] secrets file is not valid JSON: ${secretsFilePath}`);
  }

  const parsed = VisionAgentSecretsSchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`[vision-agent] invalid secrets in ${secretsFilePath}: ${details}`);
  }

  return parsed.data;
}
