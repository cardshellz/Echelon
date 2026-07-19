/**
 * Classify and conservatively recover open allocation exceptions.
 *
 * Dry run:
 *   npx tsx scripts/recover-allocation-exceptions.ts --json
 *
 * Execute only safe cleanup:
 *   npx tsx scripts/recover-allocation-exceptions.ts --execute --json
 *
 * Execute only safe cleanup/recovery:
 *   1. Cancels older duplicate open exception rows for the same order item.
 *   2. Resolves open exceptions whose order/line no longer has active shipping demand.
 *   3. Re-posts a missing pick ledger for fully picked deduction failures when
 *      a single active pick bin now has enough stock, then resolves the stale blocker.
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
  shipment_blocking: boolean | null;
  requested_qty: number;
  selected_location_id: number | null;
  selected_location_code: string | null;
  review_reason: string | null;
  created_at: string;
  order_warehouse_id: number | null;
  order_status: string | null;
  cancelled_at: string | null;
  item_status: string | null;
  item_name: string | null;
  product_id: number | null;
  requires_shipping: number | null;
  quantity: number | null;
  picked_quantity: number | null;
  item_location: string | null;
  pick_transaction_qty: number;
  selected_qty: number;
  selected_location_warehouse_id: number | null;
  selected_location_type: string | null;
  selected_location_pickable: number | null;
  selected_location_active: number | null;
  pickable_positive_total: number;
  best_pickable_location_id: number | null;
  best_pickable_location_code: string | null;
  best_pickable_zone: string | null;
  best_pickable_warehouse_id: number | null;
  best_pickable_qty: number;
  open_exception_count: number;
  item_exception_rank: number;
};

type ClassifiedException = ExceptionRow & {
  classification: string;
  stockClass: string;
  shipmentBlocking: boolean;
  recoverable: boolean;
};

type CompletedPickRecovery = {
  exceptionId: number;
  orderId: number;
  orderItemId: number;
  transactionId: number;
  locationId: number;
  locationCode: string;
  qty: number;
  orderStatusUpdated: boolean;
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

  if (process.env.DATABASE_URL) return;

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const key of ["DATABASE_URL"]) {
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
  const shipmentBlocking = row.status === "blocked" || row.shipment_blocking === true;
  const requestedQty = Math.max(0, Number(row.requested_qty ?? 0));
  const orderQty = Math.max(0, Number(row.quantity ?? 0));
  const pickedQty = Math.max(0, Number(row.picked_quantity ?? 0));
  const qtyToRecover = Math.max(requestedQty, orderQty, pickedQty);
  const hasFullPick = orderQty > 0 && pickedQty >= orderQty;
  const hasNoPickLedger = Number(row.pick_transaction_qty ?? 0) <= 0;
  const hasSinglePickBinStock = qtyToRecover > 0 && Number(row.best_pickable_qty ?? 0) >= qtyToRecover;
  let classification = "active_shipment_blocker";

  if (row.open_exception_count > 1 && row.item_exception_rank > 1) {
    classification = "duplicate_open_exception";
  } else if (orderStatus === "shipped" || orderStatus === "cancelled" || row.cancelled_at) {
    classification = "no_active_demand_order_closed";
  } else if (!requiresShipping) {
    classification = "no_active_demand_non_shipping_line";
  } else if (!shipmentBlocking) {
    classification = "review_only_nonblocking";
  } else if (
    row.exception_type === "inventory_deduction_failed" &&
    itemStatus === "completed" &&
    hasFullPick &&
    hasNoPickLedger &&
    hasSinglePickBinStock
  ) {
    classification = "stale_completed_pick_unposted";
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
    shipmentBlocking,
    recoverable:
      classification === "duplicate_open_exception" ||
      classification === "stale_completed_pick_unposted" ||
      classification.startsWith("no_active_demand"),
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
      LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true' AS shipment_blocking,
      ae.requested_qty,
      ae.selected_location_id,
      ae.selected_location_code,
      ae.review_reason,
      ae.created_at::text,
      o.warehouse_id AS order_warehouse_id,
      o.warehouse_status AS order_status,
      o.cancelled_at::text,
      oi.status AS item_status,
      oi.name AS item_name,
      oi.product_id,
      oi.requires_shipping,
      oi.quantity,
      oi.picked_quantity,
      oi.location AS item_location,
      COALESCE(pick_tx.pick_transaction_qty, 0)::int AS pick_transaction_qty,
      COALESCE(selected_level.variant_qty, 0)::int AS selected_qty,
      selected_wl.warehouse_id AS selected_location_warehouse_id,
      selected_wl.location_type AS selected_location_type,
      selected_wl.is_pickable AS selected_location_pickable,
      selected_wl.is_active AS selected_location_active,
      COALESCE(pickable.pickable_positive_total, 0)::int AS pickable_positive_total,
      pickable.best_pickable_location_id,
      pickable.best_pickable_location_code,
      pickable.best_pickable_zone,
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
      SELECT COALESCE(SUM(ABS(it.variant_qty_delta)), 0)::int AS pick_transaction_qty
      FROM inventory.inventory_transactions it
      WHERE it.order_item_id = ae.order_item_id
        AND it.transaction_type = 'pick'
    ) pick_tx ON true
    LEFT JOIN LATERAL (
      SELECT
        SUM(il.variant_qty)::int AS pickable_positive_total,
        (ARRAY_AGG(wl.id ORDER BY il.variant_qty DESC, wl.code ASC))[1] AS best_pickable_location_id,
        (ARRAY_AGG(wl.code ORDER BY il.variant_qty DESC, wl.code ASC))[1] AS best_pickable_location_code,
        (ARRAY_AGG(wl.zone ORDER BY il.variant_qty DESC, wl.code ASC))[1] AS best_pickable_zone,
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

async function recoverCompletedPickLedger(
  client: pg.PoolClient,
  row: ClassifiedException,
): Promise<CompletedPickRecovery | null> {
  const lockedResult = await client.query<ExceptionRow>(`
    SELECT
      ae.id AS exception_id,
      ae.order_id,
      ae.order_number,
      ae.order_item_id,
      ae.sku,
      ae.product_variant_id,
      ae.exception_type,
      ae.status,
      LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true' AS shipment_blocking,
      ae.requested_qty,
      ae.selected_location_id,
      ae.selected_location_code,
      ae.review_reason,
      ae.created_at::text,
      o.warehouse_id AS order_warehouse_id,
      o.warehouse_status AS order_status,
      o.cancelled_at::text,
      oi.status AS item_status,
      oi.name AS item_name,
      oi.product_id,
      oi.requires_shipping,
      oi.quantity,
      oi.picked_quantity,
      oi.location AS item_location,
      COALESCE(pick_tx.pick_transaction_qty, 0)::int AS pick_transaction_qty,
      0::int AS selected_qty,
      NULL::int AS selected_location_warehouse_id,
      NULL::text AS selected_location_type,
      NULL::int AS selected_location_pickable,
      NULL::int AS selected_location_active,
      0::int AS pickable_positive_total,
      NULL::int AS best_pickable_location_id,
      NULL::text AS best_pickable_location_code,
      NULL::text AS best_pickable_zone,
      NULL::int AS best_pickable_warehouse_id,
      0::int AS best_pickable_qty,
      1::int AS open_exception_count,
      1::int AS item_exception_rank
    FROM wms.allocation_exceptions ae
    JOIN wms.orders o ON o.id = ae.order_id
    JOIN wms.order_items oi ON oi.id = ae.order_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(ABS(it.variant_qty_delta)), 0)::int AS pick_transaction_qty
      FROM inventory.inventory_transactions it
      WHERE it.order_item_id = ae.order_item_id
        AND it.transaction_type = 'pick'
    ) pick_tx ON true
    WHERE ae.id = $1
    FOR UPDATE OF ae, o, oi
  `, [row.exception_id]);

  const locked = lockedResult.rows[0];
  if (!locked) return null;

  const current = locked;
  const orderStatus = String(current.order_status || "").toLowerCase();
  const itemStatus = String(current.item_status || "").toLowerCase();
  const shipmentBlocking = current.status === "blocked" || current.shipment_blocking === true;
  const isActiveOrder = orderStatus !== "shipped" && orderStatus !== "cancelled" && !current.cancelled_at;
  const requiresShipping = Number(current.requires_shipping ?? 1) === 1;
  const hasFullPick =
    Number(current.quantity ?? 0) > 0 &&
    Number(current.picked_quantity ?? 0) >= Number(current.quantity ?? 0);
  const hasNoPickLedger = Number(current.pick_transaction_qty ?? 0) <= 0;

  if (
    current.exception_type !== "inventory_deduction_failed" ||
    !shipmentBlocking ||
    !isActiveOrder ||
    !requiresShipping ||
    itemStatus !== "completed" ||
    !hasFullPick ||
    !hasNoPickLedger
  ) {
    return null;
  }

  const qty = Math.max(
    Number(current.requested_qty ?? 0),
    Number(current.quantity ?? 0),
    Number(current.picked_quantity ?? 0),
  );
  if (!current.product_variant_id || qty <= 0) return null;

  const locationResult = await client.query<{
    level_id: number;
    location_id: number;
    code: string;
    zone: string | null;
    variant_qty: number;
    reserved_qty: number;
  }>(`
    SELECT
      il.id AS level_id,
      wl.id AS location_id,
      wl.code,
      wl.zone,
      il.variant_qty,
      il.reserved_qty
    FROM inventory.inventory_levels il
    JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
    WHERE il.product_variant_id = $1
      AND il.variant_qty >= $2
      AND wl.is_pickable = 1
      AND wl.is_active = 1
      AND wl.cycle_count_freeze_id IS NULL
      AND ($3::int IS NULL OR wl.warehouse_id = $3 OR wl.warehouse_id IS NULL)
    ORDER BY
      CASE WHEN wl.id = $4 THEN 0 ELSE 1 END,
      CASE WHEN NULLIF($5::text, '') IS NOT NULL AND UPPER(wl.code) = UPPER($5::text) THEN 0 ELSE 1 END,
      CASE wl.location_type WHEN 'pick' THEN 0 WHEN 'pallet' THEN 1 ELSE 9 END,
      il.variant_qty DESC,
      wl.code ASC
    LIMIT 1
    FOR UPDATE OF il
  `, [
    current.product_variant_id,
    qty,
    current.order_warehouse_id,
    current.selected_location_id,
    current.item_location && current.item_location !== "UNASSIGNED" ? current.item_location : "",
  ]);

  const location = locationResult.rows[0];
  if (!location) return null;

  const qtyBefore = Number(location.variant_qty ?? 0);
  const reservationRelease = Math.min(Math.max(0, Number(location.reserved_qty ?? 0)), qty);

  const levelUpdate = await client.query(`
    UPDATE inventory.inventory_levels
    SET
      variant_qty = variant_qty - $1,
      picked_qty = picked_qty + $1,
      reserved_qty = reserved_qty - $2,
      updated_at = NOW()
    WHERE id = $3
      AND variant_qty >= $1
    RETURNING id
  `, [qty, reservationRelease, location.level_id]);
  if ((levelUpdate.rowCount ?? 0) !== 1) return null;

  const txResult = await client.query<{ id: number }>(`
    INSERT INTO inventory.inventory_transactions (
      product_variant_id,
      from_location_id,
      transaction_type,
      variant_qty_delta,
      variant_qty_before,
      variant_qty_after,
      source_state,
      target_state,
      order_id,
      order_item_id,
      reference_type,
      reference_id,
      notes,
      is_implicit,
      user_id
    )
    VALUES (
      $1,
      $2,
      'pick',
      $3,
      $4,
      $5,
      'on_hand',
      'picked',
      $6,
      $7,
      'order',
      $8,
      $9,
      1,
      NULL
    )
    RETURNING id
  `, [
    current.product_variant_id,
    location.location_id,
    -qty,
    qtyBefore,
    qtyBefore - qty,
    current.order_id,
    current.order_item_id,
    String(current.order_id),
    `Recovered missing pick ledger for allocation exception #${current.exception_id}`,
  ]);

  const transactionId = txResult.rows[0]?.id;
  if (!transactionId) throw new Error(`Failed to create pick transaction for exception ${current.exception_id}`);

  await client.query(`
    UPDATE wms.order_items
    SET
      location = $1,
      zone = COALESCE($2, 'U'),
      status = 'completed',
      picked_quantity = GREATEST(picked_quantity, $3),
      picked_at = COALESCE(picked_at, NOW())
    WHERE id = $4
  `, [location.code, location.zone, qty, current.order_item_id]);

  await client.query(`
    UPDATE wms.outbound_shipment_items osi
    SET from_location_id = $1
    FROM wms.outbound_shipments os
    WHERE osi.shipment_id = os.id
      AND osi.order_item_id = $2
      AND osi.product_variant_id = $3
      AND osi.from_location_id IS NULL
      AND os.status IN ('planned', 'queued')
  `, [location.location_id, current.order_item_id, current.product_variant_id]);

  await client.query(`
    UPDATE wms.allocation_exceptions
    SET
      status = 'resolved',
      resolution = 'stale_pick_recovered',
      selected_location_id = COALESCE(selected_location_id, $1),
      selected_location_code = COALESCE(selected_location_code, $2),
      resolved_by = NULL,
      resolved_at = NOW(),
      updated_at = NOW(),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'recoveredBy', 'recover-allocation-exceptions',
        'recoveredAt', NOW(),
        'recoveryReason', 'stale_completed_pick_unposted',
        'recoveredPickTransactionId', $3::int,
        'recoveredLocationId', $1::int,
        'recoveredLocationCode', $2::text,
        'recoveredQty', $4::int
      )
    WHERE id = $5
      AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
  `, [location.location_id, location.code, transactionId, qty, current.exception_id]);

  await client.query(`
    INSERT INTO wms.picking_logs (
      action_type,
      order_id,
      order_number,
      order_item_id,
      product_id,
      sku,
      item_name,
      location_code,
      qty_requested,
      qty_before,
      qty_after,
      qty_delta,
      reason,
      notes,
      pick_method,
      order_status_before,
      item_status_before,
      item_status_after,
      metadata
    )
    VALUES (
      'allocation_pick_recovered',
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $9,
      0,
      'Recovered missing pick ledger after allocation deduction failure',
      $10,
      'system',
      $11,
      $12,
      'completed',
      jsonb_build_object(
        'exceptionId', $13::int,
        'inventoryTransactionId', $14::int,
        'recoveryReason', 'stale_completed_pick_unposted'
      )
    )
  `, [
    current.order_id,
    current.order_number,
    current.order_item_id,
    current.product_id,
    current.sku,
    current.item_name,
    location.code,
    qty,
    Number(current.picked_quantity ?? 0),
    `Posted recovered pick transaction #${transactionId} from ${location.code}.`,
    current.order_status,
    current.item_status,
    current.exception_id,
    transactionId,
  ]);

  const orderUpdate = await client.query(`
    UPDATE wms.orders o
    SET
      warehouse_status = 'ready_to_ship',
      completed_at = COALESCE(completed_at, NOW()),
      exception_resolution = 'resolved',
      exception_resolved_at = NOW(),
      exception_resolved_by = NULL,
      exception_notes = CONCAT(
        CASE WHEN COALESCE(exception_notes, '') = '' THEN '' ELSE exception_notes || E'\n' END,
        $2::text
      ),
      updated_at = NOW()
    WHERE o.id = $1
      AND o.warehouse_status = 'exception'
      AND EXISTS (
        SELECT 1 FROM wms.order_items oi
        WHERE oi.order_id = o.id AND oi.requires_shipping = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM wms.order_items oi
        WHERE oi.order_id = o.id
          AND oi.requires_shipping = 1
          AND (
            oi.status <> 'completed'
            OR COALESCE(oi.picked_quantity, 0) < oi.quantity
            OR COALESCE(NULLIF(oi.location, ''), 'UNASSIGNED') = 'UNASSIGNED'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM wms.allocation_exceptions ae
        WHERE ae.order_id = o.id
          AND ae.status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (
            ae.status = 'blocked'
            OR LOWER(COALESCE(ae.metadata->>'shipmentBlocking', 'false')) = 'true'
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM inventory.replen_tasks rt
        WHERE rt.order_id = o.id
          AND rt.blocks_shipment = TRUE
          AND rt.status NOT IN ('completed', 'cancelled')
      )
    RETURNING id
  `, [
    current.order_id,
    `Recovered allocation exception #${current.exception_id}: posted missing pick ledger from ${location.code}.`,
  ]);

  return {
    exceptionId: current.exception_id,
    orderId: current.order_id,
    orderItemId: current.order_item_id,
    transactionId,
    locationId: location.location_id,
    locationCode: location.code,
    qty,
    orderStatusUpdated: (orderUpdate.rowCount ?? 0) > 0,
  };
}

async function executeRecovery(client: pg.PoolClient, rows: ClassifiedException[]) {
  const duplicateIds = rows
    .filter((row) => row.classification === "duplicate_open_exception")
    .map((row) => row.exception_id);
  const noActiveDemandIds = rows
    .filter((row) => row.classification.startsWith("no_active_demand"))
    .map((row) => row.exception_id);
  const staleCompletedPickRows = rows
    .filter((row) => row.classification === "stale_completed_pick_unposted");
  const staleCompletedPickIds = staleCompletedPickRows.map((row) => row.exception_id);

  let cancelledDuplicates = 0;
  let resolvedNoActiveDemand = 0;
  const recoveredCompletedPicks: CompletedPickRecovery[] = [];

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

    for (const row of staleCompletedPickRows) {
      const recovered = await recoverCompletedPickLedger(client, row);
      if (recovered) recoveredCompletedPicks.push(recovered);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    duplicateIds,
    noActiveDemandIds,
    staleCompletedPickIds,
    cancelledDuplicates,
    resolvedNoActiveDemand,
    recoveredCompletedPicks,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await loadDotenvIfAvailable();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const useSSL = Boolean(
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
          staleCompletedPickIds: rows.filter((row) => row.classification === "stale_completed_pick_unposted").map((row) => row.exception_id),
          cancelledDuplicates: 0,
          resolvedNoActiveDemand: 0,
          recoveredCompletedPicks: [] as CompletedPickRecovery[],
        };

    const output = {
      mode: options.execute ? "execute" : "dry-run",
      scannedOpenExceptions: rows.length,
      recoverable: recovery.duplicateIds.length + recovery.noActiveDemandIds.length + recovery.staleCompletedPickIds.length,
      classificationCounts: countBy(rows, "classification"),
      stockCounts: countBy(rows, "stockClass"),
      duplicateExceptionIds: recovery.duplicateIds,
      noActiveDemandExceptionIds: recovery.noActiveDemandIds,
      staleCompletedPickExceptionIds: recovery.staleCompletedPickIds,
      cancelledDuplicates: recovery.cancelledDuplicates,
      resolvedNoActiveDemand: recovery.resolvedNoActiveDemand,
      recoveredCompletedPicks: recovery.recoveredCompletedPicks.length,
      completedPickRecoveries: recovery.recoveredCompletedPicks,
      activeBlockerSamples: rows.filter((row) => !row.recoverable && row.shipmentBlocking).slice(0, 20),
      reviewOnlySamples: rows.filter((row) => row.classification === "review_only_nonblocking").slice(0, 20),
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
