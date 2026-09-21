import { z } from "zod";
import { ChannelFulfillmentProviderError } from "../channels/channel-fulfillment-provider.error";

const line = z.object({ lineId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/), quantity: z.number().int().positive() });
export const shopifyLabelPackageSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Fulfillment\/\d+$/),
  status: z.string().min(1),
  trackingNumbers: z.array(z.string().min(1)),
  items: z.array(line).min(1),
});
export type ShopifyLabelPackage = z.infer<typeof shopifyLabelPackageSchema>;

export function labelLifecycleConflict(code: string): never {
  throw new ChannelFulfillmentProviderError(code, "Shopify label correction requires exact package evidence");
}

/** A fulfillment is indivisible at Shopify. Never cancel one containing another
 * package's tracking or quantities, even when it belongs to the same order. */
export function planShopifyLabelCancellation(input: {
  trackingNumber: string;
  expectedFulfillmentIds: readonly string[];
  items: readonly { lineId: string; quantity: number }[];
  packages: readonly ShopifyLabelPackage[];
}): readonly string[] {
  const expected = z.array(line).min(1).safeParse(input.items);
  if (!expected.success || !input.trackingNumber.trim()) labelLifecycleConflict("SHOPIFY_VOID_INVALID_SCOPE");
  const totals = (items: readonly { lineId: string; quantity: number }[]) => {
    const quantities = new Map<string, number>();
    for (const item of items) {
      const quantity = (quantities.get(item.lineId) ?? 0) + item.quantity;
      if (!Number.isSafeInteger(quantity)) labelLifecycleConflict("SHOPIFY_VOID_INVALID_QUANTITY");
      quantities.set(item.lineId, quantity);
    }
    return quantities;
  };
  const packages = input.packages.map(value => {
    const parsed = shopifyLabelPackageSchema.safeParse(value);
    if (!parsed.success) labelLifecycleConflict("SHOPIFY_VOID_INVALID_PROVIDER_RESPONSE");
    return parsed.data;
  });
  if (new Set(packages.map(value => value.id)).size !== packages.length) labelLifecycleConflict("SHOPIFY_VOID_DUPLICATE_PACKAGE");
  const ids = new Set(input.expectedFulfillmentIds);
  const candidates = packages.filter(value => ids.has(value.id) || value.trackingNumbers.includes(input.trackingNumber));
  if ([...ids].some(id => !candidates.some(value => value.id === id))) labelLifecycleConflict("SHOPIFY_VOID_FULFILLMENT_NOT_FOUND");
  if (candidates.length === 0) return Object.freeze([]); // Unsent command, or a lost response proven absent.
  if (candidates.some(value => value.trackingNumbers.length !== 1 || value.trackingNumbers[0] !== input.trackingNumber)) {
    labelLifecycleConflict("SHOPIFY_VOID_TRACKING_CHANGED");
  }
  const actual = totals(candidates.flatMap(value => value.items));
  const wanted = totals(expected.data);
  if (actual.size !== wanted.size || [...wanted].some(([id, quantity]) => actual.get(id) !== quantity)) {
    labelLifecycleConflict("SHOPIFY_VOID_CONTENTS_CHANGED");
  }
  if (candidates.some(value => !["SUCCESS", "CANCELLED", "CANCELED"].includes(value.status))) {
    labelLifecycleConflict("SHOPIFY_VOID_STATUS_UNSUPPORTED");
  }
  return Object.freeze(candidates.filter(value => value.status === "SUCCESS").map(value => value.id).sort());
}
