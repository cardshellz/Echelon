import { z } from "zod";
import { MAX_UNIT_QUANTITY, toBasePieces } from "./unit-quantity";
const positiveInteger = z.number().int().positive().max(MAX_UNIT_QUANTITY);
export const shipmentUnitSelectionSchema = z.object({
  productVariantId: positiveInteger,
  unitsPerVariant: positiveInteger,
  quantity: positiveInteger,
}).strict().superRefine((value, context) => {
  try { toBasePieces(value.quantity, value.unitsPerVariant); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid converted quantity" }); }
});
export type ShipmentUnitSelection = z.infer<typeof shipmentUnitSelectionSchema>;
export const shipmentUnitVariantSchema = z.object({
  id: positiveInteger, sku: z.string().nullable(), name: z.string().nullable(), unitsPerVariant: positiveInteger,
}).strict();
export const shipmentUnitsSchema = z.object({
  productId: positiveInteger.nullable(), selectedVariantId: positiveInteger.nullable(),
  unitsPerVariantSnapshot: positiveInteger.nullable(), variants: z.array(shipmentUnitVariantSchema),
  issue: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict().nullable(),
}).strict();
export type ShipmentUnits = z.infer<typeof shipmentUnitsSchema>;
export type ShipmentUnitVariant = z.infer<typeof shipmentUnitVariantSchema>;
export const shipmentDimensionBasisSchema = z.enum(["piece", "carton"]);
