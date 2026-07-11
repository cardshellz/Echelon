import { db, pool } from "../../db";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";
import { refreshControlTowerFlowSnapshotIfDue } from "./control-tower-flow-snapshot.service";
import { runControlTowerProjectionJob } from "./control-tower-v2.job";

const CONTROL_TOWER_PROJECTOR_LOCK_ID = 736207;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 60 * 60_000;
const BOOT_DELAY_MS = 10_000;

function projectorIntervalMs(): number {
  const configured = Number(process.env.CONTROL_TOWER_PROJECTOR_INTERVAL_MS);
  return Number.isInteger(configured) && configured >= MIN_INTERVAL_MS && configured <= MAX_INTERVAL_MS
    ? configured
    : DEFAULT_INTERVAL_MS;
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

export function startControlTowerProjectionScheduler(): NodeJS.Timeout {
  const intervalMs = projectorIntervalMs();
  console.log(`[Operations Control Tower projector] scheduler started intervalMs=${intervalMs}`);

  const bootTimer = setTimeout(() => {
    runLockedProjection().catch((error) => {
      console.error("[Operations Control Tower projector] boot projection failed", error);
    });
  }, BOOT_DELAY_MS);
  bootTimer.unref();

  const interval = setInterval(() => {
    runLockedProjection().catch((error) => {
      console.error("[Operations Control Tower projector] scheduled projection failed", error);
    });
  }, intervalMs);
  interval.unref();
  return interval;
}
