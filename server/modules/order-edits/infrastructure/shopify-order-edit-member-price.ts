import { z } from "zod";
import type { OrderEditSnapshot } from "../application/order-edit-provider";
import { OrderEditProviderError } from "../application/order-edit-provider";
import type { shopifyOrderEditVariantSchema } from "./shopify-order-edit-variant";
import { cents } from "./shopify-order-edit-money";

/** The existing quote/preview resolver, also used for discovery. Reads the checkout Function's projection. */
export function memberPrice(
  variant: z.infer<typeof shopifyOrderEditVariantSchema>,
  snapshot: Pick<OrderEditSnapshot, "memberPricingEnabled" | "memberPlan">,
): number {
  const retail = cents(variant.price);
  if (
    !snapshot.memberPricingEnabled ||
    !snapshot.memberPlan ||
    !variant.planPrices
  )
    return retail;
  let decoded: unknown;
  try {
    decoded = JSON.parse(variant.planPrices.value);
  } catch {
    throw new OrderEditProviderError(
      "MEMBER_PRICE_INVALID",
      "Member pricing is not valid for this product.",
      "rejected",
    );
  }
  const values = z
    .record(z.object({ cents: z.number().int().nonnegative().safe() }))
    .safeParse(decoded);
  if (!values.success)
    throw new OrderEditProviderError(
      "SHOPIFY_RESPONSE_INVALID",
      "Shopify returned incomplete or unsupported data.",
      "rejected",
      { paths: values.error.issues.map((issue) => issue.path.join(".")) },
    );
  const member = values.data[snapshot.memberPlan]?.cents;
  return member !== undefined && member < retail ? member : retail;
}
