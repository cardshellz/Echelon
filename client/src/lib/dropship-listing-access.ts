/**
 * What the Catalog page tells a vendor who cannot preview or push listings, and
 * where it sends them to fix it.
 *
 * The decision is the shared rule the server enforces
 * (shared/dropship/listing-access.ts), run on the vendor block the portal
 * already loads, so the page and the server cannot disagree. This module adds
 * the link for each resolution and reads the same block back out of a refused
 * request, for the rare case where the account changed after the page loaded.
 * Pure: no clock, no fetch.
 */

import {
  DROPSHIP_LISTING_ACCESS_BLOCK_CODES,
  decideDropshipListingAccess,
  isDropshipListingAccessResolution,
  type DropshipListingAccessResolution,
  type DropshipListingAction,
} from "@shared/dropship/listing-access";
import { DropshipApiError } from "./dropship-ops-surface";

/** Where a Card Shellz customer joins or renews .ops (also the login page's sign-up link). */
export const OPS_MEMBERSHIP_URL = "https://www.cardshellz.com/pages/club";
export const DROPSHIP_SUPPORT_EMAIL = "support@cardshellz.com";

export interface ListingAccessLink {
  label: string;
  /** A portal path such as "/onboarding", or an absolute URL when `external`. */
  href: string;
  external: boolean;
}

export interface ListingAccessNotice {
  message: string;
  resolution: DropshipListingAccessResolution;
  link: ListingAccessLink | null;
}

/** The account facts the rule needs, as the onboarding state reports them. */
export interface ListingAccessAccount {
  status: string;
  entitlementStatus: string;
}

const BLOCK_CODES: ReadonlySet<string> = new Set(DROPSHIP_LISTING_ACCESS_BLOCK_CODES);

export function listingAccessLink(resolution: DropshipListingAccessResolution): ListingAccessLink | null {
  switch (resolution) {
    case "activate_account":
      return { label: "Go to Onboarding", href: "/onboarding", external: false };
    case "resolve_pause":
      return { label: "Go to Wallet", href: "/wallet", external: false };
    case "reconnect_store":
    case "finish_store_setup":
      // The Onboarding route hosts the store connection panel for every vendor.
      return { label: "Go to store connection", href: "/onboarding", external: false };
    case "renew_membership":
      return { label: "Renew .ops", href: OPS_MEMBERSHIP_URL, external: true };
    case "update_membership_payment":
      // No page URL is known for updating a membership payment; the message
      // names the step and the membership emails carry the link.
      return null;
    case "contact_support":
      return { label: "Email Card Shellz support", href: `mailto:${DROPSHIP_SUPPORT_EMAIL}`, external: true };
  }
}

/**
 * The block for this account, or null when the action is allowed. The store is
 * left out: the page only offers stores that are connected and launch-ready.
 */
export function describeListingAccess(
  account: ListingAccessAccount | null | undefined,
  action: DropshipListingAction,
): ListingAccessNotice | null {
  if (!account) return null;
  const decision = decideDropshipListingAccess({
    action,
    vendorStatus: account.status,
    entitlementStatus: account.entitlementStatus,
    store: null,
  });
  return decision.allowed ? null : noticeFor(decision.message, decision.resolution);
}

/** The block a refused preview or push reported, or null for any other failure. */
export function listingAccessNoticeFromError(error: unknown): ListingAccessNotice | null {
  if (!(error instanceof DropshipApiError) || error.code === null || !BLOCK_CODES.has(error.code)) return null;
  const resolution = error.context?.resolution;
  if (!isDropshipListingAccessResolution(resolution)) return null;
  return noticeFor(error.message, resolution);
}

function noticeFor(message: string, resolution: DropshipListingAccessResolution): ListingAccessNotice {
  return { message, resolution, link: listingAccessLink(resolution) };
}
