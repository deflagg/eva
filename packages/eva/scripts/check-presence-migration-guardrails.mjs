import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function assertContains(source, needle, label) {
  assert(source.includes(needle), `Missing required pattern (${label}): ${needle}`);
}

function assertNotContains(source, needle, label) {
  assert(!source.includes(needle), `Unexpected legacy pattern (${label}): ${needle}`);
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..', '..');

  const protocolSchemaPath = path.resolve(repoRoot, 'packages', 'protocol', 'schema.json');
  const executiveServerPath = path.resolve(repoRoot, 'packages', 'eva', 'executive', 'src', 'server.ts');
  const visionMainPath = path.resolve(repoRoot, 'packages', 'eva', 'vision', 'app', 'main.py');
  const visionConfigPath = path.resolve(repoRoot, 'packages', 'eva', 'vision', 'app', 'config.py');
  const visionRequirementsPath = path.resolve(repoRoot, 'packages', 'eva', 'vision', 'requirements.txt');
  const visionPresenceModulePath = path.resolve(repoRoot, 'packages', 'eva', 'vision', 'app', 'presence.py');

  const schemaRaw = readText(protocolSchemaPath);
  const schema = JSON.parse(schemaRaw);

  const insightPresence = schema?.$defs?.insight_presence;
  assert(insightPresence && typeof insightPresence === 'object', 'protocol schema missing $defs.insight_presence');
  assert(Array.isArray(insightPresence.required), 'protocol insight_presence.required must be an array');
  assert(insightPresence.required.includes('preson_present'), 'protocol insight_presence missing preson_present requirement');
  assert(
    insightPresence.required.includes('person_facing_me'),
    'protocol insight_presence missing person_facing_me requirement',
  );

  const insightSummary = schema?.$defs?.insight_summary;
  const summaryPresence = insightSummary?.properties?.presence;
  assert(summaryPresence && typeof summaryPresence === 'object', 'protocol schema missing insight_summary.presence definition');

  const executiveServerSource = readText(executiveServerPath);
  assertContains(
    executiveServerSource,
    "if (method === 'GET' && requestUrl.pathname === '/presence')",
    'presence endpoint route',
  );
  assertContains(executiveServerSource, 'latestPresenceFromInsights', 'insight presence cache');
  assertContains(
    executiveServerSource,
    '(insight-backed presence)',
    'presence startup log source-of-truth',
  );
  assertNotContains(executiveServerSource, 'presence_update', 'legacy presence_update dependency in Executive');

  const visionRequirementsSource = readText(visionRequirementsPath);
  assertNotContains(visionRequirementsSource, 'opencv-python-headless', 'OpenCV dependency removed from Vision');

  assert(!fs.existsSync(visionPresenceModulePath), 'Vision presence module should not exist: app/presence.py');

  const visionMainSource = readText(visionMainPath);
  assertNotContains(visionMainSource, 'presence_update', 'legacy Vision presence telemetry');
  assertNotContains(visionMainSource, 'cfg.presence', 'legacy Vision presence config wiring');
  assertNotContains(visionMainSource, 'load_presence_detector', 'legacy Vision detector loader usage');

  const visionConfigSource = readText(visionConfigPath);
  assertNotContains(visionConfigSource, 'PresenceConfig', 'legacy Vision presence config type');
  assertNotContains(visionConfigSource, 'presence.', 'legacy Vision presence config keys');

  console.log('PASS: presence migration guardrails');
}

main();
