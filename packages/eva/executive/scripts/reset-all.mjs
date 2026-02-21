#!/usr/bin/env node
import { ensureDir, logResolvedPaths, removePathIfExists, resolveMemoryPathsOrThrow } from './reset-common.mjs';

const paths = resolveMemoryPathsOrThrow();
logResolvedPaths('all', paths);

removePathIfExists(paths.workingLogPath);
removePathIfExists(paths.shortTermDbPath);
removePathIfExists(paths.cacheDir);
removePathIfExists(paths.longTermMemoryDbDir);
ensureDir(paths.cacheDir);
ensureDir(paths.longTermMemoryDbDir);

console.log('[mem-reset:all] removed working/session runtime files and long_term_memory_db/**');
console.log('[mem-reset:all] ensured cache/ and long_term_memory_db/ exist');
