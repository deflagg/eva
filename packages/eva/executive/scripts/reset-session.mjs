#!/usr/bin/env node
import { ensureDir, logResolvedPaths, removePathIfExists, resolveMemoryPathsOrThrow } from './reset-common.mjs';

const paths = resolveMemoryPathsOrThrow();
logResolvedPaths('session', paths);

removePathIfExists(paths.workingLogPath);
removePathIfExists(paths.shortTermDbPath);
removePathIfExists(paths.cacheDir);
removePathIfExists(paths.workingMemoryAssetsDir);
ensureDir(paths.cacheDir);

console.log('[mem-reset:session] removed working_memory.log, short_term_memory.db, cache/**, and working_memory_assets/**');
console.log('[mem-reset:session] ensured cache/ exists');
