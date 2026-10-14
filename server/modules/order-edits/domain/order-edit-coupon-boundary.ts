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
  retainedRules: OrderEditCodeRule[] = [],
): void {
  // Reopening an order must not apply the same campaign again under either
  // the same code or a different redeem code belonging to that campaign.
  const discounts = new Set<string>();
  const codes = new Set<string>();
  for (const rule of [...retainedRules, ...rules]) {
    const code = rule.code.toUpperCase();
    if (discounts.has(rule.discountId) || codes.has(code))
      throw new OrderEditError(
        "ORDER_EDIT_CODE_ALREADY_APPLIED",
        "This discount is already on your order or in your changes.",
      );
    discounts.add(rule.discountId);
    codes.add(code);
  }
  if (
    rules.some(
      (rule) =>
        rule.redemption === "shopify_coupon" &&
        (rule.usageLimit !== null || rule.appliesOncePerCustomer !== false),
    )
  )
    throw new OrderEditError(
      "ORDER_EDIT_NATIVE_COUPON_REDEMPTION_UNAVAILABLE",
      "This code has a usage limit and can only be applied at checkout. It can't be added to an existing order. Clear the code to continue editing; your order has not changed.",
    );
}
