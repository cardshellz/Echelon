import type {
  OrderEditCodePricing,
  OrderEditCodeRule,
} from "@shared/order-edits/order-edit-codes";
import { OrderEditError } from "./order-edit-error";

/** Resume existing receipt sagas; ordinary coupon entry never calls a points ledger. */
export function requiresLegacyCodeReceipt(
  pricing: OrderEditCodePricing | undefined,
): boolean {
  if (!pricing) return false;
  const requested = new Set(pricing.newCodes.map((code) => code.toUpperCase()));
  return pricing.rules.some(
    (rule) =>
      rule.redemption !== "shopify_coupon" &&
      requested.has(rule.code.toUpperCase()),
  );
}

/**
 * Calculation is not redemption. The order-edit API accepts manual amounts,
 * not a native coupon redemption. Preserve the existing unlimited-campaign
 * adjustment behavior, but never pretend a local receipt consumes a capped
 * Shopify coupon. This is an application capability check, not eligibility.
 */
export function assertCouponAdjustmentSupported(
  rules: OrderEditCodeRule[],
): void {
  if (
    rules.some(
      (rule) =>
        rule.redemption === "shopify_coupon" &&
        (rule.usageLimit !== null || rule.appliesOncePerCustomer !== false),
    )
  )
    throw new OrderEditError(
      "ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE",
      "Shopify can calculate this discount, but this code cannot currently be redeemed on an existing order. Your order has not changed and the code has not been used.",
    );
}
