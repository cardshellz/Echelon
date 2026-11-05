/** Shopify exposes manual-discount descriptions to customers and notifications. */
export const ORDER_EDIT_MEMBER_PRICING_DESCRIPTION = "Shellz Club pricing";

/** Legacy receipts retain their original description and financial fingerprint. */
export function isManagedMemberPricingDescription(value: unknown): boolean {
  return value === ORDER_EDIT_MEMBER_PRICING_DESCRIPTION || value === "Echelon member pricing";
}

/** Presentation only: do not rewrite stored discount or recovery evidence. */
export function presentOrderDiscountLabel(value: string): string {
  return value === "Echelon member pricing" ? ORDER_EDIT_MEMBER_PRICING_DESCRIPTION : value;
}
