import { type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEvaConfig } from './config.js';
import { startServer } from './server.js';
import { ManagedProcess } from './subprocess/ManagedProcess.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');

function resolveRepoPath(pathValue: string): string {
  return path.isAbsolute(pathValue) ? pathValue : path.resolve(repoRoot, pathValue);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadEvaConfig();

  let visionAgent: ManagedProcess | null = null;
  let quickvision: ManagedProcess | null = null;
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
          await closeServer(server);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[eva] failed to close server: ${message}`);
        } finally {
          server = null;
        }
      }

      if (quickvision) {
        console.log('[eva] stopping quickvision...');
        try {
          await quickvision.stop();
        } finally {
          quickvision = null;
        }
      }

      if (visionAgent) {
        console.log('[eva] stopping vision-agent...');
        try {
          await visionAgent.stop();
        } finally {
          visionAgent = null;
        }
      }
    })();

    return shutdownInFlight;
  };

  let isShuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    void shutdown()
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[eva] shutdown failed after ${signal}: ${message}`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => {
    handleSignal('SIGINT');
  });

  process.on('SIGTERM', () => {
    handleSignal('SIGTERM');
  });

  try {
    if (config.subprocesses.enabled && config.subprocesses.visionAgent.enabled) {
      const visionAgentConfig = config.subprocesses.visionAgent;
      const visionAgentCwd = resolveRepoPath(visionAgentConfig.cwd);

      console.log(
        `[eva] starting vision-agent subprocess: ${visionAgentConfig.command.join(' ')} (cwd=${visionAgentCwd})`,
      );

      visionAgent = new ManagedProcess({
        name: 'vision-agent',
        cwd: visionAgentCwd,
        command: visionAgentConfig.command,
        healthUrl: visionAgentConfig.healthUrl,
        readyTimeoutMs: visionAgentConfig.readyTimeoutMs,
        shutdownTimeoutMs: visionAgentConfig.shutdownTimeoutMs,
      });

      visionAgent.start();

      console.log(`[eva] waiting for vision-agent health at ${visionAgentConfig.healthUrl}...`);
      await visionAgent.waitForHealthy();
      console.log(`[eva] vision-agent healthy at ${visionAgentConfig.healthUrl}`);
    }

    if (config.subprocesses.enabled && config.subprocesses.quickvision.enabled) {
      const quickvisionConfig = config.subprocesses.quickvision;
      const quickvisionCwd = resolveRepoPath(quickvisionConfig.cwd);

      console.log(
        `[eva] starting quickvision subprocess: ${quickvisionConfig.command.join(' ')} (cwd=${quickvisionCwd})`,
      );

      quickvision = new ManagedProcess({
        name: 'quickvision',
        cwd: quickvisionCwd,
        command: quickvisionConfig.command,
        healthUrl: quickvisionConfig.healthUrl,
        readyTimeoutMs: quickvisionConfig.readyTimeoutMs,
        shutdownTimeoutMs: quickvisionConfig.shutdownTimeoutMs,
      });

      quickvision.start();

      console.log(`[eva] waiting for quickvision health at ${quickvisionConfig.healthUrl}...`);
      await quickvision.waitForHealthy();
      console.log(`[eva] quickvision healthy at ${quickvisionConfig.healthUrl}`);
    }

    server = startServer({
      port: config.server.port,
      eyePath: config.server.eyePath,
      quickvisionWsUrl: config.quickvision.wsUrl,
      insightRelay: config.insightRelay,
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
