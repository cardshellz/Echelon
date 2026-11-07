import { eq } from "drizzle-orm";
import { db } from "../../db";
import { outboundShipments } from "@shared/schema";
import { readCommandAuthorityActor } from "../identity";
import { hasStaffCapability, SHIPMENT_CAPABILITIES, type StaffCapability } from "@shared/staff-capabilities";
import { shipmentOrderContextSchema } from "@shared/shipment-access";
import { readShipmentLinkedOrderSummary } from "../orders/shipment-order-context.query";
import { randomUUID } from "node:crypto";
import { logger } from "../../platform/observability/logger";
export class ShipmentAccessError extends Error {
  constructor(readonly status: 400 | 403 | 404, readonly code: string, message: string) { super(message); }
}
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Query authority is checked inside the data-read transaction. Grant/account
 * share locks keep revocation and this short bounded read in a coherent order.
 */
export async function withShipmentAccess<T>(actorId: string, capability: StaffCapability,
  query: (tx: Transaction, permissions: readonly string[]) => Promise<T>): Promise<T> {
  const started = performance.now(), operationId = randomUUID(), attemptId = randomUUID();
  const report = (outcome: string, errorCode?: string) => {
    try { logger.info("shipping.shipments.read", { module: "shipping",action: capability,outcome,
      actorId,operationId,attemptId,duration_ms: performance.now()-started,
      release: process.env.HEROKU_SLUG_COMMIT ?? process.env.RELEASE_VERSION ?? "unknown",
      ...(errorCode ? { error_code: errorCode,failed_step: "authorized_read",retry_safety: "read_only" } : {}) }); }
    catch { /* Diagnostics are best-effort; this query performs no critical mutation. */ }
  };
  try {
    const result = await db.transaction(async tx => {
    const actor = await readCommandAuthorityActor(tx, actorId);
    if (!actor.active || !hasStaffCapability(actor.permissions, capability))
      throw new ShipmentAccessError(403, "SHIPMENT_ACCESS_DENIED", "Shipment access is not permitted.");
    return query(tx, actor.permissions);
    });
    report("succeeded"); return result;
  } catch (error) {
    report(error instanceof ShipmentAccessError && error.status === 403 ? "denied" : "failed",
      error instanceof ShipmentAccessError ? error.code : "SHIPMENT_READ_FAILED");
    throw error;
  }
}
export async function queryShipmentOrderContext(actorId: string, shipmentId: number) {
  return withShipmentAccess(actorId, SHIPMENT_CAPABILITIES.orderContext, async tx => {
    const [shipment] = await tx.select({ orderId: outboundShipments.orderId }).from(outboundShipments)
      .where(eq(outboundShipments.id,shipmentId)).limit(1);
    if (!shipment) throw new ShipmentAccessError(404, "SHIPMENT_NOT_FOUND", "Shipment not found.");
    const order = shipment.orderId === null ? null : await readShipmentLinkedOrderSummary(tx, shipment.orderId);
    return shipmentOrderContextSchema.parse({ shipmentId, order });
  });
}
