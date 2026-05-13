/**
 * Classify and conservatively recover open allocation exceptions.
 *
 * Dry run:
 *   npx tsx scripts/recover-allocation-exceptions.ts --json
 *
 * Execute only safe cleanup:
 *   npx tsx scripts/recover-allocation-exceptions.ts --execute --json
 *
 * Execute does not move inventory. It only:
 *   1. Cancels older duplicate open exception rows for the same order item.
 *   2. Resolves open exceptions whose order/line no longer has active shipping demand.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

type CliOptions = {
  execute: boolean;
  json: boolean;
  limit: number;
  sku: string | null;
  orderNumber: string | null;
};

type ExceptionRow = {
  exception_id: number;
  order_id: number;
  order_number: string | null;
  order_item_id: number;
  sku: string;
  product_variant_id: number | null;
  exception_type: string;
  status: string;
  requested_qty: number;
  selected_location_id: number | null;
  selected_location_code: string | null;
  review_reason: string | null;
  created_at: string;
  order_warehouse_id: number | null;
  order_status: string | null;
  cancelled_at: string | null;
  item_status: string | null;
  requires_shipping: number | null;
  quantity: number | null;
  picked_quantity: number | null;
  item_location: string | null;
  selected_qty: number;
  selected_location_warehouse_id: number | null;
  selected_location_type: string | null;
  selected_location_pickable: number | null;
  selected_location_active: number | null;
  pickable_positive_total: number;
  best_pickable_location_id: number | null;
  best_pickable_location_code: string | null;
  best_pickable_warehouse_id: number | null;
  best_pickable_qty: number;
  open_exception_count: number;
  item_exception_rank: number;
};

type ClassifiedException = ExceptionRow & {
  classification: string;
  stockClass: string;
  recoverable: boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    execute: false,
    json: false,
    limit: 250,
    sku: null,
    orderNumber: null,
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
    } else if (arg.startsWith("--sku=")) {
      options.sku = arg.slice("--sku=".length).trim() || null;
    } else if (arg.startsWith("--order=")) {
      options.orderNumber = arg.slice("--order=".length).trim() || null;
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

function classify(row: ExceptionRow): ClassifiedException {
  const orderStatus = String(row.order_status || "").toLowerCase();
  const itemStatus = String(row.item_status || "").toLowerCase();
  const requiresShipping = Number(row.requires_shipping ?? 1) === 1;
  let classification = "active_shipment_blocker";

  if (row.open_exception_count > 1 && row.item_exception_rank > 1) {
    classification = "duplicate_open_exception";
  } else if (orderStatus === "shipped" || orderStatus === "cancelled" || row.cancelled_at) {
    classification = "no_active_demand_order_closed";
  } else if (!requiresShipping) {
    classification = "no_active_demand_non_shipping_line";
  } else if (itemStatus === "short") {
    classification = "active_short_pick_blocker";
  } else if (itemStatus !== "completed") {
    classification = "active_uncompleted_line_blocker";
  }

  let stockClass = "no_pickable_stock";
  if (
    row.selected_location_id &&
    row.best_pickable_location_id &&
    Number(row.selected_location_id) !== Number(row.best_pickable_location_id) &&
    row.selected_location_code &&
    row.best_pickable_location_code &&
    row.selected_location_code.toUpperCase() === row.best_pickable_location_code.toUpperCase() &&
    row.best_pickable_qty >= row.requested_qty &&
    row.requested_qty > 0
  ) {
    stockClass = "same_code_stock_in_pickable_location";
  } else if (row.selected_location_id && row.selected_qty >= row.requested_qty && row.requested_qty > 0) {
    stockClass = "selected_bin_has_stock_now";
  } else if (row.pickable_positive_total > 0) {
    stockClass = "stock_elsewhere_pickable";
  }

  return {
    ...row,
    classification,
    stockClass,
    recoverable: classification === "duplicate_open_exception" || classification.startsWith("no_active_demand"),
  };
}

function countBy(rows: ClassifiedException[], key: keyof ClassifiedException): Record<string, number> {
  return rows.reduce((acc, row) => {
    const value = String(row[key] ?? "unknown");
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

async function fetchOpenExceptions(client: pg.PoolClient, options: CliOptions): Promise<ClassifiedException[]> {
  const filters: string[] = [];
  const values: unknown[] = [];

  if (options.sku) {
    values.push(options.sku);
    filters.push(`ae.sku = $${values.length}`);
  }
  if (options.orderNumber) {
    values.push(options.orderNumber);
    filters.push(`ae.order_number = $${values.length}`);
  }

  values.push(options.limit);
  const limitParam = `$${values.length}`;
  const filterSql = filters.length ? `AND ${filters.join(" AND ")}` : "";

  const result = await client.query<ExceptionRow>(`
    WITH open_exceptions AS (
      SELECT
        ae.*,
        count(*) OVER (PARTITION BY ae.order_item_id) AS open_exception_count,
        row_number() OVER (
          PARTITION BY ae.order_item_id
          ORDER BY ae.created_at DESC, ae.id DESC
        ) AS item_exception_rank
      FROM wms.allocation_exceptions ae
      WHERE ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
        ${filterSql}
    )
    SELECT
      ae.id AS exception_id,
      ae.order_id,
      ae.order_number,
      ae.order_item_id,
      ae.sku,
      ae.product_variant_id,
      ae.exception_type,
      ae.status,
      ae.requested_qty,
      ae.selected_location_id,
      ae.selected_location_code,
      ae.review_reason,
      ae.created_at::text,
      o.warehouse_id AS order_warehouse_id,
      o.warehouse_status AS order_status,
      o.cancelled_at::text,
      oi.status AS item_status,
      oi.requires_shipping,
      oi.quantity,
      oi.picked_quantity,
      oi.location AS item_location,
      COALESCE(selected_level.variant_qty, 0)::int AS selected_qty,
      selected_wl.warehouse_id AS selected_location_warehouse_id,
      selected_wl.location_type AS selected_location_type,
      selected_wl.is_pickable AS selected_location_pickable,
      selected_wl.is_active AS selected_location_active,
      COALESCE(pickable.pickable_positive_total, 0)::int AS pickable_positive_total,
      pickable.best_pickable_location_id,
      pickable.best_pickable_location_code,
      pickable.best_pickable_warehouse_id,
      COALESCE(pickable.best_pickable_qty, 0)::int AS best_pickable_qty,
      ae.open_exception_count::int,
      ae.item_exception_rank::int
    FROM open_exceptions ae
    JOIN wms.orders o ON o.id = ae.order_id
    JOIN wms.order_items oi ON oi.id = ae.order_item_id
    LEFT JOIN catalog.product_variants pv ON pv.sku = ae.sku
    LEFT JOIN inventory.inventory_levels selected_level
      ON selected_level.product_variant_id = COALESCE(ae.product_variant_id, pv.id)
     AND selected_level.warehouse_location_id = ae.selected_location_id
    LEFT JOIN warehouse.warehouse_locations selected_wl
      ON selected_wl.id = ae.selected_location_id
    LEFT JOIN LATERAL (
      SELECT
        SUM(il.variant_qty)::int AS pickable_positive_total,
        (ARRAY_AGG(wl.id ORDER BY il.variant_qty DESC, wl.code ASC))[1] AS best_pickable_location_id,
        (ARRAY_AGG(wl.code ORDER BY il.variant_qty DESC, wl.code ASC))[1] AS best_pickable_location_code,
        (ARRAY_AGG(wl.warehouse_id ORDER BY il.variant_qty DESC, wl.code ASC))[1] AS best_pickable_warehouse_id,
        (ARRAY_AGG(il.variant_qty ORDER BY il.variant_qty DESC, wl.code ASC))[1]::int AS best_pickable_qty
      FROM inventory.inventory_levels il
      JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.product_variant_id = COALESCE(ae.product_variant_id, pv.id)
        AND il.variant_qty > 0
        AND wl.is_pickable = 1
        AND wl.is_active = 1
        AND wl.cycle_count_freeze_id IS NULL
        AND (o.warehouse_id IS NULL OR wl.warehouse_id = o.warehouse_id OR wl.warehouse_id IS NULL)
    ) pickable ON true
    ORDER BY
      CASE WHEN ae.status = 'blocked' THEN 0 ELSE 1 END,
      ae.created_at ASC,
      ae.id ASC
    LIMIT ${limitParam}
  `, values);

  return result.rows.map(classify);
}

async function executeRecovery(client: pg.PoolClient, rows: ClassifiedException[]) {
  const duplicateIds = rows
    .filter((row) => row.classification === "duplicate_open_exception")
    .map((row) => row.exception_id);
  const noActiveDemandIds = rows
    .filter((row) => row.classification.startsWith("no_active_demand"))
    .map((row) => row.exception_id);

  let cancelledDuplicates = 0;
  let resolvedNoActiveDemand = 0;

  await client.query("BEGIN");
  try {
    if (duplicateIds.length > 0) {
      const result = await client.query(`
        UPDATE wms.allocation_exceptions
        SET status = 'cancelled',
            resolution = 'duplicate_open_exception_recovery',
            resolved_by = NULL,
            resolved_at = NOW(),
            updated_at = NOW(),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'recoveredBy', 'recover-allocation-exceptions',
              'recoveredAt', NOW(),
              'recoveryReason', 'duplicate_open_exception'
            )
        WHERE id = ANY($1::int[])
          AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
        RETURNING id
      `, [duplicateIds]);
      cancelledDuplicates = result.rowCount ?? 0;
    }

    if (noActiveDemandIds.length > 0) {
      const result = await client.query(`
        UPDATE wms.allocation_exceptions
        SET status = 'resolved',
            resolution = 'no_active_demand_recovery',
            resolved_by = NULL,
            resolved_at = NOW(),
            updated_at = NOW(),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'recoveredBy', 'recover-allocation-exceptions',
              'recoveredAt', NOW(),
              'recoveryReason', 'no_active_demand'
            )
        WHERE id = ANY($1::int[])
          AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
        RETURNING id
      `, [noActiveDemandIds]);
      resolvedNoActiveDemand = result.rowCount ?? 0;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    duplicateIds,
    noActiveDemandIds,
    cancelledDuplicates,
    resolvedNoActiveDemand,
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
    const rows = await fetchOpenExceptions(client, options);
    const recovery = options.execute
      ? await executeRecovery(client, rows)
      : {
          duplicateIds: rows.filter((row) => row.classification === "duplicate_open_exception").map((row) => row.exception_id),
          noActiveDemandIds: rows.filter((row) => row.classification.startsWith("no_active_demand")).map((row) => row.exception_id),
          cancelledDuplicates: 0,
          resolvedNoActiveDemand: 0,
        };

    const output = {
      mode: options.execute ? "execute" : "dry-run",
      scannedOpenExceptions: rows.length,
      recoverable: recovery.duplicateIds.length + recovery.noActiveDemandIds.length,
      classificationCounts: countBy(rows, "classification"),
      stockCounts: countBy(rows, "stockClass"),
      duplicateExceptionIds: recovery.duplicateIds,
      noActiveDemandExceptionIds: recovery.noActiveDemandIds,
      cancelledDuplicates: recovery.cancelledDuplicates,
      resolvedNoActiveDemand: recovery.resolvedNoActiveDemand,
      activeBlockerSamples: rows.filter((row) => !row.recoverable).slice(0, 20),
      recoverableSamples: rows.filter((row) => row.recoverable).slice(0, 20),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`Allocation exceptions: scanned=${output.scannedOpenExceptions}, recoverable=${output.recoverable}, mode=${output.mode}`);
      console.log("Classifications:", output.classificationCounts);
      console.log("Stock:", output.stockCounts);
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
