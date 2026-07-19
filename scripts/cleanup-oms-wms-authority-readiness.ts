/**
 * Repair proven OMS/WMS authority-readiness data defects before Phase 4
 * constraints are validated.
 *
 * Defaults to dry-run. Execute mode writes immutable before/after snapshots to
 * wms.oms_wms_authority_cleanup_audit in the same transaction as each repair.
 *
 * Usage:
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --limit=25
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=all --limit=all
 *   npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=materialized-counter-drift
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

interface Flags {
  mode: Mode;
  help: boolean;
  limit: number | null;
  operations: CleanupOperationId[];
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
const ALL_OPERATION_IDS: CleanupOperationId[] = [
  "orphan-oms-line-refs",
  "nonpositive-shipment-items",
  "materialized-counter-drift",
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
  if (execute && dryRun) {
    throw new Error("Cannot pass both --execute and --dry-run");
  }

  const knownFlag = /^(--help|-h|--execute|--dry-run|--limit=|--operation=|--operator=)/;
  const unknown = argv.find((arg) => !knownFlag.test(arg));
  if (unknown) {
    throw new Error(`Unknown flag: ${unknown}`);
  }

  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const limit = parseLimit(limitArg);

  const operationArg = argv.find((arg) => arg.startsWith("--operation="));
  const operations = parseOperations(operationArg);

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

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --dry-run --limit=25",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=all --limit=all",
    "  npx tsx scripts/cleanup-oms-wms-authority-readiness.ts --execute --operation=materialized-counter-drift",
    "",
    "Flags:",
    "  --dry-run          Classify and print planned repairs. Default.",
    "  --execute          Apply repairs transactionally with audit snapshots.",
    "  --limit=N|all      Max candidates per operation. Default 100.",
    "  --operation=ID     all, orphan-oms-line-refs, nonpositive-shipment-items, materialized-counter-drift.",
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
      description: "Refresh OMS line materialized counters from current-open active WMS item quantity.",
      sourceTable: "oms.oms_order_lines",
      action: "update",
      reason: "wms_materialized_quantity reconciled to current open WMS materialization before authority constraints",
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

export function materializedCounterDriftCandidateSql(limit: number | null, forUpdate = false): string {
  return `
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
      ol.id::int AS source_id,
      COALESCE(am.materialized_quantity, 0)::int AS actual_quantity,
      to_jsonb(ol) AS before_row,
      to_jsonb(ol) || jsonb_build_object(
        'wms_materialized_quantity', COALESCE(am.materialized_quantity, 0)
      ) AS after_row,
      jsonb_build_object(
        'oms_order_id', ol.order_id,
        'oms_order_line_id', ol.id,
        'sku', ol.sku,
        'recorded_wms_materialized_quantity', COALESCE(ol.wms_materialized_quantity, 0),
        'actual_active_wms_quantity', COALESCE(am.materialized_quantity, 0),
        'drift_quantity', COALESCE(am.materialized_quantity, 0) - COALESCE(ol.wms_materialized_quantity, 0)
      ) AS summary
    FROM oms.oms_order_lines ol
    LEFT JOIN active_materialized am ON am.oms_order_line_id = ol.id
    WHERE COALESCE(ol.wms_materialized_quantity, 0) <> COALESCE(am.materialized_quantity, 0)
    ORDER BY ABS(COALESCE(am.materialized_quantity, 0) - COALESCE(ol.wms_materialized_quantity, 0)) DESC,
             ol.id DESC
    ${limitClause(limit)}
    ${forUpdate ? "FOR UPDATE OF ol" : ""}
  `;
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

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
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

async function fetchCounterDriftCandidates(client: PoolClient, limit: number | null, forUpdate: boolean): Promise<CounterDriftCandidate[]> {
  const result = await client.query(materializedCounterDriftCandidateSql(limit, forUpdate));
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
  for (const candidate of args.candidates) {
    await client.query(`
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
      VALUES (
        $1::uuid,
        $2::text,
        $3::text,
        $4::bigint,
        $5::text,
        $6::text,
        $7::jsonb,
        $8::jsonb,
        $9::text
      )
    `, [
      args.runId,
      args.operation.id,
      args.operation.sourceTable,
      candidate.sourceId,
      args.operation.action,
      args.operation.reason,
      toJson(candidate.beforeRow),
      toJson(candidate.afterRow),
      args.operator,
    ]);
  }
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
  const candidates = await fetchCounterDriftCandidates(client, flags.limit, flags.mode === "execute");
  printOperationPlan(operation, candidates, 0, flags);
  if (flags.mode === "dry-run" || candidates.length === 0) {
    return resultFor(operation.id, candidates.length, 0, 0);
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

  const updateResult = await client.query(`
    UPDATE oms.oms_order_lines ol
       SET wms_materialized_quantity = input.actual_quantity,
           updated_at = $2::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS input(id bigint, actual_quantity int)
     WHERE ol.id = input.id
  `, [JSON.stringify(updateInput), updateTimestamp]);
  assertExpectedRowCount(operation.id, candidates.length, updateResult.rowCount ?? 0);

  return resultFor(operation.id, candidates.length, 0, updateResult.rowCount ?? 0);
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
    `[OMS/WMS authority cleanup] mode=${flags.mode} operations=${flags.operations.join(",")} limit=${flags.limit ?? "all"}`,
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
