/**
 * Production-safe, read-only WMS inventory integrity audit.
 *
 * This intentionally does NOT reuse ledger-replay.ts. The current legacy
 * ledger does not contain complete bucket deltas, and its historical ship
 * rows can disagree with their own before/after quantities. These checks
 * compare independently observable invariants without inventing history.
 *
 * Usage:
 *   npx tsx scripts/audit-wms-inventory-integrity.ts --limit=25
 *   npx tsx scripts/audit-wms-inventory-integrity.ts --check=level_lot_bucket_drift
 *   npx tsx scripts/audit-wms-inventory-integrity.ts --json --limit=all
 *   npx tsx scripts/audit-wms-inventory-integrity.ts --fail-on-blockers
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  createObservedIntegrityFinding,
  type ObservedIntegrityFinding,
} from "../server/modules/inventory/integrity/integrity-registry.domain";

export type AuditSeverity = "blocker" | "warning";
export type AuditCategory =
  | "schema"
  | "balances"
  | "ledger"
  | "reservations"
  | "picking"
  | "receiving"
  | "returns"
  | "conversions"
  | "cycle_counts"
  | "replenishment"
  | "costs";

export type SampleLimit = number | "all";

export interface AuditFlags {
  help: boolean;
  json: boolean;
  failOnBlockers: boolean;
  listChecks: boolean;
  sampleLimit: SampleLimit;
  checkId: string | null;
  statementTimeoutMs: number;
}

export interface WmsIntegrityCheck {
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  description: string;
  remediationTarget: string;
  identityColumns: readonly string[];
  sql: string;
}

type WmsIntegrityCheckDefinition = Omit<WmsIntegrityCheck, "identityColumns">;

export interface WmsIntegrityCheckResult {
  check: WmsIntegrityCheck;
  count: number;
  samples: Record<string, unknown>[];
  elapsedMs: number;
}

export interface WmsAuditSnapshot {
  snapshotAt: string;
  databaseName: string;
  databaseUser: string;
  serverVersion: string;
  recoveryMode: boolean;
}

export interface WmsAuditSummary {
  checks: number;
  blockers: number;
  warnings: number;
  issueCount: number;
  byCategory: Record<string, number>;
}

export interface WmsAuditResult {
  snapshot: WmsAuditSnapshot;
  summary: WmsAuditSummary;
  results: WmsIntegrityCheckResult[];
}

const DEFAULT_SAMPLE_LIMIT = 25;
const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

const CHECK_IDENTITY_COLUMNS: Record<string, readonly string[]> = {
  inventory_level_constraint_gap: ["missing_constraint"],
  inventory_ledger_immutability_guard_missing: ["missing_guard"],
  negative_inventory_level_bucket: ["inventory_level_id"],
  stock_at_invalid_location: ["inventory_level_id"],
  level_lot_bucket_drift: ["product_variant_id", "warehouse_location_id"],
  negative_inventory_lot_bucket: ["inventory_lot_id"],
  ledger_row_arithmetic_mismatch: ["inventory_transaction_id"],
  critical_ledger_actor_missing: ["inventory_transaction_id"],
  reservation_ledger_missing_delta: ["inventory_transaction_id"],
  reservation_level_ledger_drift: ["product_variant_id", "warehouse_location_id"],
  terminal_order_open_reservation: ["order_id", "order_item_id", "product_variant_id"],
  order_item_quantity_invariant: ["order_item_id"],
  active_pick_ledger_drift: ["order_item_id"],
  active_pick_cogs_drift: ["order_item_id"],
  closed_receipt_line_ledger_drift: ["receiving_order_id", "product_variant_id", "warehouse_location_id"],
  receipt_identity_collision_shape: ["receiving_order_id", "product_variant_id", "putaway_location_id"],
  closed_receipt_header_drift: ["receiving_order_id"],
  return_item_quantity_invalid: ["return_item_id"],
  cumulative_return_exceeds_fulfilled: ["order_item_id"],
  duplicate_refund_return_identity: ["order_id", "refund_external_id"],
  untraceable_case_break_adjustment: ["inventory_transaction_id"],
  invalid_variant_hierarchy: ["child_variant_id"],
  multiple_active_base_variants: ["product_id"],
  cycle_count_terminal_with_unresolved_items: ["cycle_count_id", "cycle_count_item_id"],
  cycle_count_freeze_state_drift: ["warehouse_location_id"],
  stale_in_progress_cycle_count: ["cycle_count_id"],
  inline_replen_not_completed: ["replen_task_id"],
  duplicate_active_replen_task: [
    "from_location_id",
    "to_location_id",
    "source_product_variant_id",
    "pick_product_variant_id",
    "order_id",
    "order_item_id",
    "replen_method",
  ],
  lot_cost_mirror_drift: ["inventory_lot_id"],
  order_item_cost_mirror_drift: ["order_item_cost_id"],
  duplicate_lot_number: ["lot_number"],
};

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/audit-wms-inventory-integrity.ts [--limit=25]",
    "  npx tsx scripts/audit-wms-inventory-integrity.ts --check=level_lot_bucket_drift",
    "  npx tsx scripts/audit-wms-inventory-integrity.ts --json --limit=all",
    "",
    "Flags:",
    "  --limit=N|all              Sample rows per failing check. Default 25.",
    "  --check=ID                 Run one check.",
    "  --statement-timeout-ms=N   Per-query timeout. Default 60000.",
    "  --json                     Print machine-readable JSON.",
    "  --fail-on-blockers         Exit 1 when blocker rows exist.",
    "  --list-checks              Print check ids and exit.",
    "  --help                     Print this help.",
    "",
    "Safety:",
    "  The script opens one REPEATABLE READ, READ ONLY transaction and rolls it back.",
    "  It performs no repair, backfill, lock-taking write, or external API call.",
  ].join("\n");
}

export function parseFlags(argv: string[]): AuditFlags {
  const help = argv.includes("--help") || argv.includes("-h");
  const json = argv.includes("--json");
  const failOnBlockers = argv.includes("--fail-on-blockers");
  const listChecks = argv.includes("--list-checks");
  const allowedBare = new Set([
    "--help",
    "-h",
    "--json",
    "--fail-on-blockers",
    "--list-checks",
  ]);

  for (const arg of argv) {
    if (allowedBare.has(arg)) continue;
    if (arg.startsWith("--limit=")) continue;
    if (arg.startsWith("--check=")) continue;
    if (arg.startsWith("--statement-timeout-ms=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limitText = limitArg?.slice("--limit=".length).trim() ?? String(DEFAULT_SAMPLE_LIMIT);
  const sampleLimit: SampleLimit = limitText === "all" ? "all" : Number(limitText);
  if (sampleLimit !== "all" && (!Number.isInteger(sampleLimit) || sampleLimit <= 0)) {
    throw new Error("--limit must be a positive integer or all");
  }

  const checkArg = argv.find((arg) => arg.startsWith("--check="));
  const checkId = checkArg?.slice("--check=".length).trim() ?? null;
  if (checkId !== null && checkId.length === 0) {
    throw new Error("--check cannot be blank");
  }

  const timeoutArg = argv.find((arg) => arg.startsWith("--statement-timeout-ms="));
  const statementTimeoutMs = timeoutArg == null
    ? DEFAULT_STATEMENT_TIMEOUT_MS
    : Number(timeoutArg.slice("--statement-timeout-ms=".length).trim());
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 900_000) {
    throw new Error("--statement-timeout-ms must be an integer between 1000 and 900000");
  }

  return {
    help,
    json,
    failOnBlockers,
    listChecks,
    sampleLimit,
    checkId,
    statementTimeoutMs,
  };
}

export function buildWmsIntegrityChecks(): WmsIntegrityCheck[] {
  const checks: WmsIntegrityCheckDefinition[] = [
    {
      id: "inventory_level_constraint_gap",
      category: "schema",
      severity: "blocker",
      description: "Every live inventory quantity bucket needs an explicit non-negative database constraint.",
      remediationTarget: "inventory.inventory_levels CHECK constraints",
      sql: `
        WITH expected(name) AS (
          VALUES
            ('chk_variant_qty_non_negative'),
            ('chk_reserved_qty_non_negative'),
            ('chk_picked_qty_non_negative'),
            ('chk_packed_qty_non_negative'),
            ('chk_backorder_qty_non_negative')
        )
        SELECT e.name AS missing_constraint
        FROM expected e
        LEFT JOIN pg_constraint c
          ON c.conname = e.name
         AND c.conrelid = 'inventory.inventory_levels'::regclass
        WHERE c.oid IS NULL
        ORDER BY e.name
      `,
    },
    {
      id: "inventory_ledger_immutability_guard_missing",
      category: "schema",
      severity: "blocker",
      description: "The inventory movement journal needs a database guard that rejects mutation of posted rows.",
      remediationTarget: "inventory.inventory_transactions immutable-row trigger",
      sql: `
        SELECT 'inventory_transactions_immutable_guard' AS missing_guard
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_trigger t
          WHERE t.tgrelid = 'inventory.inventory_transactions'::regclass
            AND NOT t.tgisinternal
            AND t.tgenabled <> 'D'
            AND t.tgname = 'inventory_transactions_immutable_guard'
        )
      `,
    },
    {
      id: "negative_inventory_level_bucket",
      category: "balances",
      severity: "blocker",
      description: "No materialized inventory bucket may be negative.",
      remediationTarget: "inventory.inventory_levels",
      sql: `
        SELECT
          il.id AS inventory_level_id,
          il.product_variant_id,
          pv.sku,
          il.warehouse_location_id,
          wl.code AS location_code,
          wl.warehouse_id,
          il.variant_qty,
          il.reserved_qty,
          il.picked_qty,
          il.packed_qty,
          il.backorder_qty,
          il.updated_at
        FROM inventory.inventory_levels il
        LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
        WHERE il.variant_qty < 0
           OR il.reserved_qty < 0
           OR il.picked_qty < 0
           OR il.packed_qty < 0
           OR il.backorder_qty < 0
        ORDER BY il.updated_at DESC, il.id DESC
      `,
    },
    {
      id: "stock_at_invalid_location",
      category: "balances",
      severity: "warning",
      description: "Non-zero inventory must belong to an active location and an active warehouse.",
      remediationTarget: "warehouse.warehouse_locations and inventory.inventory_levels",
      sql: `
        SELECT
          il.id AS inventory_level_id,
          pv.sku,
          il.warehouse_location_id,
          wl.code AS location_code,
          wl.warehouse_id,
          wl.is_active AS location_is_active,
          w.is_active AS warehouse_is_active,
          il.variant_qty,
          il.reserved_qty,
          il.picked_qty,
          il.packed_qty,
          il.backorder_qty
        FROM inventory.inventory_levels il
        LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
        LEFT JOIN warehouse.warehouses w ON w.id = wl.warehouse_id
        WHERE (il.variant_qty <> 0 OR il.reserved_qty <> 0 OR il.picked_qty <> 0 OR il.packed_qty <> 0 OR il.backorder_qty <> 0)
          AND (wl.id IS NULL OR wl.is_active <> 1 OR wl.warehouse_id IS NULL OR w.id IS NULL OR w.is_active <> 1)
        ORDER BY il.id DESC
      `,
    },
    {
      id: "level_lot_bucket_drift",
      category: "balances",
      severity: "blocker",
      description: "Location-level on-hand, reserved, and picked buckets must equal the sum of their FIFO lots.",
      remediationTarget: "inventory.inventory_levels and inventory.inventory_lots",
      sql: `
        WITH lot_totals AS (
          SELECT
            product_variant_id,
            warehouse_location_id,
            COALESCE(SUM(qty_on_hand), 0)::bigint AS lot_on_hand,
            COALESCE(SUM(qty_reserved), 0)::bigint AS lot_reserved,
            COALESCE(SUM(qty_picked), 0)::bigint AS lot_picked,
            COUNT(*)::int AS lot_count
          FROM inventory.inventory_lots
          GROUP BY product_variant_id, warehouse_location_id
        ), cells AS (
          SELECT
            COALESCE(il.product_variant_id, lt.product_variant_id) AS product_variant_id,
            COALESCE(il.warehouse_location_id, lt.warehouse_location_id) AS warehouse_location_id,
            il.id AS inventory_level_id,
            COALESCE(il.variant_qty, 0)::bigint AS level_on_hand,
            COALESCE(il.reserved_qty, 0)::bigint AS level_reserved,
            COALESCE(il.picked_qty, 0)::bigint AS level_picked,
            COALESCE(lt.lot_on_hand, 0)::bigint AS lot_on_hand,
            COALESCE(lt.lot_reserved, 0)::bigint AS lot_reserved,
            COALESCE(lt.lot_picked, 0)::bigint AS lot_picked,
            COALESCE(lt.lot_count, 0)::int AS lot_count
          FROM inventory.inventory_levels il
          FULL OUTER JOIN lot_totals lt
            ON lt.product_variant_id = il.product_variant_id
           AND lt.warehouse_location_id = il.warehouse_location_id
        )
        SELECT
          c.*,
          pv.sku,
          wl.code AS location_code,
          wl.warehouse_id,
          c.level_on_hand - c.lot_on_hand AS on_hand_delta,
          c.level_reserved - c.lot_reserved AS reserved_delta,
          c.level_picked - c.lot_picked AS picked_delta
        FROM cells c
        LEFT JOIN catalog.product_variants pv ON pv.id = c.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = c.warehouse_location_id
        WHERE c.level_on_hand <> c.lot_on_hand
           OR c.level_reserved <> c.lot_reserved
           OR c.level_picked <> c.lot_picked
        ORDER BY GREATEST(
          ABS(c.level_on_hand - c.lot_on_hand),
          ABS(c.level_reserved - c.lot_reserved),
          ABS(c.level_picked - c.lot_picked)
        ) DESC, c.product_variant_id, c.warehouse_location_id
      `,
    },
    {
      id: "negative_inventory_lot_bucket",
      category: "balances",
      severity: "blocker",
      description: "FIFO lot quantity buckets may not be negative.",
      remediationTarget: "inventory.inventory_lots",
      sql: `
        SELECT
          il.id AS inventory_lot_id,
          il.lot_number,
          il.product_variant_id,
          pv.sku,
          il.warehouse_location_id,
          wl.code AS location_code,
          il.qty_on_hand,
          il.qty_reserved,
          il.qty_picked,
          il.qty_received,
          il.qty_consumed,
          il.status
        FROM inventory.inventory_lots il
        LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
        WHERE il.qty_on_hand < 0
           OR il.qty_reserved < 0
           OR il.qty_picked < 0
           OR COALESCE(il.qty_received, 0) < 0
           OR COALESCE(il.qty_consumed, 0) < 0
        ORDER BY il.id DESC
      `,
    },
    {
      id: "ledger_row_arithmetic_mismatch",
      category: "ledger",
      severity: "blocker",
      description: "A posted movement row's delta must equal its own after-minus-before quantity.",
      remediationTarget: "inventory.inventory_transactions movement semantics",
      sql: `
        SELECT
          it.id AS inventory_transaction_id,
          it.transaction_type,
          it.product_variant_id,
          pv.sku,
          it.from_location_id,
          it.to_location_id,
          it.variant_qty_delta,
          it.variant_qty_before,
          it.variant_qty_after,
          it.variant_qty_after - it.variant_qty_before AS observed_delta,
          it.order_id,
          it.order_item_id,
          it.shipment_id,
          it.reference_type,
          it.reference_id,
          it.created_at
        FROM inventory.inventory_transactions it
        LEFT JOIN catalog.product_variants pv ON pv.id = it.product_variant_id
        WHERE it.voided_at IS NULL
          AND it.transaction_type IN ('receipt', 'pick', 'unpick', 'adjustment', 'csv_upload', 'sku_correction')
          AND it.variant_qty_before IS NOT NULL
          AND it.variant_qty_after IS NOT NULL
          AND (it.variant_qty_after - it.variant_qty_before) <> it.variant_qty_delta
        ORDER BY it.created_at DESC, it.id DESC
      `,
    },
    {
      id: "critical_ledger_actor_missing",
      category: "ledger",
      severity: "warning",
      description: "Operator-controlled inventory movements require an attributable actor.",
      remediationTarget: "inventory.inventory_transactions.user_id",
      sql: `
        SELECT
          it.id AS inventory_transaction_id,
          it.transaction_type,
          it.product_variant_id,
          pv.sku,
          it.from_location_id,
          it.to_location_id,
          it.variant_qty_delta,
          it.reference_type,
          it.reference_id,
          it.notes,
          it.created_at
        FROM inventory.inventory_transactions it
        LEFT JOIN catalog.product_variants pv ON pv.id = it.product_variant_id
        WHERE it.voided_at IS NULL
          AND it.transaction_type IN ('adjustment', 'csv_upload', 'sku_correction', 'break', 'assemble', 'transfer', 'return')
          AND NULLIF(BTRIM(COALESCE(it.user_id, '')), '') IS NULL
        ORDER BY it.created_at DESC, it.id DESC
      `,
    },
    {
      id: "reservation_ledger_missing_delta",
      category: "reservations",
      severity: "warning",
      description: "Reservation-affecting rows without signed bucket deltas cannot be attributed or replayed.",
      remediationTarget: "inventory.inventory_transactions.reserved_qty_delta",
      sql: `
        SELECT
          it.id AS inventory_transaction_id,
          it.transaction_type,
          it.order_id,
          it.order_item_id,
          it.product_variant_id,
          pv.sku,
          it.from_location_id,
          it.to_location_id,
          it.variant_qty_delta,
          it.created_at
        FROM inventory.inventory_transactions it
        LEFT JOIN catalog.product_variants pv ON pv.id = it.product_variant_id
        WHERE it.voided_at IS NULL
          AND it.transaction_type IN ('reserve', 'unreserve', 'pick')
          AND it.reserved_qty_delta IS NULL
        ORDER BY it.created_at DESC, it.id DESC
      `,
    },
    {
      id: "reservation_level_ledger_drift",
      category: "reservations",
      severity: "blocker",
      description: "Live reserved counters must equal signed reservation movements by variant and location.",
      remediationTarget: "order-owned reservation allocations",
      sql: `
        WITH reservation_cells AS (
          SELECT
            product_variant_id,
            to_location_id AS location_id,
            reserved_qty_delta::bigint AS delta,
            0::bigint AS legacy_missing_delta_count
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL AND transaction_type = 'reserve' AND reserved_qty_delta IS NOT NULL
          UNION ALL
          SELECT
            product_variant_id,
            from_location_id AS location_id,
            reserved_qty_delta::bigint AS delta,
            0::bigint AS legacy_missing_delta_count
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL AND transaction_type IN ('unreserve', 'pick') AND reserved_qty_delta IS NOT NULL
          UNION ALL
          SELECT
            product_variant_id,
            from_location_id AS location_id,
            -ABS(variant_qty_delta)::bigint AS delta,
            0::bigint AS legacy_missing_delta_count
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL AND transaction_type = 'reserve_move'
          UNION ALL
          SELECT
            product_variant_id,
            to_location_id AS location_id,
            ABS(variant_qty_delta)::bigint AS delta,
            0::bigint AS legacy_missing_delta_count
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL AND transaction_type = 'reserve_move'
          UNION ALL
          SELECT
            product_variant_id,
            CASE
              WHEN transaction_type = 'reserve' THEN to_location_id
              ELSE from_location_id
            END AS location_id,
            0::bigint AS delta,
            1::bigint AS legacy_missing_delta_count
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL
            AND transaction_type IN ('reserve', 'unreserve', 'pick')
            AND reserved_qty_delta IS NULL
        ), ledger_totals AS (
          SELECT
            product_variant_id,
            location_id,
            COALESCE(SUM(delta), 0)::bigint AS ledger_reserved,
            COALESCE(SUM(legacy_missing_delta_count), 0)::bigint AS legacy_missing_delta_count
          FROM reservation_cells
          WHERE product_variant_id IS NOT NULL AND location_id IS NOT NULL
          GROUP BY product_variant_id, location_id
        ), cells AS (
          SELECT
            COALESCE(il.product_variant_id, lt.product_variant_id) AS product_variant_id,
            COALESCE(il.warehouse_location_id, lt.location_id) AS warehouse_location_id,
            COALESCE(il.reserved_qty, 0)::bigint AS level_reserved,
            COALESCE(lt.ledger_reserved, 0)::bigint AS ledger_reserved,
            COALESCE(lt.legacy_missing_delta_count, 0)::bigint AS legacy_missing_delta_count
          FROM inventory.inventory_levels il
          FULL OUTER JOIN ledger_totals lt
            ON lt.product_variant_id = il.product_variant_id
           AND lt.location_id = il.warehouse_location_id
        )
        SELECT
          c.*,
          pv.sku,
          wl.code AS location_code,
          wl.warehouse_id,
          c.level_reserved - c.ledger_reserved AS reserved_delta
        FROM cells c
        LEFT JOIN catalog.product_variants pv ON pv.id = c.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = c.warehouse_location_id
        WHERE c.legacy_missing_delta_count = 0
          AND c.level_reserved <> c.ledger_reserved
        ORDER BY ABS(c.level_reserved - c.ledger_reserved) DESC, c.product_variant_id, c.warehouse_location_id
      `,
    },
    {
      id: "terminal_order_open_reservation",
      category: "reservations",
      severity: "blocker",
      description: "Shipped, cancelled, or completed WMS orders may not retain an open reservation balance.",
      remediationTarget: "order-scoped reservation release",
      sql: `
        WITH order_reservations AS (
          SELECT
            it.order_id,
            it.order_item_id,
            it.product_variant_id,
            COALESCE(SUM(it.reserved_qty_delta), 0)::bigint AS open_reserved
          FROM inventory.inventory_transactions it
          WHERE it.voided_at IS NULL
            AND it.transaction_type IN ('reserve', 'unreserve', 'pick')
            AND it.reserved_qty_delta IS NOT NULL
            AND it.order_id IS NOT NULL
          GROUP BY it.order_id, it.order_item_id, it.product_variant_id
          HAVING COALESCE(SUM(it.reserved_qty_delta), 0) > 0
        )
        SELECT
          r.order_id,
          o.order_number,
          o.warehouse_status,
          r.order_item_id,
          oi.sku,
          r.product_variant_id,
          r.open_reserved,
          o.updated_at
        FROM order_reservations r
        JOIN wms.orders o ON o.id = r.order_id
        LEFT JOIN wms.order_items oi ON oi.id = r.order_item_id
        WHERE o.warehouse_status IN ('shipped', 'cancelled', 'completed')
        ORDER BY o.updated_at DESC, r.order_id DESC, r.order_item_id
      `,
    },
    {
      id: "order_item_quantity_invariant",
      category: "picking",
      severity: "blocker",
      description: "Picked and fulfilled quantities must remain within zero and the authorized WMS line quantity.",
      remediationTarget: "wms.order_items quantity guards",
      sql: `
        SELECT
          oi.id AS order_item_id,
          oi.order_id,
          o.order_number,
          o.warehouse_status,
          oi.sku,
          oi.quantity,
          oi.picked_quantity,
          oi.fulfilled_quantity,
          oi.status,
          oi.location
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        WHERE oi.quantity < 0
           OR oi.picked_quantity < 0
           OR oi.fulfilled_quantity < 0
           OR oi.picked_quantity > oi.quantity
           OR oi.fulfilled_quantity > oi.quantity
        ORDER BY oi.id DESC
      `,
    },
    {
      id: "active_pick_ledger_drift",
      category: "picking",
      severity: "blocker",
      description: "An active WMS line's picked quantity must equal its net pick/unpick movements.",
      remediationTarget: "order-item-owned pick allocations",
      sql: `
        WITH pick_ledger AS (
          SELECT
            order_item_id,
            COALESCE(SUM(
              CASE
                WHEN transaction_type = 'pick' THEN -variant_qty_delta
                WHEN transaction_type = 'unpick' THEN -variant_qty_delta
                ELSE 0
              END
            ), 0)::bigint AS ledger_picked
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL
            AND transaction_type IN ('pick', 'unpick')
            AND order_item_id IS NOT NULL
          GROUP BY order_item_id
        )
        SELECT
          oi.id AS order_item_id,
          oi.order_id,
          o.order_number,
          o.warehouse_status,
          oi.sku,
          oi.quantity,
          oi.picked_quantity,
          oi.fulfilled_quantity,
          oi.status,
          oi.location,
          COALESCE(pl.ledger_picked, 0) AS ledger_picked,
          oi.picked_quantity - COALESCE(pl.ledger_picked, 0) AS picked_delta
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        LEFT JOIN pick_ledger pl ON pl.order_item_id = oi.id
        WHERE o.warehouse_status NOT IN ('shipped', 'cancelled')
          AND oi.requires_shipping = 1
          AND oi.picked_quantity <> COALESCE(pl.ledger_picked, 0)
        ORDER BY ABS(oi.picked_quantity - COALESCE(pl.ledger_picked, 0)) DESC, oi.id DESC
      `,
    },
    {
      id: "active_pick_cogs_drift",
      category: "picking",
      severity: "blocker",
      description: "An active WMS line's picked quantity must equal the FIFO cost quantity attributed to it.",
      remediationTarget: "oms.order_item_costs and WMS unpick semantics",
      sql: `
        WITH costs AS (
          SELECT order_item_id, COALESCE(SUM(qty), 0)::bigint AS costed_qty
          FROM oms.order_item_costs
          GROUP BY order_item_id
        )
        SELECT
          oi.id AS order_item_id,
          oi.order_id,
          o.order_number,
          o.warehouse_status,
          oi.sku,
          oi.quantity,
          oi.picked_quantity,
          oi.status,
          COALESCE(c.costed_qty, 0) AS costed_qty,
          oi.picked_quantity - COALESCE(c.costed_qty, 0) AS cost_qty_delta
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        LEFT JOIN costs c ON c.order_item_id = oi.id
        WHERE o.warehouse_status NOT IN ('shipped', 'cancelled')
          AND oi.requires_shipping = 1
          AND oi.picked_quantity <> COALESCE(c.costed_qty, 0)
        ORDER BY ABS(oi.picked_quantity - COALESCE(c.costed_qty, 0)) DESC, oi.id DESC
      `,
    },
    {
      id: "closed_receipt_line_ledger_drift",
      category: "receiving",
      severity: "blocker",
      description: "Closed receiving-line quantities must equal receipt movements for the same receipt, variant, and location.",
      remediationTarget: "receipt-event idempotency and receiving close",
      sql: `
        WITH line_totals AS (
          SELECT
            rl.receiving_order_id,
            rl.product_variant_id,
            rl.putaway_location_id,
            COALESCE(SUM(rl.received_qty), 0)::bigint AS line_received,
            COUNT(*)::int AS line_count
          FROM procurement.receiving_lines rl
          JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
          WHERE ro.status = 'closed' AND rl.received_qty > 0
          GROUP BY rl.receiving_order_id, rl.product_variant_id, rl.putaway_location_id
        ), ledger_totals AS (
          SELECT
            receiving_order_id,
            product_variant_id,
            to_location_id,
            COALESCE(SUM(variant_qty_delta), 0)::bigint AS ledger_received,
            COUNT(*)::int AS ledger_row_count
          FROM inventory.inventory_transactions
          WHERE voided_at IS NULL
            AND transaction_type = 'receipt'
            AND receiving_order_id IS NOT NULL
          GROUP BY receiving_order_id, product_variant_id, to_location_id
        )
        SELECT
          COALESCE(lt.receiving_order_id, it.receiving_order_id) AS receiving_order_id,
          ro.receipt_number,
          ro.status AS receiving_status,
          COALESCE(lt.product_variant_id, it.product_variant_id) AS product_variant_id,
          pv.sku,
          COALESCE(lt.putaway_location_id, it.to_location_id) AS warehouse_location_id,
          wl.code AS location_code,
          COALESCE(lt.line_received, 0) AS line_received,
          COALESCE(it.ledger_received, 0) AS ledger_received,
          COALESCE(lt.line_count, 0) AS line_count,
          COALESCE(it.ledger_row_count, 0) AS ledger_row_count,
          COALESCE(lt.line_received, 0) - COALESCE(it.ledger_received, 0) AS received_delta
        FROM line_totals lt
        FULL OUTER JOIN ledger_totals it
          ON it.receiving_order_id = lt.receiving_order_id
         AND it.product_variant_id = lt.product_variant_id
         AND it.to_location_id = lt.putaway_location_id
        LEFT JOIN procurement.receiving_orders ro ON ro.id = COALESCE(lt.receiving_order_id, it.receiving_order_id)
        LEFT JOIN catalog.product_variants pv ON pv.id = COALESCE(lt.product_variant_id, it.product_variant_id)
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = COALESCE(lt.putaway_location_id, it.to_location_id)
        WHERE ro.status = 'closed'
          AND COALESCE(lt.line_received, 0) <> COALESCE(it.ledger_received, 0)
        ORDER BY ABS(COALESCE(lt.line_received, 0) - COALESCE(it.ledger_received, 0)) DESC,
                 COALESCE(lt.receiving_order_id, it.receiving_order_id) DESC
      `,
    },
    {
      id: "receipt_identity_collision_shape",
      category: "receiving",
      severity: "warning",
      description: "Multiple positive lines sharing receipt, variant, and location cannot be distinguished by the current receipt idempotency key.",
      remediationTarget: "receipt-event and receiving-line identity",
      sql: `
        SELECT
          rl.receiving_order_id,
          ro.receipt_number,
          ro.status,
          rl.product_variant_id,
          pv.sku,
          rl.putaway_location_id,
          wl.code AS location_code,
          COUNT(*)::int AS positive_line_count,
          ARRAY_AGG(rl.id ORDER BY rl.id) AS receiving_line_ids,
          SUM(rl.received_qty)::bigint AS total_received_qty
        FROM procurement.receiving_lines rl
        JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
        LEFT JOIN catalog.product_variants pv ON pv.id = rl.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = rl.putaway_location_id
        WHERE rl.received_qty > 0
          AND rl.product_variant_id IS NOT NULL
          AND rl.putaway_location_id IS NOT NULL
        GROUP BY rl.receiving_order_id, ro.receipt_number, ro.status,
                 rl.product_variant_id, pv.sku, rl.putaway_location_id, wl.code
        HAVING COUNT(*) > 1
        ORDER BY rl.receiving_order_id DESC, positive_line_count DESC
      `,
    },
    {
      id: "closed_receipt_header_drift",
      category: "receiving",
      severity: "warning",
      description: "Closed receiving headers must equal their line-level received counts and quantities.",
      remediationTarget: "procurement.receiving_orders materialized totals",
      sql: `
        WITH totals AS (
          SELECT
            receiving_order_id,
            COUNT(*) FILTER (WHERE received_qty > 0)::int AS received_line_count,
            COALESCE(SUM(received_qty), 0)::bigint AS received_total_units
          FROM procurement.receiving_lines
          GROUP BY receiving_order_id
        )
        SELECT
          ro.id AS receiving_order_id,
          ro.receipt_number,
          ro.received_line_count AS header_line_count,
          COALESCE(t.received_line_count, 0) AS actual_line_count,
          ro.received_total_units AS header_total_units,
          COALESCE(t.received_total_units, 0) AS actual_total_units,
          ro.closed_date,
          ro.updated_at
        FROM procurement.receiving_orders ro
        LEFT JOIN totals t ON t.receiving_order_id = ro.id
        WHERE ro.status = 'closed'
          AND (
            COALESCE(ro.received_line_count, 0) <> COALESCE(t.received_line_count, 0)
            OR COALESCE(ro.received_total_units, 0) <> COALESCE(t.received_total_units, 0)
          )
        ORDER BY ro.closed_date DESC NULLS LAST, ro.id DESC
      `,
    },
    {
      id: "return_item_quantity_invalid",
      category: "returns",
      severity: "blocker",
      description: "Return expected and received quantities must be positive, bounded, and tied to their WMS order.",
      remediationTarget: "WMS return authorization and receipt events",
      sql: `
        SELECT
          ri.id AS return_item_id,
          ri.return_id,
          r.order_id AS return_order_id,
          r.refund_external_id,
          ri.order_item_id,
          oi.order_id AS item_order_id,
          ri.sku,
          ri.expected_qty,
          ri.received_qty,
          oi.fulfilled_quantity,
          ri.status,
          ri.updated_at
        FROM wms.return_items ri
        JOIN wms.returns r ON r.id = ri.return_id
        LEFT JOIN wms.order_items oi ON oi.id = ri.order_item_id
        WHERE ri.expected_qty <= 0
           OR ri.received_qty < 0
           OR ri.received_qty > ri.expected_qty
           OR (ri.order_item_id IS NOT NULL AND (oi.id IS NULL OR oi.order_id <> r.order_id))
        ORDER BY ri.updated_at DESC, ri.id DESC
      `,
    },
    {
      id: "cumulative_return_exceeds_fulfilled",
      category: "returns",
      severity: "blocker",
      description: "Cumulative physically received returns may not exceed the WMS line's fulfilled quantity.",
      remediationTarget: "order-line return entitlement",
      sql: `
        SELECT
          ri.order_item_id,
          oi.order_id,
          o.order_number,
          oi.sku,
          oi.quantity,
          oi.fulfilled_quantity,
          SUM(ri.received_qty)::bigint AS returned_received_qty,
          ARRAY_AGG(DISTINCT ri.return_id ORDER BY ri.return_id) AS return_ids
        FROM wms.return_items ri
        JOIN wms.order_items oi ON oi.id = ri.order_item_id
        JOIN wms.orders o ON o.id = oi.order_id
        WHERE ri.received_qty > 0
        GROUP BY ri.order_item_id, oi.order_id, o.order_number, oi.sku, oi.quantity, oi.fulfilled_quantity
        HAVING SUM(ri.received_qty) > oi.fulfilled_quantity
        ORDER BY SUM(ri.received_qty) - oi.fulfilled_quantity DESC, ri.order_item_id DESC
      `,
    },
    {
      id: "duplicate_refund_return_identity",
      category: "returns",
      severity: "blocker",
      description: "A channel refund identity may create at most one active WMS return for an order.",
      remediationTarget: "wms.returns refund idempotency constraint",
      sql: `
        SELECT
          order_id,
          refund_external_id,
          COUNT(*)::int AS return_count,
          ARRAY_AGG(id ORDER BY id) AS return_ids,
          MIN(created_at) AS first_created_at,
          MAX(created_at) AS last_created_at
        FROM wms.returns
        WHERE NULLIF(BTRIM(COALESCE(refund_external_id, '')), '') IS NOT NULL
        GROUP BY order_id, refund_external_id
        HAVING COUNT(*) > 1
        ORDER BY return_count DESC, last_created_at DESC
      `,
    },
    {
      id: "untraceable_case_break_adjustment",
      category: "conversions",
      severity: "warning",
      description: "Case-break movements need one durable conversion identity linking source, target, remainder, actor, and cost.",
      remediationTarget: "inventory conversion operation journal",
      sql: `
        SELECT
          it.id AS inventory_transaction_id,
          it.product_variant_id,
          pv.sku,
          it.from_location_id,
          it.to_location_id,
          it.variant_qty_delta,
          it.batch_id,
          it.notes,
          it.user_id,
          it.created_at
        FROM inventory.inventory_transactions it
        LEFT JOIN catalog.product_variants pv ON pv.id = it.product_variant_id
        WHERE it.voided_at IS NULL
          AND (
            it.transaction_type IN ('break', 'assemble')
            OR (
              it.transaction_type = 'adjustment'
              AND (
                LOWER(COALESCE(it.notes, '')) LIKE 'case break:%'
                OR LOWER(COALESCE(it.notes, '')) LIKE 'case-break%'
                OR LOWER(COALESCE(it.notes, '')) LIKE 'replen case-break%'
              )
            )
          )
          AND NULLIF(BTRIM(COALESCE(it.batch_id, '')), '') IS NULL
        ORDER BY it.created_at DESC, it.id DESC
      `,
    },
    {
      id: "invalid_variant_hierarchy",
      category: "conversions",
      severity: "blocker",
      description: "A variant's parent_variant_id break target must share its product and contain fewer base units.",
      remediationTarget: "catalog.product_variants hierarchy constraints",
      sql: `
        SELECT
          child.id AS child_variant_id,
          child.sku AS child_sku,
          child.product_id AS child_product_id,
          child.units_per_variant AS child_units_per_variant,
          parent.id AS parent_variant_id,
          parent.sku AS parent_sku,
          parent.product_id AS parent_product_id,
          parent.units_per_variant AS parent_units_per_variant,
          child.is_active AS child_is_active,
          parent.is_active AS parent_is_active
        FROM catalog.product_variants child
        LEFT JOIN catalog.product_variants parent ON parent.id = child.parent_variant_id
        WHERE child.parent_variant_id IS NOT NULL
          AND (
            parent.id IS NULL
            OR parent.product_id <> child.product_id
            OR parent.units_per_variant >= child.units_per_variant
          )
        ORDER BY child.id
      `,
    },
    {
      id: "multiple_active_base_variants",
      category: "conversions",
      severity: "warning",
      description: "Case-break remainder routing is nondeterministic when a product has multiple active base-unit variants.",
      remediationTarget: "catalog base-variant uniqueness",
      sql: `
        SELECT
          product_id,
          COUNT(*)::int AS active_base_variant_count,
          ARRAY_AGG(id ORDER BY id) AS variant_ids,
          ARRAY_AGG(sku ORDER BY id) AS skus
        FROM catalog.product_variants
        WHERE is_active = true AND is_base_unit = true
        GROUP BY product_id
        HAVING COUNT(*) > 1
        ORDER BY active_base_variant_count DESC, product_id
      `,
    },
    {
      id: "cycle_count_terminal_with_unresolved_items",
      category: "cycle_counts",
      severity: "blocker",
      description: "A completed cycle count may not contain pending, investigative, or unapproved variance items.",
      remediationTarget: "inventory.cycle_counts completion transaction",
      sql: `
        SELECT
          cc.id AS cycle_count_id,
          cc.name,
          cc.status AS cycle_count_status,
          cc.completed_at,
          cci.id AS cycle_count_item_id,
          cci.status AS item_status,
          cci.expected_sku,
          cci.expected_qty,
          cci.counted_sku,
          cci.counted_qty,
          cci.variance_type,
          cci.variance_qty,
          cci.requires_approval
        FROM inventory.cycle_counts cc
        JOIN inventory.cycle_count_items cci ON cci.cycle_count_id = cc.id
        WHERE cc.status = 'completed'
          AND (
            cci.status IN ('pending', 'investigate')
            OR (
              cci.variance_type IS NOT NULL
              AND cci.status NOT IN ('approved', 'adjusted', 'resolved')
            )
          )
        ORDER BY cc.completed_at DESC NULLS LAST, cc.id DESC, cci.id
      `,
    },
    {
      id: "cycle_count_freeze_state_drift",
      category: "cycle_counts",
      severity: "blocker",
      description: "Only in-progress cycle counts may own frozen warehouse locations.",
      remediationTarget: "cycle-count status and location freeze atomicity",
      sql: `
        SELECT
          wl.id AS warehouse_location_id,
          wl.code AS location_code,
          wl.warehouse_id,
          wl.cycle_count_freeze_id AS cycle_count_id,
          cc.name AS cycle_count_name,
          cc.status AS cycle_count_status,
          cc.started_at,
          cc.completed_at
        FROM warehouse.warehouse_locations wl
        LEFT JOIN inventory.cycle_counts cc ON cc.id = wl.cycle_count_freeze_id
        WHERE wl.cycle_count_freeze_id IS NOT NULL
          AND (cc.id IS NULL OR cc.status <> 'in_progress')
        ORDER BY wl.id
      `,
    },
    {
      id: "stale_in_progress_cycle_count",
      category: "cycle_counts",
      severity: "warning",
      description: "Cycle counts left in progress beyond three days require explicit review rather than silent auto-completion.",
      remediationTarget: "cycle-count exception workflow",
      sql: `
        SELECT
          cc.id AS cycle_count_id,
          cc.name,
          cc.warehouse_id,
          cc.status,
          cc.started_at,
          cc.created_at,
          COUNT(DISTINCT wl.id)::int AS frozen_location_count,
          COUNT(DISTINCT cci.id) FILTER (WHERE cci.status IN ('pending', 'investigate', 'variance'))::int AS unresolved_item_count
        FROM inventory.cycle_counts cc
        LEFT JOIN warehouse.warehouse_locations wl ON wl.cycle_count_freeze_id = cc.id
        LEFT JOIN inventory.cycle_count_items cci ON cci.cycle_count_id = cc.id
        WHERE cc.status = 'in_progress'
          AND COALESCE(cc.started_at, cc.created_at) < NOW() - INTERVAL '3 days'
        GROUP BY cc.id, cc.name, cc.warehouse_id, cc.status, cc.started_at, cc.created_at
        ORDER BY COALESCE(cc.started_at, cc.created_at), cc.id
      `,
    },
    {
      id: "inline_replen_not_completed",
      category: "replenishment",
      severity: "blocker",
      description: "Inline replenishment is system-authoritative and may not remain queued after its execution window.",
      remediationTarget: "inventory.replen_tasks inline execution",
      sql: `
        SELECT
          rt.id AS replen_task_id,
          rt.status,
          rt.execution_mode,
          rt.replen_method,
          rt.auto_replen,
          rt.from_location_id,
          src.code AS source_location,
          rt.to_location_id,
          dest.code AS target_location,
          rt.source_product_variant_id,
          source_variant.sku AS source_sku,
          rt.pick_product_variant_id,
          pick_variant.sku AS pick_sku,
          rt.qty_source_units,
          rt.qty_target_units,
          rt.qty_completed,
          rt.order_id,
          rt.order_item_id,
          rt.exception_reason,
          rt.created_at
        FROM inventory.replen_tasks rt
        LEFT JOIN warehouse.warehouse_locations src ON src.id = rt.from_location_id
        LEFT JOIN warehouse.warehouse_locations dest ON dest.id = rt.to_location_id
        LEFT JOIN catalog.product_variants source_variant ON source_variant.id = rt.source_product_variant_id
        LEFT JOIN catalog.product_variants pick_variant ON pick_variant.id = rt.pick_product_variant_id
        WHERE rt.execution_mode = 'inline'
          AND rt.status IN ('pending', 'assigned', 'in_progress', 'blocked')
          AND rt.created_at < NOW() - INTERVAL '5 minutes'
        ORDER BY rt.created_at, rt.id
      `,
    },
    {
      id: "duplicate_active_replen_task",
      category: "replenishment",
      severity: "warning",
      description: "Equivalent active replenishment work must have one durable task identity.",
      remediationTarget: "inventory.replen_tasks active idempotency key",
      sql: `
        SELECT
          from_location_id,
          to_location_id,
          source_product_variant_id,
          pick_product_variant_id,
          order_id,
          order_item_id,
          replen_method,
          COUNT(*)::int AS active_task_count,
          ARRAY_AGG(id ORDER BY id) AS task_ids,
          MIN(created_at) AS first_created_at,
          MAX(created_at) AS last_created_at
        FROM inventory.replen_tasks
        WHERE status IN ('pending', 'assigned', 'in_progress', 'blocked')
        GROUP BY from_location_id, to_location_id, source_product_variant_id,
                 pick_product_variant_id, order_id, order_item_id, replen_method
        HAVING COUNT(*) > 1
        ORDER BY active_task_count DESC, last_created_at DESC
      `,
    },
    {
      id: "lot_cost_mirror_drift",
      category: "costs",
      severity: "blocker",
      description: "Derived lot cent mirrors must equal authoritative integer mills.",
      remediationTarget: "inventory.inventory_lots cost projections",
      sql: `
        SELECT
          il.id AS inventory_lot_id,
          il.lot_number,
          il.product_variant_id,
          pv.sku,
          il.warehouse_location_id,
          il.unit_cost_mills,
          il.unit_cost_cents,
          il.po_unit_cost_mills,
          il.po_unit_cost_cents,
          il.packaging_cost_mills,
          il.packaging_cost_cents,
          il.landed_cost_mills,
          il.landed_cost_cents,
          il.total_unit_cost_mills,
          il.total_unit_cost_cents,
          il.cost_source,
          il.cost_provisional
        FROM inventory.inventory_lots il
        LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        WHERE ROUND(il.unit_cost_mills::numeric / 100) <> COALESCE(il.unit_cost_cents, 0)::numeric
           OR ROUND(il.po_unit_cost_mills::numeric / 100) <> COALESCE(il.po_unit_cost_cents, 0)::numeric
           OR ROUND(il.packaging_cost_mills::numeric / 100) <> COALESCE(il.packaging_cost_cents, 0)::numeric
           OR ROUND(il.landed_cost_mills::numeric / 100) <> COALESCE(il.landed_cost_cents, 0)::numeric
           OR ROUND(il.total_unit_cost_mills::numeric / 100) <> COALESCE(il.total_unit_cost_cents, 0)::numeric
        ORDER BY il.id DESC
      `,
    },
    {
      id: "order_item_cost_mirror_drift",
      category: "costs",
      severity: "blocker",
      description: "Derived order-line COGS cents must equal authoritative integer mills.",
      remediationTarget: "oms.order_item_costs cost projections",
      sql: `
        SELECT
          oic.id AS order_item_cost_id,
          oic.order_id,
          o.order_number,
          oic.order_item_id,
          oi.sku,
          oic.inventory_lot_id,
          oic.qty,
          oic.unit_cost_mills,
          oic.unit_cost_cents,
          oic.total_cost_mills,
          oic.total_cost_cents
        FROM oms.order_item_costs oic
        LEFT JOIN wms.orders o ON o.id = oic.order_id
        LEFT JOIN wms.order_items oi ON oi.id = oic.order_item_id
        WHERE ROUND(oic.unit_cost_mills::numeric / 100) <> oic.unit_cost_cents::numeric
           OR ROUND(oic.total_cost_mills::numeric / 100) <> oic.total_cost_cents::numeric
           OR oic.total_cost_mills <> oic.unit_cost_mills * oic.qty
        ORDER BY oic.id DESC
      `,
    },
    {
      id: "duplicate_lot_number",
      category: "costs",
      severity: "warning",
      description: "Lot numbers must uniquely identify a cost layer.",
      remediationTarget: "inventory.inventory_lots lot-number allocation",
      sql: `
        SELECT
          lot_number,
          COUNT(*)::int AS lot_count,
          ARRAY_AGG(id ORDER BY id) AS lot_ids,
          MIN(created_at) AS first_created_at,
          MAX(created_at) AS last_created_at
        FROM inventory.inventory_lots
        GROUP BY lot_number
        HAVING COUNT(*) > 1
        ORDER BY lot_count DESC, last_created_at DESC
      `,
    },
  ];

  return checks.map((check) => {
    const identityColumns = CHECK_IDENTITY_COLUMNS[check.id];
    if (!identityColumns) throw new Error(`WMS integrity check ${check.id} has no finding identity contract`);
    return { ...check, identityColumns };
  });
}

export function requiredWmsIntegrityAuditRelations(): string[] {
  const relations = new Set<string>();
  for (const check of buildWmsIntegrityChecks()) {
    for (const match of check.sql.matchAll(
      /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi,
    )) {
      relations.add(match[1].toLowerCase());
    }
  }
  return [...relations].sort();
}

function loadDotenvIfAvailable(): void {
  if (process.env.DATABASE_URL) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const env = fs.readFileSync(envPath, "utf8").replace(/\0/g, "");
  for (const line of env.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt);
    if (process.env[key]) continue;
    let value = trimmed.slice(equalsAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function connectionStringFromEnv(): string {
  loadDotenvIfAvailable();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return connectionString;
}

function normalizeSql(sqlText: string): string {
  return sqlText.trim().replace(/;+\s*$/, "");
}

function stripInternalCount(row: Record<string, unknown>): Record<string, unknown> {
  const { __issue_count: _ignored, ...sample } = row;
  return sample;
}

function integerField(row: Record<string, unknown>, key: string): bigint {
  const value = row[key];
  if (value === null || value === undefined) return BigInt(0);
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Integrity field ${key} is not a safe integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`Integrity field ${key} is not an integer: ${String(value)}`);
}

function abs(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

function max(values: bigint[]): bigint {
  return values.reduce((current, value) => value > current ? value : current, BigInt(0));
}

function negativeMagnitude(row: Record<string, unknown>, keys: string[]): bigint {
  return keys.reduce((total, key) => {
    const value = integerField(row, key);
    return value < BigInt(0) ? total - value : total;
  }, BigInt(0));
}

export function findingMagnitude(checkId: string, row: Record<string, unknown>): bigint {
  let magnitude: bigint;
  switch (checkId) {
    case "negative_inventory_level_bucket":
      magnitude = negativeMagnitude(row, [
        "variant_qty",
        "reserved_qty",
        "picked_qty",
        "packed_qty",
        "backorder_qty",
      ]);
      break;
    case "level_lot_bucket_drift":
      magnitude = max([
        abs(integerField(row, "on_hand_delta")),
        abs(integerField(row, "reserved_delta")),
        abs(integerField(row, "picked_delta")),
      ]);
      break;
    case "negative_inventory_lot_bucket":
      magnitude = negativeMagnitude(row, [
        "qty_on_hand",
        "qty_reserved",
        "qty_picked",
        "qty_received",
        "qty_consumed",
      ]);
      break;
    case "ledger_row_arithmetic_mismatch":
      magnitude = abs(integerField(row, "observed_delta") - integerField(row, "variant_qty_delta"));
      break;
    case "reservation_level_ledger_drift":
      magnitude = abs(integerField(row, "reserved_delta"));
      break;
    case "terminal_order_open_reservation":
      magnitude = abs(integerField(row, "open_reserved"));
      break;
    case "order_item_quantity_invariant": {
      const quantity = integerField(row, "quantity");
      const picked = integerField(row, "picked_quantity");
      const fulfilled = integerField(row, "fulfilled_quantity");
      magnitude = max([
        quantity < BigInt(0) ? -quantity : BigInt(0),
        picked < BigInt(0) ? -picked : BigInt(0),
        fulfilled < BigInt(0) ? -fulfilled : BigInt(0),
        picked > quantity ? picked - quantity : BigInt(0),
        fulfilled > quantity ? fulfilled - quantity : BigInt(0),
      ]);
      break;
    }
    case "active_pick_ledger_drift":
      magnitude = abs(integerField(row, "picked_delta"));
      break;
    case "active_pick_cogs_drift":
      magnitude = abs(integerField(row, "cost_qty_delta"));
      break;
    case "closed_receipt_line_ledger_drift":
      magnitude = abs(integerField(row, "received_delta"));
      break;
    case "receipt_identity_collision_shape":
      magnitude = integerField(row, "positive_line_count");
      break;
    case "closed_receipt_header_drift":
      magnitude = max([
        abs(integerField(row, "header_line_count") - integerField(row, "actual_line_count")),
        abs(integerField(row, "header_total_units") - integerField(row, "actual_total_units")),
      ]);
      break;
    case "cumulative_return_exceeds_fulfilled":
      magnitude = abs(
        integerField(row, "returned_received_qty") - integerField(row, "fulfilled_quantity"),
      );
      break;
    case "duplicate_refund_return_identity":
      magnitude = integerField(row, "return_count");
      break;
    case "multiple_active_base_variants":
      magnitude = integerField(row, "active_base_variant_count");
      break;
    case "duplicate_active_replen_task":
      magnitude = integerField(row, "active_task_count");
      break;
    case "duplicate_lot_number":
      magnitude = integerField(row, "lot_count");
      break;
    default:
      magnitude = BigInt(1);
  }
  return magnitude > BigInt(0) ? magnitude : BigInt(1);
}

export function buildObservedIntegrityFindings(result: WmsAuditResult): ObservedIntegrityFinding[] {
  const findings: ObservedIntegrityFinding[] = [];
  const seen = new Set<string>();
  for (const checkResult of result.results) {
    if (checkResult.samples.length !== checkResult.count) {
      throw new Error(
        `Cannot record WMS integrity check ${checkResult.check.id}: `
          + `received ${checkResult.samples.length} of ${checkResult.count} findings. Run with --limit=all.`,
      );
    }
    for (const evidence of checkResult.samples) {
      const finding = createObservedIntegrityFinding({
        checkId: checkResult.check.id,
        category: checkResult.check.category,
        severity: checkResult.check.severity,
        identityColumns: checkResult.check.identityColumns,
        evidence,
        metricValue: findingMagnitude(checkResult.check.id, evidence),
      });
      const key = `${finding.checkId}:${finding.entityFingerprint}`;
      if (seen.has(key)) {
        throw new Error(`WMS integrity check ${checkResult.check.id} returned duplicate entity identity ${key}`);
      }
      seen.add(key);
      findings.push(finding);
    }
  }
  return findings;
}

export async function runCheck(
  client: Pick<PoolClient, "query">,
  check: WmsIntegrityCheck,
  sampleLimit: SampleLimit,
): Promise<WmsIntegrityCheckResult> {
  const startedAt = Date.now();
  const baseSql = normalizeSql(check.sql);
  const query = sampleLimit === "all"
    ? `SELECT audit_issue.*, COUNT(*) OVER()::bigint AS __issue_count FROM (${baseSql}) audit_issue`
    : `SELECT audit_issue.*, COUNT(*) OVER()::bigint AS __issue_count FROM (${baseSql}) audit_issue LIMIT $1`;
  const params = sampleLimit === "all" ? [] : [sampleLimit];
  const result = await client.query(query, params);
  const count = result.rows.length === 0 ? 0 : Number(result.rows[0].__issue_count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`WMS integrity check ${check.id} returned invalid issue count: ${String(result.rows[0]?.__issue_count)}`);
  }

  return {
    check,
    count,
    samples: result.rows.map((row) => stripInternalCount(row)),
    elapsedMs: Date.now() - startedAt,
  };
}

export function summarizeResults(results: WmsIntegrityCheckResult[]): WmsAuditSummary {
  const blockers = results
    .filter((result) => result.check.severity === "blocker")
    .reduce((total, result) => total + result.count, 0);
  const warnings = results
    .filter((result) => result.check.severity === "warning")
    .reduce((total, result) => total + result.count, 0);
  const byCategory: Record<string, number> = {};
  for (const result of results) {
    byCategory[result.check.category] = (byCategory[result.check.category] ?? 0) + result.count;
  }

  return {
    checks: results.length,
    blockers,
    warnings,
    issueCount: blockers + warnings,
    byCategory,
  };
}

async function readSnapshot(client: Pick<PoolClient, "query">): Promise<WmsAuditSnapshot> {
  const result = await client.query(`
    SELECT
      transaction_timestamp() AS snapshot_at,
      current_database() AS database_name,
      current_user AS database_user,
      current_setting('server_version') AS server_version,
      pg_is_in_recovery() AS recovery_mode
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Could not read database snapshot metadata");
  return {
    snapshotAt: new Date(row.snapshot_at).toISOString(),
    databaseName: String(row.database_name),
    databaseUser: String(row.database_user),
    serverVersion: String(row.server_version),
    recoveryMode: Boolean(row.recovery_mode),
  };
}

export async function runAuditWithClient(
  client: Pick<PoolClient, "query">,
  flags: AuditFlags,
): Promise<WmsAuditResult> {
  let checks = buildWmsIntegrityChecks();
  if (flags.checkId !== null) {
    checks = checks.filter((check) => check.id === flags.checkId);
    if (checks.length === 0) throw new Error(`Unknown WMS integrity check id: ${flags.checkId}`);
  }

  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${flags.statementTimeoutMs}ms`]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${LOCK_TIMEOUT_MS}ms`]);
    await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
      `${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`,
    ]);
    const snapshot = await readSnapshot(client);
    const results: WmsIntegrityCheckResult[] = [];
    for (const check of checks) {
      results.push(await runCheck(client, check, flags.sampleLimit));
    }
    return { snapshot, summary: summarizeResults(results), results };
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function runWmsInventoryAudit(flags: AuditFlags): Promise<WmsAuditResult> {
  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: "wms-inventory-integrity-audit",
  });
  const client = await pool.connect();
  try {
    return await runAuditWithClient(client, flags);
  } finally {
    client.release();
    await pool.end();
  }
}

function printTextResult(result: WmsAuditResult, sampleLimit: SampleLimit): void {
  console.log(
    `[WMS inventory integrity audit] snapshot=${result.snapshot.snapshotAt} database=${result.snapshot.databaseName} `
      + `user=${result.snapshot.databaseUser} recovery=${result.snapshot.recoveryMode} checks=${result.summary.checks} sampleLimit=${sampleLimit}`,
  );
  for (const checkResult of result.results) {
    const { check, count, samples, elapsedMs } = checkResult;
    console.log(
      `[${check.severity.toUpperCase()}] ${check.id}: category=${check.category} count=${count} elapsedMs=${elapsedMs} target="${check.remediationTarget}"`,
    );
    console.log(`  ${check.description}`);
    for (const sample of samples) console.log(`  sample ${JSON.stringify(sample)}`);
  }
  console.log(JSON.stringify(result.summary));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  if (flags.listChecks) {
    for (const check of buildWmsIntegrityChecks()) {
      console.log(`${check.id}\t${check.severity}\t${check.category}\t${check.description}`);
    }
    return;
  }

  const result = await runWmsInventoryAudit(flags);
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else printTextResult(result, flags.sampleLimit);

  if (flags.failOnBlockers && result.summary.blockers > 0) process.exitCode = 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[WMS inventory integrity audit] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
