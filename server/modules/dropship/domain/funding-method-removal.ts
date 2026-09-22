/**
 * Dropship funding method removal — the pure rule for whether a vendor may
 * remove a saved funding method.
 *
 * A funding method is never deleted: the ledger references it for as long as
 * the ledger exists, so removal is a status change to `archived`, after which
 * nothing charges it and the wallet page lists it under "removed". The rule
 * refuses removal only where the wallet would otherwise be left in a state
 * the vendor cannot see from the page:
 *
 * - the method is still the enabled autopay source;
 * - a top-up from it is still on its way (a bank debit in flight);
 * - it is the only card Card Shellz could charge for a held order while the
 *   vendor is live — the card backstop is a launch requirement (see
 *   `assertAutoReloadMayBeDisabled` in the wallet service).
 *
 * No clock, no database: every fact is passed in, read under the row lock
 * of the transaction that applies the decision.
 */

export const FUNDING_METHOD_ARCHIVED_STATUS = "archived";

/** The vendor lifecycle status in which the card backstop cannot be withdrawn. */
const LIVE_VENDOR_STATUS = "active";

export const FUNDING_METHOD_REMOVAL_REFUSAL_CODES = [
  "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE",
  "DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING",
  "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD",
] as const;

export type FundingMethodRemovalRefusalCode = (typeof FUNDING_METHOD_REMOVAL_REFUSAL_CODES)[number];

export interface FundingMethodRemovalFacts {
  /** The method the vendor asked to remove. */
  method: {
    fundingMethodId: number;
    rail: string;
    status: string;
    providerCustomerId: string | null;
    providerPaymentMethodId: string | null;
  };
  /** The vendor's auto-reload setting, or null when none was ever saved. */
  autoReload: { enabled: boolean; fundingMethodId: number | null } | null;
  /** Ledger entries still pending on this method: a bank debit that has not landed or failed. */
  pendingFundingCount: number;
  /** Other active cards Card Shellz could charge instead of this one. */
  otherChargeableCardCount: number;
  /** The vendor's lifecycle status; null when the vendor row is missing. */
  vendorStatus: string | null;
}

export type FundingMethodRemovalDecision =
  | { outcome: "archive" }
  /** Already archived: nothing to change, the caller reports the stored state. */
  | { outcome: "replay" }
  | {
      outcome: "refuse";
      code: FundingMethodRemovalRefusalCode;
      message: string;
      context: Record<string, unknown>;
    };

export function decideFundingMethodRemoval(facts: FundingMethodRemovalFacts): FundingMethodRemovalDecision {
  assertCount(facts.pendingFundingCount, "pendingFundingCount");
  assertCount(facts.otherChargeableCardCount, "otherChargeableCardCount");
  const { method, autoReload } = facts;
  const base = { fundingMethodId: method.fundingMethodId, rail: method.rail, status: method.status };

  if (method.status === FUNDING_METHOD_ARCHIVED_STATUS) {
    return { outcome: "replay" };
  }
  if (autoReload?.enabled && autoReload.fundingMethodId === method.fundingMethodId) {
    return {
      outcome: "refuse",
      code: "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE",
      message: "This funding method is the autopay source. Choose another source first, then remove it.",
      context: { ...base, classification: "permanent" },
    };
  }
  if (facts.pendingFundingCount > 0) {
    return {
      outcome: "refuse",
      code: "DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING",
      message: "A top-up from this funding method is still on its way. It can be removed once that top-up lands or fails.",
      context: { ...base, pendingFundingCount: facts.pendingFundingCount, classification: "permanent" },
    };
  }
  if (
    isChargeableCard(method)
    && facts.vendorStatus === LIVE_VENDOR_STATUS
    && facts.otherChargeableCardCount === 0
  ) {
    return {
      outcome: "refuse",
      code: "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD",
      message: "This is the only card Card Shellz can charge when an order needs more than the balance. Add another card first, then remove this one.",
      context: { ...base, vendorStatus: facts.vendorStatus, classification: "permanent" },
    };
  }
  return { outcome: "archive" };
}

/** The same predicate the wallet service charges a held order by (`isChargeableCard`). */
function isChargeableCard(method: FundingMethodRemovalFacts["method"]): boolean {
  return method.rail === "stripe_card"
    && method.status === "active"
    && method.providerCustomerId !== null
    && method.providerPaymentMethodId !== null;
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative whole number; received ${String(value)}.`);
  }
}
