/**
 * Classify and conservatively recover replen health baggage.
 *
 * Dry run:
 *   npx tsx scripts/recover-replen-health.ts --json
 *
 * Execute only safe cleanup:
 *   npx tsx scripts/recover-replen-health.ts --execute --json
 *
 * Execute does not move inventory. By default it only:
 *   1. Cancels duplicate active non-shipment replen tasks, keeping the best task.
 *   2. Cancels blocked no-source/no-demand sentinel tasks that have no executable quantity.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

type CliOptions = {
  execute: boolean;
  json: boolean;
  limit: number;
};

type ReplenRow = {
  task_id: number;
  status: string;
  replen_method: string | null;
  blocks_shipment: boolean;
  exception_reason: string | null;
  depends_on_task_id: number | null;
  order_id: number | null;
  order_item_id: number | null;
  pick_product_variant_id: number | null;
  source_product_variant_id: number | null;
  pick_sku: string | null;
  source_sku: string | null;
  from_location_id: number | null;
  from_location: string | null;
  to_location_id: number;
  to_location: string | null;
  qty_source_units: number;
  qty_target_units: number;
  created_at: string;
  started_at: string | null;
  assigned_at: string | null;
  age_hours: number;
  active_pending_lines: number;
  target_qty: number;
  source_qty: number;
  duplicate_rank: number;
  duplicate_keep_id: number;
  duplicate_count: number;
};

type ClassifiedReplenRow = ReplenRow & {
  classification: string;
  recoverable: boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    json: false,
    limit: 250,
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
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
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
    if (!(error instanceof Error) || !error.message.includes("dotenv")) throw error;
  }

  if (process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL) return;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const key of ["EXTERNAL_DATABASE_URL", "DATABASE_URL"]) {
    const line = env.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
    if (!line) continue;
    let value = line.slice(key.length + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    break;
  }
}

function isBlockedNoDemandSentinel(row: ReplenRow): boolean {
  return row.status === "blocked" &&
    row.blocks_shipment === false &&
    row.depends_on_task_id == null &&
    Number(row.qty_source_units ?? 0) === 0 &&
    Number(row.qty_target_units ?? 0) === 0 &&
    ["no_source_stock", "no_source_variant"].includes(row.exception_reason ?? "no_source_stock") &&
    Number(row.active_pending_lines ?? 0) === 0;
}

function classify(row: ReplenRow): ClassifiedReplenRow {
  let classification = "queued_replen_backlog";

  if (isBlockedNoDemandSentinel(row)) {
    classification = "blocked_no_demand_sentinel";
  } else if (row.duplicate_count > 1 && row.duplicate_rank > 1 && row.status !== "in_progress") {
    classification = "duplicate_active_task";
  } else if (row.status === "blocked") {
    classification = "blocked_replen";
  } else if (row.status === "in_progress") {
    classification = "abandoned_in_progress";
  } else if (row.active_pending_lines > 0 && row.target_qty <= 0 && row.source_qty >= Math.max(1, row.qty_source_units)) {
    classification = "active_demand_ready";
  } else if (row.active_pending_lines > 0 && row.target_qty <= 0) {
    classification = "active_demand_no_source";
  } else if (row.active_pending_lines > 0) {
    classification = "active_demand_pick_has_stock";
  } else if (row.target_qty <= 0 && row.source_qty >= Math.max(1, row.qty_source_units)) {
    classification = "queued_no_demand_ready";
  } else if (row.target_qty <= 0) {
    classification = "queued_no_demand_no_source";
  } else {
    classification = "queued_no_demand_pick_has_stock";
  }

  return {
    ...row,
    classification,
    recoverable: classification === "duplicate_active_task" || classification === "blocked_no_demand_sentinel",
  };
}

function countBy(rows: ClassifiedReplenRow[], key: keyof ClassifiedReplenRow): Record<string, number> {
  return rows.reduce((acc, row) => {
    const value = String(row[key] ?? "unknown");
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

async function fetchAgedReplenTasks(client: pg.PoolClient, options: CliOptions): Promise<ClassifiedReplenRow[]> {
  const result = await client.query<ReplenRow>(`
    WITH aged_tasks AS (
      SELECT
        rt.id AS task_id,
        rt.status,
        rt.replen_method,
        rt.blocks_shipment,
        rt.exception_reason,
        rt.depends_on_task_id,
        rt.order_id,
        rt.order_item_id,
        rt.pick_product_variant_id,
        rt.source_product_variant_id,
        pv_pick.sku AS pick_sku,
        pv_source.sku AS source_sku,
        rt.from_location_id,
        wl_from.code AS from_location,
        rt.to_location_id,
        wl_to.code AS to_location,
        COALESCE(rt.qty_source_units, 0)::int AS qty_source_units,
        COALESCE(rt.qty_target_units, 0)::int AS qty_target_units,
        rt.created_at::text,
        rt.started_at::text,
        rt.assigned_at::text,
        FLOOR(EXTRACT(EPOCH FROM NOW() - COALESCE(rt.started_at, rt.assigned_at, rt.created_at)) / 3600)::int AS age_hours,
        COALESCE(demand.active_pending_lines, 0)::int AS active_pending_lines,
        COALESCE(target_level.variant_qty, 0)::int AS target_qty,
        COALESCE(source_level.variant_qty, 0)::int AS source_qty
      FROM inventory.replen_tasks rt
      JOIN warehouse.warehouse_locations wl_to ON rt.to_location_id = wl_to.id
      LEFT JOIN warehouse.warehouse_locations wl_from ON rt.from_location_id = wl_from.id
      LEFT JOIN catalog.product_variants pv_pick ON rt.pick_product_variant_id = pv_pick.id
      LEFT JOIN catalog.product_variants pv_source ON rt.source_product_variant_id = pv_source.id
      LEFT JOIN inventory.inventory_levels target_level
        ON target_level.product_variant_id = rt.pick_product_variant_id
       AND target_level.warehouse_location_id = rt.to_location_id
      LEFT JOIN inventory.inventory_levels source_level
        ON source_level.product_variant_id = rt.source_product_variant_id
       AND source_level.warehouse_location_id = rt.from_location_id
      LEFT JOIN LATERAL (
        SELECT COUNT(oi.id)::int AS active_pending_lines
        FROM wms.order_items oi
        JOIN wms.orders o
          ON o.id = oi.order_id
         AND COALESCE(o.warehouse_status, '') NOT IN ('shipped', 'cancelled')
        WHERE oi.sku = pv_pick.sku
          AND oi.status = 'pending'
          AND oi.requires_shipping = 1
      ) demand ON true
      WHERE rt.status NOT IN ('completed', 'cancelled')
        AND (
          rt.status = 'blocked'
          OR (rt.status = 'in_progress' AND COALESCE(rt.started_at, rt.created_at) < NOW() - INTERVAL '1 hour')
          OR (rt.status IN ('pending', 'assigned') AND rt.created_at < NOW() - INTERVAL '4 hours')
        )
    ),
    ranked AS (
      SELECT
        aged_tasks.*,
        first_value(task_id) OVER task_group AS duplicate_keep_id,
        (row_number() OVER task_group)::int AS duplicate_rank,
        (count(*) OVER task_group)::int AS duplicate_count
      FROM aged_tasks
      WINDOW task_group AS (
        PARTITION BY pick_product_variant_id, to_location_id
        ORDER BY
          CASE status
            WHEN 'in_progress' THEN 1
            WHEN 'assigned' THEN 2
            WHEN 'pending' THEN 3
            WHEN 'blocked' THEN 4
            ELSE 9
          END,
          created_at ASC,
          task_id ASC
      )
    )
    SELECT *
    FROM ranked
    ORDER BY
      CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
      age_hours DESC,
      created_at ASC,
      task_id ASC
    LIMIT $1
  `, [options.limit]);

  return result.rows.map(classify);
}

async function executeRecovery(client: pg.PoolClient, rows: ClassifiedReplenRow[]) {
  const duplicateIds = rows
    .filter((row) => row.classification === "duplicate_active_task")
    .map((row) => row.task_id);
  const blockedNoDemandIds = rows
    .filter((row) => row.classification === "blocked_no_demand_sentinel")
    .map((row) => row.task_id);

  let cancelledDuplicates = 0;
  let cancelledBlockedNoDemand = 0;

  await client.query("BEGIN");
  try {
    if (duplicateIds.length > 0) {
      const result = await client.query(`
        UPDATE inventory.replen_tasks rt
        SET status = 'cancelled',
            completed_at = NOW(),
            notes = TRIM(BOTH E'\n' FROM COALESCE(rt.notes, '') || E'\nCancelled by recover-replen-health: duplicate active replen task.')
        WHERE rt.id = ANY($1::int[])
          AND rt.status IN ('pending', 'assigned', 'blocked')
          AND rt.blocks_shipment = false
        RETURNING rt.id
      `, [duplicateIds]);
      cancelledDuplicates = result.rowCount ?? 0;
    }

    if (blockedNoDemandIds.length > 0) {
      const result = await client.query(`
        UPDATE inventory.replen_tasks rt
        SET status = 'cancelled',
            completed_at = NOW(),
            notes = TRIM(BOTH E'\n' FROM COALESCE(rt.notes, '') || E'\nCancelled by recover-replen-health: no active demand and no executable replen work remains.')
        WHERE rt.id = ANY($1::int[])
          AND rt.status = 'blocked'
          AND rt.blocks_shipment = false
          AND rt.depends_on_task_id IS NULL
          AND COALESCE(rt.qty_source_units, 0) = 0
          AND COALESCE(rt.qty_target_units, 0) = 0
        RETURNING rt.id
      `, [blockedNoDemandIds]);
      cancelledBlockedNoDemand = result.rowCount ?? 0;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    duplicateIds,
    blockedNoDemandIds,
    cancelledDuplicates,
    cancelledBlockedNoDemand,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL or EXTERNAL_DATABASE_URL is required");

  const useSSL = Boolean(
    process.env.EXTERNAL_DATABASE_URL ||
    process.env.NODE_ENV === "production" ||
    connectionString.includes("amazonaws.com"),
  );
  const pool = new pg.Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  });
  const client = await pool.connect();

  try {
    const rows = await fetchAgedReplenTasks(client, options);
    const recovery = options.execute
      ? await executeRecovery(client, rows)
      : {
          duplicateIds: rows.filter((row) => row.classification === "duplicate_active_task").map((row) => row.task_id),
          blockedNoDemandIds: rows.filter((row) => row.classification === "blocked_no_demand_sentinel").map((row) => row.task_id),
          cancelledDuplicates: 0,
          cancelledBlockedNoDemand: 0,
        };

    const output = {
      mode: options.execute ? "execute" : "dry-run",
      scannedAgedTasks: rows.length,
      recoverable: recovery.duplicateIds.length + recovery.blockedNoDemandIds.length,
      classificationCounts: countBy(rows, "classification"),
      methodCounts: countBy(rows, "replen_method"),
      duplicateTaskIds: recovery.duplicateIds,
      blockedNoDemandTaskIds: recovery.blockedNoDemandIds,
      cancelledDuplicates: recovery.cancelledDuplicates,
      cancelledBlockedNoDemand: recovery.cancelledBlockedNoDemand,
      activeDemandSamples: rows.filter((row) => row.classification.startsWith("active_demand")).slice(0, 20),
      recoverableSamples: rows.filter((row) => row.recoverable).slice(0, 20),
      queueBacklogSamples: rows.filter((row) => row.classification.startsWith("queued_")).slice(0, 20),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`Replen health: scanned=${output.scannedAgedTasks}, recoverable=${output.recoverable}, mode=${output.mode}`);
      console.log("Classifications:", output.classificationCounts);
      console.log("Methods:", output.methodCounts);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
