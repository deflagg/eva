import { CronJob } from 'cron';

import type { AgentConfig } from '../config.js';

interface SchedulerOptions {
  config: AgentConfig;
  runCompaction: () => Promise<void>;
  runPromotion: () => Promise<void>;
}

interface SchedulerHandle {
  stop: () => void;
}

type ScheduledJobName = 'compaction' | 'promotion';

function createGuardedTick(name: ScheduledJobName, runJob: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  let overlapLogged = false;

  return async () => {
    if (inFlight) {
      if (!overlapLogged) {
        overlapLogged = true;
        console.warn(`[agent] scheduler: ${name} job is still running; skipping overlapping tick.`);
      }
      return;
    }

    inFlight = true;
    overlapLogged = false;

    console.log(`[agent] scheduler: running ${name} job...`);

    try {
      await runJob();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent] scheduler: ${name} job failed: ${message}`);
    } finally {
      inFlight = false;
      overlapLogged = false;
    }
  };
}

function createCronJob(
  name: ScheduledJobName,
  cronExpr: string,
  timezone: string,
  onTick: () => void,
): CronJob {
  try {
    return CronJob.from({
      cronTime: cronExpr,
      onTick,
      start: false,
      timeZone: timezone,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agent] scheduler: invalid ${name} cron "${cronExpr}" for timezone "${timezone}": ${message}`);
  }
}

function maybeStartScheduledJob(params: {
  name: ScheduledJobName;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  runJob: () => Promise<void>;
  jobs: CronJob[];
}): void {
  const { name, enabled, cronExpr, timezone, runJob, jobs } = params;

  if (!enabled) {
    console.log(`[agent] scheduler: ${name} job disabled.`);
    return;
  }

  const guardedTick = createGuardedTick(name, runJob);

  const job = createCronJob(name, cronExpr, timezone, () => {
    void guardedTick();
  });

  job.start();
  jobs.push(job);

  console.log(`[agent] scheduler: ${name} job scheduled cron="${cronExpr}" timezone="${timezone}".`);
}

export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  const { config } = options;

  if (!config.jobs.enabled) {
    return {
      stop: () => {},
    };
  }

  const jobs: CronJob[] = [];
  const timezone = config.jobs.timezone;

  maybeStartScheduledJob({
    name: 'compaction',
    enabled: config.jobs.compaction.enabled,
    cronExpr: config.jobs.compaction.cron,
    timezone,
    runJob: options.runCompaction,
    jobs,
  });

  maybeStartScheduledJob({
    name: 'promotion',
    enabled: config.jobs.promotion.enabled,
    cronExpr: config.jobs.promotion.cron,
    timezone,
    runJob: options.runPromotion,
    jobs,
  });

  if (jobs.length === 0) {
    console.log('[agent] scheduler: enabled but no jobs were started (all jobs disabled).');
  }

  return {
    stop: () => {
      for (const job of jobs) {
        try {
          job.stop();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[agent] scheduler: failed to stop job cleanly: ${message}`);
        }
      }
    },
  };
}
