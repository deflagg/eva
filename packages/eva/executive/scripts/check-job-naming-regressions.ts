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

function assertNotIncludes(content: string, pattern: RegExp, message: string): void {
  assert(!pattern.test(content), message);
}

function run(): void {
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(scriptsDir, '..');

  const configPath = path.resolve(packageRoot, 'src/config.ts');
  const serverPath = path.resolve(packageRoot, 'src/server.ts');
  const schedulerPath = path.resolve(packageRoot, 'src/jobs/scheduler.ts');
  const promptPath = path.resolve(packageRoot, 'src/prompts/working_memory_compaction.ts');
  const toolPath = path.resolve(packageRoot, 'src/tools/working_memory_compaction.ts');
  const readmePath = path.resolve(packageRoot, 'README.md');

  const deprecatedPromptShimPath = path.resolve(packageRoot, 'src/prompts/hourly_compaction.ts');
  const deprecatedToolShimPath = path.resolve(packageRoot, 'src/tools/hourly_compaction.ts');

  assert(existsSync(configPath), 'Missing expected config surface: src/config.ts');
  assert(existsSync(serverPath), 'Missing expected server surface: src/server.ts');
  assert(existsSync(schedulerPath), 'Missing expected scheduler surface: src/jobs/scheduler.ts');
  assert(existsSync(promptPath), 'Missing expected prompt surface: src/prompts/working_memory_compaction.ts');
  assert(existsSync(toolPath), 'Missing expected tool surface: src/tools/working_memory_compaction.ts');
  assert(existsSync(readmePath), 'Missing expected docs surface: README.md');

  assert(!existsSync(deprecatedPromptShimPath), 'Deprecated shim must be removed: src/prompts/hourly_compaction.ts');
  assert(!existsSync(deprecatedToolShimPath), 'Deprecated shim must be removed: src/tools/hourly_compaction.ts');

  const config = readUtf8(configPath);
  const server = readUtf8(serverPath);
  const scheduler = readUtf8(schedulerPath);
  const prompt = readUtf8(promptPath);
  const tool = readUtf8(toolPath);
  const readme = readUtf8(readmePath);

  // Config surface: canonical keys only.
  assertIncludes(config, /compaction:\s*CompactionJobConfigSchema/, 'Config must define jobs.compaction schema.');
  assertIncludes(config, /promotion:\s*PromotionJobConfigSchema/, 'Config must define jobs.promotion schema.');
  assertIncludes(config, /windowMs:\s*z[\s\S]*?\.default\(COMPACTION_WINDOW_MS_DEFAULT\)/, 'Config must define jobs.compaction.windowMs with default.');
  assertIncludes(config, /windowMs:\s*z\.number\(\)\.int\(\)\.nonnegative\(\)\.default\(COMPACTION_WINDOW_MS_DEFAULT\)/, 'Config windowMs validation must remain nonnegative + defaulted.');
  assertIncludes(config, /const JobsConfigSchema = z[\s\S]*?\.strict\(\);/, 'JobsConfigSchema must be strict.');
  assertNotIncludes(config, /jobs\.hourly|jobs\.daily|\bhourly\b|\bdaily\b/, 'Config must not use hourly/daily job vocabulary.');

  // Server surface: canonical API vocabulary and error codes.
  assertIncludes(
    server,
    /job:\s*z\.enum\(\['compaction',\s*'promotion'\]\)/,
    'RunJobRequestSchema must accept canonical job values only.',
  );
  assertIncludes(server, /COMPACTION_JOB_FAILED/, 'Server must use COMPACTION_JOB_FAILED error code.');
  assertIncludes(server, /PROMOTION_JOB_FAILED/, 'Server must use PROMOTION_JOB_FAILED error code.');
  assertIncludes(
    server,
    /canonical request values: compaction\|promotion/,
    'Server startup log must advertise canonical /jobs/run values.',
  );
  assertIncludes(
    server,
    /compactionWindowMs:\s*config\.jobs\.compaction\.windowMs/,
    'Server compaction path must use configured jobs.compaction.windowMs value.',
  );
  assertIncludes(
    server,
    /window_ms:\s*config\.jobs\.compaction\.windowMs/,
    'Health payload must expose jobs.compaction.window_ms from config.',
  );
  assertNotIncludes(
    server,
    /WORKING_MEMORY_WINDOW_MS/,
    'Server must not rely on hardcoded WORKING_MEMORY_WINDOW_MS constant for compaction split age.',
  );
  assertNotIncludes(
    server,
    /\bhourly\b|\bdaily\b|deprecated_alias_used|preferred_job|LegacyRunJobAlias|hourly_compaction/,
    'Server must not retain hourly/daily alias vocabulary or alias-response hints.',
  );

  // Scheduler surface: canonical job naming only.
  assertIncludes(scheduler, /type ScheduledJobName = 'compaction' \| 'promotion'/, 'Scheduler must use canonical job names.');
  assertNotIncludes(scheduler, /\bhourly\b|\bdaily\b/, 'Scheduler must not use hourly/daily naming.');

  // Prompt/tool surfaces: canonical compaction module names and tool contract.
  assertIncludes(prompt, /buildWorkingMemoryCompactionSystemPrompt/, 'Prompt surface must expose canonical compaction builders.');
  assertIncludes(prompt, /commit_working_memory_compaction/, 'Prompt must target canonical tool name.');
  assertNotIncludes(prompt, /hourly_compaction|\bhourly\b|\bdaily\b/, 'Prompt surface must not use hourly/daily naming.');

  assertIncludes(tool, /WORKING_MEMORY_COMPACTION_TOOL_NAME = 'commit_working_memory_compaction'/, 'Tool must expose canonical compaction tool name.');
  assertNotIncludes(tool, /HOURLY_|hourly_compaction|\bhourly\b|\bdaily\b/, 'Tool surface must not use hourly/daily naming.');

  // Docs surface: compaction window must remain documented.
  assertIncludes(readme, /jobs\.compaction\.windowMs/, 'README must document jobs.compaction.windowMs.');
  assertIncludes(readme, /jobs\.compaction\.window_ms/, 'README must document /health jobs.compaction.window_ms observability.');

  console.log('PASS: job naming + compaction window regression checks');
}

run();
