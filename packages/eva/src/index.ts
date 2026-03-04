import { type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEvaConfig } from './config.js';
import { ConsoleRenderer } from './logging/ConsoleRenderer.js';
import { LogManager } from './logging/LogManager.js';
import { startServer } from './server.js';
import { ManagedProcess, type ManagedProcessLine } from './subprocess/ManagedProcess.js';

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
  const logManager = new LogManager({
    config: config.logging,
    packageRoot,
  });
  const consoleRenderer = new ConsoleRenderer({
    mode: config.logging.console.mode,
    timestamps: config.logging.console.timestamps,
  });

  logManager.init();
  logManager.log('eva', 'info', 'startup begin');
  logManager.log('eva', 'info', 'config loaded');

  const evaBaseUrl = `http://127.0.0.1:${config.server.port}`;

  consoleRenderer.echoLifecycle('━━━━━━━━ Eva Stack startup ━━━━━━━━');
  consoleRenderer.echoLifecycle(`runId=${logManager.runId}`);
  consoleRenderer.echoLifecycle(`logDir=${logManager.runDir}`);
  consoleRenderer.echoLifecycle(`eva.http=${evaBaseUrl}`);
  consoleRenderer.echoLifecycle(`eva.eyeWs=${evaBaseUrl}${config.server.eyePath}`);
  consoleRenderer.echoLifecycle(`eva.audioWs=${evaBaseUrl}${config.server.audioPath}`);
  consoleRenderer.echoLifecycle(`subprocesses.enabled=${config.subprocesses.enabled}`);
  consoleRenderer.echoLifecycle(
    `agent.enabled=${config.subprocesses.enabled && config.subprocesses.agent.enabled} health=${config.subprocesses.agent.healthUrl}`,
  );
  consoleRenderer.echoLifecycle(
    `vision.enabled=${config.subprocesses.enabled && config.subprocesses.vision.enabled} health=${config.subprocesses.vision.healthUrl}`,
  );
  consoleRenderer.echoLifecycle(
    `audio.enabled=${config.subprocesses.enabled && config.subprocesses.audio.enabled} health=${config.subprocesses.audio.healthUrl}`,
  );

  const handleSubprocessLine = (payload: ManagedProcessLine): void => {
    if (payload.service === 'agent' || payload.service === 'vision' || payload.service === 'audio') {
      logManager.logSubprocessLine(payload.service, payload.stream, payload.line);
      consoleRenderer.echoSubprocessLine(payload.service, payload.stream, payload.line);
    }
  };

  let agent: ManagedProcess | null = null;
  let vision: ManagedProcess | null = null;
  let audio: ManagedProcess | null = null;
  let server: Server | null = null;

  let shutdownInFlight: Promise<void> | null = null;
  let logsClosed = false;

  const closeLogsSafely = async (): Promise<void> => {
    if (logsClosed) {
      return;
    }

    logsClosed = true;

    try {
      await logManager.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consoleRenderer.echoEva('error', `log flush failed: ${message}`);
    }
  };

  const runShutdownStep = async (stepName: string, action: (() => Promise<void>) | null): Promise<void> => {
    const startedMs = Date.now();
    consoleRenderer.echoLifecycle(`shutdown step: ${stepName}...`);

    if (!action) {
      const elapsedMs = Date.now() - startedMs;
      consoleRenderer.echoLifecycle(`shutdown step: ${stepName} skipped (${elapsedMs}ms)`);
      logManager.log('eva', 'info', `shutdown step ${stepName} skipped (${elapsedMs}ms)`);
      return;
    }

    try {
      await action();
      const elapsedMs = Date.now() - startedMs;
      consoleRenderer.echoLifecycle(`shutdown step: ${stepName} done (${elapsedMs}ms)`);
      logManager.log('eva', 'info', `shutdown step ${stepName} done (${elapsedMs}ms)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedMs = Date.now() - startedMs;
      consoleRenderer.echoEva('error', `shutdown step: ${stepName} failed (${elapsedMs}ms): ${message}`);
      logManager.log('eva', 'error', `shutdown step ${stepName} failed (${elapsedMs}ms): ${message}`);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shutdownInFlight) {
      return shutdownInFlight;
    }

    shutdownInFlight = (async () => {
      const shutdownStartedMs = Date.now();
      logManager.log('eva', 'info', 'shutdown begin');
      consoleRenderer.echoLifecycle('━━━━━━━━ Eva Stack shutdown ━━━━━━━━');

      const serverToClose = server;
      await runShutdownStep(
        'close server',
        serverToClose
          ? async () => {
              try {
                await closeServer(serverToClose, SERVER_CLOSE_TIMEOUT_MS);
              } finally {
                if (server === serverToClose) {
                  server = null;
                }
              }
            }
          : null,
      );

      const audioToStop = audio;
      await runShutdownStep(
        'stop audio',
        audioToStop
          ? async () => {
              try {
                await audioToStop.stop();
              } finally {
                if (audio === audioToStop) {
                  audio = null;
                }
              }
            }
          : null,
      );

      const visionToStop = vision;
      await runShutdownStep(
        'stop vision',
        visionToStop
          ? async () => {
              try {
                await visionToStop.stop();
              } finally {
                if (vision === visionToStop) {
                  vision = null;
                }
              }
            }
          : null,
      );

      const agentToStop = agent;
      await runShutdownStep(
        'stop agent',
        agentToStop
          ? async () => {
              try {
                await agentToStop.stop();
              } finally {
                if (agent === agentToStop) {
                  agent = null;
                }
              }
            }
          : null,
      );

      const shutdownElapsedMs = Date.now() - shutdownStartedMs;
      consoleRenderer.echoLifecycle(`shutdown total: ${shutdownElapsedMs}ms`);
      consoleRenderer.echoLifecycle(`shutdown logs: ${logManager.runDir}`);
      logManager.log(
        'eva',
        'info',
        `shutdown end total_ms=${shutdownElapsedMs} run_dir=${logManager.runDir}`,
      );

      await closeLogsSafely();
    })();

    return shutdownInFlight;
  };

  let isShuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | null = null;

  const forceTerminate = async (reason: string, exitCode: number): Promise<never> => {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }

    consoleRenderer.echoEva('error', reason);
    logManager.log('eva', 'error', `force terminate: ${reason}`);

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

    if (audio) {
      consoleRenderer.echoLifecycle('force-killing audio...');
      audio.forceKill();
      audio = null;
    }

    if (vision) {
      consoleRenderer.echoLifecycle('force-killing vision...');
      vision.forceKill();
      vision = null;
    }

    if (agent) {
      consoleRenderer.echoLifecycle('force-killing agent...');
      agent.forceKill();
      agent = null;
    }

    consoleRenderer.echoLifecycle(`shutdown logs: ${logManager.runDir}`);
    await closeLogsSafely();
    process.exit(exitCode);
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (isShuttingDown) {
      const reason = `received ${signal} during shutdown; forcing immediate exit`;
      consoleRenderer.echoLifecycle(reason);
      logManager.log('eva', 'warn', reason);
      void forceTerminate(reason, 130);
      return;
    }

    isShuttingDown = true;

    forceExitTimer = setTimeout(() => {
      const reason = `graceful shutdown timed out after ${SHUTDOWN_GRACE_TIMEOUT_MS}ms; forcing exit`;
      consoleRenderer.echoLifecycle(reason);
      logManager.log('eva', 'error', reason);
      void forceTerminate(reason, 1);
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
        const reason = `shutdown failed after ${signal}: ${message}`;
        consoleRenderer.echoEva('error', reason);
        logManager.log('eva', 'error', reason);
        void forceTerminate(reason, 1);
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

      consoleRenderer.echoLifecycle(
        `agent starting... command="${agentConfig.command.join(' ')}" cwd=${agentCwd}`,
      );

      agent = new ManagedProcess({
        name: 'agent',
        cwd: agentCwd,
        command: agentConfig.command,
        healthUrl: agentConfig.healthUrl,
        readyTimeoutMs: agentConfig.readyTimeoutMs,
        shutdownTimeoutMs: agentConfig.shutdownTimeoutMs,
        onLine: handleSubprocessLine,
      });

      agent.start();

      consoleRenderer.echoLifecycle(`agent waiting for health... ${agentConfig.healthUrl}`);
      await agent.waitForHealthy();
      consoleRenderer.echoLifecycle(`agent healthy... ${agentConfig.healthUrl}`);
    }

    if (config.subprocesses.enabled && config.subprocesses.vision.enabled) {
      const visionConfig = config.subprocesses.vision;
      const visionCwd = resolveRepoPath(visionConfig.cwd);

      consoleRenderer.echoLifecycle(
        `vision starting... command="${visionConfig.command.join(' ')}" cwd=${visionCwd}`,
      );

      vision = new ManagedProcess({
        name: 'vision',
        cwd: visionCwd,
        command: visionConfig.command,
        healthUrl: visionConfig.healthUrl,
        readyTimeoutMs: visionConfig.readyTimeoutMs,
        shutdownTimeoutMs: visionConfig.shutdownTimeoutMs,
        onLine: handleSubprocessLine,
      });

      vision.start();

      consoleRenderer.echoLifecycle(`vision waiting for health... ${visionConfig.healthUrl}`);
      await vision.waitForHealthy();
      consoleRenderer.echoLifecycle(`vision healthy... ${visionConfig.healthUrl}`);
    }

    if (config.subprocesses.enabled && config.subprocesses.audio.enabled) {
      const audioConfig = config.subprocesses.audio;
      const audioCwd = resolveRepoPath(audioConfig.cwd);

      consoleRenderer.echoLifecycle(
        `audio starting... command="${audioConfig.command.join(' ')}" cwd=${audioCwd}`,
      );

      audio = new ManagedProcess({
        name: 'audio',
        cwd: audioCwd,
        command: audioConfig.command,
        healthUrl: audioConfig.healthUrl,
        readyTimeoutMs: audioConfig.readyTimeoutMs,
        shutdownTimeoutMs: audioConfig.shutdownTimeoutMs,
        onLine: handleSubprocessLine,
      });

      audio.start();

      consoleRenderer.echoLifecycle(`audio waiting for health... ${audioConfig.healthUrl}`);
      await audio.waitForHealthy();
      consoleRenderer.echoLifecycle(`audio healthy... ${audioConfig.healthUrl}`);
    }

    server = startServer({
      port: config.server.port,
      eyePath: config.server.eyePath,
      audioPath: config.server.audioPath,
      visionWsUrl: config.vision.wsUrl,
      audioWsUrl: config.audio.wsUrl,
      stream: config.stream,
      motionGate: config.motionGate,
      insightRelay: config.insightRelay,
      agent: config.agent,
      text: config.text,
      speech: config.speech,
    });

    consoleRenderer.echoLifecycle(`eva listening... ${evaBaseUrl}`);
    logManager.log('eva', 'info', 'startup end');
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
