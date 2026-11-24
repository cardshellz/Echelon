import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { logger } from "../../../platform/observability/logger";

const LOG_PREFIX = "[Proactive Replen Sweep]";
export const PROACTIVE_REPLEN_SWEEP_LOCK_ID = 918533;
export const PROACTIVE_REPLEN_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const PROACTIVE_REPLEN_INITIAL_DELAY_MS = 45 * 1000;

export interface ProactiveReplenSweepRunner {
  runProactiveReplenSweep(limit?: number): Promise<{
    scanned: number;
    triggered: number;
    taskIds: number[];
  }>;
}

export async function runProactiveReplenSweepPass(
  replenishment: ProactiveReplenSweepRunner,
  limit = 100,
): Promise<{ scanned: number; triggered: number; taskIds: number[] }> {
  try {
    const result = await replenishment.runProactiveReplenSweep(limit);
    if (result.triggered > 0) {
      logger.info("inventory.proactive_replen_sweep_scheduler", {
        message: `${LOG_PREFIX} Triggered ${result.triggered} proactive replenishment task(s) across ${result.scanned} low pick bin(s).`,
        taskIds: result.taskIds,
      });
    }
    return result;
  } catch (err: any) {
    logger.error("inventory.proactive_replen_sweep_scheduler", {
      message: `${LOG_PREFIX} Sweep error: ${err?.message ?? err}`,
    });
    return { scanned: 0, triggered: 0, taskIds: [] };
  }
}

export function startProactiveReplenSweepScheduler(
  replenishment: ProactiveReplenSweepRunner,
): { stop: () => void } {
  if (process.env.DISABLE_SCHEDULERS === "true") {
    return { stop: () => undefined };
  }

  logger.info("inventory.proactive_replen_sweep_scheduler", {
    message: `${LOG_PREFIX} Scheduler started (every 15m, dyno-safe advisory lock ${PROACTIVE_REPLEN_SWEEP_LOCK_ID})`,
  });

  const bootTimer = setTimeout(() => {
    withAdvisoryLock(PROACTIVE_REPLEN_SWEEP_LOCK_ID, async () => {
      await runProactiveReplenSweepPass(replenishment);
    }).catch((err) => {
      logger.error("inventory.proactive_replen_sweep_scheduler", {
        message: `${LOG_PREFIX} Initial run error: ${err?.message ?? err}`,
      });
    });
  }, PROACTIVE_REPLEN_INITIAL_DELAY_MS);

  const intervalTimer = setInterval(() => {
    withAdvisoryLock(PROACTIVE_REPLEN_SWEEP_LOCK_ID, async () => {
      await runProactiveReplenSweepPass(replenishment);
    }).catch((err) => {
      logger.error("inventory.proactive_replen_sweep_scheduler", {
        message: `${LOG_PREFIX} Scheduled run error: ${err?.message ?? err}`,
      });
    });
  }, PROACTIVE_REPLEN_SWEEP_INTERVAL_MS);

  return {
    stop: () => {
      clearTimeout(bootTimer);
      clearInterval(intervalTimer);
    },
  };
}
