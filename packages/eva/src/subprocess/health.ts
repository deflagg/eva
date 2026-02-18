export interface WaitForHttpHealthyOptions {
  name: string;
  healthUrl: string;
  timeoutMs: number;
  intervalMs?: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForHttpHealthy(options: WaitForHttpHealthyOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 250;
  const deadlineMs = Date.now() + options.timeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadlineMs) {
    try {
      const response = await fetch(options.healthUrl, { method: 'GET' });
      if (response.status === 200) {
        return;
      }

      lastError = `received HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(intervalMs);
  }

  const suffix = lastError ? ` (last error: ${lastError})` : '';
  throw new Error(
    `[${options.name}] health check timed out after ${options.timeoutMs}ms at ${options.healthUrl}${suffix}`,
  );
}
