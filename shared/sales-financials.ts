import { z } from "zod";

const cents = z.number().int().nonnegative().max(2147483647);
/** A single provider snapshot, before refunds. Never combine current_* values
 * (which can already reflect refunds) with the original order/refund ledger. */
export const salesFinancialsSchema = z
  .object({
    version: z.literal(1),
    basis: z.literal("shopify_order_before_refunds"),
    sourceOrderId: z.string().regex(/^[1-9][0-9]{0,29}$/),
    sourceUpdatedAt: z.string().datetime(),
    currency: z.enum(["USD", "CAD", "EUR", "GBP"]),
    grossMerchandiseCents: cents,
    merchandiseDiscountCents: cents,
    netMerchandiseCents: cents,
    grossShippingCents: cents,
    shippingDiscountCents: cents,
    netShippingCents: cents,
    taxAddedCents: cents,
    taxIncludedCents: cents,
    dutiesCents: cents,
    feesCents: cents,
    tipsCents: cents,
    orderTotalCents: cents,
  })
  .strict()
  .superRefine((value, ctx) => {
    const amounts = Object.entries(value)
      .filter(([key]) => key.endsWith("Cents"))
      .map(([, amount]) => amount);
    if (
      amounts.some(
        (amount) =>
          typeof amount !== "number" ||
          !Number.isSafeInteger(amount) ||
          amount < 0,
      )
    )
      return;
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      value.grossMerchandiseCents - value.merchandiseDiscountCents !==
      value.netMerchandiseCents
    )
      fail("Merchandise components do not reconcile");
    if (
      value.grossShippingCents - value.shippingDiscountCents !==
      value.netShippingCents
    )
      fail("Shipping components do not reconcile");
    if (value.taxAddedCents > 0 && value.taxIncludedCents > 0)
      fail("One order cannot both include and add its tax");
    if (
      value.taxIncludedCents >
      value.netMerchandiseCents +
        value.netShippingCents +
        value.dutiesCents +
        value.feesCents
    )
      fail("Included tax exceeds the charges containing it");
    const total = [
      value.netMerchandiseCents,
      value.netShippingCents,
      value.taxAddedCents,
      value.dutiesCents,
      value.feesCents,
      value.tipsCents,
    ].reduce((sum, amount) => sum + BigInt(amount), BigInt(0));
    if (total !== BigInt(value.orderTotalCents))
      fail("Provider components do not reconcile to its order total");
  });
export type SalesFinancials = z.infer<typeof salesFinancialsSchema>;

/** A financial breakdown cannot be attached to a different order or header revision. */
export function matchesFinancialHeaders(
  f: SalesFinancials,
  order: {
    external_order_id: string;
    currency: string;
    total_cents: number;
    subtotal_cents: number;
    shipping_cents: number;
    tax_cents: number;
  },
): boolean {
  return (
    f.sourceOrderId ===
      order.external_order_id.replace(/^gid:\/\/shopify\/Order\//, "") &&
    f.currency === order.currency &&
    f.orderTotalCents === order.total_cents &&
    f.netMerchandiseCents === order.subtotal_cents &&
    f.grossShippingCents === order.shipping_cents &&
    f.taxAddedCents + f.taxIncludedCents === order.tax_cents
  );
}
