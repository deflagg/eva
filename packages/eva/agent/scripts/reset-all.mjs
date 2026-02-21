#!/usr/bin/env node
import { ensureDir, logResolvedPaths, removePathIfExists, resolveMemoryPathsOrThrow } from './reset-common.mjs';

const paths = resolveMemoryPathsOrThrow();
logResolvedPaths('all', paths);

removePathIfExists(paths.workingLogPath);
removePathIfExists(paths.shortTermDbPath);
removePathIfExists(paths.cacheDir);
removePathIfExists(paths.vectorDbDir);
ensureDir(paths.cacheDir);
ensureDir(paths.vectorDbDir);

console.log('[mem-reset:all] removed working/session runtime files and vector_db/**');
console.log('[mem-reset:all] ensured cache/ and vector_db/ exist');
