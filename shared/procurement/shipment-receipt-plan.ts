import { z } from "zod";

const quantity = z.number().int().positive().max(2_147_483_647);
// Bound preview payloads to the existing shipment editing batch size.
export const MAX_SHIPMENT_RECEIPT_UNIT_SELECTIONS = 500;

/** A receipt's counting unit is an explicit inventory choice, independent of
 * shipping cartons. Freeze the reviewed pieces and catalog factor together. */
export const shipmentReceiptUnitSelectionSchema = z.object({
  shipmentLineId: quantity,
  productVariantId: quantity,
  unitsPerVariant: quantity,
  expectedBaseQty: quantity,
}).strict();
export const shipmentReceiptUnitSelectionsSchema = z.array(shipmentReceiptUnitSelectionSchema).max(MAX_SHIPMENT_RECEIPT_UNIT_SELECTIONS)
  .refine(values => new Set(values.map(value => value.shipmentLineId)).size === values.length,
    "Choose only one receiving unit for each shipment line.");
export const shipmentReceiptPlanRequestSchema = z.object({
  purchaseOrderId: quantity.optional(),
  receiptUnitSelections: shipmentReceiptUnitSelectionsSchema.optional(),
}).strict();

export type ShipmentReceiptUnitSelection = z.infer<typeof shipmentReceiptUnitSelectionSchema>;
export type ShipmentReceiptPlanRequest = z.infer<typeof shipmentReceiptPlanRequestSchema>;
