import { sql } from "drizzle-orm";

/**
 * Durable record of when a scheduled sweep last completed.
 *
 * The background sweeps each ran a catch-up pass on boot, which is right after
 * real downtime and wasteful otherwise. Echelon deploys many times a day - 15 of
 * the last 15 releases were deploys - so that catch-up fires constantly against
 * an app that was up seconds earlier. Several heavy sweeps then allocate at once
 * on a 512MB dyno, which is the shape behind the 1.4GB peak and the R14/R15/H10
 * crash loop seen on 2026-08-28.
 *
 * The existing heartbeats are module-level variables, so a restart erases them
 * and every boot looks like a cold start. This persists the timestamp instead,
 * letting a boot ask the only question that matters: are we actually behind?
 *
 * Stored in public.scheduler_runs (migration 0624) rather than oms.*, because
 * ARCHITECTURE-AUDIT-2026-07.md 4.1 makes modules/oms the sole writer of oms.*
 * and this is cross-cutting scheduler bookkeeping. public.audit_events is the
 * same shape of infrastructure-owned table. Note that neither app_settings
 * table was usable: both are singleton settings rows in production, despite the
 * Drizzle schema declaring warehouse.app_settings as a key/value store - the real
 * table has no `key` column at all.
 */

type Db = { execute: (query: any) => Promise<any> };

function firstRow(result: any): any | undefined {
  return Array.isArray(result?.rows) ? result.rows[0] : undefined;
}

/** When this job last completed successfully, or null if never recorded. */
export async function getLastRunAt(db: Db, jobKey: string): Promise<Date | null> {
  const row = firstRow(
    await db.execute(sql`
      SELECT last_completed_at
      FROM public.scheduler_runs
      WHERE job_key = ${jobKey}
      LIMIT 1
    `),
  );
  if (!row?.last_completed_at) return null;
  const parsed = new Date(row.last_completed_at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Record a successful completion. Call this from the scheduled runs too, not
 * just the boot run - otherwise the timestamp goes stale and every boot decides
 * it is behind, which is the behaviour this is meant to remove.
 */
export async function recordRunCompleted(
  db: Db,
  jobKey: string,
  now: Date = new Date(),
): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.scheduler_runs (job_key, last_completed_at, updated_at)
    VALUES (${jobKey}, ${now.toISOString()}, NOW())
    ON CONFLICT (job_key) DO UPDATE
      SET last_completed_at = EXCLUDED.last_completed_at,
          updated_at = NOW()
  `);
}

/**
 * Should this job run a catch-up pass now?
 *
 * True when it has never run, or when its last completion is older than its
 * normal interval - i.e. a scheduled run was genuinely missed. After an ordinary
 * deploy the last run is minutes old, so this is false and the boot pass is
 * skipped; the regular interval picks the work up on time.
 *
 * Fails OPEN: if the lookup errors, the sweep runs. A catch-up pass that was not
 * needed is wasteful, but a skipped one can leave fulfillments unwritten.
 */
export async function isBehindSchedule(
  db: Db,
  jobKey: string,
  intervalMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const lastRunAt = await getLastRunAt(db, jobKey);
    if (!lastRunAt) return true;
    return now.getTime() - lastRunAt.getTime() >= intervalMs;
  } catch (error: any) {
    console.error(
      `[scheduler-run-registry] could not read last run for ${jobKey}; running anyway:`,
      error?.message ?? error,
    );
    return true;
  }
}
