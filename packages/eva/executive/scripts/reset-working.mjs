#!/usr/bin/env node
import { ensureDir, logResolvedPaths, removePathIfExists, resolveMemoryPathsOrThrow } from './reset-common.mjs';

const paths = resolveMemoryPathsOrThrow();
logResolvedPaths('working', paths);

removePathIfExists(paths.workingLogPath);
removePathIfExists(paths.toneCachePath);
removePathIfExists(paths.workingMemoryAssetsDir);
ensureDir(paths.cacheDir);

console.log('[mem-reset:working] removed working_memory.log, cache/personality_tone.json, and working_memory_assets/**');
console.log('[mem-reset:working] ensured cache/ exists');
