import { z } from "zod";
const quantity = z.number().int().nonnegative().max(2_147_483_647);
export const pickingCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    status: z.enum(["pending", "in_progress", "completed", "short"]),
    pickedQuantity: quantity.optional(),
    shortReason: z.string().trim().min(1).max(1000).optional(),
    pickMethod: z
      .enum(["scan", "manual", "pick_all", "button", "short"])
      .optional(),
    warehouseLocationId: quantity.positive().optional(),
  })
  .strict();
export const unpickingCommandSchema = z
  .object({
    commandId: z.string().uuid(),
    qty: quantity.positive(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
