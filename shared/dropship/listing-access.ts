/**
 * Who may preview or push dropship listings, and what the vendor has to do
 * when they may not.
 *
 * One rule for both sides. The server enforces it before every listing preview
 * and push (DropshipListingPreviewService.loadStoreContextForAction); the vendor
 * pages run it on the same account facts to explain a block before the vendor
 * clicks. Each block names the one step that lifts it (`resolution`), which the
 * pages turn into a link. Pure: no clock, no I/O.
 */

export type DropshipListingAction = "preview" | "push";

export const DROPSHIP_LISTING_ACCESS_BLOCK_CODES = [
  "DROPSHIP_LISTING_VENDOR_BLOCKED",
  "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
  "DROPSHIP_LISTING_STORE_BLOCKED",
] as const;
export type DropshipListingAccessBlockCode = (typeof DROPSHIP_LISTING_ACCESS_BLOCK_CODES)[number];

export const DROPSHIP_LISTING_ACCESS_RESOLUTIONS = [
  /** Onboarding: finish the steps and activate the account. */
  "activate_account",
  /** Paused: the Wallet page says why and what lifts it. */
  "resolve_pause",
  /** Membership lapsed or never active: renew .ops at Card Shellz. */
  "renew_membership",
  /** Membership payment past due: update the payment at Card Shellz. */
  "update_membership_payment",
  /** Suspended, closed, or a state the vendor cannot change: support. */
  "contact_support",
  /** The store connection needs to be authorized again. */
  "reconnect_store",
  /** The store is connected but its listing setup is not finished. */
  "finish_store_setup",
] as const;
export type DropshipListingAccessResolution = (typeof DROPSHIP_LISTING_ACCESS_RESOLUTIONS)[number];

export interface DropshipListingAccessInput {
  action: DropshipListingAction;
  vendorStatus: string;
  entitlementStatus: string;
  /** The destination store. Null decides the account part only, before a store is chosen. */
  store: { status: string; launchReady: boolean } | null;
}

export interface DropshipListingAccessBlock {
  allowed: false;
  code: DropshipListingAccessBlockCode;
  resolution: DropshipListingAccessResolution;
  /** Vendor-facing: what is blocked, why, and the step that lifts it. */
  message: string;
}

export type DropshipListingAccessDecision = { allowed: true } | DropshipListingAccessBlock;

const BLOCKED_BOTH = "listings can't be previewed or pushed";

/**
 * Checks run in the order the server has always used (account status, then
 * membership, then store), so a vendor with several problems is told about the
 * account first: fixing the store would not help while the account is blocked.
 */
export function decideDropshipListingAccess(input: DropshipListingAccessInput): DropshipListingAccessDecision {
  return vendorStatusBlock(input.action, input.vendorStatus)
    ?? entitlementBlock(input.entitlementStatus)
    ?? (input.store ? storeBlock(input.store) : null)
    ?? { allowed: true };
}

function vendorStatusBlock(action: DropshipListingAction, status: string): DropshipListingAccessBlock | null {
  if (status === "active") return null;
  if (status === "onboarding") {
    // Previewing is how a vendor checks listings before going live.
    return action === "preview" ? null : block("DROPSHIP_LISTING_VENDOR_BLOCKED", "activate_account",
      "Your account isn't active yet, so listings can't be pushed to your store. Finish the steps on the Onboarding page and choose Activate .ops.");
  }
  switch (status) {
    case "paused":
      return block("DROPSHIP_LISTING_VENDOR_BLOCKED", "resolve_pause",
        `Selling is paused on your account, so ${BLOCKED_BOTH}. The Wallet page shows why and what to do.`);
    case "lapsed":
      return block("DROPSHIP_LISTING_VENDOR_BLOCKED", "renew_membership",
        `Your .ops membership has lapsed, so ${BLOCKED_BOTH}. Renew it at Card Shellz, then return to this page.`);
    case "suspended":
      return block("DROPSHIP_LISTING_VENDOR_BLOCKED", "contact_support",
        `Your .ops membership is suspended, so ${BLOCKED_BOTH}. Contact Card Shellz support to restore it.`);
    case "closed":
      return block("DROPSHIP_LISTING_VENDOR_BLOCKED", "contact_support",
        `This dropship account is closed, so ${BLOCKED_BOTH}. Contact Card Shellz support if you want to reopen it.`);
    default:
      return block("DROPSHIP_LISTING_VENDOR_BLOCKED", "contact_support",
        `Your account's current status doesn't allow listing, so ${BLOCKED_BOTH}. Contact Card Shellz support.`);
  }
}

function entitlementBlock(status: string): DropshipListingAccessBlock | null {
  switch (status) {
    case "active":
      return null;
    case "grace":
      return block("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "update_membership_payment",
        `Your .ops membership payment is past due, so ${BLOCKED_BOTH}. Update your payment at Card Shellz, then return to this page.`);
    case "lapsed":
    case "not_entitled":
      return block("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "renew_membership",
        `Your .ops membership isn't active, so ${BLOCKED_BOTH}. Renew it at Card Shellz, then return to this page.`);
    case "suspended":
      return block("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "contact_support",
        `Your .ops membership is suspended, so ${BLOCKED_BOTH}. Contact Card Shellz support to restore it.`);
    default:
      return block("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "contact_support",
        `Your .ops membership couldn't be confirmed, so ${BLOCKED_BOTH}. Contact Card Shellz support.`);
  }
}

function storeBlock(store: { status: string; launchReady: boolean }): DropshipListingAccessBlock | null {
  // No code path pauses a store connection; only Card Shellz can, so only
  // support can lift it. Every other non-connected state is fixed by reconnecting.
  if (store.status === "paused") {
    return block("DROPSHIP_LISTING_STORE_BLOCKED", "contact_support",
      `Your store connection is paused, so ${BLOCKED_BOTH}. Contact Card Shellz support to resume it.`);
  }
  if (store.status !== "connected") {
    return block("DROPSHIP_LISTING_STORE_BLOCKED", "reconnect_store",
      `Your store connection needs attention, so ${BLOCKED_BOTH}. Reconnect your store on the Onboarding page.`);
  }
  if (!store.launchReady) {
    return block("DROPSHIP_LISTING_STORE_BLOCKED", "finish_store_setup",
      `Your store setup isn't finished, so ${BLOCKED_BOTH}. Finish it on the Onboarding page.`);
  }
  return null;
}

function block(code: DropshipListingAccessBlockCode, resolution: DropshipListingAccessResolution,
  message: string): DropshipListingAccessBlock {
  return { allowed: false, code, resolution, message };
}

export function isDropshipListingAccessResolution(value: unknown): value is DropshipListingAccessResolution {
  return typeof value === "string" && (DROPSHIP_LISTING_ACCESS_RESOLUTIONS as readonly string[]).includes(value);
}
