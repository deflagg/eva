import { type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEvaConfig } from './config.js';
import { startServer } from './server.js';
import { ManagedProcess } from './subprocess/ManagedProcess.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

const SERVER_CLOSE_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_TIMEOUT_MS = 20_000;

function resolveRepoPath(pathValue: string): string {
  return path.isAbsolute(pathValue) ? pathValue : path.resolve(repoRoot, pathValue);
}

function closeServer(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const timeoutId = setTimeout(() => {
      try {
        server.closeAllConnections();
      } catch {
        // Best effort.
      }

      finish(new Error(`server close timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    server.close((error) => {
      clearTimeout(timeoutId);
      if (error) {
        finish(error);
        return;
      }

      finish();
    });
  });
}

async function main(): Promise<void> {
  const config = loadEvaConfig();

  let agent: ManagedProcess | null = null;
  let vision: ManagedProcess | null = null;
  let server: Server | null = null;

  let shutdownInFlight: Promise<void> | null = null;

  const shutdown = async (): Promise<void> => {
    if (shutdownInFlight) {
      return shutdownInFlight;
    }

    shutdownInFlight = (async () => {
      console.log('[eva] shutting down...');

      if (server) {
        try {
          await closeServer(server, SERVER_CLOSE_TIMEOUT_MS);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[eva] failed to close server: ${message}`);
        } finally {
          server = null;
        }
      }

      if (vision) {
        console.log('[eva] stopping vision...');
        try {
          await vision.stop();
        } finally {
          vision = null;
        }
      }

      if (agent) {
        console.log('[eva] stopping agent...');
        try {
          await agent.stop();
        } finally {
          agent = null;
        }
      }
    })();

    return shutdownInFlight;
  };

  let isShuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const forceTerminate = (reason: string, exitCode: number): never => {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }

    console.error(`[eva] ${reason}`);

    if (server) {
      try {
        server.closeAllConnections();
      } catch {
        // Best effort.
      }

      try {
        server.close();
      } catch {
        // Best effort.
      }

      server = null;
    }

    if (vision) {
      console.warn('[eva] force-killing vision...');
      vision.forceKill();
      vision = null;
    }

    if (agent) {
      console.warn('[eva] force-killing agent...');
      agent.forceKill();
      agent = null;
    }

    process.exit(exitCode);
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      forceTerminate(`received ${signal} during shutdown; forcing exit`, 130);
      return;
    }

    isShuttingDown = true;

    forceExitTimer = setTimeout(() => {
      forceTerminate(`graceful shutdown timed out after ${SHUTDOWN_GRACE_TIMEOUT_MS}ms; forcing exit`, 1);
    }, SHUTDOWN_GRACE_TIMEOUT_MS);

    void shutdown()
      .then(() => {
        if (forceExitTimer) {
          clearTimeout(forceExitTimer);
          forceExitTimer = null;
        }

        process.exit(0);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        forceTerminate(`shutdown failed after ${signal}: ${message}`, 1);
      });
  };

  process.on('SIGINT', () => {
    handleSignal('SIGINT');
  });

  process.on('SIGTERM', () => {
    handleSignal('SIGTERM');
  });

  process.on('SIGHUP', () => {
    handleSignal('SIGHUP');
  });

  try {
    if (config.subprocesses.enabled && config.subprocesses.agent.enabled) {
      const agentConfig = config.subprocesses.agent;
      const agentCwd = resolveRepoPath(agentConfig.cwd);

      console.log(`[eva] starting agent subprocess: ${agentConfig.command.join(' ')} (cwd=${agentCwd})`);

      agent = new ManagedProcess({
        name: 'agent',
        cwd: agentCwd,
        command: agentConfig.command,
        healthUrl: agentConfig.healthUrl,
        readyTimeoutMs: agentConfig.readyTimeoutMs,
        shutdownTimeoutMs: agentConfig.shutdownTimeoutMs,
      });

      agent.start();

      console.log(`[eva] waiting for agent health at ${agentConfig.healthUrl}...`);
      await agent.waitForHealthy();
      console.log(`[eva] agent healthy at ${agentConfig.healthUrl}`);
    }

    if (config.subprocesses.enabled && config.subprocesses.vision.enabled) {
      const visionConfig = config.subprocesses.vision;
      const visionCwd = resolveRepoPath(visionConfig.cwd);

      console.log(`[eva] starting vision subprocess: ${visionConfig.command.join(' ')} (cwd=${visionCwd})`);

      vision = new ManagedProcess({
        name: 'vision',
        cwd: visionCwd,
        command: visionConfig.command,
        healthUrl: visionConfig.healthUrl,
        readyTimeoutMs: visionConfig.readyTimeoutMs,
        shutdownTimeoutMs: visionConfig.shutdownTimeoutMs,
      });

      vision.start();

      console.log(`[eva] waiting for vision health at ${visionConfig.healthUrl}...`);
      await vision.waitForHealthy();
      console.log(`[eva] vision healthy at ${visionConfig.healthUrl}`);
    }

    server = startServer({
      port: config.server.port,
      eyePath: config.server.eyePath,
      visionWsUrl: config.vision.wsUrl,
      stream: config.stream,
      caption: config.caption,
      motionGate: config.motionGate,
      insightRelay: config.insightRelay,
      agent: config.agent,
      text: config.text,
      speech: config.speech,
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void main().catch((error) => {
  if (error instanceof Error) {
    console.error(`[eva] fatal startup error: ${error.message}`);
  } else {
    console.error(`[eva] fatal startup error: ${String(error)}`);
  }

  process.exit(1);
});
