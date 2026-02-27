#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cosmiconfigSync } from 'cosmiconfig';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_MEMORY_SUFFIX = path.join('packages', 'eva', 'memory');

function resolveRelativeToConfig(rawPath, configFilePath) {
  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }

  return path.resolve(path.dirname(configFilePath), rawPath);
}

function getTailPath(inputPath, segmentCount) {
  const parts = path.resolve(inputPath).split(path.sep).filter(Boolean);
  return parts.slice(-segmentCount).join(path.sep);
}

function assertFileExists(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`[mem-reset] required file missing: ${filePath}`);
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`[mem-reset] expected file but found something else: ${filePath}`);
  }
}

function assertSafeMemoryDir(memoryDir) {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const expectedTail = REQUIRED_MEMORY_SUFFIX;
  const actualTail = getTailPath(resolvedMemoryDir, 3);

  if (actualTail !== expectedTail) {
    throw new Error(
      `[mem-reset] refusing to run: resolved memory dir must end with "${expectedTail}". Got: ${resolvedMemoryDir}`,
    );
  }

  assertFileExists(path.join(resolvedMemoryDir, 'persona.md'));
  assertFileExists(path.join(resolvedMemoryDir, 'experience_tags.json'));

  return resolvedMemoryDir;
}

function loadMemoryDirFromConfig() {
  const explorer = cosmiconfigSync('agent', {
    searchPlaces: ['agent.config.local.json', 'agent.config.json'],
    stopDir: packageRoot,
  });

  const result = explorer.search(packageRoot);
  if (!result || result.isEmpty) {
    throw new Error(
      '[mem-reset] agent config not found. Expected one of: agent.config.local.json or agent.config.json',
    );
  }

  const memoryDirRaw = result.config?.memory?.dir;
  if (typeof memoryDirRaw !== 'string' || memoryDirRaw.trim() === '') {
    throw new Error(`[mem-reset] invalid memory.dir in ${result.filepath}`);
  }

  const resolvedMemoryDir = resolveRelativeToConfig(memoryDirRaw, result.filepath);
  const safeMemoryDir = assertSafeMemoryDir(resolvedMemoryDir);

  return {
    configFilePath: result.filepath,
    memoryDir: safeMemoryDir,
  };
}

export function resolveMemoryPathsOrThrow() {
  const { configFilePath, memoryDir } = loadMemoryDirFromConfig();

  return {
    configFilePath,
    memoryDir,
    workingLogPath: path.join(memoryDir, 'working_memory.log'),
    shortTermDbPath: path.join(memoryDir, 'short_term_memory.db'),
    cacheDir: path.join(memoryDir, 'cache'),
    toneCachePath: path.join(memoryDir, 'cache', 'personality_tone.json'),
    longTermMemoryDbDir: path.join(memoryDir, 'long_term_memory_db'),
    workingMemoryAssetsDir: path.join(memoryDir, 'working_memory_assets'),
  };
}

export function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

export function removePathIfExists(targetPath) {
  rmSync(targetPath, { recursive: true, force: true });
}

export function logResolvedPaths(label, paths) {
  console.log(`[mem-reset:${label}] config: ${paths.configFilePath}`);
  console.log(`[mem-reset:${label}] memory: ${paths.memoryDir}`);
}
