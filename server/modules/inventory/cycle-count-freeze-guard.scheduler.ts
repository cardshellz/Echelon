import { db } from "../../db";
import { sql } from "drizzle-orm";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";

const LOG_PREFIX = "[Cycle-Count Freeze Guard]";
const FREEZE_GUARD_LOCK_ID = 90210;
const DEFAULT_MAX_AGE_DAYS = 3;

/**
 * Max number of days a cycle-count freeze may hold a location before it is
 * auto-released. Configurable via the CYCLE_COUNT_FREEZE_MAX_AGE_DAYS env var
 * (e.g. set it in Heroku config). Defaults to 3.
 */
export function getFreezeMaxAgeDays(): number {
  const raw = Number(process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AGE_DAYS;
}

/**
 * Auto-release "stale" cycle-count freezes. A bin frozen by a cycle count that
 * has been left `in_progress` longer than the configured max age is unfrozen so
 * picks / reservations / case-break replenishment can run again.
 *
 * Background: a stuck single-bin "Quick Count" silently froze pick bins for
 * months — case-break replenishment was blocked, bins drained to 0, and
 * shipments couldn't deduct inventory. This guard prevents recurrence.
 *
 * Touches NO inventory: it only clears the freeze flag and marks the abandoned
 * count completed (the variance, if any, was already applied at approval time).
 */
export async function runCycleCountFreezeGuard(dbArg: any = db): Promise<{ released: number }> {
  const maxAgeDays = getFreezeMaxAgeDays();
  try {
    const stale = await dbArg.execute(sql`
      SELECT wl.id AS location_id, wl.code AS location_code,
             wl.cycle_count_freeze_id AS cycle_count_id, cc.created_at
      FROM warehouse.warehouse_locations wl
      JOIN inventory.cycle_counts cc ON cc.id = wl.cycle_count_freeze_id
      WHERE wl.cycle_count_freeze_id IS NOT NULL
        AND cc.status = 'in_progress'
        AND cc.created_at < NOW() - make_interval(days => ${maxAgeDays})
    `);

    if (stale.rows.length === 0) return { released: 0 };

    const ids = [...new Set(stale.rows.map((r: any) => Number(r.cycle_count_id)))].filter((n) =>
      Number.isInteger(n),
    );
    if (ids.length === 0) return { released: 0 };

    for (const r of stale.rows as any[]) {
      console.warn(
        `${LOG_PREFIX} Releasing stale freeze on ${r.location_code} (location ${r.location_id}) — ` +
          `cycle count ${r.cycle_count_id} in_progress since ${r.created_at} (> ${maxAgeDays}d); replenishment was blocked.`,
      );
    }

    // ids are integers read back from our own DB — safe to inline.
    const idList = sql.raw(ids.join(","));
    await dbArg.execute(sql`
      UPDATE inventory.cycle_counts
      SET status = 'completed', completed_at = NOW(), updated_at = NOW(),
          description = COALESCE(description, '') || ${" [auto-released by freeze guard: in_progress > " + maxAgeDays + "d]"}
      WHERE id IN (${idList}) AND status = 'in_progress'
    `);
    await dbArg.execute(sql`
      UPDATE warehouse.warehouse_locations
      SET cycle_count_freeze_id = NULL, updated_at = NOW()
      WHERE cycle_count_freeze_id IN (${idList})
    `);

    console.warn(`${LOG_PREFIX} Released ${stale.rows.length} stale freeze(s) across ${ids.length} count(s).`);
    return { released: stale.rows.length };
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Error: ${err?.message ?? err}`);
    return { released: 0 };
  }
}

export function startCycleCountFreezeGuard(dbArg: any = db): void {
  if (process.env.DISABLE_SCHEDULERS === "true") return;
  console.log(
    `${LOG_PREFIX} Scheduler started (every 6h, max freeze age ${getFreezeMaxAgeDays()}d, dyno-safe lock)`,
  );

  // Boot run (staggered after other schedulers)
  setTimeout(() => {
    withAdvisoryLock(FREEZE_GUARD_LOCK_ID, async () => {
      await runCycleCountFreezeGuard(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} Boot run error: ${err.message}`));
  }, 20000);

  // Every 6 hours thereafter
  setInterval(() => {
    withAdvisoryLock(FREEZE_GUARD_LOCK_ID, async () => {
      await runCycleCountFreezeGuard(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} Scheduled run error: ${err.message}`));
  }, 6 * 60 * 60 * 1000);
}
