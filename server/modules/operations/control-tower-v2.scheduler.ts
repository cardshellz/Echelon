import { db, pool } from "../../db";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";
import { refreshControlTowerFlowSnapshotIfDue } from "./control-tower-flow-snapshot.service";
import { runControlTowerProjectionJob } from "./control-tower-v2.job";

const CONTROL_TOWER_PROJECTOR_LOCK_ID = 736207;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 60 * 60_000;
const MAX_INITIAL_PHASE_DELAY_MS = 2 * 60_000;

function projectorIntervalMs(environment: NodeJS.ProcessEnv): number {
  const configured = Number(environment.CONTROL_TOWER_PROJECTOR_INTERVAL_MS);
  return Number.isInteger(configured) && configured >= MIN_INTERVAL_MS && configured <= MAX_INTERVAL_MS
    ? configured
    : DEFAULT_INTERVAL_MS;
}

export function controlTowerProjectorInitialDelayMs(intervalMs: number): number {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error("Control Tower projector interval is outside the supported range");
  }
  // The web dyno also starts order, carrier, and label sweeps near boot and on
  // five-minute boundaries. Phase the lower-priority projection between them;
  // cap startup delay even if an operator configures a much longer interval.
  return Math.min(Math.floor(intervalMs / 2), MAX_INITIAL_PHASE_DELAY_MS);
}

export interface ControlTowerProjectionSchedulerHandle {
  stop(): void;
}

export async function runControlTowerProjectionOnce(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await runControlTowerProjectionJob({ client, execute: true });
    const flowSnapshot = await refreshControlTowerFlowSnapshotIfDue({ client, db });
    console.log("[Operations Control Tower projector] run complete", {
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      failedSources: result.failedSources,
      sources: result.sources.map((source) => ({
        name: source.sourceName,
        status: source.status,
        rowsScanned: source.rowsScanned,
        rowsFailed: source.rowsFailed,
      })),
      flowSnapshot,
    });
  } finally {
    client.release();
  }
}

async function runLockedProjection(): Promise<void> {
  await withAdvisoryLock(CONTROL_TOWER_PROJECTOR_LOCK_ID, runControlTowerProjectionOnce);
}

export function startControlTowerProjectionScheduler(options: {
  environment?: NodeJS.ProcessEnv;
} = {}): ControlTowerProjectionSchedulerHandle {
  const intervalMs = projectorIntervalMs(options.environment ?? process.env);
  const initialDelayMs = controlTowerProjectorInitialDelayMs(intervalMs);
  console.log(`[Operations Control Tower projector] scheduler started intervalMs=${intervalMs} initialDelayMs=${initialDelayMs}`);

  let stopped = false;
  let intervalTimer: NodeJS.Timeout | null = null;
  const run = () => {
    if (stopped) return;
    runLockedProjection().catch((error) => {
      console.error("[Operations Control Tower projector] scheduled projection failed", error);
    });
  };
  const initialTimer = setTimeout(() => {
    if (stopped) return;
    run();
    // Anchor recurring runs to the delayed first run, not to process startup.
    intervalTimer = setInterval(run, intervalMs);
    intervalTimer.unref?.();
  }, initialDelayMs);
  initialTimer.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      if (intervalTimer !== null) clearInterval(intervalTimer);
    },
  };
}
