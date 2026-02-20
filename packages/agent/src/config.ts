import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosmiconfigSync } from 'cosmiconfig';
import { z } from 'zod';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const InsightConfigSchema = z.object({
  maxBodyBytes: z.number().int().positive().default(8_388_608),
});

const AgentConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65_535),
  }),
  memory: z.object({
    dir: z.string().trim().min(1),
  }),
  insight: InsightConfigSchema.default({
    maxBodyBytes: 8_388_608,
  }),
  secretsFile: z.string().trim().min(1),
});

type AgentConfigData = z.infer<typeof AgentConfigSchema>;

export type AgentConfig = AgentConfigData & {
  configFilePath: string;
  memoryDirPath: string;
  secretsFilePath: string;
};

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
