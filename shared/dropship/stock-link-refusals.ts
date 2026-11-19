/**
 * The vendor's words for a Dropship eBay push refused by the automatic stock link
 * (Card Shellz stock to the listing's exact eBay SKU). One source for both sides:
 * the server's DropshipError message is the reason as a sentence (it reaches the
 * failure email as is, dropship-listing-push-worker-service describeFailedListingPushJob),
 * and the portal renders "Could not list: <reason>" plus the next step
 * (client/src/lib/dropship-listing-push-status.ts).
 *
 * Whether a code is retried is the server's decision
 * (server/modules/dropship/domain/stock-link-readiness.ts); the words say the same
 * thing. The two transient codes say the retry is automatic because the push sweep
 * re-queues them by itself (bounded count, growing wait); when it will not for an
 * item, the portal uses DROPSHIP_STOCK_LINK_MANUAL_RETRY_NEXT_STEPS instead (review V2-2).
 *
 * Review round additions: DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU (this item's own
 * link names another SKU, the reverse of DROPSHIP_STOCK_SKU_LINK_CONFLICT) and
 * DROPSHIP_STOCK_RESEND_LISTING_FOUND (an automatic re-send met a published eBay
 * listing with this SKU that the listing never recorded, so it was not adopted).
 */
export interface DropshipStockLinkRefusalWords {
  readonly reason: string;
  readonly nextStep: string;
}

export const DROPSHIP_STOCK_LINK_REFUSAL_CODES = [
  "DROPSHIP_STOCK_DESTINATION_NOT_READY",
  "DROPSHIP_STOCK_DESTINATION_DUPLICATED",
  "DROPSHIP_STOCK_ITEM_NOT_READY",
  "DROPSHIP_STOCK_STORE_ON_HOLD",
  "DROPSHIP_STOCK_ITEM_ON_HOLD",
  "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED",
  "DROPSHIP_STOCK_SKU_LINK_CONFLICT",
  "DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU",
  "DROPSHIP_STOCK_SKU_CHANGED",
  "DROPSHIP_STOCK_LINK_CHANGED",
  "DROPSHIP_STOCK_NOT_OFFERED",
  "DROPSHIP_STOCK_MODE_NOT_MANAGED",
  "DROPSHIP_STOCK_UPDATES_PAUSED",
  "DROPSHIP_STOCK_LINK_BUSY",
  "DROPSHIP_STOCK_LINK_FAILED",
  "DROPSHIP_STOCK_READINESS_REQUIRED",
  "DROPSHIP_STOCK_RESEND_LISTING_FOUND",
] as const;

export type DropshipStockLinkRefusalCode = (typeof DROPSHIP_STOCK_LINK_REFUSAL_CODES)[number];

const NOTHING_TO_FIX = "Nothing to fix on your side. Contact support with this message.";

export const DROPSHIP_STOCK_LINK_REFUSAL_WORDS: Readonly<Record<DropshipStockLinkRefusalCode, DropshipStockLinkRefusalWords>> = Object.freeze({
  DROPSHIP_STOCK_DESTINATION_NOT_READY: {
    reason: "Card Shellz hasn't turned on stock updates for your eBay store yet.",
    nextStep: "Nothing to fix on your side. Contact support with this message; once stock updates are on for your store, queue the listing again.",
  },
  DROPSHIP_STOCK_DESTINATION_DUPLICATED: {
    reason: "Card Shellz's stock settings for your eBay store need attention from support.",
    nextStep: NOTHING_TO_FIX,
  },
  DROPSHIP_STOCK_ITEM_NOT_READY: {
    reason: "Card Shellz can't work out the stock for this item on your store right now.",
    nextStep: NOTHING_TO_FIX,
  },
  DROPSHIP_STOCK_STORE_ON_HOLD: {
    reason: "Card Shellz has paused stock updates for your eBay store.",
    nextStep: "Nothing to fix on your side. Contact support with this message if the pause should end, then queue the listing again.",
  },
  DROPSHIP_STOCK_ITEM_ON_HOLD: {
    reason: "Card Shellz has paused stock updates for this item on your store.",
    nextStep: "Nothing to fix on your side. Contact support with this message if the pause should end, then queue the listing again.",
  },
  DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED: {
    reason: "Card Shellz couldn't confirm which eBay account this store is connected to.",
    nextStep: "Reconnect your eBay store, then queue the listing again.",
  },
  DROPSHIP_STOCK_SKU_LINK_CONFLICT: {
    reason: "this SKU is already linked to a different item in Card Shellz stock for your store.",
    nextStep: "Nothing to fix on your side. Contact support with this message so they can check the SKU.",
  },
  DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU: {
    reason: "this item is already linked to a different SKU in Card Shellz stock for your store.",
    nextStep: "Nothing to fix on your side. Contact support with this message so they can check the item's SKU.",
  },
  DROPSHIP_STOCK_SKU_CHANGED: {
    reason: "the item's SKU or details changed after it was queued.",
    nextStep: "Preview the listing again, then queue it.",
  },
  DROPSHIP_STOCK_LINK_CHANGED: {
    reason: "this item's link to Card Shellz stock changed after it was set up.",
    nextStep: "Queue the listing again. Contact support with this message if it fails the same way.",
  },
  DROPSHIP_STOCK_NOT_OFFERED: {
    reason: "Card Shellz isn't offering stock for this item on your store right now.",
    nextStep: "Check that the item is still in your selection and your store isn't paused, then preview the listing again and queue it.",
  },
  DROPSHIP_STOCK_MODE_NOT_MANAGED: {
    reason: "Card Shellz only lists items with stock on eBay stores set to live listings with Card Shellz-managed quantity.",
    nextStep: "Ask support to switch your store to live listings with Card Shellz-managed quantity, then queue the listing again.",
  },
  DROPSHIP_STOCK_UPDATES_PAUSED: {
    reason: "Card Shellz has paused all stock updates for a while.",
    nextStep: "Nothing to do: Card Shellz will try this listing again automatically. Contact support with this message if it is still here in six hours.",
  },
  DROPSHIP_STOCK_LINK_BUSY: {
    reason: "Card Shellz stock for this item was being updated at the same moment.",
    nextStep: "Nothing to do: Card Shellz will try this listing again automatically within a few minutes. Contact support with this message if it is still here in an hour.",
  },
  DROPSHIP_STOCK_LINK_FAILED: {
    reason: "Card Shellz couldn't link this item to its stock.",
    nextStep: NOTHING_TO_FIX,
  },
  DROPSHIP_STOCK_READINESS_REQUIRED: {
    reason: "Card Shellz couldn't check this item's stock link.",
    nextStep: NOTHING_TO_FIX,
  },
  // Queueing again is the vendor's own push, which may take over that eBay listing
  // (its content, price and quantity), exactly as any first push of a published SKU does.
  DROPSHIP_STOCK_RESEND_LISTING_FOUND: {
    reason: "eBay already has a published listing with this SKU in your store, so Card Shellz did not send this listing again automatically.",
    nextStep: "Check that listing on eBay. To let Card Shellz manage it (its title, price and stock), queue this listing again. Contact support with this message if you are not sure.",
  },
});

/**
 * The two transient codes' next step when the push sweep will NOT queue the item
 * again by itself (review V2-2): its automatic re-queues are over, or the sweep's
 * store, vendor or listing guards exclude it now (the server's
 * `automaticRetryPending` is false). The automatic words above would then be untrue.
 */
export const DROPSHIP_STOCK_LINK_MANUAL_RETRY_NEXT_STEPS: Readonly<Record<"DROPSHIP_STOCK_UPDATES_PAUSED" | "DROPSHIP_STOCK_LINK_BUSY", string>> = Object.freeze({
  DROPSHIP_STOCK_UPDATES_PAUSED: "Queue the listing again later. Contact support with this message if it keeps failing.",
  DROPSHIP_STOCK_LINK_BUSY: "Queue the listing again in a few minutes. Contact support with this message if it fails the same way.",
});

/**
 * Brand names spelled with a lower-case first letter on purpose. A reason that
 * starts with one already starts its sentence correctly ("eBay already has…"), so
 * it is not upper-cased ("EBay…", review AV1-2).
 */
const LOWER_CASE_FIRST_LETTER_BRANDS: readonly string[] = Object.freeze(["eBay"]);

/** The server message for a code: the vendor reason in sentence case (it reaches the failure email as is). */
export function dropshipStockLinkServerMessage(code: DropshipStockLinkRefusalCode): string {
  const reason = DROPSHIP_STOCK_LINK_REFUSAL_WORDS[code].reason;
  const firstWord = reason.split(/[\s']/, 1)[0] ?? "";
  if (LOWER_CASE_FIRST_LETTER_BRANDS.includes(firstWord)) return reason;
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
}

export function isDropshipStockLinkRefusalCode(code: string): code is DropshipStockLinkRefusalCode {
  return (DROPSHIP_STOCK_LINK_REFUSAL_CODES as readonly string[]).includes(code);
}
