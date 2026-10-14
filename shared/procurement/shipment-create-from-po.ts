import { z } from "zod";
import { shipmentHeaderCreateSchema } from "./shipment-header-input";
import { shipmentLineFromPoSchema, shipmentLineResourceIdSchema as id } from "./shipment-line-command";

// Creation requires an explicit, nonempty selection. Never silently expand to
// newly eligible PO lines when a saved request is retried.
export const shipmentCreateFromPoSchema = z.object({
  header: shipmentHeaderCreateSchema,
  source: shipmentLineFromPoSchema.refine((source) => source.lineSelections !== undefined && source.lineIds === undefined,
    { message: "Explicit purchase order line quantities are required" }),
}).strict();
export type ShipmentCreateFromPo = z.infer<typeof shipmentCreateFromPoSchema>;

export const shipmentCreatedFromPoSchema = z.object({
  shipment: z.object({ id, shipmentNumber: z.string().min(1).max(30) }).strict(),
  purchaseOrderId: id,
  lines: z.array(z.object({ id, inboundShipmentId: id, purchaseOrderId: id, purchaseOrderLineId: id, qtyShipped: id }).strict()).min(1),
}).strict();
export type ShipmentCreatedFromPo = z.infer<typeof shipmentCreatedFromPoSchema>;

/** Verify the entire selection before storing or accepting a success receipt. */
export function verifyShipmentCreatedFromPo(input: ShipmentCreateFromPo, raw: unknown): ShipmentCreatedFromPo {
  const result = shipmentCreatedFromPoSchema.parse(raw);
  const selections = input.source.lineSelections!;
  const expected = new Map(selections.map((line) => [line.poLineId, line.qty]));
  if (result.purchaseOrderId !== input.source.purchaseOrderId
    || (input.header.shipmentNumber !== undefined && result.shipment.shipmentNumber !== input.header.shipmentNumber)
    || result.lines.length !== selections.length
    || new Set(result.lines.map((line) => line.id)).size !== selections.length
    || new Set(result.lines.map((line) => line.purchaseOrderLineId)).size !== selections.length
    || result.lines.some((line) => line.inboundShipmentId !== result.shipment.id
      || line.purchaseOrderId !== result.purchaseOrderId || expected.get(line.purchaseOrderLineId) !== line.qtyShipped)) {
    throw new Error("Shipment creation receipt does not match the selected purchase order lines");
  }
  return result;
}
