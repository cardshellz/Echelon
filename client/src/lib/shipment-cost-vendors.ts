import { z } from "zod";
import { shipmentCostResourceIdSchema } from "@shared/procurement/shipment-cost-command";

export const shipmentCostVendorListSchema = z.array(z.object({
  id: shipmentCostResourceIdSchema,
  name: z.string().min(1),
  code: z.string().optional(),
// The /api/vendors cache is shared with other screens that need full vendor details.
}).passthrough());

export type ShipmentCostVendorOption = z.infer<typeof shipmentCostVendorListSchema>[number];
