import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assertContains(source: string, needle: string, label: string): void {
  if (!source.includes(needle)) {
    throw new Error(`Missing required pattern (${label}): ${needle}`);
  }
}

function assertNotContains(source: string, needle: string, label: string): void {
  if (source.includes(needle)) {
    throw new Error(`Unexpected legacy pattern (${label}): ${needle}`);
  }
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const mainTsxPath = path.resolve(scriptDir, '..', 'src', 'main.tsx');
  const source = fs.readFileSync(mainTsxPath, 'utf8');

  assertContains(
    source,
    'frameReceivedMessage && inFlight && frameReceivedMessage.frame_id === inFlight.frameId',
    'receipt-ack-gate',
  );
  assertContains(source, 'Frame receipt acknowledged in', 'receipt-latency-log');

  assertNotContains(
    source,
    'frameEventsMessage && inFlight && frameEventsMessage.frame_id === inFlight.frameId',
    'frame-events-ack-gate',
  );

  console.log('PASS: frame receipt ACK regression checks');
}

main();
