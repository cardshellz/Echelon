import { z } from "zod";

// Preserve integer-string callers without silently truncating fractions or junk.
const positivePgInteger = z.union([
  z.number(), z.string().trim().regex(/^\d+$/).transform(Number),
]).pipe(z.number().int().positive().max(2_147_483_647));

export const inventoryTransferRequestSchema = z.object({
  commandKey: z.string().trim().min(1).max(120).optional(),
  fromLocationId: positivePgInteger,
  toLocationId: positivePgInteger,
  variantId: positivePgInteger,
  quantity: positivePgInteger,
  notes: z.string().max(5000).optional(),
  moveReserved: z.boolean().optional(),
  crossWarehouseArrivalConfirmed: z.boolean().optional(),
}).refine((input) => input.fromLocationId !== input.toLocationId, {
  message: "Source and destination must be different", path: ["toLocationId"],
});
