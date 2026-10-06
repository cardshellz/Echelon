import { z } from "zod";

const id = z.number().int().safe().positive();
const quantity = z.number().int().safe().nonnegative();
export const returnCommandBodySchema = z.object({
  orderId: id, warehouseLocationId: id, notes: z.string().optional(),
  items: z.array(z.object({ orderItemId: id, productVariantId: id, qty: id,
    condition: z.enum(["sellable","damaged","defective"]), reason: z.string().optional() }).strict()).min(1).max(200),
}).strict();
export type ReturnCommandBody = z.infer<typeof returnCommandBodySchema>;
export const returnCommandResultSchema = z.object({
  orderId: id, processed: quantity, sellable: quantity, damaged: quantity, totalBaseUnitsReturned: quantity,
  items: z.array(z.object({ orderItemId: id,productVariantId: id,qty: id,
    condition: z.enum(["sellable","damaged","defective"]),baseUnitsReturned: quantity }).strict()).max(200),
}).strict();
export type ReturnCommandResult = z.infer<typeof returnCommandResultSchema>;

