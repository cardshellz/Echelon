import { z } from "zod";
import type { OrderEditShippingItem } from "../application/order-edit-shipping";
import { OrderEditProviderError } from "../application/order-edit-provider";

const itemSchema = z
  .object({
    variantId: z
      .string()
      .regex(/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/),
    quantity: z.number().int().safe().positive().max(2_147_483_647),
    netCents: z.number().int().safe().nonnegative(),
  })
  .strict();

/** Split penny remainders so a native calculation sees the exact already verified item total. */
export function shippingCalculationLines(
  items: OrderEditShippingItem[],
): Array<{
  variantId: string;
  quantity: number;
  priceOverride: { amount: string; currencyCode: "USD" };
}> {
  const validated = z.array(itemSchema).min(1).max(250).safeParse(items);
  if (!validated.success)
    throw new OrderEditProviderError(
      "SHIPPING_ITEMS_INVALID",
      "Shipping requires valid physical items and exact discounted totals.",
    );
  const lines = validated.data.flatMap((item) => {
    const quantity = BigInt(item.quantity);
    const total = BigInt(item.netCents);
    const unit = total / quantity;
    const remainder = total % quantity;
    const make = (count: bigint, price: bigint) => ({
      variantId: item.variantId,
      quantity: Number(count),
      priceOverride: {
        amount: formatShippingCents(price),
        currencyCode: "USD" as const,
      },
    });
    return [
      ...(quantity > remainder ? [make(quantity - remainder, unit)] : []),
      ...(remainder > BigInt(0) ? [make(remainder, unit + BigInt(1))] : []),
    ];
  });
  if (lines.length > 250)
    throw new OrderEditProviderError(
      "SHIPPING_ITEMS_LIMIT",
      "The revised order exceeds Shopify's delivery calculation limit.",
    );
  return lines;
}

export function formatShippingCents(value: bigint): string {
  return `${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

export function shippingItemTotals(
  items: OrderEditShippingItem[],
): Map<string, { quantity: bigint; netCents: bigint }> {
  const totals = new Map<string, { quantity: bigint; netCents: bigint }>();
  for (const item of items) {
    const previous = totals.get(item.variantId) ?? {
      quantity: BigInt(0),
      netCents: BigInt(0),
    };
    totals.set(item.variantId, {
      quantity: previous.quantity + BigInt(item.quantity),
      netCents: previous.netCents + BigInt(item.netCents),
    });
  }
  return totals;
}
