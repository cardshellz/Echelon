import { z } from "zod";

export const shipmentPurchaseOrderReferenceSchema = z.object({
  id: z.number().int().positive().max(2_147_483_647),
  poNumber: z.string().trim().min(1),
});

export const shipmentPurchaseOrderReferencesSchema = z.array(shipmentPurchaseOrderReferenceSchema);
export type ShipmentPurchaseOrderReference = z.infer<typeof shipmentPurchaseOrderReferenceSchema>;
