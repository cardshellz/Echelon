import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { receivingQuarantineObservationSchema, type ReceivingQuarantineObservation } from "@shared/procurement/receiving-quarantine";
import type { ReceivingIntegrityTransaction } from "./receiving-close-integrity.repository";
import { custodyQuantities, ReceivingQuarantineError } from "./domain/receiving-quarantine";
import type { CommandAuthorityActor } from "../identity/domain/command-authority";

export type CustodyTransaction = ReceivingIntegrityTransaction;
const id = z.number().int().positive();
export const custodyDatabaseTimestamp = z.union([z.date(), z.string().min(1)])
  .transform(value => value instanceof Date ? value : new Date(value))
  .pipe(z.date()).transform(value => value.toISOString());
const timestamp = custodyDatabaseTimestamp;
const observationSchema = receivingQuarantineObservationSchema.omit({
  holdingLocationLabel: true, unallocatedQty: true, physicalHeldQty: true,
  canPrepareAcceptance: true, canReturn: true, acceptances: true, dispositions: true,
}).extend({ recordedAt: timestamp });
export type CustodyObservation = z.infer<typeof observationSchema>;
const projection = sql`id,receiving_order_id AS "receivingOrderId",receiving_line_id AS "receivingLineId",
  warehouse_id AS "warehouseId",holding_location_id AS "holdingLocationId",product_id AS "productId",
  product_variant_id AS "productVariantId",units_per_variant_snapshot AS "unitsPerVariant",
  purchase_order_line_id AS "purchaseOrderLineId",inbound_shipment_line_id AS "inboundShipmentLineId",
  description,observed_sku AS "observedSku",unit_label AS "unitLabel",condition,observed_qty AS "observedQty",
  awaiting_receipt_qty AS "awaitingReceiptQty",received_qty AS "receivedQty",returned_qty AS "returnedQty",
  version,reason,evidence_reference AS "evidenceReference",actor_id AS "actorId",recorded_at AS "recordedAt"`;

export const receivingCustodyHeaderSchema = z.object({ id, warehouseId: id.nullable(), status: z.string(), receiptNumber: z.string() });
export async function readCustodyReceipt(tx: CustodyTransaction, receiptId: number, lock = false) {
  const rows = (await tx.execute(sql`SELECT id,warehouse_id AS "warehouseId",status,receipt_number AS "receiptNumber"
    FROM procurement.receiving_orders WHERE id=${receiptId} ${lock ? sql`FOR UPDATE` : sql``}`)).rows;
  if (!rows.length) throw new ReceivingQuarantineError("RECEIVING_NOT_FOUND", "Receipt not found.", 404);
  return receivingCustodyHeaderSchema.parse(rows[0]);
}

export async function readCustodyObservation(tx: CustodyTransaction, observationId: number, lock = false): Promise<CustodyObservation> {
  const rows = (await tx.execute(sql`SELECT ${projection} FROM procurement.receiving_quarantine_observations
    WHERE id=${observationId} ${lock ? sql`FOR UPDATE` : sql``}`)).rows;
  if (!rows.length) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_NOT_FOUND", "Quarantine record not found.", 404);
  return observationSchema.parse(rows[0]);
}

export async function listCustodyObservations(tx: CustodyTransaction, receivingOrderId: number): Promise<CustodyObservation[]> {
  return z.array(observationSchema).parse((await tx.execute(sql`SELECT ${projection}
    FROM procurement.receiving_quarantine_observations WHERE receiving_order_id=${receivingOrderId}
      OR id IN (SELECT observation_id FROM procurement.receiving_quarantine_acceptances WHERE receiving_order_id=${receivingOrderId})
    ORDER BY id`)).rows);
}

export function custodyCapability(allowed: boolean, reason: string) { return { allowed, reason: allowed ? null : reason }; }
export function canResolveCustody(actor: CommandAuthorityActor): boolean {
  return actor.active && actor.permissions.includes("purchasing:approve");
}
export async function assertPhysicalHoldingLocation(tx: CustodyTransaction, locationId: number): Promise<void> {
  const location = z.object({ locationType: z.string().nullable() }).parse((await tx.execute(sql`
    SELECT location_type AS "locationType" FROM warehouse.warehouse_locations WHERE id=${locationId} FOR SHARE`)).rows[0]);
  if (location.locationType === "3pl_virtual") throw new ReceivingQuarantineError("RECEIVING_CUSTODY_PHYSICAL_LOCATION_REQUIRED",
    "Choose a physical holding location. A third-party availability slot cannot record warehouse custody.");
}

export async function projectCustodyObservation(tx: CustodyTransaction, row: CustodyObservation, actor: CommandAuthorityActor): Promise<ReceivingQuarantineObservation> {
  const quantities = custodyQuantities(row);
  const location = z.object({ label: z.string() }).parse((await tx.execute(sql`SELECT code AS label FROM warehouse.warehouse_locations WHERE id=${row.holdingLocationId}`)).rows[0]);
  const acceptances = (await tx.execute(sql`SELECT a.id,a.observation_qty AS "observationQty",a.receiving_order_id AS "receivingOrderId",
    r.receipt_number AS "receiptNumber",a.receiving_line_id AS "receivingLineId",a.product_variant_id AS "productVariantId",
    a.units_per_variant_snapshot AS "unitsPerVariant",a.accepted_variant_qty AS "acceptedVariantQty",a.status,
    a.created_at AS "createdAt",r.status AS "receiptStatus"
    FROM procurement.receiving_quarantine_acceptances a JOIN procurement.receiving_orders r ON r.id=a.receiving_order_id
    WHERE a.observation_id=${row.id} ORDER BY a.id`)).rows;
  const acceptanceRows = z.array(z.object({ id, observationQty: id, receivingOrderId: id, receiptNumber: z.string(),
    receivingLineId: id, productVariantId: id, unitsPerVariant: id, acceptedVariantQty: id,
    status: z.enum(["awaiting_receipt","received","cancelled"]), createdAt: timestamp, receiptStatus: z.string() })).parse(acceptances);
  const dispositions = z.array(receivingQuarantineObservationSchema.shape.dispositions.element.extend({ recordedAt: timestamp })).parse((await tx.execute(sql`
    SELECT id,kind,observation_qty AS "observationQty",actor_id AS "actorId",recorded_at AS "recordedAt",reason,
    evidence_reference AS "evidenceReference",acceptance_id AS "acceptanceId"
    FROM procurement.receiving_quarantine_dispositions WHERE observation_id=${row.id} ORDER BY version_after`)).rows);
  const resolve = canResolveCustody(actor) && quantities.unallocatedQty > 0;
  return receivingQuarantineObservationSchema.parse({ ...row, ...quantities, holdingLocationLabel: location.label,
    canPrepareAcceptance: custodyCapability(resolve, "An active purchasing approver and unresolved quantity are required."),
    canReturn: custodyCapability(resolve, "An active purchasing approver and unresolved quantity are required."),
    acceptances: acceptanceRows.map(({ receiptStatus, ...acceptance }) => ({ ...acceptance,
      canCancel: custodyCapability(canResolveCustody(actor) && acceptance.status === "awaiting_receipt"
        && ["draft","open","receiving","verified"].includes(receiptStatus), "Only a pending acceptance on a mutable receipt can be cancelled by a purchasing approver.") })),
    dispositions });
}

export async function insertCustodyObservation(tx: CustodyTransaction, row: Omit<CustodyObservation, "id" | "awaitingReceiptQty" | "receivedQty" | "returnedQty" | "version">,
  commandKey: string, sourceEvidence: Readonly<Record<string, unknown>>): Promise<number> {
  const result = await tx.execute(sql`INSERT INTO procurement.receiving_quarantine_observations
    (receiving_order_id,receiving_line_id,warehouse_id,holding_location_id,product_id,product_variant_id,units_per_variant_snapshot,
    purchase_order_line_id,inbound_shipment_line_id,description,observed_sku,unit_label,condition,observed_qty,reason,evidence_reference,actor_id,recorded_at,command_key,source_evidence)
    VALUES(${row.receivingOrderId},${row.receivingLineId},${row.warehouseId},${row.holdingLocationId},${row.productId},${row.productVariantId},${row.unitsPerVariant},
    ${row.purchaseOrderLineId},${row.inboundShipmentLineId},${row.description},${row.observedSku},${row.unitLabel},${row.condition},${row.observedQty},
    ${row.reason},${row.evidenceReference},${row.actorId},${row.recordedAt},${commandKey},${canonicalJson(sourceEvidence)}::jsonb) RETURNING id`);
  return z.object({ id }).parse(result.rows[0]).id;
}

export const custodyAcceptanceRecordSchema = z.object({ id, observationId: id, receivingOrderId: id, receivingLineId: id,
  observationQty: id, productId: id, productVariantId: id, unitsPerVariant: id, acceptedVariantQty: id, status: z.enum(["awaiting_receipt","received","cancelled"]) });
export type CustodyAcceptance = z.infer<typeof custodyAcceptanceRecordSchema>;
const acceptanceProjection = sql`id,observation_id AS "observationId",receiving_order_id AS "receivingOrderId",receiving_line_id AS "receivingLineId",
  observation_qty AS "observationQty",product_id AS "productId",product_variant_id AS "productVariantId",units_per_variant_snapshot AS "unitsPerVariant",
  accepted_variant_qty AS "acceptedVariantQty",status`;
export async function readCustodyAcceptance(tx: CustodyTransaction, acceptanceId: number): Promise<CustodyAcceptance> {
  const rows = (await tx.execute(sql`SELECT ${acceptanceProjection} FROM procurement.receiving_quarantine_acceptances WHERE id=${acceptanceId} FOR UPDATE`)).rows;
  if (!rows.length) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACCEPTANCE_NOT_FOUND", "Acceptance not found.", 404);
  return custodyAcceptanceRecordSchema.parse(rows[0]);
}
export async function insertCustodyAcceptance(tx: CustodyTransaction, input: Omit<CustodyAcceptance,"id"|"status">,
  actorId: string, at: Date, reason: string, sourceEvidence: Readonly<Record<string, unknown>>): Promise<number> {
  return z.object({ id }).parse((await tx.execute(sql`INSERT INTO procurement.receiving_quarantine_acceptances
    (observation_id,receiving_order_id,receiving_line_id,observation_qty,product_id,product_variant_id,units_per_variant_snapshot,accepted_variant_qty,status,actor_id,created_at,reason,source_evidence)
    VALUES(${input.observationId},${input.receivingOrderId},${input.receivingLineId},${input.observationQty},${input.productId},${input.productVariantId},
    ${input.unitsPerVariant},${input.acceptedVariantQty},'awaiting_receipt',${actorId},${at},${reason},${canonicalJson(sourceEvidence)}::jsonb) RETURNING id`)).rows[0]).id;
}

export async function recordCustodyDisposition(tx: CustodyTransaction, row: CustodyObservation, input: {
  kind: "prepare_acceptance" | "cancel_acceptance" | "receive" | "return"; quantity: number; acceptanceId: number | null;
  actorId: string; at: Date; reason: string; evidenceReference: string | null; commandKey: string; requestEvidence: Readonly<Record<string, unknown>>;
}): Promise<void> {
  const awaiting = row.awaitingReceiptQty + (input.kind === "prepare_acceptance" ? input.quantity
    : ["cancel_acceptance","receive"].includes(input.kind) ? -input.quantity : 0);
  const received = row.receivedQty + (input.kind === "receive" ? input.quantity : 0);
  const returned = row.returnedQty + (input.kind === "return" ? input.quantity : 0);
  custodyQuantities({ observedQty: row.observedQty, awaitingReceiptQty: awaiting, receivedQty: received, returnedQty: returned, version: row.version + 1 });
  const updated = await tx.execute(sql`UPDATE procurement.receiving_quarantine_observations SET awaiting_receipt_qty=${awaiting},
    received_qty=${received},returned_qty=${returned},version=version+1 WHERE id=${row.id} AND version=${row.version} RETURNING id`);
  if (updated.rows.length !== 1) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_STALE", "Custody changed. Refresh before resolving.");
  if (input.acceptanceId && input.kind !== "prepare_acceptance") {
    const result = await tx.execute(sql`UPDATE procurement.receiving_quarantine_acceptances SET status=${input.kind === "receive" ? "received" : "cancelled"}
      WHERE id=${input.acceptanceId} AND observation_id=${row.id} AND status='awaiting_receipt' RETURNING id`);
    if (result.rows.length !== 1) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACCEPTANCE_STALE", "The acceptance was already resolved.");
  }
  await tx.execute(sql`INSERT INTO procurement.receiving_quarantine_dispositions
    (observation_id,acceptance_id,kind,observation_qty,actor_id,recorded_at,reason,evidence_reference,version_before,version_after,command_key,request_evidence)
    VALUES(${row.id},${input.acceptanceId},${input.kind},${input.quantity},${input.actorId},${input.at},${input.reason},
    ${input.evidenceReference},${row.version},${row.version + 1},${input.commandKey},${canonicalJson(input.requestEvidence)}::jsonb)`);
}

export async function readReceiptCustodyPresence(tx: CustodyTransaction, receiptId: number): Promise<boolean> {
  return (await tx.execute(sql`SELECT id FROM procurement.receiving_quarantine_observations WHERE receiving_order_id=${receiptId}
    UNION ALL SELECT id FROM procurement.receiving_quarantine_acceptances WHERE receiving_order_id=${receiptId} LIMIT 1`)).rows.length > 0;
}
export async function assertNoReceivingCustodyHistory(tx: CustodyTransaction, input: { receivingOrderId?: number; receivingLineId?: number }): Promise<void> {
  if (!input.receivingOrderId && !input.receivingLineId) throw new TypeError("Receipt or line identity required");
  const conflict = input.receivingOrderId ? await readReceiptCustodyPresence(tx, input.receivingOrderId)
    : (await tx.execute(sql`SELECT id FROM procurement.receiving_quarantine_observations WHERE receiving_line_id=${input.receivingLineId}
      UNION ALL SELECT id FROM procurement.receiving_quarantine_acceptances WHERE receiving_line_id=${input.receivingLineId} LIMIT 1`)).rows.length > 0;
  if (conflict) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_HISTORY_PROTECTED",
    "This receipt has quarantine custody history. Resolve its held goods explicitly; its source and acceptance lines cannot be deleted, recounted, or reassigned.");
}
export async function assertReceivingQuarantineLineEditable(tx: CustodyTransaction, lineId: number, changedFields: readonly string[]): Promise<void> {
  // Notes and destination can change before close; identity, counts and cost
  // evidence must stay bound to the reviewed custody/acceptance snapshot.
  if (changedFields.every(field => ["notes","putawayLocationId"].includes(field))) return;
  await assertNoReceivingCustodyHistory(tx, { receivingLineId: lineId });
}

/** Caller acquired the write fence before receipt/stock locks. No independent
 * transaction or publication: custody exits only with successful normal close. */
export async function completeReceivingQuarantineAcceptances(tx: CustodyTransaction, input: {
  receivingOrderId: number; actorId: string; recordedAt: Date;
}): Promise<void> {
  const acceptances = z.array(custodyAcceptanceRecordSchema).parse((await tx.execute(sql`SELECT ${acceptanceProjection}
    FROM procurement.receiving_quarantine_acceptances WHERE receiving_order_id=${input.receivingOrderId} AND status='awaiting_receipt' ORDER BY observation_id,id FOR UPDATE`)).rows);
  for (const acceptance of acceptances) {
    const line = z.object({ receivedQty: id, productVariantId: id, unitsPerVariant: id, status: z.string() }).parse((await tx.execute(sql`
      SELECT received_qty AS "receivedQty",product_variant_id AS "productVariantId",units_per_variant_snapshot AS "unitsPerVariant",status
      FROM procurement.receiving_lines WHERE id=${acceptance.receivingLineId} AND receiving_order_id=${input.receivingOrderId} FOR SHARE`)).rows[0]);
    if (line.receivedQty !== acceptance.acceptedVariantQty || line.productVariantId !== acceptance.productVariantId || line.unitsPerVariant !== acceptance.unitsPerVariant) {
      throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACCEPTANCE_CHANGED", "The prepared acceptance no longer matches the receipt line.");
    }
    const row = await readCustodyObservation(tx, acceptance.observationId, true);
    await recordCustodyDisposition(tx, row, { kind: "receive", quantity: acceptance.observationQty, acceptanceId: acceptance.id,
      actorId: input.actorId, at: input.recordedAt, reason: "Normal receiving close committed accepted stock.",
      evidenceReference: null, commandKey: `receipt-close:${input.receivingOrderId}:${acceptance.id}`,
      requestEvidence: { receivingOrderId: input.receivingOrderId, receivingLineId: acceptance.receivingLineId } });
  }
}
