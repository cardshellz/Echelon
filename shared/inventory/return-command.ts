import { z } from "zod";

const id = z.number().int().safe().positive();
const quantity = z.number().int().safe().nonnegative();
export const returnCommandBodySchema = z.object({
  orderId: id, warehouseLocationId: id, notes: z.string().optional(),
  items: z.array(z.object({ orderItemId: id, productVariantId: id, qty: id,
    condition: z.enum(["sellable","damaged","defective"]), reason: z.string().optional() }).strict()).min(1).max(200),
}).strict();
export type ReturnCommandBody = z.infer<typeof returnCommandBodySchema>;
/** The optional key preserves older clients; malformed keys are rejected before
 * the application starts a transaction. A physical batch identifies each item once.
 */
export const returnCommandRequestSchema = returnCommandBodySchema.extend({
  commandKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/).optional(),
}).refine(body => new Set(body.items.map(item => item.orderItemId)).size === body.items.length,
  { message: "Each return item must appear once in the physical command.", path: ["items"] });
export const returnCommandResultSchema = z.object({
  orderId: id, processed: quantity, sellable: quantity, damaged: quantity, totalBaseUnitsReturned: quantity,
  items: z.array(z.object({ orderItemId: id,productVariantId: id,qty: id,
    condition: z.enum(["sellable","damaged","defective"]),baseUnitsReturned: id }).strict()).min(1).max(200),
}).strict().superRefine((result, context) => {
  const sellable = result.items.filter(item => item.condition === "sellable").length;
  const baseUnits = result.items.reduce((total, item) => total + BigInt(item.baseUnitsReturned), BigInt(0));
  if (result.processed !== result.items.length || result.sellable !== sellable
    || result.damaged !== result.items.length - sellable
    || baseUnits !== BigInt(result.totalBaseUnitsReturned)
    || new Set(result.items.map(item => item.orderItemId)).size !== result.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Return summary does not match its recorded items." });
  }
});
export type ReturnCommandResult = z.infer<typeof returnCommandResultSchema>;

/** Acknowledgement must identify the exact retained physical command. */
export function returnCommandResultFor(rawBody: ReturnCommandBody) {
  const body = returnCommandBodySchema.parse(rawBody);
  return returnCommandResultSchema.superRefine((result, context) => {
    if (result.orderId !== body.orderId || result.items.length !== body.items.length
      || body.items.some(item => !result.items.some(recorded => recorded.orderItemId === item.orderItemId
        && recorded.productVariantId === item.productVariantId && recorded.qty === item.qty
        && recorded.condition === item.condition))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Return result does not identify the requested physical work." });
    }
  });
}
