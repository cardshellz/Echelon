import { asc, eq, sql } from "drizzle-orm";
import { auditEvents, inboundShipments, inboundShipmentLines } from "@shared/schema";
import { shipmentMeasurementContextSchema, shipmentMeasurementsSchema, shipmentMeasurementApprovalResultSchema, type ShipmentMeasurementReviewRequest, type ShipmentMeasurementPreview } from "@shared/procurement/shipment-measurement-correction";
import { readPurchaseApprovalActor, readPurchaseApproverName } from "../identity/infrastructure/purchase-approval-access.repository";
import { lockInventoryCostGraph, costFingerprint } from "../inventory/infrastructure/cost-evidence.repository";
import { readPoAmendmentDependencies, type PoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";

export class ShipmentMeasurementCorrectionError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); this.name = "ShipmentMeasurementCorrectionError"; }
}

/** Graph before shipment locks matches receiving and the existing cost command.
 * Include the complete shared shipments/lot graph, rather than approving a
 * partial PO share when a measurement changes the freight split. */
export async function readShipmentMeasurementSource(tx: AmendmentTransaction, shipmentId: number, actorId: string) {
  await lockInventoryCostGraph(tx);
  const [shipment] = await tx.select().from(inboundShipments).where(eq(inboundShipments.id, shipmentId)).for("update");
  if (!shipment) throw new ShipmentMeasurementCorrectionError("Shipment not found.", "SHIPMENT_MEASUREMENTS_NOT_FOUND", 404);
  const actor = await readPurchaseApprovalActor(tx, actorId);
  const lines = await tx.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.inboundShipmentId, shipmentId)).orderBy(asc(inboundShipmentLines.id)).for("update");
  if (!lines.length || lines.length > 500) throw new ShipmentMeasurementCorrectionError("Review between 1 and 500 shipment lines together.", "SHIPMENT_MEASUREMENTS_LINE_LIMIT");
  const poLineIds = [...new Set(lines.flatMap(line => line.purchaseOrderLineId === null ? [] : [line.purchaseOrderLineId]))];
  // Costed shipment lines must have PO ownership for allocation and receipt
  // lineage. Do not manufacture ownership for an unlinked historical line.
  if (lines.some(line => line.purchaseOrderLineId === null)) throw new ShipmentMeasurementCorrectionError("Link every shipment line to its PO before reviewing costs.", "SHIPMENT_MEASUREMENTS_PO_LINK_REQUIRED");
  const dependencies = await readPoAmendmentDependencies(tx, poLineIds);
  return { shipment, lines, actor, dependencies,
    sourceVersion: costFingerprint({ measurementReviewVersion: 1, shipment, lines, actor, dependencies }) };
}
export type ShipmentMeasurementSource = Awaited<ReturnType<typeof readShipmentMeasurementSource>>;

export function measurementsOf(line: ShipmentMeasurementSource["lines"][number]) {
  return shipmentMeasurementsSchema.parse({ cartonCount: line.cartonCount, dimensionBasis: line.dimensionBasis,
    weightKg: line.weightKg, lengthCm: line.lengthCm, widthCm: line.widthCm, heightCm: line.heightCm });
}
export async function saveShipmentMeasurements(tx: AmendmentTransaction, source: ShipmentMeasurementSource, request: ShipmentMeasurementReviewRequest, at: Date) {
  for (const change of request.lines) {
    if (!source.lines.some(line => line.id === change.lineId)) throw new ShipmentMeasurementCorrectionError("A corrected line does not belong to this shipment.", "SHIPMENT_MEASUREMENTS_LINE_INVALID", 400);
    await tx.update(inboundShipmentLines).set({ ...change.measurements,
      updatedAt: sql`GREATEST(${at}::timestamp, ${inboundShipmentLines.updatedAt} + interval '1 millisecond')`,
    }).where(eq(inboundShipmentLines.id, change.lineId));
  }
}
export async function readShipmentMeasurementApprovals(tx: AmendmentTransaction, shipmentId: number) {
  const result = await tx.execute(sql`SELECT event.id,event.actor,event.timestamp,event.changes,
    COALESCE(event.context->>'actorName',NULLIF(btrim(actor.display_name),''),actor.username,event.actor) AS actor_name
    FROM public.audit_events event LEFT JOIN identity.users actor ON actor.id=event.actor
    WHERE event.action='procurement.shipment.measurements_corrected' AND event.target=${`shipment:${shipmentId}`}
    ORDER BY event.id DESC LIMIT 20`);
  return shipmentMeasurementContextSchema.shape.approvals.parse(result.rows.map(row => ({
    id: Number(row.id), actorId: row.actor, actorName: row.actor_name,
    approvedAt: new Date(String(row.timestamp)).toISOString(), preview: (row.changes as { preview: unknown }).preview,
  })));
}
export async function recordShipmentMeasurementApproval(tx: AmendmentTransaction, source: ShipmentMeasurementSource,
  preview: ShipmentMeasurementPreview, actorId: string, at: Date) {
  const actorName = await readPurchaseApproverName(tx, actorId);
  const [event] = await tx.insert(auditEvents).values({ timestamp: at, level: "AUDIT", actor: actorId,
    action: "procurement.shipment.measurements_corrected", target: `shipment:${source.shipment.id}`,
    changes: { preview }, context: { shipmentId: source.shipment.id, actorName, reason: preview.reason,
      source: "saved_shipment_line_measurements", inventoryQuantityDelta: 0, shipmentStatus: source.shipment.status },
  }).returning({ id: auditEvents.id });
  if (!event) throw new ShipmentMeasurementCorrectionError("The measurement approval could not be recorded.", "SHIPMENT_MEASUREMENTS_AUDIT_FAILED", 500);
  return shipmentMeasurementApprovalResultSchema.parse({ auditEventId: event.id, actorId, actorName, approvedAt: at.toISOString(), preview });
}

export function shipmentDependencyLines(dependencies: PoAmendmentDependencies, shipmentId: number) {
  return dependencies.shipmentLines.filter(line => Number(line.inbound_shipment_id) === shipmentId);
}
