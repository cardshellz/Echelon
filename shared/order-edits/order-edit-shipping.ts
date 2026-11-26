import { z } from "zod";

const cents = z.number().int().safe().nonnegative();
const charge = {
  title: z.string().min(1),
  code: z.string(),
  source: z.string(),
  grossCents: cents,
  discountCents: cents,
  netCents: cents,
  discountLabels: z.array(z.string().min(1)),
};
type Amounts = { grossCents: number; discountCents: number; netCents: number };
const safe = (value: Amounts) =>
  [value.grossCents, value.discountCents, value.netCents].every(
    Number.isSafeInteger,
  );
const reconciles = (value: Amounts) =>
  !safe(value) ||
  BigInt(value.grossCents) - BigInt(value.discountCents) ===
    BigInt(value.netCents);

/** One delivery charge. Checkout creates one per delivery group (shipping profile). */
export const orderEditShippingGroupSchema = z
  .object({
    /** Shopify delivery profile priced by this charge; null when an original charge is restored. */
    deliveryProfileId: z.string().min(1).nullable(),
    ...charge,
  })
  .strict()
  .refine(reconciles, "Shipping rate and benefits must reconcile to the charge");
export type OrderEditShippingGroup = z.infer<
  typeof orderEditShippingGroupSchema
>;

/**
 * The order's delivery pricing. The top-level amounts are the whole order.
 * `groups` is present only when the order has more than one delivery charge,
 * so a one-charge order has exactly one representation.
 */
export const orderEditShippingRepricingSchema = z
  .object({
    ...charge,
    groups: z.array(orderEditShippingGroupSchema).min(2).max(20).optional(),
  })
  .strict()
  .refine(reconciles, "Shipping rate and benefits must reconcile to the charge")
  .refine((value) => {
    if (!value.groups || !safe(value) || !value.groups.every(safe)) return true;
    const total = (key: keyof Amounts) =>
      value.groups!.reduce(
        (sum, group) => sum + BigInt(group[key]),
        BigInt(0),
      );
    return (
      total("grossCents") === BigInt(value.grossCents) &&
      total("discountCents") === BigInt(value.discountCents) &&
      total("netCents") === BigInt(value.netCents)
    );
  }, "Delivery group charges must add up to the order's shipping");
export type OrderEditShippingRepricing = z.infer<
  typeof orderEditShippingRepricingSchema
>;

export interface OrderEditShippingCharge {
  title: string;
  grossCents: number;
  discountCents: number;
  netCents: number;
  discountLabels: string[];
}

/** Every delivery charge of a repricing, whether the order has one or several. */
export function orderEditShippingCharges(
  repricing: OrderEditShippingRepricing,
): OrderEditShippingCharge[] {
  return (repricing.groups ?? [repricing]).map(
    ({ title, grossCents, discountCents, netCents, discountLabels }) => ({
      title,
      grossCents,
      discountCents,
      netCents,
      discountLabels,
    }),
  );
}

/** Order-independent identity of the charges an order carries: service name and amount charged. */
export function orderEditShippingChargeKey(
  charges: ReadonlyArray<{ title: string; netCents: number }>,
): string {
  return JSON.stringify(
    charges
      .map(({ title, netCents }) => [title, netCents] as const)
      .sort(
        ([leftTitle, leftCents], [rightTitle, rightCents]) =>
          (leftTitle < rightTitle ? -1 : leftTitle > rightTitle ? 1 : 0) ||
          leftCents - rightCents,
      ),
  );
}

/** One name for the order's delivery services; distinct names are listed once each. */
export function orderEditShippingTitle(titles: readonly string[]): string {
  return [...new Set(titles)].join(" + ");
}
