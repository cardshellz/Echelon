import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  shipmentHistoryContextSchema, shipmentHistoryPostingSchema, type ShipmentHistoryReview,
} from "@shared/procurement/shipment-history-correction";
import { shipmentQuantityStage } from "@shared/procurement/purchase-line-shipping";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { SYSTEM_ROLES } from "../identity/domain/identity.domain";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { ShipmentHistoryCorrectionError, historyCorrectionBlock, shipmentHistoryIssues } from "./domain/shipment-history-correction";

export const historyFingerprint = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const row = z.record(z.unknown());
const integer = z.number().int().safe();
const storedInteger = z.preprocess(value => typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value, integer);
function count(value: unknown): number { return storedInteger.pipe(z.number().nonnegative()).parse(value); }
function sum(values: unknown[]): number {
  return integer.parse(Number(values.reduce<bigint>((total, value) => total + BigInt(storedInteger.parse(value)), BigInt(0))));
}
const day = (value: unknown): string | null => value == null ? null : z.coerce.date().parse(value).toISOString().slice(0, 10);
const iso = (value: unknown): string => z.coerce.date().parse(value).toISOString();
const nullableId = (value: unknown): number | null => value == null ? null : count(value);
async function rows(tx: AmendmentTransaction, query: SQL) { return z.array(row).parse((await tx.execute(query)).rows); }

/** Same shipment/cost lock order as quantity correction and cost finalization.
 * All reads are evidence; only writeHistoryCorrection below can mutate state. */
export async function readShipmentHistorySource(tx: AmendmentTransaction, shipmentId: number, actorId: string) {
  try { return await readLockedShipmentHistorySource(tx, shipmentId, actorId); }
  catch (error) {
    if (error instanceof z.ZodError) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_SOURCE_INVALID",
      "Saved shipment or receipt values are incomplete or invalid. Review the source records before approving; no changes were saved.");
    throw error;
  }
}

async function readLockedShipmentHistorySource(tx: AmendmentTransaction, shipmentId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const [shipment] = await rows(tx, sql`SELECT * FROM procurement.inbound_shipments WHERE id=${shipmentId} FOR UPDATE`);
  if (!shipment) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_NOT_FOUND", "Shipment not found.", 404);
  const lines = await rows(tx, sql`SELECT * FROM procurement.inbound_shipment_lines WHERE inbound_shipment_id=${shipmentId} ORDER BY id FOR UPDATE`);
  const poLineIds = lines.map(line => nullableId(line.purchase_order_line_id)).filter((id): id is number => id !== null);
  const poIds = [...new Set(lines.map(line => nullableId(line.purchase_order_id)).filter((id): id is number => id !== null))];
  const purchases = await rows(tx, sql`SELECT * FROM procurement.purchase_orders WHERE id=ANY(${sql.param(poIds)}::int[]) ORDER BY id FOR UPDATE`);
  const purchaseLines = await rows(tx, sql`SELECT * FROM procurement.purchase_order_lines WHERE id=ANY(${sql.param(poLineIds)}::int[]) ORDER BY id FOR UPDATE`);
  const relatedLines = await rows(tx, sql`SELECT line.*,shipment.status AS shipment_status
    FROM procurement.inbound_shipment_lines line JOIN procurement.inbound_shipments shipment ON shipment.id=line.inbound_shipment_id
    WHERE line.purchase_order_line_id=ANY(${sql.param(poLineIds)}::int[]) AND shipment.id<>${shipmentId} ORDER BY line.id`);
  const receipts = await rows(tx, sql`SELECT receipt.* FROM procurement.receiving_orders receipt WHERE receipt.id IN
    (SELECT receiving_order_id FROM procurement.receiving_lines WHERE purchase_order_line_id=ANY(${sql.param(poLineIds)}::int[])) ORDER BY receipt.id FOR SHARE`);
  const receiptLines = await rows(tx, sql`SELECT * FROM procurement.receiving_lines WHERE purchase_order_line_id=ANY(${sql.param(poLineIds)}::int[]) ORDER BY id FOR SHARE`);
  const postings = await rows(tx, sql`SELECT * FROM procurement.po_receipts WHERE purchase_order_line_id=ANY(${sql.param(poLineIds)}::int[]) ORDER BY id FOR SHARE`);
  const receiptIds = receipts.map(receipt => count(receipt.id));
  const reversals = await rows(tx, sql`SELECT * FROM procurement.receipt_reversals WHERE receiving_order_id=ANY(${sql.param(receiptIds)}::int[]) ORDER BY id`);
  const costs = await rows(tx, sql`SELECT * FROM procurement.inbound_freight_costs WHERE inbound_shipment_id=${shipmentId} ORDER BY id FOR SHARE`);
  const allocations = await rows(tx, sql`SELECT allocation.* FROM procurement.inbound_freight_allocations allocation
    JOIN procurement.inbound_freight_costs cost ON cost.id=allocation.shipment_cost_id WHERE cost.inbound_shipment_id=${shipmentId} ORDER BY allocation.id`);
  const lineIds = lines.map(line => count(line.id));
  const snapshots = await rows(tx, sql`SELECT * FROM procurement.landed_cost_snapshots WHERE inbound_shipment_line_id=ANY(${sql.param(lineIds)}::int[]) ORDER BY id`);
  const adjustments = await rows(tx, sql`SELECT * FROM procurement.landed_cost_adjustments WHERE inbound_shipment_line_id=ANY(${sql.param(lineIds)}::int[]) ORDER BY id`);
  const history = await rows(tx, sql`SELECT * FROM procurement.inbound_shipment_status_history WHERE inbound_shipment_id=${shipmentId} ORDER BY id`);
  const approvals = await rows(tx, sql`SELECT * FROM procurement.shipment_history_corrections WHERE inbound_shipment_id=${shipmentId} ORDER BY id DESC LIMIT 20`);
  const actor = await readPurchaseApprovalActor(tx, actorId);
  // Freeze every existing business record. Header status/event dates are the only
  // allowed changes; neither receipts nor the PO are rewritten to force a match.
  const { status: _status, ship_date: _ship, delivered_date: _delivered, updated_at: _updated, ...protectedHeader } = shipment;
  const protectedRecords = { protectedHeader, lines, purchases, purchaseLines, relatedLines, receipts, receiptLines, postings, reversals, costs, allocations, snapshots, adjustments };
  const protectedRecordsVersion = historyFingerprint(protectedRecords);
  const sourceVersion = historyFingerprint({ version: 1, protectedRecords, shipment, history, approvals });
  const lineViews = lines.map(line => {
    const poLine = purchaseLines.find(candidate => candidate.id === line.purchase_order_line_id && candidate.purchase_order_id === line.purchase_order_id);
    const purchase = purchases.find(candidate => candidate.id === line.purchase_order_id);
    const other = relatedLines.filter(candidate => candidate.purchase_order_line_id === line.purchase_order_line_id);
    const linePostings = postings.filter(posting => posting.purchase_order_line_id === poLine?.id);
    const unknown = other.some(candidate => shipmentQuantityStage(String(candidate.shipment_status)) === "unknown");
    return { id: count(line.id), sku: z.string().parse(line.sku), pieces: count(line.qty_shipped),
      purchaseOrderId: nullableId(line.purchase_order_id), poNumber: purchase ? z.string().parse(purchase.po_number) : null,
      purchaseOrderLineId: poLine ? count(poLine.id) : null,
      orderedPieces: poLine ? count(poLine.order_qty) : null, receivedPieces: poLine ? count(poLine.received_qty) : null,
      postedReceiptPieces: !poLine || reversals.length || !linePostings.length ? null : sum(linePostings.map(posting => posting.qty_received)),
      otherShippedPieces: unknown ? null : sum(other.filter(candidate => shipmentQuantityStage(String(candidate.shipment_status)) === "shipped").map(candidate => candidate.qty_shipped)),
      otherPlannedPieces: unknown ? null : sum(other.filter(candidate => shipmentQuantityStage(String(candidate.shipment_status)) === "planned").map(candidate => candidate.qty_shipped)),
    };
  });
  const receiptViews = receiptLines.map(line => {
    const receipt = receipts.find(candidate => candidate.id === line.receiving_order_id);
    if (!receipt) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_SOURCE_INVALID", "A receiving line has no receipt. Review its source record.");
    const posted = postings.filter(posting => posting.receiving_line_id === line.id);
    return { id: count(receipt.id), number: z.string().parse(receipt.receipt_number), lineId: count(line.id),
      purchaseOrderLineId: nullableId(line.purchase_order_line_id), handledUnits: count(line.received_qty),
      piecesPerUnit: nullableId(line.units_per_variant_snapshot), postedPieces: posted.length && !reversals.length ? sum(posted.map(posting => posting.qty_received)) : null,
      shipmentId: nullableId(receipt.inbound_shipment_id), shipmentLineId: nullableId(line.inbound_shipment_line_id) };
  });
  const currencies = [...new Set(costs.map(cost => z.string().length(3).parse(cost.currency)))].sort();
  const context = shipmentHistoryContextSchema.parse({
    shipmentId, shipmentNumber: shipment.shipment_number, sourceVersion,
    canApprove: actor.active && actor.approvalGrantIds.length > 0 && actor.roles.some(role => role.isSystem && role.name === SYSTEM_ROLES.admin.name),
    blockedReason: historyCorrectionBlock(String(shipment.status), lines.length),
    current: { status: shipment.status, departedOn: day(shipment.ship_date), deliveredOn: day(shipment.delivered_date) },
    lines: lineViews, receipts: receiptViews,
    charges: currencies.map(currency => ({ currency, cents: sum(costs.filter(cost => cost.currency === currency).map(cost => cost.actual_cents ?? cost.estimated_cents ?? 0)) })),
    issues: shipmentHistoryIssues(lineViews, receiptViews, shipmentId),
    events: history.map(event => ({ status: event.to_status, recordedAt: iso(event.changed_at), notes: event.notes })),
    approvals: approvals.map(approval => ({ id: count(approval.id), actorId: approval.actor_id, actorName: approval.actor_name,
      approvedAt: iso(approval.approved_at), reason: approval.reason, review: approval.review })),
  });
  return { context, protectedRecordsVersion };
}

export async function writeHistoryCorrection(tx: AmendmentTransaction, shipmentId: number, sourceVersion: string, actorId: string, reason: string, review: ShipmentHistoryReview, approvedAt: Date) {
  const actorName = await readPurchaseApproverName(tx, actorId);
  await tx.execute(sql`UPDATE procurement.inbound_shipments SET status=${review.after.status},
    ship_date=${new Date(`${review.after.departedOn}T00:00:00.000Z`)},
    delivered_date=${review.after.deliveredOn ? new Date(`${review.after.deliveredOn}T00:00:00.000Z`) : null},
    updated_at=${approvedAt} WHERE id=${shipmentId}`);
  const [saved] = await rows(tx, sql`INSERT INTO procurement.shipment_history_corrections
    (inbound_shipment_id,source_version,actor_id,actor_name,approved_at,reason,review)
    VALUES (${shipmentId},${sourceVersion},${actorId},${actorName},${approvedAt},${reason},${JSON.stringify(review)}::jsonb) RETURNING id`);
  const approval = shipmentHistoryPostingSchema.parse({ id: count(saved.id), actorId, actorName, approvedAt: approvedAt.toISOString(), reason, review });
  await tx.execute(sql`INSERT INTO procurement.inbound_shipment_status_history
    (inbound_shipment_id,from_status,to_status,changed_by,notes,changed_at)
    VALUES (${shipmentId},${review.before.status},${review.after.status},${actorId},
    ${`History correction #${approval.id} approved by ${actorName}. Departure: ${review.after.departedOn}; delivery: ${review.after.deliveredOn ?? "not confirmed"}. ${reason}`},${approvedAt})`);
  return approval;
}
