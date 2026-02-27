import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function readUtf8(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function assertIncludes(content: string, pattern: RegExp, message: string): void {
  assert(pattern.test(content), message);
}

function run(): void {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(scriptsDir, '..');

  const serverPath = path.resolve(packageRoot, 'src/server.ts');
  const shortTermContextPath = path.resolve(packageRoot, 'src/memcontext/respond_short_term_context.ts');
  const promptPath = path.resolve(packageRoot, 'src/prompts/respond.ts');
  const readmePath = path.resolve(packageRoot, 'README.md');

  assert(existsSync(serverPath), 'Missing expected server surface: src/server.ts');
  assert(
    existsSync(shortTermContextPath),
    'Missing expected short-term context surface: src/memcontext/respond_short_term_context.ts',
  );
  assert(existsSync(promptPath), 'Missing expected prompt surface: src/prompts/respond.ts');
  assert(existsSync(readmePath), 'Missing expected docs surface: README.md');

  const server = readUtf8(serverPath);
  const shortTermContext = readUtf8(shortTermContextPath);
  const prompt = readUtf8(promptPath);
  const readme = readUtf8(readmePath);

  // /respond path must import and call the short-term retrieval helper.
  assertIncludes(
    server,
    /from '\.\/memcontext\/respond_short_term_context\.js'/,
    'Server must import short-term respond context helper module.',
  );
  assertIncludes(
    server,
    /buildRespondShortTermContext\(\{[\s\S]*?shortTermMemoryDbPath:\s*memorySources\.shortTermMemoryDbPath/,
    'Respond path must build short-term context from short-term memory DB path.',
  );

  // Context assembly must include short-term section plus trace/debug observability.
  assertIncludes(
    server,
    /Short-term memory context \(recent \+ compacted; reference only\):/,
    'Combined memory context must include explicit short-term memory section header.',
  );
  assertIncludes(
    server,
    /memory_context_debug:\s*memoryContextDebug/,
    'Respond request trace must include memory_context_debug payload.',
  );
  assertIncludes(
    server,
    /candidate_rows:\s*shortTermContext\?\.candidateShortTermRowsCount\s*\?\?\s*0/,
    'Trace debug must include short-term candidate row count.',
  );
  assertIncludes(
    server,
    /selected_rows:\s*shortTermContext\?\.selectedShortTermRowsCount\s*\?\?\s*0/,
    'Trace debug must include short-term selected row count.',
  );
  assertIncludes(
    server,
    /selection_mode:\s*shortTermContext\?\.shortTermSelectionMode\s*\?\?\s*'none'/,
    'Trace debug must include short-term selection mode.',
  );
  assertIncludes(
    server,
    /respond retrieval: short_term candidate_rows=\$\{memoryContextDebug\.short_term\.candidate_rows\}/,
    'Runtime logs must include short-term retrieval selection summary.',
  );

  // Short-term helper must read short_term_summaries rows (not just in-memory placeholders).
  assertIncludes(
    shortTermContext,
    /FROM short_term_summaries/,
    'Short-term helper must query short_term_summaries table.',
  );
  assertIncludes(
    shortTermContext,
    /Recent short-term summaries \(tag-filtered\):/,
    'Short-term helper output must include tag-filtered short-term summary section.',
  );

  // Prompt/docs surfaces must document combined retrieval flow.
  assertIncludes(
    prompt,
    /Memory context \(short-term \+ long-term; reference only\):/,
    'Respond system prompt must describe combined short-term + long-term memory context.',
  );
  assertIncludes(readme, /Retrieval pipeline \(`\/respond`\)/, 'README must document /respond retrieval pipeline.');
  assertIncludes(readme, /short_term_summaries/, 'README must mention short_term_summaries in retrieval flow.');
  assertIncludes(
    readme,
    /memory_context_debug\.short_term\./,
    'README runbook must document memory_context_debug.short_term verification fields.',
  );

  console.log('PASS: respond short-term retrieval integration regression checks');
}

run();
