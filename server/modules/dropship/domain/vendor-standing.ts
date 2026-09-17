import type {
  DropshipListingHoldState,
  DropshipVendorStandingReason,
  DropshipVendorStatus,
} from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "./errors";

/**
 * Vendor standing rules (pure).
 *
 * A vendor is paused on the first hard funding failure: a declined card or a
 * returned bank debit. While paused, no order is accepted and every store
 * connection is held at zero quantity. Selling resumes on its own once a
 * settled credit brings the available balance back to the auto-reload
 * minimum. These functions hold the rules; the application service applies
 * them and the repositories persist them.
 */

/** Reasons the wallet can clear on its own; an operator pause needs an operator. */
export const DROPSHIP_FUNDING_STANDING_REASONS: ReadonlySet<DropshipVendorStandingReason> = new Set([
  "card_declined",
  "funding_returned",
]);

/**
 * The one funding error that counts as a decline: the vendor's bank said no.
 * Raised by the Stripe adapter (`dropship-stripe-error.ts`); every other
 * permanent error (rejected request, idempotency conflict) is ours.
 */
export const DROPSHIP_FUNDING_DECLINED_ERROR_CODE = "DROPSHIP_STRIPE_CARD_DECLINED";

export function isDropshipFundingDeclineError(error: unknown): error is DropshipError {
  return error instanceof DropshipError && error.code === DROPSHIP_FUNDING_DECLINED_ERROR_CODE;
}

/**
 * Why a vendor is paused after a recorded funding credit failed. A card that
 * fails after the wallet counted it is still a decline; anything else (ACH,
 * an unknown rail) is money the bank sent back.
 */
export function standingReasonForFailedFunding(rail: string | null): DropshipVendorStandingReason {
  return rail === "stripe_card" ? "card_declined" : "funding_returned";
}

export function isFundingStandingReason(reason: DropshipVendorStandingReason | null): boolean {
  return reason !== null && DROPSHIP_FUNDING_STANDING_REASONS.has(reason);
}

/**
 * What happens to an order that arrives for this vendor.
 * - accept: the vendor is active; the wallet decides accepted vs. held.
 * - hold: paused for a funding reason. Listings are at zero, so this is a
 *   race (a sale that landed before the zero reached the marketplace); it
 *   waits under the normal payment hold and is accepted when the wallet is
 *   funded and the vendor resumes, or cancelled when the hold expires.
 * - reject: onboarding, lapsed, suspended, closed, or paused by an operator.
 */
export type DropshipVendorOrderAdmission = "accept" | "hold" | "reject";

export function vendorOrderAdmissionFor(vendor: { status: string; standingReason: string | null }): DropshipVendorOrderAdmission {
  if (vendor.status === "active") return "accept";
  if (vendor.status === "paused" && vendor.standingReason !== null
    && DROPSHIP_FUNDING_STANDING_REASONS.has(vendor.standingReason as DropshipVendorStandingReason)) {
    return "hold";
  }
  return "reject";
}

/** What inventory planning should hold for a vendor in this standing. */
export function listingHoldStateFor(status: DropshipVendorStatus): DropshipListingHoldState {
  return status === "paused" ? "held" : "released";
}

/**
 * Hold and release commands are keyed by the standing revision, so a retried
 * command after a deferral replays the same receipt instead of repeating.
 */
export function listingHoldIdempotencyKeyFor(input: {
  vendorId: number;
  standingRevision: number;
  state: DropshipListingHoldState;
  storeConnectionId: number;
}): string {
  return `dropship-vendor-standing:${input.vendorId}:${input.standingRevision}:${input.state}:${input.storeConnectionId}`;
}

export function vendorStandingNotificationKeyFor(input: {
  vendorId: number;
  standingRevision: number;
  event: "paused" | "resumed";
}): string {
  return `dropship-vendor-standing:${input.vendorId}:${input.standingRevision}:${input.event}`;
}

export interface DropshipVendorFundingStanding {
  availableBalanceCents: number;
  /** The auto-reload minimum; null when auto-reload is not configured. */
  minimumBalanceCents: number | null;
  currency: string;
}

/**
 * How far the available balance is below what "funded" means: the auto-reload
 * minimum, or at least one cent when no minimum is configured (an empty wallet
 * is never funded). Zero when the vendor may sell again.
 */
export function fundingShortfallCents(funding: DropshipVendorFundingStanding): number {
  const required = Math.max(funding.minimumBalanceCents ?? 0, 1);
  return Math.max(0, required - funding.availableBalanceCents);
}
