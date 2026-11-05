/**
 * Words the vendor portal (cardshellz.io) shows for the system's codes.
 *
 * Vendors are eBay sellers, not engineers. Staff pages keep `formatStatus`,
 * which title-cases a code ("payment_hold" -> "Payment Hold", "ebay" ->
 * "Ebay"); vendor pages read every platform, status and enum through this
 * module instead, and every error through `vendorErrorMessage`, so no raw code,
 * server message or HTTP status reaches a vendor.
 *
 * Display only: nothing here changes what is sent, stored or decided.
 */
import {
  DROPSHIP_SITE_UPDATING_CODE,
  DROPSHIP_SITE_UPDATING_MESSAGE,
  DropshipApiError,
} from "./dropship-ops-surface";
import { LEDGER_REASON_LABELS } from "./dropship-wallet-flow";
import { deriveLedgerReason, type WalletLedgerReason } from "./dropship-wallet-view-adapter";

type Labels = Readonly<Record<string, string>>;

/** Shown for any error whose code has no vendor wording of its own. */
export const VENDOR_ERROR_FALLBACK = "Something went wrong. Try again, or contact Card Shellz support.";

/**
 * A code nobody mapped yet still reads as plain words ("label_printed" ->
 * "Label printed"), never as a code. Sentence case, as the rest of the portal.
 */
export function humanizeCode(value: string | null | undefined): string {
  if (!value || !value.trim()) return "Unknown";
  const words = value.trim().split(/[_\s]+/).filter(Boolean).join(" ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function labelFrom(labels: Labels, value: string | null | undefined): string {
  if (value && Object.hasOwn(labels, value)) return labels[value];
  return humanizeCode(value);
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const VENDOR_PLATFORM_NAMES: Labels = Object.freeze({
  ebay: "eBay",
  shopify: "Shopify",
});

export function vendorPlatformName(platform: string | null | undefined): string {
  if (platform && Object.hasOwn(VENDOR_PLATFORM_NAMES, platform)) return VENDOR_PLATFORM_NAMES[platform];
  return platform ? humanizeCode(platform) : "Marketplace";
}

/** "eBay order #12-34567" when the marketplace order number is known, else "eBay order". */
export function vendorMarketplaceOrderLabel(order: {
  platform: string | null | undefined;
  externalOrderNumber?: string | null;
  externalOrderId?: string | null;
}): string {
  const number = order.externalOrderNumber?.trim() || order.externalOrderId?.trim() || "";
  const platform = vendorPlatformName(order.platform);
  return number ? `${platform} order #${number}` : `${platform} order`;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const VENDOR_ORDER_STATUS_LABELS: Labels = Object.freeze({
  received: "New",
  processing: "Processing",
  accepted: "Accepted",
  rejected: "Rejected",
  retrying: "Processing",
  failed: "Couldn't process",
  payment_hold: "Waiting on payment",
  cancelled: "Cancelled",
  exception: "Needs review",
});

export function vendorOrderStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_ORDER_STATUS_LABELS, status);
}

/** Tracking sent to the marketplace for one shipment. */
export const VENDOR_TRACKING_STATUS_LABELS: Labels = Object.freeze({
  queued: "Sending to marketplace",
  processing: "Sending to marketplace",
  succeeded: "Sent to marketplace",
  failed: "Not sent yet",
});

export function vendorTrackingStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_TRACKING_STATUS_LABELS, status);
}

// ---------------------------------------------------------------------------
// Store connection
// ---------------------------------------------------------------------------

export const VENDOR_STORE_STATUS_LABELS: Labels = Object.freeze({
  connected: "Connected",
  needs_reauth: "Needs reconnecting",
  refresh_failed: "Needs reconnecting",
  grace_period: "Disconnecting soon",
  paused: "Paused",
  disconnected: "Disconnected",
});

export function vendorStoreStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_STORE_STATUS_LABELS, status);
}

export const VENDOR_STORE_SETUP_LABELS: Labels = Object.freeze({
  pending: "Setting up",
  ready: "Ready",
  attention_required: "Needs attention",
});

export function vendorStoreSetupLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_STORE_SETUP_LABELS, status);
}

/**
 * One line for a store connection: connected, or what to do. Token presence is
 * an internal detail; the vendor only needs to know whether to reconnect.
 */
export function vendorStoreConnectionLine(connection: {
  platform: string;
  status: string;
  setupStatus: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  launchReady: boolean;
}): string {
  const platform = vendorPlatformName(connection.platform);
  if (connection.launchReady) return `${platform} connection: Connected`;
  if (connection.status === "grace_period") return `${platform} connection: Disconnecting soon`;
  if (connection.status === "paused") return `${platform} connection: Paused`;
  if (connection.status === "disconnected") return `${platform} connection: Disconnected`;
  if (connection.status !== "connected" || !connection.hasAccessToken
    || (connection.platform === "ebay" && !connection.hasRefreshToken)) {
    return `${platform} connection: Needs reconnecting`;
  }
  return `${platform} connection: Still setting up`;
}

/** What is still in the way of a store taking orders, as one plain sentence. */
export function vendorStoreReadinessDetail(connection: {
  platform: string;
  status: string;
  setupStatus: string;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
}): string {
  const platform = vendorPlatformName(connection.platform);
  if (connection.status !== "connected") return vendorStoreStatusLabel(connection.status);
  if (!connection.hasAccessToken || (connection.platform === "ebay" && !connection.hasRefreshToken)) {
    return `Reconnect your ${platform} store.`;
  }
  if (connection.setupStatus !== "ready") return `${platform} setup: ${vendorStoreSetupLabel(connection.setupStatus).toLowerCase()}`;
  return "Not ready yet";
}

/** A store setup check (server `checkKey`), in a vendor's words. */
export const VENDOR_SETUP_CHECK_LABELS: Labels = Object.freeze({
  store_auth_health: "Store connection",
  post_connect_setup: "Store setup",
  order_intake_health: "Orders from your store",
});

export function vendorSetupCheckLabel(checkKey: string | null | undefined): string {
  return labelFrom(VENDOR_SETUP_CHECK_LABELS, checkKey);
}

/**
 * The line under a setup check. The check's stored message comes from the
 * marketplace or the system, so the vendor sees what to do instead; a check
 * this page does not know shows no line rather than a raw message.
 */
export const VENDOR_SETUP_CHECK_DETAILS: Labels = Object.freeze({
  store_auth_health: "Reconnect your store so orders, listings and tracking keep working.",
  post_connect_setup: "We're finishing setting up your store.",
  order_intake_health: "We're having trouble reading orders from your store. We'll keep trying.",
});

export function vendorSetupCheckDetail(checkKey: string | null | undefined): string | null {
  return checkKey && Object.hasOwn(VENDOR_SETUP_CHECK_DETAILS, checkKey) ? VENDOR_SETUP_CHECK_DETAILS[checkKey] : null;
}

export const VENDOR_SEVERITY_LABELS: Labels = Object.freeze({
  info: "For your information",
  warning: "Check this",
  error: "Needs fixing",
  blocker: "Needs fixing",
});

export function vendorSeverityLabel(severity: string | null | undefined): string {
  return labelFrom(VENDOR_SEVERITY_LABELS, severity);
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export const VENDOR_ACCOUNT_STATUS_LABELS: Labels = Object.freeze({
  onboarding: "Getting started",
  active: "Active",
  paused: "Paused",
  lapsed: "Membership lapsed",
  suspended: "Suspended",
  closed: "Closed",
  grace: "Renewal due",
  not_entitled: "No .ops membership",
});

export function vendorAccountStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_ACCOUNT_STATUS_LABELS, status);
}

export const VENDOR_AUTH_METHOD_LABELS: Labels = Object.freeze({
  passkey: "Passkey",
  password: "Password",
  email_mfa: "Email code",
});

export function vendorAuthMethodLabel(method: string | null | undefined): string {
  return labelFrom(VENDOR_AUTH_METHOD_LABELS, method);
}

export const VENDOR_STEP_STATUS_LABELS: Labels = Object.freeze({
  complete: "Done",
  incomplete: "To do",
  blocked: "Waiting",
});

export function vendorStepStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_STEP_STATUS_LABELS, status);
}

/**
 * Settings blockers (server `buildDropshipSettingsSections`): stable codes the
 * server builds, some with a status suffix (`store_${status}`,
 * `setup_${setupStatus}`, `entitlement_${status}`, `store_platform_${platform}`).
 */
export const VENDOR_SETTINGS_BLOCKER_LABELS: Labels = Object.freeze({
  store_connection_required: "Connect your eBay store.",
  store_access_token_required: "Reconnect your eBay store.",
  store_refresh_token_required: "Reconnect your eBay store.",
  store_needs_reauth: "Reconnect your eBay store.",
  store_refresh_failed: "Reconnect your eBay store.",
  store_grace_period: "Your store is being disconnected. Reconnect it to keep selling.",
  store_paused: "Your store is paused.",
  store_disconnected: "Your store is disconnected. Connect it again to sell.",
  setup_pending: "Your store is still being set up.",
  setup_attention_required: "Your store setup needs attention.",
  auto_reload_required: "Turn on autopay in Wallet.",
  auto_reload_funding_method_required: "Choose a payment method for autopay in Wallet.",
  stripe_funding_method_required: "Add a card or bank account in Wallet.",
  vendor_paused: "Selling is paused until your wallet is funded.",
  entitlement_grace: "Your .ops membership is due for renewal.",
  entitlement_lapsed: "Your .ops membership has lapsed. Renew it to keep selling.",
  entitlement_suspended: "Your .ops membership is suspended. Contact Card Shellz support.",
  entitlement_not_entitled: "You need an active .ops membership to sell.",
  contact_email_required: "Add a contact email.",
});

export function vendorSettingsBlockerLabel(blocker: string): string {
  if (Object.hasOwn(VENDOR_SETTINGS_BLOCKER_LABELS, blocker)) return VENDOR_SETTINGS_BLOCKER_LABELS[blocker];
  if (blocker.startsWith("store_platform_")) return "This store type isn't supported yet.";
  if (blocker.startsWith("entitlement_")) return "Your .ops membership needs attention.";
  if (blocker.startsWith("setup_")) return "Your store setup needs attention.";
  if (blocker.startsWith("store_")) return "Your store connection needs attention.";
  return `${humanizeCode(blocker)}.`;
}

export const VENDOR_SECTION_STATUS_LABELS: Labels = Object.freeze({
  ready: "Ready",
  attention_required: "Needs attention",
  coming_soon: "Coming soon",
});

export function vendorSectionStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_SECTION_STATUS_LABELS, status);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export const VENDOR_LEDGER_STATUS_LABELS: Labels = Object.freeze({
  pending: "Pending",
  settled: "Settled",
  failed: "Failed",
  voided: "Cancelled",
  reversed: "Reversed",
});

export function vendorLedgerStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_LEDGER_STATUS_LABELS, status);
}

/**
 * What a wallet ledger row was for, in the Wallet page's own words
 * (LEDGER_REASON_LABELS). Ledger ids and reference ids are not shown.
 */
export function vendorLedgerEntryLabel(entry: {
  type: string;
  referenceType?: string | null;
  reason?: unknown;
  metadata?: unknown;
}): string {
  const reason = typeof entry.reason === "string" && Object.hasOwn(LEDGER_REASON_LABELS, entry.reason)
    ? entry.reason as WalletLedgerReason
    : undefined;
  const metadata = typeof entry.metadata === "object" && entry.metadata !== null && !Array.isArray(entry.metadata)
    ? entry.metadata as Record<string, unknown>
    : null;
  return LEDGER_REASON_LABELS[deriveLedgerReason({
    type: entry.type,
    referenceType: entry.referenceType ?? null,
    reason,
    metadata,
  })];
}

/** Why a payment into the wallet failed, from the card or bank's decline code. */
export const VENDOR_PAYMENT_FAILURE_REASONS: Labels = Object.freeze({
  card_declined: "Your card was declined.",
  generic_decline: "Your card was declined.",
  do_not_honor: "Your card was declined.",
  insufficient_funds: "There wasn't enough money in the account.",
  expired_card: "The card has expired.",
  incorrect_cvc: "The card's security code was wrong.",
  processing_error: "Your bank couldn't process the payment.",
  authentication_required: "Your bank needs you to confirm the payment.",
  account_closed: "The bank account is closed.",
  no_account: "The bank account couldn't be found.",
  debit_not_authorized: "Your bank didn't allow the payment.",
});

const VENDOR_PAYMENT_FAILURE_DEFAULT = "Contact your bank, or try another payment method.";

export function vendorPaymentFailureLine(failure: { code: string | null; message: string | null }): string {
  const code = failure.code?.trim().toLowerCase() ?? "";
  const reason = code && Object.hasOwn(VENDOR_PAYMENT_FAILURE_REASONS, code)
    ? VENDOR_PAYMENT_FAILURE_REASONS[code]
    : VENDOR_PAYMENT_FAILURE_DEFAULT;
  return `Payment failed. ${reason}`;
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

export const VENDOR_RETURN_STATUS_LABELS: Labels = Object.freeze({
  requested: "Requested",
  in_transit: "On its way back",
  received: "Received",
  inspecting: "Being checked",
  approved: "Approved",
  rejected: "Not approved",
  disputed: "Under review",
  no_inspection_review: "Under review",
  credited: "Credited",
  closed: "Closed",
});

export function vendorReturnStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_RETURN_STATUS_LABELS, status);
}

export const VENDOR_RETURN_FAULT_LABELS: Labels = Object.freeze({
  card_shellz: "Card Shellz",
  vendor: "You (the seller)",
  customer: "The buyer",
  marketplace: "The marketplace",
  carrier: "The carrier",
});

export function vendorReturnFaultLabel(fault: string | null | undefined): string {
  return labelFrom(VENDOR_RETURN_FAULT_LABELS, fault);
}

export const VENDOR_RETURN_REASON_LABELS: Labels = Object.freeze({
  buyer_return: "Buyer returned it",
  damaged: "Damaged",
  wrong_item: "Wrong item",
  other: "Other",
});

/**
 * The reason and label source are typed by the vendor on the return form, so a
 * value that is not one of the known codes is the vendor's own words and is
 * shown as typed.
 */
function knownCodeOrTyped(labels: Labels, value: string | null | undefined): string {
  if (value && Object.hasOwn(labels, value)) return labels[value];
  return value?.trim() || "Not given";
}

export function vendorReturnReasonLabel(reason: string | null | undefined): string {
  return knownCodeOrTyped(VENDOR_RETURN_REASON_LABELS, reason);
}

export const VENDOR_RETURN_LABEL_SOURCE_LABELS: Labels = Object.freeze({
  marketplace: "The marketplace",
  vendor: "You (the seller)",
  ops: "Card Shellz",
});

export function vendorReturnLabelSourceLabel(source: string | null | undefined): string {
  return knownCodeOrTyped(VENDOR_RETURN_LABEL_SOURCE_LABELS, source);
}

export const VENDOR_INSPECTION_OUTCOME_LABELS: Labels = Object.freeze({
  approved: "Approved",
  rejected: "Not approved",
});

export function vendorInspectionOutcomeLabel(outcome: string | null | undefined): string {
  return labelFrom(VENDOR_INSPECTION_OUTCOME_LABELS, outcome);
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/** Every notification event the server sends (server dropship-notification-events.ts). */
export const VENDOR_NOTIFICATION_EVENT_LABELS: Labels = Object.freeze({
  dropship_auto_reload_failed: "Autopay failed",
  dropship_rma_no_inspection_review: "Return needs review",
  dropship_entitlement_blocked: "Membership needs attention",
  dropship_listing_push_failed: "Listing couldn't be sent",
  dropship_listing_tier_grace_notice: "Listing limit warning",
  dropship_listing_tier_held: "Listings on hold",
  dropship_listing_tier_released: "Listings back on sale",
  dropship_order_accepted: "Order accepted",
  dropship_order_intake_rejected: "Order couldn't be taken",
  dropship_order_intake_degraded: "Orders are coming in slowly",
  dropship_order_intake_stopped: "Orders aren't coming in",
  dropship_order_intake_recovered: "Orders are coming in again",
  dropship_order_payment_hold: "Order needs payment",
  dropship_order_payment_hold_expired: "Order cancelled: not paid in time",
  dropship_order_payment_hold_expiring: "Order payment due soon",
  dropship_order_processing_failed: "Order couldn't be processed",
  dropship_order_processing_retrying: "Order delayed",
  dropship_order_received: "New order",
  dropship_order_rejected: "Order rejected",
  dropship_return_credit_posted: "Return credited",
  dropship_rma_opened: "Return opened",
  dropship_store_disconnected: "Store disconnected",
  dropship_store_needs_reauth: "Store needs reconnecting",
  dropship_tracking_push_failed: "Tracking couldn't be sent",
  dropship_tracking_pushed: "Tracking sent",
  dropship_vendor_paused: "Selling paused",
  dropship_vendor_resumed: "Selling resumed",
  dropship_wallet_funding_failed: "Payment failed",
  dropship_wallet_funding_reinstated: "Payment restored",
  dropship_wallet_funding_reversed: "Payment reversed",
  dropship_wallet_low_balance: "Wallet balance low",
  dropship_usdc_deposit_landed: "USDC deposit received",
  dropship_usdc_deposit_voided: "USDC deposit cancelled",
  dropship_cost_change_announced: "Cost change coming",
  dropship_cost_change_applied: "Cost changed",
  dropship_cost_change_updated: "Cost change updated",
  dropship_cost_change_listings_repriced: "Listings repriced",
  dropship_cost_change_listings_review_needed: "Listing prices to review",
  dropship_cost_change_listings_below_cost: "Listings priced under cost",
  dropship_cost_change_listings_paused: "Listings paused: under cost",
  dropship_cost_change_listings_resumed: "Listings back on sale",
  dropship_ebay_listing_action_needed: "eBay listing needs action",
  dropship_ebay_listing_warning: "eBay listing warning",
  dropship_ebay_order_action_needed: "eBay order needs action",
  dropship_ebay_order_update: "eBay order update",
  dropship_catalog_new_items: "New items in your categories",
  dropship_selection_rules_converted: "Your product picks were updated",
  dropship_listing_end_failed: "Listings couldn't be ended",
});

export function vendorNotificationEventLabel(eventType: string | null | undefined): string {
  if (eventType && Object.hasOwn(VENDOR_NOTIFICATION_EVENT_LABELS, eventType)) return VENDOR_NOTIFICATION_EVENT_LABELS[eventType];
  // An event this page does not know yet: drop the internal prefix before humanizing.
  return humanizeCode(eventType?.replace(/^dropship_/, ""));
}

export const VENDOR_NOTIFICATION_CHANNEL_LABELS: Labels = Object.freeze({
  in_app: "In the portal",
  email: "Email",
});

export function vendorNotificationChannelLabel(channel: string | null | undefined): string {
  return labelFrom(VENDOR_NOTIFICATION_CHANNEL_LABELS, channel);
}

export const VENDOR_NOTIFICATION_STATUS_LABELS: Labels = Object.freeze({
  pending: "Sending",
  delivered: "Sent",
  failed: "Not sent",
});

export function vendorNotificationStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_NOTIFICATION_STATUS_LABELS, status);
}

// ---------------------------------------------------------------------------
// Listing preview
// ---------------------------------------------------------------------------

export const VENDOR_LISTING_PREVIEW_STATUS_LABELS: Labels = Object.freeze({
  ready: "Ready",
  warning: "Check this",
  blocked: "Can't list yet",
});

export function vendorListingPreviewStatusLabel(status: string | null | undefined): string {
  return labelFrom(VENDOR_LISTING_PREVIEW_STATUS_LABELS, status);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Server error codes whose meaning a vendor can act on, in a vendor's words.
 * Any other code — and any error without one — shows VENDOR_ERROR_FALLBACK,
 * because a server message is written for the people who run the system.
 * Pages with their own curated maps (Wallet, Listing settings, Catalog) keep
 * them; this is the default for everything else.
 */
export const VENDOR_ERROR_WORDS: Labels = Object.freeze({
  [DROPSHIP_SITE_UPDATING_CODE]: DROPSHIP_SITE_UPDATING_MESSAGE,
  DROPSHIP_AUTH_REQUIRED: "You've been signed out. Sign in again to continue.",
  DROPSHIP_ENTITLEMENT_REQUIRED: "You need an active .ops membership to use the Dropship Portal.",
  DROPSHIP_INVALID_LOGIN: "That email or password isn't right.",
  DROPSHIP_AUTH_RATE_LIMITED: "Too many tries. Wait a few minutes and try again.",
  DROPSHIP_INVALID_AUTH_REQUEST: "Check what you entered and try again.",
  DROPSHIP_PASSWORD_POLICY_FAILED: "Choose a longer password and try again.",
  DROPSHIP_INVALID_EMAIL_CHALLENGE: "That code isn't right or has expired. Request a new code and try again.",
  DROPSHIP_AUTH_EMAIL_DELIVERY_FAILED: "We couldn't send the email. Try again in a few minutes.",
  DROPSHIP_PASSKEY_AUTHENTICATION_FAILED: "Your passkey didn't work. Try again, or sign in another way.",
  DROPSHIP_PASSKEY_CHALLENGE_EXPIRED: "That took too long. Try again.",
  DROPSHIP_STEP_UP_REQUIRED: "Confirm it's you, then try again.",
  DROPSHIP_STEP_UP_METHOD_REQUIRED: "Confirm it's you, then try again.",
  DROPSHIP_ORDER_INTAKE_NOT_ACCEPTABLE: "This order can't be changed any more. Reload the page to see where it stands.",
  DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED: "This order wasn't paid in time and is being cancelled.",
  DROPSHIP_ORDER_INVENTORY_SHORTFALL: "Card Shellz doesn't have enough stock for this order right now.",
  DROPSHIP_ORDER_STORE_BLOCKED: "Reconnect your store before you accept orders.",
  DROPSHIP_ORDER_VENDOR_BLOCKED: "Your account can't accept orders right now. Check your dashboard.",
  DROPSHIP_ORDER_ENTITLEMENT_BLOCKED: "You need an active .ops membership to accept orders.",
  DROPSHIP_ORDER_SHIPPING_ADDRESS_REQUIRED: "This order has no shipping address yet.",
  DROPSHIP_RETURN_WINDOW_EXPIRED: "The return window for this order has closed.",
  DROPSHIP_RETURN_CREATE_INVALID_INPUT: "Check the order and quantities, then try again.",
});

export const VENDOR_PASSKEY_CANCELLED = "The passkey check was cancelled or timed out. Try again.";

function isErrorNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;
}

/**
 * What a vendor page shows for a failed request. A code in `words` (a page's
 * own map) or VENDOR_ERROR_WORDS shows its words; everything else — server
 * messages, "Request failed with 500", a client parse error — shows `fallback`.
 */
export function vendorErrorMessage(
  error: unknown,
  fallback: string = VENDOR_ERROR_FALLBACK,
  words: Labels = VENDOR_ERROR_WORDS,
): string {
  const code = error instanceof DropshipApiError ? error.code : null;
  if (code) {
    if (Object.hasOwn(words, code)) return words[code];
    if (Object.hasOwn(VENDOR_ERROR_WORDS, code)) return VENDOR_ERROR_WORDS[code];
  }
  // The browser's answer when a passkey prompt is closed or times out.
  if (isErrorNamed(error, "NotAllowedError")) return VENDOR_PASSKEY_CANCELLED;
  return fallback;
}
