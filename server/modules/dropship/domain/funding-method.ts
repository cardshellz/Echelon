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

/**
 * How the provider-side removal of a funding method ended (funding method
 * removal). Our ledger archives the method first, which is what stops every
 * charge; the provider detach is hygiene on Stripe's side, so an outcome
 * other than `detached` never un-archives anything — it is recorded on the
 * method so the vendor's screen and the audit trail both say the provider
 * side is still owed.
 */
export const FUNDING_METHOD_DETACH_OUTCOMES = [
  "detached",
  /** The provider no longer had the payment method. */
  "already_detached",
  /** The provider could not be reached; the detach is owed. */
  "pending",
  /** The provider refused; a human reconciles the provider side. */
  "requires_review",
  /** The rail has no provider-side object to detach (USDC, manual). */
  "not_applicable",
] as const;

export type FundingMethodDetachOutcome = (typeof FUNDING_METHOD_DETACH_OUTCOMES)[number];

/** The metadata key under which an archived method keeps its provider detach outcome. */
export const FUNDING_METHOD_PROVIDER_DETACH_KEY = "providerDetach";
/** The metadata keys an archived method carries: when and by which member it was removed. */
export const FUNDING_METHOD_ARCHIVED_AT_KEY = "archivedAt";
export const FUNDING_METHOD_ARCHIVED_BY_MEMBER_KEY = "archivedByMemberId";

export function fundingMethodProviderDetachOutcome(
  metadata: Record<string, unknown> | null | undefined,
): FundingMethodDetachOutcome | null {
  const record = metadata?.[FUNDING_METHOD_PROVIDER_DETACH_KEY];
  if (!record || typeof record !== "object") return null;
  const outcome = (record as Record<string, unknown>).outcome;
  return (FUNDING_METHOD_DETACH_OUTCOMES as readonly unknown[]).includes(outcome)
    ? (outcome as FundingMethodDetachOutcome)
    : null;
}
