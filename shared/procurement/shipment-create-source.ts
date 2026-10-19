import { z } from "zod";
import { shipmentUnitsSchema } from "./shipment-unit-selection";
import { shipmentLineResourceIdSchema } from "./shipment-line-command";

const quantity = z.number().int().nonnegative().safe();
const sourceIdentity = { id: shipmentLineResourceIdSchema, purchaseOrderId: shipmentLineResourceIdSchema, sku: z.string().nullable() };
// getShippablePurchaseOrderLines returns full PO records. Project only fields the
// chooser consumes; quantity authority remains in shipment-source-capacity.ts.
const selectableLineSchema = z.object({
  ...sourceIdentity, shipmentUnits: shipmentUnitsSchema.optional(), productName: z.string().nullable(), description: z.string().nullable(),
  orderQty: shipmentLineResourceIdSchema, alreadyShippedQty: quantity, directReceivedQty: quantity,
  remainingQty: shipmentLineResourceIdSchema,
});
const reviewLineSchema = z.object({
  ...sourceIdentity, shipmentUnits: shipmentUnitsSchema.optional(), remainingQty: z.null(), code: z.string().min(1), error: z.string().min(1),
});
export const shipmentCreateSourcesSchema = z.object({
  lines: z.array(selectableLineSchema), reviewRequiredLines: z.array(reviewLineSchema),
}).strict().superRefine((value, context) => {
  const ids = [...value.lines,...value.reviewRequiredLines].map(line=>line.id);
  if (new Set(ids).size !== ids.length) context.addIssue({code:"custom",message:"Shipment source identities are duplicated or contradictory."});
});
export type ShipmentCreateSources = z.infer<typeof shipmentCreateSourcesSchema>;
export function parseShipmentCreateSources(raw: unknown, expectedPurchaseOrderId: number): ShipmentCreateSources {
  const purchaseOrderId = shipmentLineResourceIdSchema.parse(expectedPurchaseOrderId);
  const result = shipmentCreateSourcesSchema.parse(raw);
  if ([...result.lines,...result.reviewRequiredLines].some(line=>line.purchaseOrderId!==purchaseOrderId)) {
    throw new Error("Shipment source lines do not belong to the selected purchase order.");
  }
  return result;
}

// Warehouse ownership and eligibility remain in WMS and the creation command.
// This read boundary only verifies the identities/labels used by the selector.
export const shipmentWarehouseOptionsSchema = z.array(z.object({
  id: shipmentLineResourceIdSchema, code: z.string().min(1).max(20), name: z.string().min(1).max(200),
})).superRefine((warehouses, context) => {
  if (new Set(warehouses.map(warehouse=>warehouse.id)).size!==warehouses.length) {
    context.addIssue({code:"custom",message:"Warehouse options have duplicate identities."});
  }
});
export type ShipmentWarehouseOption = z.infer<typeof shipmentWarehouseOptionsSchema>[number];
