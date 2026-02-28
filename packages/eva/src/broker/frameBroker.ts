export interface FrameBrokerConfig {
  enabled: boolean;
  maxFrames: number;
  maxAgeMs: number;
  maxBytes: number;
}

export interface FrameBrokerEntry {
  frame_id: string;
  ts_ms: number;
  width: number;
  height: number;
  jpegBytes: Buffer;
  receivedAtMs: number;
}

export interface FrameBrokerPushInput {
  frame_id: string;
  ts_ms: number;
  width: number;
  height: number;
  jpegBytes: Buffer;
  receivedAtMs?: number;
}

export interface FrameBrokerPushResult {
  accepted: boolean;
  queueDepth: number;
  dropped: number;
}

export interface FrameBrokerStats {
  enabled: boolean;
  maxFrames: number;
  maxAgeMs: number;
  maxBytes: number;
  queueDepth: number;
  dropped: number;
  totalBytes: number;
}

export class FrameBroker {
  private readonly entries: FrameBrokerEntry[] = [];

  private totalBytes = 0;
  private droppedCount = 0;

  constructor(private readonly config: FrameBrokerConfig) {}

  public getByFrameId(frameId: string, nowMs: number = Date.now()): FrameBrokerEntry | null {
    if (!this.config.enabled) {
      return null;
    }

    this.evictExpired(nowMs);
    this.evictOverflow();

    for (const entry of this.entries) {
      if (entry.frame_id === frameId) {
        return entry;
      }
    }

    return null;
  }

  public getLatest(nowMs: number = Date.now()): FrameBrokerEntry | null {
    if (!this.config.enabled) {
      return null;
    }

    this.evictExpired(nowMs);
    this.evictOverflow();

    if (this.entries.length === 0) {
      return null;
    }

    return this.entries[this.entries.length - 1];
  }

  public getStats(nowMs: number = Date.now()): FrameBrokerStats {
    if (this.config.enabled) {
      this.evictExpired(nowMs);
      this.evictOverflow();
    }

    return {
      enabled: this.config.enabled,
      maxFrames: this.config.maxFrames,
      maxAgeMs: this.config.maxAgeMs,
      maxBytes: this.config.maxBytes,
      queueDepth: this.entries.length,
      dropped: this.droppedCount,
      totalBytes: this.totalBytes,
    };
  }

  public push(input: FrameBrokerPushInput): FrameBrokerPushResult {
    if (!this.config.enabled) {
      return {
        accepted: true,
        queueDepth: 0,
        dropped: this.droppedCount,
      };
    }

    const receivedAtMs = input.receivedAtMs ?? Date.now();
    this.evictExpired(receivedAtMs);
    this.evictOverflow();

    const frameBytes = input.jpegBytes.byteLength;

    if (this.config.maxFrames > 0 && this.entries.length >= this.config.maxFrames) {
      this.droppedCount += 1;
      return this.snapshot(false);
    }

    if (this.config.maxBytes > 0 && frameBytes > this.config.maxBytes) {
      this.droppedCount += 1;
      return this.snapshot(false);
    }

    if (this.config.maxBytes > 0 && this.totalBytes + frameBytes > this.config.maxBytes) {
      this.droppedCount += 1;
      return this.snapshot(false);
    }

    this.entries.push({
      frame_id: input.frame_id,
      ts_ms: input.ts_ms,
      width: input.width,
      height: input.height,
      jpegBytes: input.jpegBytes,
      receivedAtMs,
    });
    this.totalBytes += frameBytes;

    this.evictOverflow();

    return this.snapshot(true);
  }

  private snapshot(accepted: boolean): FrameBrokerPushResult {
    return {
      accepted,
      queueDepth: this.entries.length,
      dropped: this.droppedCount,
    };
  }

  private evictExpired(nowMs: number): void {
    if (this.config.maxAgeMs <= 0) {
      return;
    }

    while (this.entries.length > 0) {
      const oldest = this.entries[0];
      if (nowMs - oldest.receivedAtMs < this.config.maxAgeMs) {
        break;
      }

      this.removeOldest();
    }
  }

  private evictOverflow(): void {
    if (this.config.maxFrames > 0) {
      while (this.entries.length > this.config.maxFrames) {
        this.removeOldest();
      }
    }

    if (this.config.maxBytes > 0) {
      while (this.entries.length > 0 && this.totalBytes > this.config.maxBytes) {
        this.removeOldest();
      }
    }
  }

  private removeOldest(): void {
    const oldest = this.entries.shift();
    if (!oldest) {
      return;
    }

    this.totalBytes -= oldest.jpegBytes.byteLength;
    this.droppedCount += 1;
  }
}
