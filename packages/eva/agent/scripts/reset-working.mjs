#!/usr/bin/env node
import { ensureDir, logResolvedPaths, removePathIfExists, resolveMemoryPathsOrThrow } from './reset-common.mjs';

const paths = resolveMemoryPathsOrThrow();
logResolvedPaths('working', paths);

removePathIfExists(paths.workingLogPath);
removePathIfExists(paths.toneCachePath);
ensureDir(paths.cacheDir);

console.log('[mem-reset:working] removed working_memory.log and cache/personality_tone.json');
console.log('[mem-reset:working] ensured cache/ exists');
