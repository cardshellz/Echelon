/**
 * Row blockers for a listing's eBay return and payment policy ids, from the
 * preview's live check (side PR S1). A missing id is not reported here: the
 * listing config check already blocks it as `missing_config:…`.
 */

export const EBAY_RETURN_POLICY_NOT_FOUND = "ebay_return_policy:not_found";
export const EBAY_PAYMENT_POLICY_NOT_FOUND = "ebay_payment_policy:not_found";
export const EBAY_RETURN_POLICY_VERIFICATION_UNAVAILABLE = "ebay_return_policy:verification_unavailable";
export const EBAY_PAYMENT_POLICY_VERIFICATION_UNAVAILABLE = "ebay_payment_policy:verification_unavailable";

/** What the preview's live check found for the store. */
export type DropshipEbayReturnPaymentPolicyCheck =
  /** Not an eBay store, no marketplace, or no ids to check. */
  | { status: "not_checked" }
  /** eBay could not be read; nothing is known about the ids. */
  | { status: "unavailable" }
  | {
    status: "checked";
    missingReturnPolicyIds: ReadonlySet<string>;
    missingPaymentPolicyIds: ReadonlySet<string>;
  };

export function ebayReturnPaymentPolicyBlockers(input: {
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  check: DropshipEbayReturnPaymentPolicyCheck;
}): string[] {
  const { check } = input;
  if (check.status === "not_checked") return [];
  const blockers: string[] = [];
  if (input.returnPolicyId) {
    if (check.status === "unavailable") blockers.push(EBAY_RETURN_POLICY_VERIFICATION_UNAVAILABLE);
    else if (check.missingReturnPolicyIds.has(input.returnPolicyId)) blockers.push(EBAY_RETURN_POLICY_NOT_FOUND);
  }
  if (input.paymentPolicyId) {
    if (check.status === "unavailable") blockers.push(EBAY_PAYMENT_POLICY_VERIFICATION_UNAVAILABLE);
    else if (check.missingPaymentPolicyIds.has(input.paymentPolicyId)) blockers.push(EBAY_PAYMENT_POLICY_NOT_FOUND);
  }
  return blockers;
}
