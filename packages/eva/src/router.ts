import type WebSocket from 'ws';

export interface FrameRouterOptions {
  ttlMs?: number;
  onExpire?: (frameId: string, client: WebSocket) => void;
}

interface RouteEntry {
  client: WebSocket;
  timeout: NodeJS.Timeout;
}

export class FrameRouter {
  private readonly ttlMs: number;

  private readonly onExpire?: (frameId: string, client: WebSocket) => void;

  private readonly routes = new Map<string, RouteEntry>();

  constructor(options: FrameRouterOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5_000;
    this.onExpire = options.onExpire;
  }

  public set(frameId: string, client: WebSocket): void {
    this.delete(frameId);

    const timeout = setTimeout(() => {
      const entry = this.routes.get(frameId);
      if (!entry) {
        return;
      }

      this.routes.delete(frameId);
      this.onExpire?.(frameId, entry.client);
    }, this.ttlMs);

    timeout.unref?.();

    this.routes.set(frameId, {
      client,
      timeout,
    });
  }

  public take(frameId: string): WebSocket | null {
    const entry = this.routes.get(frameId);
    if (!entry) {
      return null;
    }

    clearTimeout(entry.timeout);
    this.routes.delete(frameId);
    return entry.client;
  }

  public delete(frameId: string): boolean {
    const entry = this.routes.get(frameId);
    if (!entry) {
      return false;
    }

    clearTimeout(entry.timeout);
    this.routes.delete(frameId);
    return true;
  }

  public deleteByClient(client: WebSocket): number {
    let removed = 0;

    for (const [frameId, entry] of this.routes.entries()) {
      if (entry.client !== client) {
        continue;
      }

      clearTimeout(entry.timeout);
      this.routes.delete(frameId);
      removed += 1;
    }

    return removed;
  }

  public clear(): void {
    for (const entry of this.routes.values()) {
      clearTimeout(entry.timeout);
    }

    this.routes.clear();
  }

  public size(): number {
    return this.routes.size;
  }
}
