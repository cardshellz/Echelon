/**
 * Recover blocked replen baggage without guessing.
 *
 * Default is read-only dry-run:
 *   npx tsx scripts/recover-blocked-replen.ts
 *
 * Apply the conservative recovery:
 *   npx tsx scripts/recover-blocked-replen.ts --execute
 *
 * What execute does:
 *   1. Backfills missing replen_tasks.product_id from the pick/source variant.
 *   2. Cancels non-shipment blocked replen tasks only when source stock now exists.
 *   3. Re-runs replen evaluation for affected pick locations so a fresh task is created.
 *   4. Marks unresolved null-reason blocked rows as no_source_stock for health queue routing.
 *
 * It does not cancel shipment-blocking source-empty tasks or dependency-blocked cascade tasks.
 */

import fs from "node:fs";
import path from "node:path";

type CliOptions = {
  execute: boolean;
  json: boolean;
  limit: number | null;
};

type Candidate = {
  task_id: number;
  product_id: number | null;
  resolved_product_id: number | null;
  exception_reason: string | null;
  replen_method: string | null;
  pick_product_variant_id: number | null;
  source_product_variant_id: number | null;
  pick_sku: string | null;
  source_sku: string | null;
  from_location: string | null;
  to_location: string | null;
  to_location_id: number;
  source_positive_total: number;
  active_pending_lines: number;
  active_pending_units: number;
  created_at: string;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    json: false,
    limit: null,
  };

  for (const arg of args) {
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--dry-run") {
      options.execute = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--limit=")) {
      const limit = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = limit;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function loadDotenvIfAvailable(): Promise<void> {
  try {
    const dotenv = await import("dotenv");
    dotenv.config({ quiet: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("dotenv")) {
      throw error;
    }
  }

  if (!process.env.DATABASE_URL) {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith("DATABASE_URL="));
    if (!line) return;
    let value = line.slice("DATABASE_URL=".length).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env.DATABASE_URL = value;
  }
}

function printHuman(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  if (!process.env.DATABASE_URL && !process.env.EXTERNAL_DATABASE_URL) {
    throw new Error("DATABASE_URL or EXTERNAL_DATABASE_URL is required");
  }

  if (!process.env.EXTERNAL_DATABASE_URL && process.env.DATABASE_URL) {
    process.env.EXTERNAL_DATABASE_URL = process.env.DATABASE_URL;
  }

  const { pool, db } = await import("../server/db");

  const candidatesResult = await pool.query<Candidate>(`
    WITH blocked AS (
      SELECT
        rt.id AS task_id,
        rt.product_id,
        COALESCE(pv_pick.product_id, pv_source.product_id) AS resolved_product_id,
        rt.exception_reason,
        rt.replen_method,
        rt.notes,
        rt.pick_product_variant_id,
        rt.source_product_variant_id,
        pv_pick.sku AS pick_sku,
        pv_source.sku AS source_sku,
        wl_from.code AS from_location,
        wl_to.code AS to_location,
        rt.to_location_id,
        rt.created_at
      FROM inventory.replen_tasks rt
      LEFT JOIN catalog.product_variants pv_pick ON pv_pick.id = rt.pick_product_variant_id
      LEFT JOIN catalog.product_variants pv_source ON pv_source.id = rt.source_product_variant_id
      LEFT JOIN warehouse.warehouse_locations wl_from ON wl_from.id = rt.from_location_id
      LEFT JOIN warehouse.warehouse_locations wl_to ON wl_to.id = rt.to_location_id
      WHERE rt.status = 'blocked'
        AND rt.blocks_shipment = false
        AND rt.depends_on_task_id IS NULL
        AND COALESCE(rt.exception_reason, 'no_source_stock') IN ('no_source_stock', 'execute_failed')
    ),
    source_totals AS (
      SELECT
        b.task_id,
        COALESCE(SUM(il.variant_qty) FILTER (WHERE il.variant_qty > 0 AND wl.id IS NOT NULL), 0)::int AS source_positive_total
      FROM blocked b
      LEFT JOIN inventory.inventory_levels il
        ON il.product_variant_id = COALESCE(b.source_product_variant_id, b.pick_product_variant_id)
      LEFT JOIN warehouse.warehouse_locations wl
        ON wl.id = il.warehouse_location_id
       AND (
         (LOWER(COALESCE(b.notes, '')) LIKE '%reserve locations%' AND wl.is_pickable = 0)
         OR (LOWER(COALESCE(b.notes, '')) LIKE '%pick locations%' AND wl.is_pickable = 1)
         OR (
           LOWER(COALESCE(b.notes, '')) NOT LIKE '%reserve locations%'
           AND LOWER(COALESCE(b.notes, '')) NOT LIKE '%pick locations%'
           AND b.replen_method = 'pallet_drop'
           AND wl.is_pickable = 0
         )
         OR (
           LOWER(COALESCE(b.notes, '')) NOT LIKE '%reserve locations%'
           AND LOWER(COALESCE(b.notes, '')) NOT LIKE '%pick locations%'
           AND b.replen_method = 'case_break'
           AND wl.is_pickable = 1
         )
         OR (
           LOWER(COALESCE(b.notes, '')) NOT LIKE '%reserve locations%'
           AND LOWER(COALESCE(b.notes, '')) NOT LIKE '%pick locations%'
           AND COALESCE(b.replen_method, '') NOT IN ('pallet_drop', 'case_break')
         )
       )
      GROUP BY b.task_id
    ),
    active_demand AS (
      SELECT
        b.task_id,
        COUNT(oi.id)::int AS active_pending_lines,
        COALESCE(SUM(oi.quantity), 0)::int AS active_pending_units
      FROM blocked b
      JOIN wms.order_items oi
        ON oi.sku = b.pick_sku
       AND oi.status = 'pending'
       AND oi.requires_shipping = 1
      JOIN wms.orders o
        ON o.id = oi.order_id
       AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
      GROUP BY b.task_id
    )
    SELECT
      b.*,
      COALESCE(st.source_positive_total, 0)::int AS source_positive_total,
      COALESCE(ad.active_pending_lines, 0)::int AS active_pending_lines,
      COALESCE(ad.active_pending_units, 0)::int AS active_pending_units
    FROM blocked b
    LEFT JOIN source_totals st ON st.task_id = b.task_id
    LEFT JOIN active_demand ad ON ad.task_id = b.task_id
    ORDER BY
      COALESCE(ad.active_pending_lines, 0) DESC,
      COALESCE(st.source_positive_total, 0) DESC,
      b.created_at ASC
    ${options.limit ? "LIMIT $1" : ""}
  `, options.limit ? [options.limit] : []);

  const candidates = candidatesResult.rows;
  const recoverable = candidates.filter((row) => Number(row.source_positive_total) > 0);
  const unresolved = candidates.filter((row) => Number(row.source_positive_total) <= 0);

  const summary: Record<string, unknown> = {
    mode: options.execute ? "execute" : "dry-run",
    scannedBlockedTasks: candidates.length,
    recoverableWithSource: recoverable.length,
    unresolvedNoSource: unresolved.length,
    activePickLinesImpacted: candidates.reduce((sum, row) => sum + Number(row.active_pending_lines ?? 0), 0),
    recoverableTaskIds: recoverable.map((row) => row.task_id),
    unresolvedTaskIds: unresolved.map((row) => row.task_id),
    samples: candidates.slice(0, 20),
  };

  if (!options.execute) {
    options.json ? console.log(JSON.stringify(summary, null, 2)) : printHuman(summary);
    await pool.end();
    return;
  }

  const recoverableIds = recoverable.map((row) => row.task_id);
  const unresolvedIds = unresolved.map((row) => row.task_id);
  let backfilledProductIds = 0;
  let cancelledForRecheck = 0;
  let markedNoSource = 0;
  let recheckedLocations = 0;

  await pool.query("BEGIN");
  try {
    const backfillResult = await pool.query(`
      WITH resolved AS (
        SELECT
          rt.id,
          COALESCE(pv_pick.product_id, pv_source.product_id) AS product_id
        FROM inventory.replen_tasks rt
        LEFT JOIN catalog.product_variants pv_pick ON pv_pick.id = rt.pick_product_variant_id
        LEFT JOIN catalog.product_variants pv_source ON pv_source.id = rt.source_product_variant_id
        WHERE rt.product_id IS NULL
          AND COALESCE(pv_pick.product_id, pv_source.product_id) IS NOT NULL
      )
      UPDATE inventory.replen_tasks rt
      SET
        product_id = resolved.product_id,
        notes = TRIM(BOTH E'\n' FROM COALESCE(rt.notes, '') || E'\nBackfilled product_id via recover-blocked-replen.')
      FROM resolved
      WHERE rt.id = resolved.id
      RETURNING rt.id
    `);
    backfilledProductIds = backfillResult.rowCount ?? 0;

    if (recoverableIds.length > 0) {
      const cancelResult = await pool.query(`
        UPDATE inventory.replen_tasks
        SET
          status = 'cancelled',
          completed_at = NOW(),
          exception_reason = COALESCE(exception_reason, 'no_source_stock'),
          notes = TRIM(BOTH E'\n' FROM COALESCE(notes, '') || E'\nCancelled by recover-blocked-replen: source stock now exists; re-evaluating.')
        WHERE id = ANY($1::int[])
          AND status = 'blocked'
          AND blocks_shipment = false
          AND depends_on_task_id IS NULL
        RETURNING id, to_location_id
      `, [recoverableIds]);
      cancelledForRecheck = cancelResult.rowCount ?? 0;
    }

    if (unresolvedIds.length > 0) {
      const unresolvedResult = await pool.query(`
        UPDATE inventory.replen_tasks
        SET
          exception_reason = COALESCE(exception_reason, 'no_source_stock'),
          notes = CASE
            WHEN exception_reason IS NULL THEN TRIM(BOTH E'\n' FROM COALESCE(notes, '') || E'\nClassified by recover-blocked-replen: still no source stock.')
            ELSE notes
          END
        WHERE id = ANY($1::int[])
          AND status = 'blocked'
          AND blocks_shipment = false
          AND depends_on_task_id IS NULL
        RETURNING id
      `, [unresolvedIds]);
      markedNoSource = unresolvedResult.rowCount ?? 0;
    }

    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }

  if (recoverable.length > 0) {
    const { createServices } = await import("../server/services/index");
    const services = createServices(db);
    const locationIds = Array.from(new Set(recoverable.map((row) => row.to_location_id)));
    for (const locationId of locationIds) {
      await services.replenishment.checkReplenForLocation(locationId);
      recheckedLocations++;
    }
  }

  const executed = {
    ...summary,
    backfilledProductIds,
    cancelledForRecheck,
    markedNoSource,
    recheckedLocations,
  };

  options.json ? console.log(JSON.stringify(executed, null, 2)) : printHuman(executed);
  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
