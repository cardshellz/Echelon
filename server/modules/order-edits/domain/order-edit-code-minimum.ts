import { z } from "zod";
import { OrderEditError } from "./order-edit-error";

const cents = z.number().int().safe().nonnegative();
const count = z.number().int().safe().nonnegative();

/** The minimum purchase a checkout code required, as the sales channel states it today. */
export const orderEditCodeMinimumSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subtotal"), amountCents: cents }).strict(),
  z.object({ type: z.literal("quantity"), quantity: count }).strict(),
]);
export type OrderEditCodeMinimum = z.infer<typeof orderEditCodeMinimumSchema>;

const measureSchema = z
  .object({ subtotalCents: cents, quantity: count })
  .strict();
const inputSchema = z
  .object({
    codes: z
      .array(
        z
          .object({
            code: z.string().min(1),
            minimum: orderEditCodeMinimumSchema,
          })
          .strict(),
      )
      .max(250),
    before: measureSchema,
    after: measureSchema,
  })
  .strict();

export const ORDER_EDIT_CODE_MINIMUM_NOT_MET = "ORDER_EDIT_CODE_MINIMUM_NOT_MET";

function dollars(amountCents: number): string {
  const whole = Math.trunc(amountCents / 100);
  return `$${whole}.${String(amountCents % 100).padStart(2, "0")}`;
}

/**
 * Owner rule (2026-11-24): an edit may not take an order below the minimum
 * purchase of a discount code already on it.
 *
 * The sales channel does not enforce this during an edit. It keeps the code's
 * share on the remaining items (order #65912: a $5.00 code with a $35.00
 * minimum stayed on $19.53 of items) and refuses to remove a checkout code. So
 * the only way to stop a customer qualifying for a code and then removing the
 * items that qualified is to refuse the edit.
 *
 * This is an eligibility rule, not price arithmetic: both measures are the
 * sales channel's own figures and are only compared with the code's minimum.
 *
 * An order can already be below the minimum (the code's terms were raised
 * after checkout, or staff edited the order). Such an order may still be
 * changed as long as the change does not take it further below.
 */
export function assertOrderEditCodeMinimumKept(
  raw: z.infer<typeof inputSchema>,
): void {
  const { codes, before, after } = inputSchema.parse(raw);
  for (const { minimum } of codes) {
    const required =
      minimum.type === "subtotal" ? minimum.amountCents : minimum.quantity;
    const was =
      minimum.type === "subtotal" ? before.subtotalCents : before.quantity;
    const next =
      minimum.type === "subtotal" ? after.subtotalCents : after.quantity;
    if (next >= required || next >= was) continue;
    throw new OrderEditError(
      ORDER_EDIT_CODE_MINIMUM_NOT_MET,
      minimum.type === "subtotal"
        ? `The discount code on this order needs at least ${dollars(required)} of items. These changes would leave ${dollars(next)}. Keep or add items to stay at ${dollars(required)} or more. Your order has not changed.`
        : `The discount code on this order needs at least ${required} items. These changes would leave ${next}. Keep or add items to stay at ${required} or more. Your order has not changed.`,
    );
  }
}
