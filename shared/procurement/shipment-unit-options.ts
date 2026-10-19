import { z } from "zod";
import { shipmentUnitsSchema } from "./shipment-unit-selection";
import { MAX_UNIT_QUANTITY } from "./unit-quantity";
export const SHIPMENT_UNIT_OPTIONS_ROW_LIMIT = 500;
const id = z.number().int().positive().max(MAX_UNIT_QUANTITY);
export const shipmentUnitOptionsRowSchema = z.object({
  purchaseOrderLineId: id.optional(), productVariantId: id.optional(), selectedVariantId: id.optional(),
  sku: z.string().trim().min(1).max(100).optional(),
}).strict();
// Validate rows independently so malformed CSV evidence remains visible alongside
// valid options. No row is applied by this read-only operation.
export const shipmentUnitOptionsRequestSchema = z.object({ rows: z.array(z.unknown()).min(1).max(SHIPMENT_UNIT_OPTIONS_ROW_LIMIT) }).strict();
export const shipmentUnitOptionsResultSchema = z.object({
  shipmentId: id,
  rows: z.array(z.object({ row: id, units: shipmentUnitsSchema }).strict()).max(SHIPMENT_UNIT_OPTIONS_ROW_LIMIT),
}).strict();
export type ShipmentUnitOptionsIdentity = z.infer<typeof shipmentUnitOptionsRowSchema>;
export type ShipmentUnitOptionsResult = z.infer<typeof shipmentUnitOptionsResultSchema>;
