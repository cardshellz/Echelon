import type { InboundShipment } from "@shared/schema";
import { shipmentCreateSchema } from "@shared/procurement/shipment-create-command";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import type { ShipmentTrackingService } from "./shipment-tracking.service";
import { shipmentDefaultAllocation, ShipmentCreateError } from "./domain/shipment-create";
export { ShipmentCreateError } from "./domain/shipment-create";
import { allocateShipmentNumber, insertShipmentWithHistory, readCreatedShipment, recordShipmentCreation, type ShipmentCreateTransaction } from "./shipment-create.repository";

export type CreatedShipment = InboundShipment & { lineCount: number };

export function assertShipmentCreateActor(actorId: unknown): asserts actorId is string {
  if (typeof actorId !== "string" || !actorId.trim() || actorId.length > 100 || actorId !== actorId.trim()) {
    throw new ShipmentCreateError("SHIPMENT_CREATE_ACTOR_REQUIRED", "An authenticated actor is required.", 401);
  }
}

/** Header, history, selected lines, allocation totals and audit share one transaction. */
export async function executeCreateShipmentInTransaction(
  tx: ShipmentCreateTransaction,
  rawBody: unknown,
  actorId: string,
  now: Date,
  lineOwner: Pick<ShipmentTrackingService, "executeLineCommandInTransaction">,
): Promise<CreatedShipment> {
  assertShipmentCreateActor(actorId);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new ShipmentCreateError("SHIPMENT_CREATE_CLOCK_INVALID", "Shipment creation requires a valid clock.", 500);
  const { purchaseOrder, eta, etd, ...header } = shipmentCreateSchema.parse(rawBody);
  // Existing line creation acquires this graph lock before its shipment and PO
  // locks. Acquire it first here too, before the numbering lock or any writes.
  await lockInventoryCostGraph(tx);
  const shipmentNumber = await allocateShipmentNumber(tx, header.shipmentNumber, now);
  const shipment = await insertShipmentWithHistory(tx, {
    ...header, shipmentNumber, status: "draft", allocationMethodDefault: shipmentDefaultAllocation(header.mode), createdBy: actorId,
    ...(eta !== undefined ? { eta: eta === null ? null : new Date(eta) } : {}),
    ...(etd !== undefined ? { etd: etd === null ? null : new Date(etd) } : {}),
  }, actorId, now);
  if (purchaseOrder) await lineOwner.executeLineCommandInTransaction(tx, {
    operation: "add-from-po", resourceId: shipment.id, body: purchaseOrder,
  }, actorId, now);
  const final = await readCreatedShipment(tx, shipment.id);
  if (final.lines.length !== (purchaseOrder?.lineSelections?.length ?? 0)) {
    throw new ShipmentCreateError("SHIPMENT_CREATE_SELECTION_INCOMPLETE", "The complete reviewed purchase order selection could not be created.", 409);
  }
  await recordShipmentCreation(tx, { ...final, actorId, now });
  return { ...final.shipment, lineCount: final.lines.length };
}
