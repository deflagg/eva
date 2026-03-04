import type { AudioBinaryMeta } from './types';

const HEADER_LENGTH_BYTES = 4;

const textEncoder = new TextEncoder();

export interface BinaryAudioEnvelopeInput {
  meta: AudioBinaryMeta;
  audioBytes: Uint8Array;
}

export function encodeBinaryAudioEnvelope(input: BinaryAudioEnvelopeInput): ArrayBuffer {
  const { meta, audioBytes } = input;

  if (meta.audio_bytes !== audioBytes.byteLength) {
    throw new Error(
      `Binary audio metadata/payload length mismatch (meta=${meta.audio_bytes}, bytes=${audioBytes.byteLength}).`,
    );
  }

  const metadataBytes = textEncoder.encode(JSON.stringify(meta));
  const output = new Uint8Array(HEADER_LENGTH_BYTES + metadataBytes.byteLength + audioBytes.byteLength);

  const view = new DataView(output.buffer);
  view.setUint32(0, metadataBytes.byteLength, false);

  output.set(metadataBytes, HEADER_LENGTH_BYTES);
  output.set(audioBytes, HEADER_LENGTH_BYTES + metadataBytes.byteLength);

  return output.buffer;
}
