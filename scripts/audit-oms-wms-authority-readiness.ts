/**
 * Read-only readiness audit for OMS/WMS authority database constraints.
 *
 * This script is intentionally non-mutating. It answers whether production data
 * can accept the Phase 4 authority constraints, and prints concrete blocker
 * rows that need quarantine or repair before constraints are added.
 *
 * Usage:
 *   npx tsx scripts/audit-oms-wms-authority-readiness.ts --limit=10
 *   npx tsx scripts/audit-oms-wms-authority-readiness.ts --json --fail-on-issues
 *   npx tsx scripts/audit-oms-wms-authority-readiness.ts --check=oms_line_over_materialized
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

type Severity = "blocker" | "warning";

interface Flags {
  help: boolean;
  json: boolean;
  failOnIssues: boolean;
  sampleLimit: number;
  checkId: string | null;
}

export interface ReadinessCheck {
  id: string;
  severity: Severity;
  description: string;
  constraintTarget: string;
  sql: string;
}

export interface CheckResult {
  check: ReadinessCheck;
  count: number;
  samples: Record<string, unknown>[];
}

export interface AuditSummary {
  checks: number;
  blockers: number;
  warnings: number;
  issueCount: number;
}

export interface AuditResult {
  summary: AuditSummary;
  results: CheckResult[];
}

const OMS_ORIGIN_SOURCE_FILTER = "COALESCE(o.source, '') IN ('oms', 'shopify', 'ebay')";
const CURRENT_OPEN_WMS_ORDER_FILTER = `
  o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
  AND o.cancelled_at IS NULL
  AND o.completed_at IS NULL
`;
const CURRENT_OPEN_WMS_ITEM_FILTER = `
  ${CURRENT_OPEN_WMS_ORDER_FILTER}
  AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
`;
const ACTIVE_SHIPMENT_FILTER = "s.status IN ('planned', 'queued', 'labeled', 'on_hold')";
const COMBINED_CHILD_SOURCE_FILTER = `
  COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child')
`;

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const json = argv.includes("--json");
  const failOnIssues = argv.includes("--fail-on-issues");

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const sampleLimit = limitArg == null ? 10 : Number(limitArg.slice("--limit=".length));
  if (!Number.isInteger(sampleLimit) || sampleLimit <= 0) {
    throw new Error("--limit must be a positive integer");
  }

  const checkArg = argv.find((arg) => arg.startsWith("--check="));
  const checkId = checkArg == null ? null : checkArg.slice("--check=".length).trim();
  if (checkId !== null && checkId.length === 0) {
    throw new Error("--check cannot be blank");
  }

  return { help, json, failOnIssues, sampleLimit, checkId };
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/audit-oms-wms-authority-readiness.ts [--limit=10]",
    "  npx tsx scripts/audit-oms-wms-authority-readiness.ts --json --fail-on-issues",
    "  npx tsx scripts/audit-oms-wms-authority-readiness.ts --check=oms_line_over_materialized",
    "",
    "Flags:",
    "  --limit=N          Number of sample rows to print per failing check. Default 10.",
    "  --check=ID         Run one readiness check by id.",
    "  --json             Print machine-readable JSON.",
    "  --fail-on-issues   Exit 1 when any blocker or warning rows are found.",
  ].join("\n");
}

function expectedOmsOrderRefSql(): string {
  return `
    NULLIF(TRIM(
      CASE
        WHEN o.source = 'shopify' THEN COALESCE(o.source_table_id::text, '')
        ELSE COALESCE(o.oms_fulfillment_order_id::text, '')
      END
    ), '')
  `;
}

export function buildReadinessChecks(): ReadinessCheck[] {
  const expectedOmsOrderRef = expectedOmsOrderRefSql();

  return [
    {
      id: "oms_origin_order_missing_oms_ref",
      severity: "blocker",
      description: "Current open OMS-origin WMS orders need a parseable OMS order reference before order-level lineage can be constrained.",
      constraintTarget: "Future FK-like lineage guard from current open WMS orders to oms.oms_orders.",
      sql: `
        SELECT
          o.id AS wms_order_id,
          o.order_number,
          o.source,
          o.source_table_id,
          o.oms_fulfillment_order_id,
          o.warehouse_status,
          o.created_at
        FROM wms.orders o
        WHERE ${OMS_ORIGIN_SOURCE_FILTER}
          AND ${CURRENT_OPEN_WMS_ORDER_FILTER}
          AND (
            ${expectedOmsOrderRef} IS NULL
            OR ${expectedOmsOrderRef} !~ '^[0-9]+$'
          )
        ORDER BY o.created_at DESC NULLS LAST, o.id DESC
      `,
    },
    {
      id: "oms_wms_item_missing_oms_line_id",
      severity: "blocker",
      description: "Current open OMS-origin WMS items must point at the OMS line that authorized them.",
      constraintTarget: "Partial NOT NULL constraint for current open OMS-origin WMS order_items.oms_order_line_id.",
      sql: `
        SELECT
          o.id AS wms_order_id,
          o.order_number,
          o.source,
          o.warehouse_status,
          oi.id AS wms_order_item_id,
          oi.source_item_id,
          oi.sku,
          oi.quantity,
          oi.status AS item_status,
          o.created_at AS wms_order_created_at
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        WHERE ${OMS_ORIGIN_SOURCE_FILTER}
          AND ${CURRENT_OPEN_WMS_ITEM_FILTER}
          AND oi.oms_order_line_id IS NULL
        ORDER BY o.created_at DESC NULLS LAST, oi.id DESC
      `,
    },
    {
      id: "oms_wms_item_orphan_oms_line",
      severity: "blocker",
      description: "WMS items with OMS line ids must reference existing OMS lines.",
      constraintTarget: "Foreign key from wms.order_items.oms_order_line_id to oms.oms_order_lines.id.",
      sql: `
        SELECT
          o.id AS wms_order_id,
          o.order_number,
          oi.id AS wms_order_item_id,
          oi.oms_order_line_id,
          oi.sku,
          oi.quantity,
          oi.status AS item_status
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
        WHERE oi.oms_order_line_id IS NOT NULL
          AND ol.id IS NULL
        ORDER BY oi.id DESC
      `,
    },
    {
      id: "oms_wms_item_wrong_order_lineage",
      severity: "blocker",
      description: "A WMS item cannot consume an OMS line that belongs to a different OMS order.",
      constraintTarget: "Composite lineage guard tying WMS order OMS ref to the referenced OMS line order_id.",
      sql: `
        SELECT
          o.id AS wms_order_id,
          o.order_number,
          o.source,
          ${expectedOmsOrderRef} AS expected_oms_order_id,
          oi.id AS wms_order_item_id,
          oi.oms_order_line_id,
          ol.order_id AS actual_oms_order_id,
          oi.sku,
          oi.quantity
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
        WHERE ${OMS_ORIGIN_SOURCE_FILTER}
          AND ${CURRENT_OPEN_WMS_ITEM_FILTER}
          AND ${expectedOmsOrderRef} ~ '^[0-9]+$'
          AND ol.order_id::text <> ${expectedOmsOrderRef}
        ORDER BY oi.id DESC
      `,
    },
    {
      id: "oms_wms_duplicate_order_line_items",
      severity: "blocker",
      description: "A WMS order should not contain multiple active item rows for the same OMS line.",
      constraintTarget: "Unique active index on wms.order_items(order_id, oms_order_line_id).",
      sql: `
        SELECT
          o.id AS wms_order_id,
          o.order_number,
          oi.oms_order_line_id,
          COUNT(*)::int AS duplicate_item_count,
          ARRAY_AGG(oi.id ORDER BY oi.id) AS wms_order_item_ids,
          SUM(oi.quantity)::int AS total_quantity
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        WHERE oi.oms_order_line_id IS NOT NULL
          AND ${CURRENT_OPEN_WMS_ITEM_FILTER}
        GROUP BY o.id, o.order_number, oi.oms_order_line_id
        HAVING COUNT(*) > 1
        ORDER BY duplicate_item_count DESC, o.id DESC
      `,
    },
    {
      id: "oms_line_multiple_active_wms_orders",
      severity: "blocker",
      description: "Current single-warehouse materialization should not spread one OMS line across multiple active WMS orders.",
      constraintTarget: "Current-generation unique lineage guard; future split-warehouse support must replace this with explicit allocation segments.",
      sql: `
        SELECT
          oi.oms_order_line_id,
          COUNT(DISTINCT o.id)::int AS wms_order_count,
          ARRAY_AGG(DISTINCT o.id ORDER BY o.id) AS wms_order_ids,
          ARRAY_AGG(DISTINCT o.order_number ORDER BY o.order_number) AS order_numbers,
          SUM(oi.quantity)::int AS total_quantity
        FROM wms.order_items oi
        JOIN wms.orders o ON o.id = oi.order_id
        WHERE oi.oms_order_line_id IS NOT NULL
          AND ${CURRENT_OPEN_WMS_ITEM_FILTER}
        GROUP BY oi.oms_order_line_id
        HAVING COUNT(DISTINCT o.id) > 1
        ORDER BY wms_order_count DESC, oi.oms_order_line_id DESC
      `,
    },
    {
      id: "oms_line_over_materialized",
      severity: "blocker",
      description: "Active WMS materialized quantity cannot exceed the OMS line authority quantity.",
      constraintTarget: "Authority-consumption invariant enforced by transaction logic and backed by audit/quarantine before constraints.",
      sql: `
        WITH active_materialized AS (
          SELECT
            oi.oms_order_line_id,
            SUM(oi.quantity)::int AS materialized_quantity,
            ARRAY_AGG(oi.id ORDER BY oi.id) AS wms_order_item_ids,
            ARRAY_AGG(DISTINCT o.id ORDER BY o.id) AS wms_order_ids
          FROM wms.order_items oi
          JOIN wms.orders o ON o.id = oi.order_id
          WHERE oi.oms_order_line_id IS NOT NULL
            AND ${CURRENT_OPEN_WMS_ITEM_FILTER}
          GROUP BY oi.oms_order_line_id
        )
        SELECT
          ol.order_id AS oms_order_id,
          ol.id AS oms_order_line_id,
          ol.sku,
          ol.quantity AS oms_quantity,
          ol.authority_fulfillable_quantity,
          am.materialized_quantity,
          am.wms_order_ids,
          am.wms_order_item_ids
        FROM active_materialized am
        JOIN oms.oms_order_lines ol ON ol.id = am.oms_order_line_id
        WHERE am.materialized_quantity > COALESCE(ol.authority_fulfillable_quantity, 0)
        ORDER BY (am.materialized_quantity - COALESCE(ol.authority_fulfillable_quantity, 0)) DESC,
                 ol.id DESC
      `,
    },
    {
      id: "wms_order_materialized_counter_drift",
      severity: "warning",
      description: "OMS line materialized counters should match active WMS item quantity before relying on counters operationally.",
      constraintTarget: "Backfill readiness for oms.oms_order_lines.wms_materialized_quantity.",
      sql: `
        WITH active_materialized AS (
          SELECT
            oi.oms_order_line_id,
            SUM(oi.quantity)::int AS materialized_quantity
          FROM wms.order_items oi
          JOIN wms.orders o ON o.id = oi.order_id
          WHERE oi.oms_order_line_id IS NOT NULL
            AND ${CURRENT_OPEN_WMS_ITEM_FILTER}
          GROUP BY oi.oms_order_line_id
        )
        SELECT
          ol.order_id AS oms_order_id,
          ol.id AS oms_order_line_id,
          ol.sku,
          COALESCE(ol.wms_materialized_quantity, 0) AS recorded_wms_materialized_quantity,
          COALESCE(am.materialized_quantity, 0) AS actual_active_wms_quantity,
          COALESCE(am.materialized_quantity, 0) - COALESCE(ol.wms_materialized_quantity, 0) AS drift_quantity
        FROM oms.oms_order_lines ol
        LEFT JOIN active_materialized am ON am.oms_order_line_id = ol.id
        WHERE COALESCE(ol.wms_materialized_quantity, 0) <> COALESCE(am.materialized_quantity, 0)
        ORDER BY ABS(COALESCE(am.materialized_quantity, 0) - COALESCE(ol.wms_materialized_quantity, 0)) DESC,
                 ol.id DESC
      `,
    },
    {
      id: "active_shipstation_order_id_duplicates",
      severity: "blocker",
      description: "Two active standalone shipments must not point at the same ShipStation order id.",
      constraintTarget: "Unique active index on wms.outbound_shipments.shipstation_order_id, excluding combined-child mirror rows.",
      sql: `
        SELECT
          s.shipstation_order_id,
          COUNT(*)::int AS shipment_count,
          ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
          ARRAY_AGG(s.order_id ORDER BY s.id) AS wms_order_ids,
          ARRAY_AGG(o.order_number ORDER BY s.id) AS order_numbers,
          ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
          ARRAY_AGG(s.status ORDER BY s.id) AS statuses
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE ${ACTIVE_SHIPMENT_FILTER}
          AND ${COMBINED_CHILD_SOURCE_FILTER}
          AND s.shipstation_order_id IS NOT NULL
        GROUP BY s.shipstation_order_id
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.shipstation_order_id DESC
      `,
    },
    {
      id: "active_shipstation_order_key_duplicates",
      severity: "blocker",
      description: "Two active standalone shipments must not point at the same ShipStation order key.",
      constraintTarget: "Unique active index on wms.outbound_shipments.shipstation_order_key, excluding combined-child mirror rows.",
      sql: `
        SELECT
          s.shipstation_order_key,
          COUNT(*)::int AS shipment_count,
          ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
          ARRAY_AGG(s.order_id ORDER BY s.id) AS wms_order_ids,
          ARRAY_AGG(o.order_number ORDER BY s.id) AS order_numbers,
          ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
          ARRAY_AGG(s.status ORDER BY s.id) AS statuses
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE ${ACTIVE_SHIPMENT_FILTER}
          AND ${COMBINED_CHILD_SOURCE_FILTER}
          AND NULLIF(TRIM(s.shipstation_order_key), '') IS NOT NULL
        GROUP BY s.shipstation_order_key
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.shipstation_order_key DESC
      `,
    },
    {
      id: "active_engine_order_ref_duplicates",
      severity: "blocker",
      description: "Two active standalone shipments must not point at the same shipping-engine order reference.",
      constraintTarget: "Engine-agnostic unique active index on (shipping_engine, engine_order_ref), excluding combined-child mirror rows.",
      sql: `
        SELECT
          s.shipping_engine,
          s.engine_order_ref,
          COUNT(*)::int AS shipment_count,
          ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
          ARRAY_AGG(s.order_id ORDER BY s.id) AS wms_order_ids,
          ARRAY_AGG(o.order_number ORDER BY s.id) AS order_numbers,
          ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
          ARRAY_AGG(s.status ORDER BY s.id) AS statuses
        FROM wms.outbound_shipments s
        LEFT JOIN wms.orders o ON o.id = s.order_id
        WHERE ${ACTIVE_SHIPMENT_FILTER}
          AND ${COMBINED_CHILD_SOURCE_FILTER}
          AND NULLIF(TRIM(s.shipping_engine), '') IS NOT NULL
          AND NULLIF(TRIM(s.engine_order_ref), '') IS NOT NULL
        GROUP BY s.shipping_engine, s.engine_order_ref
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.shipping_engine, s.engine_order_ref
      `,
    },
    {
      id: "active_non_child_shipment_per_order_duplicates",
      severity: "blocker",
      description: "A WMS order should not have multiple active standalone shipment rows.",
      constraintTarget: "Existing partial unique index uq_outbound_shipments_active_per_order.",
      sql: `
        SELECT
          s.order_id AS wms_order_id,
          COUNT(*)::int AS shipment_count,
          ARRAY_AGG(s.id ORDER BY s.id) AS shipment_ids,
          ARRAY_AGG(s.status ORDER BY s.id) AS statuses,
          ARRAY_AGG(COALESCE(s.source, '') ORDER BY s.id) AS sources,
          ARRAY_AGG(s.shipstation_order_id ORDER BY s.id) AS shipstation_order_ids
        FROM wms.outbound_shipments s
        WHERE ${ACTIVE_SHIPMENT_FILTER}
          AND COALESCE(s.source, '') NOT IN ('echelon_combined_child', 'shipstation_combined_child', 'shipstation_split')
        GROUP BY s.order_id
        HAVING COUNT(*) > 1
        ORDER BY shipment_count DESC, s.order_id DESC
      `,
    },
    {
      id: "shipment_items_missing_order_item",
      severity: "blocker",
      description: "Shipment items must point at a WMS order item before shipment-item lineage can be constrained.",
      constraintTarget: "NOT NULL/FK constraint on wms.outbound_shipment_items.order_item_id.",
      sql: `
        SELECT
          si.id AS shipment_item_id,
          si.shipment_id,
          s.order_id AS shipment_wms_order_id,
          s.status AS shipment_status,
          si.product_variant_id,
          si.qty
        FROM wms.outbound_shipment_items si
        JOIN wms.outbound_shipments s ON s.id = si.shipment_id
        WHERE si.order_item_id IS NULL
        ORDER BY si.id DESC
      `,
    },
    {
      id: "shipment_item_order_mismatch",
      severity: "blocker",
      description: "A shipment item cannot reference a WMS order item from a different WMS order.",
      constraintTarget: "Composite lineage guard tying outbound_shipment_items to outbound_shipments.order_id.",
      sql: `
        SELECT
          si.id AS shipment_item_id,
          si.shipment_id,
          s.order_id AS shipment_wms_order_id,
          si.order_item_id,
          oi.order_id AS item_wms_order_id,
          s.status AS shipment_status,
          oi.sku,
          si.qty
        FROM wms.outbound_shipment_items si
        JOIN wms.outbound_shipments s ON s.id = si.shipment_id
        JOIN wms.order_items oi ON oi.id = si.order_item_id
        WHERE oi.order_id <> s.order_id
        ORDER BY si.id DESC
      `,
    },
    {
      id: "negative_wms_order_item_quantities",
      severity: "blocker",
      description: "WMS order item quantities must be non-negative.",
      constraintTarget: "CHECK constraints for wms.order_items quantity, picked_quantity, fulfilled_quantity.",
      sql: `
        SELECT
          oi.id AS wms_order_item_id,
          oi.order_id AS wms_order_id,
          oi.sku,
          oi.quantity,
          oi.picked_quantity,
          oi.fulfilled_quantity,
          oi.status
        FROM wms.order_items oi
        WHERE COALESCE(oi.quantity, 0) < 0
           OR COALESCE(oi.picked_quantity, 0) < 0
           OR COALESCE(oi.fulfilled_quantity, 0) < 0
        ORDER BY oi.id DESC
      `,
    },
    {
      id: "nonpositive_shipment_item_quantities",
      severity: "blocker",
      description: "Outbound shipment item quantities must be positive.",
      constraintTarget: "CHECK constraint for wms.outbound_shipment_items.qty > 0.",
      sql: `
        SELECT
          si.id AS shipment_item_id,
          si.shipment_id,
          si.order_item_id,
          si.product_variant_id,
          si.qty
        FROM wms.outbound_shipment_items si
        WHERE COALESCE(si.qty, 0) <= 0
        ORDER BY si.id DESC
      `,
    },
  ];
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
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function connectionStringFromEnv(): string {
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

async function runCheck(pool: Pool, check: ReadinessCheck, sampleLimit: number): Promise<CheckResult> {
  const baseSql = normalizeSql(check.sql);
  const countResult = await pool.query(`SELECT COUNT(*)::int AS issue_count FROM (${baseSql}) readiness_issue`);
  const rawCount = countResult.rows[0]?.issue_count;
  const count = Number(rawCount);
  if (!Number.isInteger(count)) {
    throw new Error(`Readiness check ${check.id} returned a non-integer count: ${rawCount}`);
  }

  const sampleResult = count > 0
    ? await pool.query(`SELECT * FROM (${baseSql}) readiness_issue LIMIT $1`, [sampleLimit])
    : { rows: [] };

  return {
    check,
    count,
    samples: sampleResult.rows,
  };
}

export function summarizeResults(results: CheckResult[]): AuditSummary {
  return {
    checks: results.length,
    blockers: results
      .filter((result) => result.check.severity === "blocker")
      .reduce((total, result) => total + result.count, 0),
    warnings: results
      .filter((result) => result.check.severity === "warning")
      .reduce((total, result) => total + result.count, 0),
    issueCount: results.reduce((total, result) => total + result.count, 0),
  };
}

export async function runAudit(flags: Flags): Promise<AuditResult> {
  let checks = buildReadinessChecks();
  if (flags.checkId !== null) {
    checks = checks.filter((check) => check.id === flags.checkId);
    if (checks.length === 0) {
      throw new Error(`Unknown readiness check id: ${flags.checkId}`);
    }
  }

  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  try {
    const results: CheckResult[] = [];
    for (const check of checks) {
      results.push(await runCheck(pool, check, flags.sampleLimit));
    }
    return { summary: summarizeResults(results), results };
  } finally {
    await pool.end();
  }
}

function printTextResult(result: AuditResult, sampleLimit: number): void {
  console.log(
    `[OMS/WMS authority readiness] checks=${result.summary.checks} sampleLimit=${sampleLimit}`,
  );

  for (const checkResult of result.results) {
    const { check, count, samples } = checkResult;
    console.log(
      `CHECK ${check.severity} ${check.id} count=${count} target="${check.constraintTarget}"`,
    );
    if (count === 0) continue;
    console.log(`  ${check.description}`);
    for (const sample of samples) {
      console.log(`  sample ${JSON.stringify(sample)}`);
    }
  }

  console.log(JSON.stringify(result.summary));
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  const result = await runAudit(flags);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printTextResult(result, flags.sampleLimit);
  }

  if (flags.failOnIssues && result.summary.issueCount > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("[OMS/WMS authority readiness] fatal:", error);
    process.exit(1);
  });
}
