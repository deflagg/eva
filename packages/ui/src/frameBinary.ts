import type { FrameBinaryMeta } from './types';

const HEADER_LENGTH_BYTES = 4;

const textEncoder = new TextEncoder();

export interface BinaryFrameEnvelopeInput {
  meta: FrameBinaryMeta;
  imageBytes: Uint8Array;
}

export function encodeBinaryFrameEnvelope(input: BinaryFrameEnvelopeInput): ArrayBuffer {
  const { meta, imageBytes } = input;

  if (meta.image_bytes !== imageBytes.byteLength) {
    throw new Error(`Binary frame metadata/image length mismatch (meta=${meta.image_bytes}, bytes=${imageBytes.byteLength}).`);
  }

  const metadataBytes = textEncoder.encode(JSON.stringify(meta));
  const output = new Uint8Array(HEADER_LENGTH_BYTES + metadataBytes.byteLength + imageBytes.byteLength);

  const view = new DataView(output.buffer);
  view.setUint32(0, metadataBytes.byteLength, false);

  output.set(metadataBytes, HEADER_LENGTH_BYTES);
  output.set(imageBytes, HEADER_LENGTH_BYTES + metadataBytes.byteLength);

  return output.buffer;
}
