import sharp from 'sharp';

const DEFAULT_THUMB_W = 64;
const DEFAULT_THUMB_H = 64;
const DEFAULT_MIN_PERSIST_FRAMES = 1;

export interface MotionGateConfig {
  thumbW?: number;
  thumbH?: number;
  triggerThreshold: number;
  resetThreshold: number;
  cooldownMs: number;
  minPersistFrames?: number;
}

interface ResolvedMotionGateConfig {
  thumbW: number;
  thumbH: number;
  triggerThreshold: number;
  resetThreshold: number;
  cooldownMs: number;
  minPersistFrames: number;
}

export interface MotionGateProcessInput {
  tsMs: number;
  jpegBytes: Buffer;
}

export interface MotionGateProcessResult {
  mad: number;
  triggered: boolean;
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`motionGate.${name} must be a finite, non-negative number.`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`motionGate.${name} must be a positive integer.`);
  }
}

function normalizeConfig(config: MotionGateConfig): ResolvedMotionGateConfig {
  const thumbW = config.thumbW ?? DEFAULT_THUMB_W;
  const thumbH = config.thumbH ?? DEFAULT_THUMB_H;
  const minPersistFrames = config.minPersistFrames ?? DEFAULT_MIN_PERSIST_FRAMES;

  assertPositiveInteger('thumbW', thumbW);
  assertPositiveInteger('thumbH', thumbH);
  assertFiniteNonNegative('triggerThreshold', config.triggerThreshold);
  assertFiniteNonNegative('resetThreshold', config.resetThreshold);
  assertFiniteNonNegative('cooldownMs', config.cooldownMs);
  assertPositiveInteger('minPersistFrames', minPersistFrames);

  if (config.resetThreshold > config.triggerThreshold) {
    throw new Error('motionGate.resetThreshold must be <= motionGate.triggerThreshold.');
  }

  return {
    thumbW,
    thumbH,
    triggerThreshold: config.triggerThreshold,
    resetThreshold: config.resetThreshold,
    cooldownMs: config.cooldownMs,
    minPersistFrames,
  };
}

async function decodeGrayscaleThumbnail(
  jpegBytes: Buffer,
  thumbW: number,
  thumbH: number,
): Promise<Buffer> {
  const { data, info } = await sharp(jpegBytes)
    .removeAlpha()
    .resize(thumbW, thumbH, {
      fit: 'fill',
      kernel: sharp.kernel.nearest,
      fastShrinkOnLoad: true,
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== thumbW || info.height !== thumbH) {
    throw new Error('Failed to produce expected motion thumbnail dimensions.');
  }

  if (info.channels === 1) {
    return data;
  }

  const pixelCount = info.width * info.height;
  const firstChannel = Buffer.allocUnsafe(pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    firstChannel[i] = data[i * info.channels];
  }

  return firstChannel;
}

function computeMad(previous: Buffer, current: Buffer): number {
  if (previous.length !== current.length) {
    throw new Error('Cannot compute MAD across buffers of different sizes.');
  }

  if (current.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < current.length; i += 1) {
    sum += Math.abs(current[i] - previous[i]);
  }

  return sum / current.length;
}

export class MotionGate {
  private readonly config: ResolvedMotionGateConfig;

  private previousThumbnail: Buffer | null = null;
  private motionEpisodeActive = false;
  private consecutiveAboveTrigger = 0;
  private nextAllowedTriggerTsMs = 0;

  constructor(config: MotionGateConfig) {
    this.config = normalizeConfig(config);
  }

  public async process(input: MotionGateProcessInput): Promise<MotionGateProcessResult> {
    if (!Number.isFinite(input.tsMs) || input.tsMs < 0) {
      throw new Error('MotionGate process input tsMs must be a finite non-negative number.');
    }

    if (input.jpegBytes.byteLength === 0) {
      throw new Error('MotionGate process input jpegBytes must be non-empty.');
    }

    const thumbnail = await decodeGrayscaleThumbnail(
      input.jpegBytes,
      this.config.thumbW,
      this.config.thumbH,
    );

    if (this.previousThumbnail === null) {
      this.previousThumbnail = thumbnail;
      this.consecutiveAboveTrigger = 0;
      return {
        mad: 0,
        triggered: false,
      };
    }

    const mad = computeMad(this.previousThumbnail, thumbnail);
    this.previousThumbnail = thumbnail;

    if (this.motionEpisodeActive) {
      if (mad <= this.config.resetThreshold) {
        this.motionEpisodeActive = false;
        this.consecutiveAboveTrigger = 0;
      }

      return {
        mad,
        triggered: false,
      };
    }

    if (mad >= this.config.triggerThreshold) {
      this.consecutiveAboveTrigger += 1;
    } else {
      this.consecutiveAboveTrigger = 0;
    }

    if (this.consecutiveAboveTrigger < this.config.minPersistFrames) {
      return {
        mad,
        triggered: false,
      };
    }

    this.motionEpisodeActive = true;
    this.consecutiveAboveTrigger = 0;

    if (input.tsMs < this.nextAllowedTriggerTsMs) {
      return {
        mad,
        triggered: false,
      };
    }

    this.nextAllowedTriggerTsMs = input.tsMs + this.config.cooldownMs;

    return {
      mad,
      triggered: true,
    };
  }
}
