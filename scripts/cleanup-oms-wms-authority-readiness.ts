/**
 * Repair proven OMS/WMS authority-readiness data defects before Phase 4
 * constraints are validated.
 *
 * Defaults to dry-run. Execute mode writes immutable before/after snapshots to
 * wms.oms_wms_authority_cleanup_audit in the same transaction as each repair.
 *
 * Usage:
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --limit=25
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --operation=materialized-counter-drift --counter-direction=recorded-above-actual
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=materialized-counter-drift --counter-direction=recorded-below-actual --summary-only
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=materialized-counter-drift --counter-direction=recorded-above-actual --counter-decrease-safety=zero-authority-zero-actual --summary-only
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

type Mode = "dry-run" | "execute";

export type CleanupOperationId =
  | "orphan-oms-line-refs"
  | "nonpositive-shipment-items"
  | "materialized-counter-drift";

export type MaterializedCounterDirection =
  | "all"
  | "recorded-below-actual"
  | "recorded-above-actual";

export type CounterDecreaseSafety =
  | "none"
  | "zero-authority-zero-actual";

interface Flags {
  mode: Mode;
  help: boolean;
  limit: number | null;
  operations: CleanupOperationId[];
  counterDirection: MaterializedCounterDirection;
  counterDecreaseSafety: CounterDecreaseSafety;
  summaryOnly: boolean;
  operator: string;
}

interface CleanupCandidate {
  sourceId: number;
  beforeRow: Record<string, unknown>;
  afterRow: Record<string, unknown> | null;
  summary: Record<string, unknown>;
}

interface CounterDriftCandidate extends CleanupCandidate {
  actualQuantity: number;
}

interface OperationResult {
  operation: CleanupOperationId;
  candidates: number;
  unsafeSkipped: number;
  repaired: number;
}

interface CleanupSummary {
  runId: string;
  mode: Mode;
  results: OperationResult[];
  candidates: number;
  unsafeSkipped: number;
  repaired: number;
}

interface CleanupOperationDefinition {
  id: CleanupOperationId;
  description: string;
  sourceTable: string;
  action: "update" | "delete";
  reason: string;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_OPERATOR = "script:cleanup-oms-wms-authority-readiness";
const AUDIT_INSERT_BATCH_SIZE = 500;
const ALL_OPERATION_IDS: CleanupOperationId[] = [
  "orphan-oms-line-refs",
  "nonpositive-shipment-items",
  "materialized-counter-drift",
];
const ALL_COUNTER_DIRECTIONS: MaterializedCounterDirection[] = [
  "all",
  "recorded-below-actual",
  "recorded-above-actual",
];
const ALL_COUNTER_DECREASE_SAFETIES: CounterDecreaseSafety[] = [
  "none",
  "zero-authority-zero-actual",
];

export const CURRENT_OPEN_WMS_ORDER_FILTER = `
  o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
  AND o.cancelled_at IS NULL
  AND o.completed_at IS NULL
`;

export const CURRENT_OPEN_WMS_ITEM_FILTER = `
  ${CURRENT_OPEN_WMS_ORDER_FILTER}
  AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')
`;

export const SAFE_HISTORICAL_ORPHAN_ORDER_FILTER = `
  (
    o.warehouse_status IN ('shipped', 'completed', 'cancelled')
    OR o.completed_at IS NOT NULL
    OR o.cancelled_at IS NOT NULL
  )
`;

export const SAFE_NONPOSITIVE_SHIPMENT_STATUS_FILTER = `
  s.status IN ('shipped', 'cancelled', 'voided', 'returned', 'lost')
`;

export function parseFlags(argv: string[]): Flags {
  const help = argv.includes("--help") || argv.includes("-h");
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");
  const summaryOnly = argv.includes("--summary-only");
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const knownFlag = /^(--help|-h|--execute|--dry-run|--summary-only|--limit=|--operation=|--counter-direction=|--counter-decrease-safety=|--operator=)/;
  const unknown = argv.find((arg) => !knownFlag.test(arg));
  if (unknown) {
    throw new Error(`Unknown flag: ${unknown}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = parseLimit(limitArg);

  const operationArg = argv.find((arg) => arg.startsWith("--operation="));
  const operations = parseOperations(operationArg);

  const counterDirectionArg = argv.find((arg) => arg.startsWith("--counter-direction="));
  const counterDirection = parseCounterDirection(counterDirectionArg);
  const counterDecreaseSafetyArg = argv.find(
    (arg) => arg.startsWith("--counter-decrease-safety="),
  );
  const counterDecreaseSafety = parseCounterDecreaseSafety(counterDecreaseSafetyArg);
  if (
    execute &&
    operations.includes("materialized-counter-drift") &&
    counterDirection === "all"
  ) {
    throw new Error(
      "Execute mode for materialized-counter-drift requires an explicit counter direction",
    );
  }
  if (
    execute &&
    operations.includes("materialized-counter-drift") &&
    counterDirection === "recorded-above-actual" &&
    counterDecreaseSafety !== "zero-authority-zero-actual"
  ) {
    throw new Error(
      "Execute mode for recorded-above-actual requires " +
      "--counter-decrease-safety=zero-authority-zero-actual; " +
      "unrestricted counter decreases can reopen fulfillment authority",
    );
  }

  const operatorArg = argv.find((arg) => arg.startsWith("--operator="));
  const operator = operatorArg == null
    ? DEFAULT_OPERATOR
    : operatorArg.slice("--operator=".length).trim();
  if (operator.length === 0) {
    throw new Error("--operator cannot be blank");
  }

  return {
    mode: execute ? "execute" : "dry-run",
    help,
    limit,
    operations,
    counterDirection,
    counterDecreaseSafety,
    summaryOnly,
    operator,
  };
}

function parseLimit(limitArg: string | undefined): number | null {
  if (limitArg == null) return DEFAULT_LIMIT;
  const raw = limitArg.slice("--limit=".length).trim().toLowerCase();
  if (raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer or all");
  }
  return parsed;
}

function parseOperations(operationArg: string | undefined): CleanupOperationId[] {
  if (operationArg == null) return ALL_OPERATION_IDS;
  const raw = operationArg.slice("--operation=".length).trim();
  if (raw.length === 0) {
    throw new Error("--operation cannot be blank");
  }
  if (raw === "all") return ALL_OPERATION_IDS;

  const selected = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (selected.length === 0) {
    throw new Error("--operation cannot be blank");
  }

  for (const operation of selected) {
    if (!ALL_OPERATION_IDS.includes(operation as CleanupOperationId)) {
      throw new Error(`Unknown cleanup operation: ${operation}`);
    }
  }

  return [...new Set(selected as CleanupOperationId[])];
}

function parseCounterDirection(
  directionArg: string | undefined,
): MaterializedCounterDirection {
  if (directionArg == null) return "all";
  const direction = directionArg.slice("--counter-direction=".length).trim();
  if (!ALL_COUNTER_DIRECTIONS.includes(direction as MaterializedCounterDirection)) {
    throw new Error(
      "--counter-direction must be all, recorded-below-actual, or recorded-above-actual",
    );
  }
  return direction as MaterializedCounterDirection;
}

export function parseCounterDecreaseSafety(
  safetyArg: string | undefined,
): CounterDecreaseSafety {
  if (safetyArg == null) return "none";
  const safety = safetyArg.slice("--counter-decrease-safety=".length).trim();
  if (!ALL_COUNTER_DECREASE_SAFETIES.includes(safety as CounterDecreaseSafety)) {
    throw new Error(
      "--counter-decrease-safety must be none or zero-authority-zero-actual",
    );
  }
  return safety as CounterDecreaseSafety;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --limit=25",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --operation=materialized-counter-drift --counter-direction=recorded-above-actual",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=materialized-counter-drift --counter-direction=recorded-below-actual --summary-only",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=materialized-counter-drift --counter-direction=recorded-above-actual --counter-decrease-safety=zero-authority-zero-actual --summary-only",
    "",
    "Flags:",
    "  --dry-run          Classify and print planned repairs. Default.",
    "  --execute          Apply repairs transactionally with audit snapshots.",
    "  --summary-only     Print operation totals without one line per candidate.",
    "  --limit=N|all      Max candidates per operation. Default 100.",
    "  --operation=ID     all, orphan-oms-line-refs, nonpositive-shipment-items, materialized-counter-drift.",
    "  --counter-direction=VALUE",
    "                     Materialized-counter cohort: all, recorded-below-actual, or recorded-above-actual.",
    "  --counter-decrease-safety=VALUE",
    "                     Required to execute recorded-above-actual. The only supported policy is",
    "                     zero-authority-zero-actual, which cannot reopen fulfillment authority.",
    "  --operator=TEXT    Audit operator label. Default script:cleanup-oms-wms-authority-readiness.",
  ].join("\n");
}

export function buildCleanupOperations(): CleanupOperationDefinition[] {
  return [
    {
      id: "orphan-oms-line-refs",
      description: "Clear historical wms.order_items.oms_order_line_id values that reference deleted OMS lines.",
      sourceTable: "wms.order_items",
      action: "update",
      reason: "orphan OMS line id cleared before FK validation; referenced oms.oms_order_lines row does not exist",
    },
    {
      id: "nonpositive-shipment-items",
      description: "Delete terminal outbound shipment item rows with qty <= 0 before positive-quantity constraints.",
      sourceTable: "wms.outbound_shipment_items",
      action: "delete",
      reason: "zero/non-positive shipment item removed before qty > 0 constraint; row carries no physical quantity",
    },
    {
      id: "materialized-counter-drift",
      description: "Refresh OMS line materialized counters from cumulative non-cancelled WMS item quantity.",
      sourceTable: "oms.oms_order_lines",
      action: "update",
      reason: "wms_materialized_quantity reconciled to cumulative non-cancelled WMS materialization before authority constraints",
    },
  ];
}

function limitClause(limit: number | null): string {
  return limit == null ? "" : `LIMIT ${limit}`;
}

export function orphanOmsLineRefsCandidateSql(limit: number | null, forUpdate = false): string {
  return `
    SELECT
      oi.id::int AS source_id,
      to_jsonb(oi) AS before_row,
      to_jsonb(oi) || jsonb_build_object('oms_order_line_id', NULL) AS after_row,
      jsonb_build_object(
        'wms_order_id', o.id,
        'order_number', o.order_number,
        'warehouse_status', o.warehouse_status,
        'item_status', oi.status,
        'sku', oi.sku,
        'quantity', oi.quantity,
        'orphan_oms_order_line_id', oi.oms_order_line_id
      ) AS summary
    FROM wms.order_items oi
    JOIN wms.orders o ON o.id = oi.order_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
    WHERE oi.oms_order_line_id IS NOT NULL
      AND ol.id IS NULL
      AND ${SAFE_HISTORICAL_ORPHAN_ORDER_FILTER}
    ORDER BY oi.id
    ${limitClause(limit)}
    ${forUpdate ? "FOR UPDATE OF oi" : ""}
  `;
}

export function orphanOmsLineRefsUnsafeCountSql(): string {
  return `
    SELECT COUNT(*)::int AS unsafe_count
    FROM wms.order_items oi
    JOIN wms.orders o ON o.id = oi.order_id
    LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
    WHERE oi.oms_order_line_id IS NOT NULL
      AND ol.id IS NULL
      AND NOT ${SAFE_HISTORICAL_ORPHAN_ORDER_FILTER}
  `;
}

export function nonpositiveShipmentItemsCandidateSql(limit: number | null, forUpdate = false): string {
  return `
    SELECT
      si.id::int AS source_id,
      to_jsonb(si) AS before_row,
      NULL::jsonb AS after_row,
      jsonb_build_object(
        'shipment_id', si.shipment_id,
        'shipment_status', s.status,
        'wms_order_id', s.order_id,
        'order_item_id', si.order_item_id,
        'product_variant_id', si.product_variant_id,
        'qty', si.qty
      ) AS summary
    FROM wms.outbound_shipment_items si
    JOIN wms.outbound_shipments s ON s.id = si.shipment_id
    WHERE COALESCE(si.qty, 0) <= 0
      AND ${SAFE_NONPOSITIVE_SHIPMENT_STATUS_FILTER}
    ORDER BY si.id
    ${limitClause(limit)}
    ${forUpdate ? "FOR UPDATE OF si" : ""}
  `;
}

export function nonpositiveShipmentItemsUnsafeCountSql(): string {
  return `
    SELECT COUNT(*)::int AS unsafe_count
    FROM wms.outbound_shipment_items si
    JOIN wms.outbound_shipments s ON s.id = si.shipment_id
    WHERE COALESCE(si.qty, 0) <= 0
      AND NOT ${SAFE_NONPOSITIVE_SHIPMENT_STATUS_FILTER}
  `;
}

function materializedCounterDirectionPredicate(
  direction: MaterializedCounterDirection,
): string {
  if (direction === "recorded-below-actual") return "<";
  if (direction === "recorded-above-actual") return ">";
  return "<>";
}

export function materializedCounterDriftCandidateSql(
  limit: number | null,
  forUpdate = false,
  direction: MaterializedCounterDirection = "all",
  decreaseSafety: CounterDecreaseSafety = "none",
): string {
  const directionPredicate = materializedCounterDirectionPredicate(direction);
  const safeDecreasePredicate = decreaseSafety === "zero-authority-zero-actual"
    ? `
      AND COALESCE(ol.authority_fulfillable_quantity, 0) = 0
      AND COALESCE(materialized.materialized_quantity, 0) = 0
    `
    : "";
  return `
    WITH materialized AS (
      SELECT
        oi.oms_order_line_id,
        SUM(COALESCE(oi.quantity, 0))::int AS materialized_quantity
      FROM wms.order_items oi
      WHERE oi.oms_order_line_id IS NOT NULL
        AND COALESCE(oi.status, '') <> 'cancelled'
      GROUP BY oi.oms_order_line_id
    )
    SELECT
      ol.id::int AS source_id,
      COALESCE(materialized.materialized_quantity, 0)::int AS actual_quantity,
      to_jsonb(ol) AS before_row,
      to_jsonb(ol) || jsonb_build_object(
        'wms_materialized_quantity', COALESCE(materialized.materialized_quantity, 0)
      ) AS after_row,
      jsonb_build_object(
        'oms_order_id', ol.order_id,
        'oms_order_line_id', ol.id,
        'sku', ol.sku,
        'recorded_wms_materialized_quantity', COALESCE(ol.wms_materialized_quantity, 0),
        'actual_materialized_wms_quantity', COALESCE(materialized.materialized_quantity, 0),
        'counter_direction', CASE
          WHEN COALESCE(ol.wms_materialized_quantity, 0) < COALESCE(materialized.materialized_quantity, 0)
            THEN 'recorded-below-actual'
          ELSE 'recorded-above-actual'
        END,
        'drift_quantity', COALESCE(materialized.materialized_quantity, 0) - COALESCE(ol.wms_materialized_quantity, 0)
      ) AS summary
    FROM oms.oms_order_lines ol
    LEFT JOIN materialized ON materialized.oms_order_line_id = ol.id
    WHERE COALESCE(ol.wms_materialized_quantity, 0) ${directionPredicate} COALESCE(materialized.materialized_quantity, 0)
      ${safeDecreasePredicate}
    ORDER BY ABS(COALESCE(materialized.materialized_quantity, 0) - COALESCE(ol.wms_materialized_quantity, 0)) DESC,
             ol.id DESC
    ${limitClause(limit)}
    ${forUpdate ? "FOR UPDATE OF ol" : ""}
  `;
}

export function unsafeMaterializedCounterDecreaseCountSql(): string {
  return `
    WITH materialized AS (
      SELECT
        oi.oms_order_line_id,
        SUM(COALESCE(oi.quantity, 0))::int AS materialized_quantity
      FROM wms.order_items oi
      WHERE oi.oms_order_line_id IS NOT NULL
        AND COALESCE(oi.status, '') <> 'cancelled'
      GROUP BY oi.oms_order_line_id
    )
    SELECT COUNT(*)::int AS unsafe_count
    FROM oms.oms_order_lines ol
    LEFT JOIN materialized ON materialized.oms_order_line_id = ol.id
    WHERE COALESCE(ol.wms_materialized_quantity, 0) > COALESCE(materialized.materialized_quantity, 0)
      AND NOT (
        COALESCE(ol.authority_fulfillable_quantity, 0) = 0
        AND COALESCE(materialized.materialized_quantity, 0) = 0
      )
  `;
}

export function materializedCounterDecreaseCountSql(): string {
  return `
    WITH materialized AS (
      SELECT
        oi.oms_order_line_id,
        SUM(COALESCE(oi.quantity, 0))::int AS materialized_quantity
      FROM wms.order_items oi
      WHERE oi.oms_order_line_id IS NOT NULL
        AND COALESCE(oi.status, '') <> 'cancelled'
      GROUP BY oi.oms_order_line_id
    )
    SELECT COUNT(*)::int AS unsafe_count
    FROM oms.oms_order_lines ol
    LEFT JOIN materialized ON materialized.oms_order_line_id = ol.id
    WHERE COALESCE(ol.wms_materialized_quantity, 0) > COALESCE(materialized.materialized_quantity, 0)
  `;
}

function loadDotenvIfAvailable(): void {
  if (process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL) return;
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
  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("EXTERNAL_DATABASE_URL or DATABASE_URL is required");
  }
  return connectionString;
}

function coerceCandidates<T extends CleanupCandidate>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => ({
    sourceId: Number(row.source_id),
    actualQuantity: row.actual_quantity == null ? undefined : Number(row.actual_quantity),
    beforeRow: asObject(row.before_row),
    afterRow: row.after_row == null ? null : asObject(row.after_row),
    summary: asObject(row.summary),
  })) as T[];
}

function asObject(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function fetchUnsafeCount(client: PoolClient, sqlText: string): Promise<number> {
  const result = await client.query(sqlText);
  const unsafeCount = Number(result.rows[0]?.unsafe_count ?? 0);
  if (!Number.isInteger(unsafeCount)) {
    throw new Error(`Unsafe count query returned non-integer value: ${result.rows[0]?.unsafe_count}`);
  }
  return unsafeCount;
}

async function fetchOrphanCandidates(client: PoolClient, limit: number | null, forUpdate: boolean): Promise<CleanupCandidate[]> {
  const result = await client.query(orphanOmsLineRefsCandidateSql(limit, forUpdate));
  return coerceCandidates(result.rows);
}

async function fetchNonpositiveShipmentCandidates(client: PoolClient, limit: number | null, forUpdate: boolean): Promise<CleanupCandidate[]> {
  const result = await client.query(nonpositiveShipmentItemsCandidateSql(limit, forUpdate));
  return coerceCandidates(result.rows);
}

async function fetchCounterDriftCandidates(
  client: PoolClient,
  limit: number | null,
  forUpdate: boolean,
  direction: MaterializedCounterDirection,
  decreaseSafety: CounterDecreaseSafety,
): Promise<CounterDriftCandidate[]> {
  const result = await client.query(
    materializedCounterDriftCandidateSql(limit, forUpdate, direction, decreaseSafety),
  );
  return coerceCandidates<CounterDriftCandidate>(result.rows);
}

async function insertAuditRows(
  client: PoolClient,
  args: {
    runId: string;
    operation: CleanupOperationDefinition;
    candidates: CleanupCandidate[];
    operator: string;
  },
): Promise<void> {
  let insertedCount = 0;
  for (const batch of chunkForAuditInsert(args.candidates)) {
    const auditRows = batch.map((candidate) => ({
      source_id: candidate.sourceId,
      before_row: candidate.beforeRow,
      after_row: candidate.afterRow,
    }));
    const insertResult = await client.query(`
      INSERT INTO wms.oms_wms_authority_cleanup_audit (
        run_id,
        operation,
        source_table,
        source_id,
        action,
        reason,
        before_row,
        after_row,
        operator
      )
      SELECT
        $1::uuid,
        $2::text,
        $3::text,
        input.source_id,
        $4::text,
        $5::text,
        input.before_row,
        input.after_row,
        $6::text
      FROM jsonb_to_recordset($7::jsonb) AS input(
        source_id bigint,
        before_row jsonb,
        after_row jsonb
      )
    `, [
      args.runId,
      args.operation.id,
      args.operation.sourceTable,
      args.operation.action,
      args.operation.reason,
      args.operator,
      JSON.stringify(auditRows),
    ]);
    insertedCount += insertResult.rowCount ?? 0;
  }
  assertExpectedRowCount(args.operation.id, args.candidates.length, insertedCount);
}

export function chunkForAuditInsert<T>(
  values: T[],
  batchSize = AUDIT_INSERT_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Audit insert batch size must be a positive integer");
  }

  const batches: T[][] = [];
  for (let start = 0; start < values.length; start += batchSize) {
    batches.push(values.slice(start, start + batchSize));
  }
  return batches;
}

async function clearOrphanOmsLineRefs(
  client: PoolClient,
  runId: string,
  operation: CleanupOperationDefinition,
  flags: Flags,
): Promise<OperationResult> {
  const unsafeSkipped = await fetchUnsafeCount(client, orphanOmsLineRefsUnsafeCountSql());
  const candidates = await fetchOrphanCandidates(client, flags.limit, flags.mode === "execute");

  printOperationPlan(operation, candidates, unsafeSkipped, flags);
  if (flags.mode === "dry-run" || candidates.length === 0) {
    return resultFor(operation.id, candidates.length, unsafeSkipped, 0);
  }

  await insertAuditRows(client, { runId, operation, candidates, operator: flags.operator });
  const ids = candidates.map((candidate) => candidate.sourceId);
  const updateResult = await client.query(`
    UPDATE wms.order_items oi
       SET oms_order_line_id = NULL
      FROM wms.orders o
     WHERE oi.id = ANY($1::int[])
       AND o.id = oi.order_id
       AND oi.oms_order_line_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM oms.oms_order_lines ol
         WHERE ol.id = oi.oms_order_line_id
       )
       AND ${SAFE_HISTORICAL_ORPHAN_ORDER_FILTER}
  `, [ids]);
  assertExpectedRowCount(operation.id, candidates.length, updateResult.rowCount ?? 0);

  return resultFor(operation.id, candidates.length, unsafeSkipped, updateResult.rowCount ?? 0);
}

async function deleteNonpositiveShipmentItems(
  client: PoolClient,
  runId: string,
  operation: CleanupOperationDefinition,
  flags: Flags,
): Promise<OperationResult> {
  const unsafeSkipped = await fetchUnsafeCount(client, nonpositiveShipmentItemsUnsafeCountSql());
  const candidates = await fetchNonpositiveShipmentCandidates(client, flags.limit, flags.mode === "execute");

  printOperationPlan(operation, candidates, unsafeSkipped, flags);
  if (flags.mode === "dry-run" || candidates.length === 0) {
    return resultFor(operation.id, candidates.length, unsafeSkipped, 0);
  }

  await insertAuditRows(client, { runId, operation, candidates, operator: flags.operator });
  const ids = candidates.map((candidate) => candidate.sourceId);
  const deleteResult = await client.query(`
    DELETE FROM wms.outbound_shipment_items si
      USING wms.outbound_shipments s
     WHERE si.id = ANY($1::int[])
       AND s.id = si.shipment_id
       AND COALESCE(si.qty, 0) <= 0
       AND ${SAFE_NONPOSITIVE_SHIPMENT_STATUS_FILTER}
  `, [ids]);
  assertExpectedRowCount(operation.id, candidates.length, deleteResult.rowCount ?? 0);

  return resultFor(operation.id, candidates.length, unsafeSkipped, deleteResult.rowCount ?? 0);
}

async function refreshMaterializedCounters(
  client: PoolClient,
  runId: string,
  operation: CleanupOperationDefinition,
  flags: Flags,
): Promise<OperationResult> {
  const unsafeSkipped = flags.counterDirection === "recorded-below-actual"
    ? await fetchUnsafeCount(client, materializedCounterDecreaseCountSql())
    : flags.counterDecreaseSafety === "zero-authority-zero-actual"
      ? await fetchUnsafeCount(client, unsafeMaterializedCounterDecreaseCountSql())
      : 0;
  const candidates = await fetchCounterDriftCandidates(
    client,
    flags.limit,
    flags.mode === "execute",
    flags.counterDirection,
    flags.counterDecreaseSafety,
  );
  printOperationPlan(operation, candidates, unsafeSkipped, flags);
  if (flags.mode === "dry-run" || candidates.length === 0) {
    return resultFor(operation.id, candidates.length, unsafeSkipped, 0);
  }

  const updateTimestamp = (await client.query("SELECT NOW() AS updated_at")).rows[0]?.updated_at;
  for (const candidate of candidates) {
    candidate.afterRow = {
      ...candidate.beforeRow,
      wms_materialized_quantity: candidate.actualQuantity,
      updated_at: updateTimestamp,
    };
  }

  await insertAuditRows(client, { runId, operation, candidates, operator: flags.operator });
  const updateInput = candidates.map((candidate) => ({
    id: candidate.sourceId,
    actual_quantity: candidate.actualQuantity,
  }));
  const updateDirectionPredicate = flags.counterDirection === "recorded-above-actual"
    ? ">"
    : "<";
  const safeDecreasePredicate = flags.counterDirection === "recorded-above-actual"
    ? `
       AND COALESCE(ol.authority_fulfillable_quantity, 0) = 0
       AND input.actual_quantity = 0
    `
    : "";

  const updateResult = await client.query(`
    WITH materialized AS (
      SELECT
        oi.oms_order_line_id,
        SUM(COALESCE(oi.quantity, 0))::int AS actual_quantity
      FROM wms.order_items oi
      WHERE oi.oms_order_line_id IS NOT NULL
        AND COALESCE(oi.status, '') <> 'cancelled'
      GROUP BY oi.oms_order_line_id
    ),
    input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS record(id bigint, actual_quantity int)
    )
    UPDATE oms.oms_order_lines ol
       SET wms_materialized_quantity = input.actual_quantity,
           updated_at = $2::timestamptz
     FROM input
      LEFT JOIN materialized ON materialized.oms_order_line_id = input.id
     WHERE ol.id = input.id
       AND COALESCE(ol.wms_materialized_quantity, 0) ${updateDirectionPredicate} input.actual_quantity
       AND input.actual_quantity = COALESCE(materialized.actual_quantity, 0)
       ${safeDecreasePredicate}
  `, [JSON.stringify(updateInput), updateTimestamp]);
  assertExpectedRowCount(operation.id, candidates.length, updateResult.rowCount ?? 0);

  return resultFor(
    operation.id,
    candidates.length,
    unsafeSkipped,
    updateResult.rowCount ?? 0,
  );
}

function assertExpectedRowCount(operation: CleanupOperationId, expected: number, actual: number): void {
  if (actual !== expected) {
    throw new Error(
      `${operation} repaired ${actual}/${expected} selected row(s); rolling back because candidate state changed during cleanup`,
    );
  }
}

function resultFor(
  operation: CleanupOperationId,
  candidates: number,
  unsafeSkipped: number,
  repaired: number,
): OperationResult {
  return { operation, candidates, unsafeSkipped, repaired };
}

function printOperationPlan(
  operation: CleanupOperationDefinition,
  candidates: CleanupCandidate[],
  unsafeSkipped: number,
  flags: Flags,
): void {
  console.log(
    `[OMS/WMS authority cleanup] ${operation.id} mode=${flags.mode} candidates=${candidates.length} unsafeSkipped=${unsafeSkipped} limit=${flags.limit ?? "all"}`,
  );
  if (unsafeSkipped > 0) {
    console.log(`  UNSAFE_SKIPPED ${unsafeSkipped} row(s) do not match the operation's proven-safe predicate`);
  }
  if (flags.summaryOnly) return;

  for (const candidate of candidates) {
    const action = flags.mode === "execute" ? operation.action.toUpperCase() : `PLAN_${operation.action.toUpperCase()}`;
    console.log(`  ${action} ${operation.sourceTable} id=${candidate.sourceId} summary=${JSON.stringify(candidate.summary)}`);
  }
}

async function runOperation(
  client: PoolClient,
  runId: string,
  operation: CleanupOperationDefinition,
  flags: Flags,
): Promise<OperationResult> {
  if (flags.mode === "execute") {
    await client.query("BEGIN");
  }

  try {
    let result: OperationResult;
    if (operation.id === "orphan-oms-line-refs") {
      result = await clearOrphanOmsLineRefs(client, runId, operation, flags);
    } else if (operation.id === "nonpositive-shipment-items") {
      result = await deleteNonpositiveShipmentItems(client, runId, operation, flags);
    } else {
      result = await refreshMaterializedCounters(client, runId, operation, flags);
    }

    if (flags.mode === "execute") {
      await client.query("COMMIT");
    }
    return result;
  } catch (error) {
    if (flags.mode === "execute") {
      await client.query("ROLLBACK");
    }
    throw error;
  }
}

export async function runCleanup(flags: Flags): Promise<CleanupSummary> {
  const definitionsById = new Map(buildCleanupOperations().map((operation) => [operation.id, operation]));
  const operations = flags.operations.map((id) => {
    const operation = definitionsById.get(id);
    if (!operation) throw new Error(`Unknown cleanup operation: ${id}`);
    return operation;
  });

  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });

  const runId = crypto.randomUUID();
  const results: OperationResult[] = [];
  const client = await pool.connect();
  try {
    for (const operation of operations) {
      results.push(await runOperation(client, runId, operation, flags));
    }
  } finally {
    client.release();
    await pool.end();
  }

  return {
    runId,
    mode: flags.mode,
    results,
    candidates: results.reduce((total, result) => total + result.candidates, 0),
    unsafeSkipped: results.reduce((total, result) => total + result.unsafeSkipped, 0),
    repaired: results.reduce((total, result) => total + result.repaired, 0),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  console.log(
    `[OMS/WMS authority cleanup] mode=${flags.mode} operations=${flags.operations.join(",")} counterDirection=${flags.counterDirection} counterDecreaseSafety=${flags.counterDecreaseSafety} summaryOnly=${flags.summaryOnly} limit=${flags.limit ?? "all"}`,
  );
  const summary = await runCleanup(flags);
  console.log(`[OMS/WMS authority cleanup] complete ${JSON.stringify(summary)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("[OMS/WMS authority cleanup] fatal:", error);
    process.exit(1);
  });
}
