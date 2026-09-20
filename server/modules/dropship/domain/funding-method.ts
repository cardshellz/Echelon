/**
 * Dropship funding method — pure readers over the provider metadata a funding
 * method row carries.
 *
 * The bank account holder type decides how long an ACH debit can be returned
 * as unauthorized: about 60 days on a consumer account, 2 banking days on a
 * business account (NACHA). It is therefore the one attribute the pending-ACH
 * advance is allowed to rely on, and it is read from here rather than from
 * the raw metadata bag so every caller applies the same fail-closed rule: a
 * value that is not literally "company" or "individual" is unknown.
 */

export type DropshipFundingAccountHolderType = "individual" | "company";

/** The metadata key the Stripe funding provider writes for `us_bank_account` methods. */
export const FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY = "accountHolderType";

export function fundingMethodAccountHolderType(
  metadata: Record<string, unknown> | null | undefined,
): DropshipFundingAccountHolderType | null {
  const value = metadata?.[FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY];
  return value === "company" || value === "individual" ? value : null;
}
