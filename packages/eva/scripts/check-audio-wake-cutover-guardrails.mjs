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

  const rootReadmePath = path.resolve(repoRoot, 'README.md');
  const runbookPath = path.resolve(repoRoot, 'docs', 'audio-transcript-wake-runbook.md');
  const audioRequirementsPath = path.resolve(repoRoot, 'packages', 'eva', 'audio', 'requirements.txt');
  const audioSettingsPath = path.resolve(repoRoot, 'packages', 'eva', 'audio', 'settings.yaml');
  const audioConfigPath = path.resolve(repoRoot, 'packages', 'eva', 'audio', 'app', 'config.py');
  const audioWakePath = path.resolve(repoRoot, 'packages', 'eva', 'audio', 'app', 'wake.py');
  const audioMainPath = path.resolve(repoRoot, 'packages', 'eva', 'audio', 'app', 'main.py');

  assert(fs.existsSync(runbookPath), 'Missing runbook: docs/audio-transcript-wake-runbook.md');

  const rootReadme = readText(rootReadmePath);
  const runbook = readText(runbookPath);
  const requirements = readText(audioRequirementsPath);
  const settings = readText(audioSettingsPath);
  const config = readText(audioConfigPath);
  const wake = readText(audioWakePath);
  const main = readText(audioMainPath);

  assertNotContains(requirements, 'pvporcupine', 'audio requirements should not depend on Porcupine');
  assertContains(requirements, 'requests>=', 'audio requirements include explicit requests runtime dependency');

  assertContains(settings, 'phrases:', 'transcript wake phrase list exists');
  assertContains(settings, 'match_mode:', 'transcript wake match mode exists');
  assertContains(settings, 'min_confidence:', 'transcript wake confidence setting exists');
  assertNotContains(settings, 'wake.provider', 'legacy wake provider key removed from settings');
  assertNotContains(settings, 'keyword_path', 'legacy wake keyword path removed from settings');
  assertNotContains(settings, 'access_key_env', 'legacy wake access key env removed from settings');
  assertNotContains(settings, 'access_key:', 'legacy wake access key removed from settings');

  assertContains(config, 'def _reject_legacy_wake_keys', 'legacy wake key rejection guard exists');
  assertContains(config, '"wake.provider"', 'legacy wake.provider rejection exists');

  assertNotContains(wake, 'pvporcupine', 'wake runtime no longer imports pvporcupine');
  assertNotContains(wake, 'PorcupineWakeDetector', 'wake runtime no longer defines Porcupine detector');

  assertNotContains(main, 'PV_ACCESS_KEY', 'audio runtime should not mention PV access key');
  assertNotContains(main, 'porcupine', 'audio runtime should not mention Porcupine');
  assertContains(main, 'wake matcher unavailable', 'audio startup log uses wake matcher wording');

  assertContains(runbook, 'Presence TRUE + no wake phrase', 'runbook presence bypass checklist step');
  assertContains(runbook, 'Presence FALSE + wake phrase', 'runbook wake phrase checklist step');
  assertContains(runbook, 'Presence FALSE + no wake phrase', 'runbook rejection checklist step');
  assertNotContains(runbook, 'PV_ACCESS_KEY', 'runbook should not mention old Porcupine credentials');

  assertContains(
    rootReadme,
    'docs/audio-transcript-wake-runbook.md',
    'root README links transcript wake runbook',
  );
  assertNotContains(rootReadme, 'PV_ACCESS_KEY', 'root README should not mention old Porcupine credentials');

  console.log('PASS: audio transcript wake cutover guardrails');
}

main();
