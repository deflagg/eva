import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SynthesizeInput } from './types.js';

type EdgeTTSInstance = {
  ttsPromise: (text: string, audioPath: string) => Promise<unknown>;
};

type EdgeTTSConstructor = new (options?: {
  voice?: string;
  outputFormat?: string;
  rate?: string;
}) => EdgeTTSInstance;

let edgeTTSConstructorPromise: Promise<EdgeTTSConstructor> | null = null;

function normalizeRate(rate: number | undefined): string {
  if (rate === undefined) {
    return 'default';
  }

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('speech rate must be a positive finite number');
  }

  const percentDelta = Math.round((rate - 1) * 100);

  if (percentDelta === 0) {
    return 'default';
  }

  return `${percentDelta > 0 ? '+' : ''}${percentDelta}%`;
}

async function loadEdgeTTSConstructor(): Promise<EdgeTTSConstructor> {
  if (!edgeTTSConstructorPromise) {
    edgeTTSConstructorPromise = import('node-edge-tts')
      .then((moduleExports) => {
        const maybeConstructor =
          (moduleExports as { EdgeTTS?: EdgeTTSConstructor }).EdgeTTS ??
          (moduleExports as { default?: { EdgeTTS?: EdgeTTSConstructor } }).default?.EdgeTTS;

        if (!maybeConstructor) {
          throw new Error('EdgeTTS export was not found in node-edge-tts module');
        }

        return maybeConstructor;
      })
      .catch((error) => {
        edgeTTSConstructorPromise = null;
        throw error;
      });
  }

  return edgeTTSConstructorPromise;
}

export async function synthesize({ text, voice, rate }: SynthesizeInput): Promise<Buffer> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('speech text must be a non-empty string');
  }

  if (typeof voice !== 'string' || voice.trim().length === 0) {
    throw new Error('speech voice must be a non-empty string');
  }

  const EdgeTTS = await loadEdgeTTSConstructor();
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'eva-edge-tts-'));
  const outputPath = path.join(tempDirectory, `${randomUUID()}.mp3`);

  try {
    const tts = new EdgeTTS({
      voice,
      rate: normalizeRate(rate),
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    });

    await tts.ttsPromise(text, outputPath);

    return await readFile(outputPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
