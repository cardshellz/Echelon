/**
 * Vendor standing on the vendor pages.
 *
 * A vendor paused for a funding failure has stopped selling: no order is
 * accepted and every listing shows nothing for sale until the wallet is
 * funded again, when selling resumes on its own. These helpers turn the
 * onboarding state's vendor block into the few lines the vendor needs. Pure:
 * no clock, no fetch.
 */

import { formatDateTime, type DropshipOnboardingState } from "./dropship-ops-surface";

export type DropshipVendorStandingSnapshot = Pick<
  DropshipOnboardingState["vendor"],
  "status" | "standingReason" | "pausedAt"
>;

export interface VendorStandingNotice {
  /** "Selling is paused" */
  title: string;
  /** What happened. */
  reason: string;
  /** What it means and what to do about it. */
  action: string;
  /** "Paused since …", or null when the time is unknown. */
  since: string | null;
  /** True when adding money is what lifts the pause. */
  needsFunds: boolean;
}

const FUNDING_REASONS: ReadonlySet<string> = new Set(["card_declined", "funding_returned"]);

export function isPausedForFunding(vendor: DropshipVendorStandingSnapshot): boolean {
  return vendor.status === "paused" && vendor.standingReason !== null && FUNDING_REASONS.has(vendor.standingReason);
}

/** The banner copy for a paused vendor, or null when the vendor is not paused. */
export function describeVendorStanding(vendor: DropshipVendorStandingSnapshot): VendorStandingNotice | null {
  if (vendor.status !== "paused") return null;
  const needsFunds = isPausedForFunding(vendor);
  const reason = vendor.standingReason === "card_declined"
    ? "Your saved card was declined when we tried to top up your wallet."
    : vendor.standingReason === "funding_returned"
      ? "A bank transfer to your wallet was returned by your bank."
      : vendor.standingReason === "operator"
        ? "Card Shellz paused your account."
        : "Your account is paused.";
  const consequence = "Orders are not being accepted and your listings show nothing for sale.";
  const action = needsFunds
    ? `${consequence} Add funds or update your card; selling resumes on its own once your balance is back to the minimum.`
    : `${consequence} Contact Card Shellz support to resume.`;
  return {
    title: "Selling is paused",
    reason,
    action,
    since: vendor.pausedAt ? `Paused since ${formatDateTime(vendor.pausedAt)}.` : null,
    needsFunds,
  };
}
