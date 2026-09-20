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

/**
 * The metadata key the Stripe funding provider writes for a `us_bank_account`
 * collected through Financial Connections: the provider-side account whose
 * balance can be read (funding design phase 3). Absent for an account entered
 * manually or verified by micro-deposits, which therefore can never be
 * "balance verified" and never qualifies for the pending-ACH advance.
 */
export const FUNDING_METHOD_FINANCIAL_CONNECTIONS_ACCOUNT_KEY = "financialConnectionsAccountId";

export function fundingMethodFinancialConnectionsAccountId(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.[FUNDING_METHOD_FINANCIAL_CONNECTIONS_ACCOUNT_KEY];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
