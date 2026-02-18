import { spawn, type ChildProcess } from 'node:child_process';

import { sleep, waitForHttpHealthy } from './health.js';

export interface ManagedProcessOptions {
  name: string;
  cwd: string;
  command: string[];
  healthUrl: string;
  readyTimeoutMs: number;
  shutdownTimeoutMs: number;
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

function chunkToText(chunk: Buffer | string): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
}

function emitPrefixedLog(prefix: string, chunk: Buffer | string, level: 'log' | 'error'): void {
  const text = chunkToText(chunk);
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    console[level](`[${prefix}] ${line}`);
  }
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

    child.stdout?.on('data', (chunk: Buffer | string) => {
      emitPrefixedLog(this.options.name, chunk, 'log');
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      emitPrefixedLog(this.options.name, chunk, 'error');
    });

    child.on('error', (error) => {
      console.error(`[${this.options.name}] process error: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      console.log(`[${this.options.name}] exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
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
      console.warn(`[${this.options.name}] process did not exit after SIGKILL timeout`);
    }

    this.child = null;
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
