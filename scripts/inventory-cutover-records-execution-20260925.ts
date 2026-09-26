/** Exact D3/D4 records correction. No CLI, connection lookup or application bootstrap. */
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { buildProposal } from "./inventory-cutover-records-proposal-20260925";

export const CLEANUP_COMMAND = "inventory-cutover-closed-records-20260925-v1";
const AUDIT_EVENT = "cutover_records_corrected";
const AUDIT_TOPIC = "cutover/records_cleanup";
const MAX_ROWS = 100_000;
export const CLEANUP_WRITTEN_TABLES = [
  "oms.oms_orders", "oms.oms_order_lines", "oms.order_line_adjustments", "oms.oms_order_line_authority_events",
  "oms.oms_order_events", "oms.archon_order_outbox", "oms.channel_order_intakes",
] as const;
const id = z.string().regex(/^[1-9][0-9]*$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const APPROVED_RECORDS_CLEANUP_LINE_IDS = [
  "4540", "14352", "14353", "14354", "14360", "14361", "14362", "19592", "19593", "19594", "19595",
  "99733", "101455", "103801", "104624", "104989", "104990", "104991", "104992", "109598", "109875",
  "109881", "110012", "110466", "111453", "111454", "113916", "114004", "114010", "114639", "114640",
  "114641", "115062", "116361", "117125", "118357", "118358", "118363", "118414", "119132", "119632", "119726",
] as const;
const evidenceRow = z.object({ id, order_id: id.optional(), row_hash: fingerprint }).passthrough();
const evidenceSchema = z.object({
  orders: z.array(evidenceRow).max(100),
  lines: z.array(evidenceRow.extend({ order_id: id })).max(500),
  adjustments: z.array(evidenceRow).max(1000),
}).passthrough();
const refundSchema = z.object({
  table: z.literal("oms.order_line_adjustments"), orderId: id, orderLineId: id,
  externalLineItemId: z.string().min(1).max(100), source: z.literal("shopify_webhook"),
  sourceEventId: z.string().min(1).max(100), adjustmentType: z.literal("refund"),
  restockPolicy: z.enum(["cancel", "no_restock", "return", "restock", "unknown"]),
  quantity: z.number().int().positive().max(2_147_483_647), provenance: z.string().min(1).max(1000),
}).strict();
type Proposal = ReturnType<typeof buildProposal>;
type Change = Proposal["lineChanges"][number];
type HashRow = { id: string; row_hash: string };
type RowHashMap = Map<string, string>;

export class RecordsCleanupError extends Error {
  constructor(readonly code: string, readonly stage: string, readonly databaseCode?: string) {
    super(`${code} at ${stage}`);
    this.name = "RecordsCleanupError";
  }
}
function requireCondition(value: unknown, code: string, stage: string): asserts value {
  if (!value) throw new RecordsCleanupError(code, stage);
}
export function canonicalHash(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object") {
      const entries = Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([key, next]) => `${JSON.stringify(key)}:${canonical(next)}`).join(",")}}`;
    }
    const result = JSON.stringify(item);
    requireCondition(result !== undefined, "UNHASHABLE_VALUE", "contract");
    return result;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface CleanupRequest {
  /** Read-only context and exact normalized provider evidence used for the reviewed proposal. */
  readonly context: unknown;
  readonly facts: unknown;
  readonly expectedPlanHash: string;
  readonly sourceHashes: Readonly<{ context: string; shopify: string; marketplace: string }>;
  readonly actor: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly expectedAuthorityRevision: string;
  readonly expectedTriggerHash: string;
}
const requestMetadata = z.object({
  expectedPlanHash: fingerprint,
  sourceHashes: z.object({ context: fingerprint, shopify: fingerprint, marketplace: fingerprint }).strict(),
  actor: z.string().trim().min(1).max(100), reason: z.string().trim().min(10).max(1000),
  occurredAt: z.string().datetime(), expectedAuthorityRevision: id,
  expectedTriggerHash: fingerprint,
});

export async function captureCleanupTriggerHash(client: PoolClient): Promise<string> {
  const result = await client.query(`SELECT n.nspname||'.'||c.relname AS table_name,t.tgname AS trigger_name,
    pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function_definition,
    t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname||'.'||c.relname=ANY($1::text[])
    ORDER BY n.nspname,c.relname,t.tgname`, [CLEANUP_WRITTEN_TABLES]);
  return canonicalHash(result.rows);
}

export interface CleanupResult {
  readonly command: string;
  readonly replayed: boolean;
  readonly lineUpdates: number;
  readonly orderUpdates: number;
  readonly refundEvidenceInserts: number;
  readonly authorityAuditInserts: number;
  readonly orderAuditInserts: number;
  readonly inventoryWrites: 0;
  readonly providerRequests: 0;
}

function prepare(request: CleanupRequest) {
  const metadata = requestMetadata.parse(request);
  const context = evidenceSchema.parse(request.context);
  const proposal = buildProposal(request.context, request.facts);
  const expectedIds = [...APPROVED_RECORDS_CLEANUP_LINE_IDS].sort();
  requireCondition(canonicalHash([...proposal.approvedTargetLineIds].sort()) === canonicalHash(expectedIds),
    "UNAPPROVED_SCOPE", "contract");
  requireCondition(canonicalHash(proposal) === metadata.expectedPlanHash, "PLAN_HASH_MISMATCH", "contract");
  const targetLines = context.lines.filter(line => proposal.approvedTargetLineIds.includes(line.id));
  const orderIds = [...new Set(targetLines.map(line => line.order_id))];
  requireCondition(!orderIds.includes(proposal.preserve.openOmsOrderId), "LIVE_ORDER_IN_SCOPE", "contract");
  for (const change of [...proposal.lineChanges, ...proposal.orderChanges]) validateChange(change);
  const refunds = z.array(refundSchema).parse(proposal.proposedRefundEvidence);
  const requestHash = canonicalHash({ command: CLEANUP_COMMAND, ...metadata });
  return { context, proposal, metadata, orderIds, refunds, requestHash };
}
type Prepared = ReturnType<typeof prepare>;

function validateChange(change: Change): void {
  const allowed: Readonly<Record<string, readonly string[]>> = {
    "oms.oms_orders": ["status", "fulfillment_status"],
    "oms.oms_order_lines": ["fulfillment_status", "authorization_status", "refunded_quantity"],
  };
  id.parse(change.id);
  fingerprint.parse(change.expectedRowHash);
  const fields = Object.keys(change.after);
  requireCondition(fields.length > 0 && fields.every(field => allowed[change.table]?.includes(field)),
    "WRITE_OUTSIDE_REVIEWED_FIELDS", "contract");
  requireCondition(canonicalHash(Object.keys(change.before).sort()) === canonicalHash(fields.sort()),
    "PATCH_SHAPE_MISMATCH", "contract");
  // This approved dataset already has zero remaining quantity on all six refunds.
  // A future planner proposing quantity changes is a different, unapproved operation.
}

async function rowHashes(client: PoolClient, table: string, where: string, values: unknown[]): Promise<RowHashMap> {
  // table/where are internal constants, never request strings. LIMIT bounds all
  // evidence reads; overflow is an error, never an incomplete preservation check.
  const result = await client.query<HashRow>(`SELECT row.id::text,
    encode(sha256(convert_to(to_jsonb(row)::text,'UTF8')),'hex') AS row_hash
    FROM ${table} row WHERE ${where} ORDER BY row.id LIMIT ${MAX_ROWS + 1}`, values);
  requireCondition(result.rows.length <= MAX_ROWS, "PRESERVATION_BOUND_EXCEEDED", table);
  return new Map(result.rows.map(row => [row.id, row.row_hash]));
}
function sameRows(before: RowHashMap, after: RowHashMap, stage: string): void {
  requireCondition(before.size === after.size && [...before].every(([key, value]) => after.get(key) === value),
    "PROTECTED_ROWS_CHANGED", stage);
}
function matchReviewed(actual: RowHashMap, expected: readonly { id: string; row_hash: string }[], stage: string): void {
  sameRows(new Map(expected.map(row => [row.id, row.row_hash])), actual, stage);
}

async function lockScope(client: PoolClient, prepared: Prepared): Promise<void> {
  // Same admission-first ordering used by inventory writers. Never wait behind
  // cutover activation while already holding order locks.
  const fence = await client.query("SELECT epoch::text FROM inventory.cutover_admission_fence WHERE singleton_key=true FOR SHARE NOWAIT");
  requireCondition(fence.rows.length === 1 && BigInt(fence.rows[0].epoch) > BigInt(0), "ADMISSION_FENCE_MISSING", "admission");
  const authority = await client.query("SELECT authority,revision::text FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE NOWAIT");
  requireCondition(authority.rows.length === 1 && authority.rows[0].authority === "legacy"
    && authority.rows[0].revision === prepared.metadata.expectedAuthorityRevision, "AUTHORITY_CHANGED", "admission");
  const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [CLEANUP_COMMAND]);
  requireCondition(lock.rows[0]?.acquired === true, "CLEANUP_ALREADY_RUNNING", "batch_lock");
  await client.query("SELECT id FROM oms.oms_orders WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT", [prepared.orderIds]);
  await client.query("SELECT id FROM oms.oms_order_lines WHERE order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT", [prepared.orderIds]);
  await client.query("SELECT id FROM oms.order_line_adjustments WHERE order_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE NOWAIT", [prepared.orderIds]);
  requireCondition(await captureCleanupTriggerHash(client) === prepared.metadata.expectedTriggerHash,
    "DATABASE_TRIGGERS_CHANGED", "admission");
}

/** Capture protected data without exporting any customer payload or monetary values. */
async function protectedRows(client: PoolClient, prepared: Prepared): Promise<Map<string, RowHashMap>> {
  const scope = prepared.context.orders.map(order => order.id);
  const wmsIds = (await client.query<{ id: number }>(`SELECT w.id FROM wms.orders w
    WHERE EXISTS(SELECT 1 FROM oms.oms_orders o WHERE o.id=ANY($1::bigint[])
      AND (w.oms_fulfillment_order_id=o.id::text OR (w.channel_id=o.channel_id AND w.external_order_id=o.external_order_id)))
    ORDER BY w.id LIMIT 501`, [scope])).rows.map(row => row.id);
  requireCondition(wmsIds.length <= 500, "WMS_SCOPE_OVERFLOW", "preservation");
  const variantIds = (await client.query<{ id: number }>(`SELECT DISTINCT product_variant_id AS id FROM oms.oms_order_lines
    WHERE order_id=ANY($1::bigint[]) AND product_variant_id IS NOT NULL
    UNION SELECT DISTINCT product_id FROM wms.order_items WHERE order_id=ANY($2::integer[]) AND product_id IS NOT NULL`,
  [scope, wmsIds])).rows.map(row => row.id);
  const selections: Array<[string, string, unknown[]]> = [
    ["wms.orders", "row.id=ANY($1::integer[])", [wmsIds]],
    ["wms.order_items", "row.order_id=ANY($1::integer[])", [wmsIds]],
    ["wms.outbound_shipments", "row.order_id=ANY($1::integer[])", [wmsIds]],
    ["wms.outbound_shipment_items", "row.shipment_id IN (SELECT id FROM wms.outbound_shipments WHERE order_id=ANY($1::integer[]))", [wmsIds]],
    ["oms.order_item_costs", "row.order_id=ANY($1::integer[])", [wmsIds]],
    ["inventory.inventory_levels", "row.product_variant_id=ANY($1::integer[])", [variantIds]],
    ["inventory.inventory_lots", "row.product_variant_id=ANY($1::integer[])", [variantIds]],
    ["inventory.inventory_transactions", "row.product_variant_id=ANY($1::integer[])", [variantIds]],
    ["oms.channel_fulfillment_receipts", "row.oms_order_id=ANY($1::bigint[]) OR EXISTS(SELECT 1 FROM oms.oms_orders o WHERE o.id=ANY($1::bigint[]) AND row.source_channel_id=o.channel_id AND row.source_order_id=o.external_order_id)", [scope]],
    ["oms.channel_fulfillment_pushes", "row.oms_order_id=ANY($1::bigint[])", [scope]],
    ["wms.reconciliation_exceptions", "row.wms_order_id=ANY($1::integer[])", [wmsIds]],
    ["oms.oms_orders", "row.id=$1::bigint", [prepared.proposal.preserve.openOmsOrderId]],
    ["oms.oms_order_lines", "row.order_id=$1::bigint", [prepared.proposal.preserve.openOmsOrderId]],
  ];
  const result = new Map<string, RowHashMap>();
  for (const [table, where, parameters] of selections) result.set(table, await rowHashes(client, table, where, parameters));
  return result;
}

async function unchangedFields(client: PoolClient, changes: readonly Change[]): Promise<RowHashMap> {
  const result = new Map<string, string>();
  for (const change of changes) {
    const { rows } = await client.query<{ hash: string }>(`SELECT encode(sha256(convert_to(
      (to_jsonb(row)-$2::text[])::text,'UTF8')),'hex') AS hash FROM ${change.table} row WHERE id=$1::bigint`,
    [change.id, [...Object.keys(change.after), "updated_at"]]);
    requireCondition(rows.length === 1, "CHANGED_ROW_MISSING", change.table);
    result.set(`${change.table}:${change.id}`, rows[0].hash);
  }
  return result;
}

async function updateReviewedRow(client: PoolClient, change: Change, now: string): Promise<void> {
  validateChange(change);
  const fields = Object.keys(change.after);
  const values = fields.map(field => change.after[field]);
  const result = await client.query(`UPDATE ${change.table} AS row SET
    ${fields.map((field, index) => `${field}=$${index + 1}`).join(",")},updated_at=$${fields.length + 1}
    WHERE id=$${fields.length + 2}::bigint
      AND encode(sha256(convert_to(to_jsonb(row)::text,'UTF8')),'hex')=$${fields.length + 3}`,
  [...values, now, change.id, change.expectedRowHash]);
  requireCondition(result.rowCount === 1, "STALE_REVIEWED_ROW", change.table);
}

async function assertAppliedFields(client: PoolClient, prepared: Prepared): Promise<void> {
  for (const change of [...prepared.proposal.lineChanges, ...prepared.proposal.orderChanges]) {
    const fields = Object.keys(change.after);
    const { rows } = await client.query(`SELECT ${fields.join(",")} FROM ${change.table} WHERE id=$1::bigint`, [change.id]);
    requireCondition(rows.length === 1 && canonicalHash(rows[0]) === canonicalHash(change.after), "APPLIED_STATE_CHANGED", change.table);
  }
  for (const refund of prepared.refunds) {
    const { rows } = await client.query(`SELECT order_id::text,order_line_id::text,restock_policy,quantity
      FROM oms.order_line_adjustments WHERE source=$1 AND source_event_id=$2 AND external_line_item_id=$3 AND adjustment_type='refund'`,
    [refund.source, refund.sourceEventId, refund.externalLineItemId]);
    requireCondition(rows.length === 1 && rows[0].order_id === refund.orderId && rows[0].order_line_id === refund.orderLineId
      && rows[0].restock_policy === refund.restockPolicy && rows[0].quantity === refund.quantity,
    "REFUND_EVIDENCE_CHANGED", "refund_evidence");
  }
  const expectedRefundLines = prepared.proposal.lineChanges.filter(change => change.after.authorization_status === "refunded");
  const audit = await client.query(`SELECT event_key,order_line_id::text,authorization_status,refunded_quantity,
    source_topic,source_event_id FROM oms.oms_order_line_authority_events WHERE event_key=ANY($1::text[])`,
  [expectedRefundLines.map(change => `${CLEANUP_COMMAND}:line:${change.id}`)]);
  requireCondition(audit.rows.length === expectedRefundLines.length && expectedRefundLines.every(change =>
    audit.rows.some(row => row.event_key === `${CLEANUP_COMMAND}:line:${change.id}` && row.order_line_id === change.id
      && row.authorization_status === "refunded" && row.source_topic === AUDIT_TOPIC && row.source_event_id === CLEANUP_COMMAND
      && row.refunded_quantity === (change.after.refunded_quantity
        ?? prepared.context.lines.find(line => line.id === change.id)?.refunded_quantity))),
  "AUTHORITY_AUDIT_CHANGED", "authority_audit");
}

async function applyInsideTransaction(client: PoolClient, prepared: Prepared): Promise<CleanupResult> {
  await lockScope(client, prepared);
  const { proposal, context, metadata } = prepared;
  const auditRows = await client.query<{ order_id: string; details: { requestHash?: string } }>(`SELECT order_id::text,details
    FROM oms.oms_order_events WHERE order_id=ANY($1::bigint[]) AND event_type=$2 AND details->>'command'=$3 ORDER BY order_id`,
  [prepared.orderIds, AUDIT_EVENT, CLEANUP_COMMAND]);
  const result: CleanupResult = { command: CLEANUP_COMMAND, replayed: auditRows.rows.length > 0,
    lineUpdates: proposal.lineChanges.length, orderUpdates: proposal.orderChanges.length,
    refundEvidenceInserts: prepared.refunds.length,
    authorityAuditInserts: proposal.lineChanges.filter(change => change.after.authorization_status === "refunded").length,
    orderAuditInserts: prepared.orderIds.length, inventoryWrites: 0, providerRequests: 0 };
  if (result.replayed) {
    requireCondition(auditRows.rows.length === prepared.orderIds.length
      && new Set(auditRows.rows.map(row => row.order_id)).size === prepared.orderIds.length
      && auditRows.rows.every(row => row.details.requestHash === prepared.requestHash), "REPLAY_COMMAND_CONFLICT", "idempotency");
    await assertAppliedFields(client, prepared);
    return { ...result, lineUpdates: 0, orderUpdates: 0, refundEvidenceInserts: 0, authorityAuditInserts: 0, orderAuditInserts: 0 };
  }
  matchReviewed(await rowHashes(client, "oms.oms_orders", "row.id=ANY($1::bigint[])", [prepared.orderIds]),
    context.orders.filter(order => prepared.orderIds.includes(order.id)), "reviewed_orders");
  matchReviewed(await rowHashes(client, "oms.oms_order_lines", "row.order_id=ANY($1::bigint[])", [prepared.orderIds]),
    context.lines.filter(line => prepared.orderIds.includes(line.order_id)), "reviewed_lines");
  matchReviewed(await rowHashes(client, "oms.order_line_adjustments", "row.order_id=ANY($1::bigint[])", [prepared.orderIds]),
    context.adjustments.filter(row => prepared.orderIds.includes(String(row.order_id))), "reviewed_refunds");
  const protectedBefore = await protectedRows(client, prepared);
  const appendOnlyTables = ["oms.oms_order_events", "oms.oms_order_line_authority_events", "oms.order_line_adjustments"];
  const appendBefore = new Map<string, RowHashMap>();
  for (const table of appendOnlyTables) appendBefore.set(table,
    await rowHashes(client, table, "row.order_id=ANY($1::bigint[])", [prepared.orderIds]));
  const changes = [...proposal.lineChanges, ...proposal.orderChanges];
  const unchangedBefore = await unchangedFields(client, changes);
  const otherLineIds = context.lines.filter(line => prepared.orderIds.includes(line.order_id)
    && !proposal.lineChanges.some(change => change.id === line.id)).map(line => line.id);
  const siblingsBefore = await rowHashes(client, "oms.oms_order_lines", "row.id=ANY($1::bigint[])", [otherLineIds]);

  for (const refund of prepared.refunds) {
    await client.query(`INSERT INTO oms.order_line_adjustments
      (order_id,order_line_id,external_line_item_id,source,source_event_id,adjustment_type,restock_policy,quantity,reason,raw_payload,created_at)
      VALUES($1::bigint,$2::bigint,$3,$4,$5,'refund',$6,$7,$8,$9::jsonb,$10)`,
    [refund.orderId, refund.orderLineId, refund.externalLineItemId, refund.source, refund.sourceEventId, refund.restockPolicy,
      refund.quantity, metadata.reason, JSON.stringify({ command: CLEANUP_COMMAND, actor: metadata.actor,
        provenance: refund.provenance, sourceHashes: metadata.sourceHashes, refundIssued: false, inventoryPosted: false }), metadata.occurredAt]);
  }
  for (const change of proposal.lineChanges) {
    // Append authority history from the still-locked pre-update row. Original
    // payment provenance remains unchanged; the source identifies maintenance.
    if (change.after.authorization_status === "refunded") {
      await client.query(`INSERT INTO oms.oms_order_line_authority_events
        (event_key,event_type,order_id,order_line_id,source_topic,source_event_id,
         previous_channel_observed_quantity,previous_paid_quantity,previous_authority_fulfillable_quantity,
         previous_authorization_status,channel_observed_quantity,paid_quantity,authority_fulfillable_quantity,
         cancelled_quantity,refunded_quantity,authorization_status,authorized_at,authorized_by_event_id,created_at)
        SELECT $1,'line_updated',order_id,id,$2,$3,channel_observed_quantity,paid_quantity,authority_fulfillable_quantity,
          authorization_status,channel_observed_quantity,paid_quantity,authority_fulfillable_quantity,cancelled_quantity,
          $4,'refunded',authorized_at,authorized_by_event_id,$5 FROM oms.oms_order_lines WHERE id=$6::bigint`,
      [`${CLEANUP_COMMAND}:line:${change.id}`, AUDIT_TOPIC, CLEANUP_COMMAND,
        change.after.refunded_quantity ?? context.lines.find(line => line.id === change.id)?.refunded_quantity,
        metadata.occurredAt, change.id]);
    }
    await updateReviewedRow(client, change, metadata.occurredAt);
  }
  for (const change of proposal.orderChanges) await updateReviewedRow(client, change, metadata.occurredAt);
  for (const orderId of prepared.orderIds) {
    await client.query(`INSERT INTO oms.oms_order_events(order_id,event_type,details,created_at) VALUES($1::bigint,$2,$3::jsonb,$4)`,
    [orderId, AUDIT_EVENT, JSON.stringify({ command: CLEANUP_COMMAND, requestHash: prepared.requestHash,
      actor: metadata.actor, reason: metadata.reason, occurredAt: metadata.occurredAt, sourceHashes: metadata.sourceHashes,
      approval: "Owner-approved D3/D4 exact historical lines; not activation or live-order repair",
      planHash: metadata.expectedPlanHash, result, orderChange: proposal.orderChanges.find(change => change.id === orderId) ?? null,
      lineChanges: proposal.lineChanges.filter(change => context.lines.find(line => line.id === change.id)?.order_id === orderId),
      refunds: prepared.refunds.filter(refund => refund.orderId === orderId),
      internalOutboxEffects: "Normal OMS intake and Archon order projection triggers retained" }), metadata.occurredAt]);
  }
  // Audit and deferred-trigger failures are inside the same rollback boundary.
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  sameRows(unchangedBefore, await unchangedFields(client, changes), "non_lifecycle_columns");
  sameRows(siblingsBefore, await rowHashes(client, "oms.oms_order_lines", "row.id=ANY($1::bigint[])", [otherLineIds]), "unchanged_siblings");
  const protectedAfter = await protectedRows(client, prepared);
  for (const [table, before] of protectedBefore) sameRows(before, protectedAfter.get(table) ?? new Map(), table);
  const expectedAppends: Readonly<Record<string, number>> = {
    "oms.oms_order_events": result.orderAuditInserts,
    "oms.oms_order_line_authority_events": result.authorityAuditInserts,
    "oms.order_line_adjustments": result.refundEvidenceInserts,
  };
  for (const table of appendOnlyTables) {
    const before = appendBefore.get(table)!;
    const after = await rowHashes(client, table, "row.order_id=ANY($1::bigint[])", [prepared.orderIds]);
    requireCondition(after.size === before.size + expectedAppends[table]
      && [...before].every(([key, value]) => after.get(key) === value), "AUDIT_OR_REFUND_HISTORY_CHANGED", table);
  }
  await assertAppliedFields(client, prepared);
  return result;
}

/** One transaction and stable command identity; caller may retry only the same request after an uncertain commit. */
export async function executeRecordsCleanup(pool: Pick<Pool, "connect">, request: CleanupRequest): Promise<CleanupResult> {
  let prepared: Prepared;
  try { prepared = prepare(request); }
  catch (error) {
    if (error instanceof RecordsCleanupError) throw error;
    throw new RecordsCleanupError("INVALID_CLEANUP_EVIDENCE", "contract");
  }
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch { throw new RecordsCleanupError("CLEANUP_CONNECTION_FAILED", "connect"); }
  let stage = "begin";
  let commitAttempted = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL lock_timeout='1500ms'");
    await client.query("SET LOCAL statement_timeout='30000ms'");
    stage = "apply";
    const result = await applyInsideTransaction(client, prepared);
    stage = "commit";
    commitAttempted = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    let rollbackConfirmed = true;
    try { await client.query("ROLLBACK"); }
    catch { rollbackConfirmed = false; }
    if (!rollbackConfirmed) throw new RecordsCleanupError(commitAttempted
      ? "COMMIT_RESULT_UNCERTAIN" : "ROLLBACK_RESULT_UNCONFIRMED", stage);
    if (error instanceof RecordsCleanupError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    throw new RecordsCleanupError(commitAttempted ? "COMMIT_RESULT_UNCERTAIN" : "CLEANUP_TRANSACTION_FAILED",
      stage, code && /^[A-Z0-9]{5}$/.test(code) ? code : undefined);
  } finally {
    // Never return a possibly broken/aborted maintenance connection to the pool.
    client.release(true);
  }
}
