import { z } from "zod";
const cents = z.number().int().safe(), id = z.number().int().positive().safe();
export const purchaseTaxCostsSchema = z.object({
  supplierInventoryMills: cents.nullable().optional(),
  supplierInventoryCents: cents.nullable(), shipmentInventoryCents: cents.nullable(), inventoryLandedCents: cents.nullable(),
  recoverableSupplierTaxCents: cents, recoverableShipmentTaxCents: cents,
  reason: z.string().nullable(),
  lines: z.array(z.object({ purchaseOrderLineId: id, pieces: z.number().int().nonnegative().safe(),
    supplierInventoryCents: cents.nullable(), shipmentInventoryCents: cents, inventoryLandedCents: cents.nullable() }).strict()),
}).strict();
export type PurchaseTaxCosts = z.infer<typeof purchaseTaxCostsSchema>;
