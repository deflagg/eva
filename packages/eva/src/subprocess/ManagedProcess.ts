import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { sleep, waitForHttpHealthy } from './health.js';

export interface ManagedProcessLine {
  service: string;
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface ManagedProcessOptions {
  name: string;
  cwd: string;
  command: string[];
  healthUrl: string;
  readyTimeoutMs: number;
  shutdownTimeoutMs: number;
  onLine?: (payload: ManagedProcessLine) => void;
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!isRunning(child)) {
      resolve();
      return;
    }

    const onExit = (): void => {
      child.off('exit', onExit);
      child.off('close', onExit);
      resolve();
    };

    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

function chunkToBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export class ManagedProcess {
  private child: ChildProcess | null = null;

  constructor(private readonly options: ManagedProcessOptions) {}

  start(): void {
    if (this.child && isRunning(this.child)) {
      throw new Error(`[${this.options.name}] process is already running`);
    }

    const [command, ...args] = this.options.command;
    if (!command) {
      throw new Error(`[${this.options.name}] command must include an executable`);
    }

    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child = child;

    this.bindStream(child.stdout, 'stdout');
    this.bindStream(child.stderr, 'stderr');

    child.on('error', (error) => {
      this.options.onLine?.({
        service: this.options.name,
        stream: 'stderr',
        line: `process error: ${error.message}`,
      });
    });

    child.on('exit', (code, signal) => {
      this.options.onLine?.({
        service: this.options.name,
        stream: 'stderr',
        line: `exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`,
      });
    });
  }

  async waitForHealthy(): Promise<void> {
    if (!this.child || !isRunning(this.child)) {
      throw new Error(`[${this.options.name}] process is not running`);
    }

    await waitForHttpHealthy({
      name: this.options.name,
      healthUrl: this.options.healthUrl,
      timeoutMs: this.options.readyTimeoutMs,
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    if (!isRunning(child)) {
      this.child = null;
      return;
    }

    this.sendSignal(child, 'SIGTERM');
    await Promise.race([waitForExit(child), sleep(this.options.shutdownTimeoutMs)]);

    if (isRunning(child)) {
      this.sendSignal(child, 'SIGKILL');
      await Promise.race([waitForExit(child), sleep(1_000)]);
    }

    if (isRunning(child)) {
      this.options.onLine?.({
        service: this.options.name,
        stream: 'stderr',
        line: 'process did not exit after SIGKILL timeout',
      });
    }

    this.child = null;
  }

  forceKill(): void {
    const child = this.child;
    if (!child) {
      return;
    }

    if (!isRunning(child)) {
      this.child = null;
      return;
    }

    this.sendSignal(child, 'SIGKILL');
    this.child = null;
  }

  private bindStream(stream: NodeJS.ReadableStream | null | undefined, streamName: 'stdout' | 'stderr'): void {
    if (!stream) {
      return;
    }

    const decoder = new StringDecoder('utf8');
    let remainder = '';

    const emitLine = (line: string): void => {
      this.options.onLine?.({
        service: this.options.name,
        stream: streamName,
        line,
      });
    };

    stream.on('data', (chunk: Buffer | string) => {
      const text = remainder + decoder.write(chunkToBuffer(chunk));
      const parts = text.split(/\r?\n/);
      remainder = parts.pop() ?? '';

      for (const part of parts) {
        emitLine(part);
      }
    });

    stream.on('end', () => {
      const tail = decoder.end();
      const final = remainder + tail;
      remainder = '';

      if (final.length > 0) {
        emitLine(final);
      }
    });
  }

  private sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;

    if (pid && process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall through to direct child kill.
      }
    }

    try {
      child.kill(signal);
    } catch {
      // Best effort.
    }
  }
}
