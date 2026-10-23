// PROPOSED (sync-back)
import type { MarketplaceSyncNoticeKind } from "./marketplace-sync-decision";

/**
 * The vendor's words for what eBay sync-back saw on their listings (plan v4
 * §10, owner rule 7). Every string here is PROPOSED (sync-back): new, and
 * kept in this one file so a later change edits one place. A notice row's
 * payload carries only facts (ids, cents, counts, labels); the words are made
 * here when the notice is sent. Money is integer cents, shown as dollars.
 */

/** // PROPOSED (sync-back): the title of each notice. */
export const MARKETPLACE_SYNC_NOTICE_TITLES: Readonly<Record<MarketplaceSyncNoticeKind, string>> = {
  price_below_cost: "An eBay price is below your Card Shellz cost",
  policy_incompatible: "Card Shellz can't ship under an eBay shipping policy",
  sku_changed: "An eBay custom label changed",
  offer_missing: "We can't find an eBay listing",
  variation_unsupported: "An eBay listing changed to a kind Card Shellz can't update",
  order_cancel_refunded: "A cancelled eBay order was refunded to your wallet",
  order_cancel_not_stopped: "An eBay order was cancelled after Card Shellz started on it",
  unknown_item_number: "An eBay order sold a Card Shellz custom label on an unlinked listing",
};

/**
 * // PROPOSED (sync-back): why a push was not sent (plan v4 §5 step 2), kept
 * on the job item. A vendor's end is skipped quietly (no notice for an ended
 * listing, owner rule 7); a listing Card Shellz can no longer prove is its own
 * fails, which the failure email names (rule 7c).
 */
export const MARKETPLACE_PUSH_STOP_WORDS: Readonly<Record<
  "DROPSHIP_LISTING_ENDED_ON_EBAY" | "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN" | "DROPSHIP_MARKETPLACE_SYNC_NOTHING_TO_COMPARE"
  | "DROPSHIP_MARKETPLACE_SYNC_REQUIRES_REVIEW" | "DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING", string>> = {
  DROPSHIP_LISTING_ENDED_ON_EBAY: "This listing was ended on eBay, so Card Shellz did not relist it. Publish it again from Card Shellz to relist it.",
  // Skipped quietly after the item's waits (review OR-4): a quantity is never a notice (owner rules 1 and 7).
  DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING:
    "This size was not sent this time: eBay's newest orders were still loading, so its quantity could not be checked yet.",
  DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN:
    "Card Shellz couldn't confirm this eBay listing is still the one it manages, so nothing was changed on eBay.",
  DROPSHIP_MARKETPLACE_SYNC_NOTHING_TO_COMPARE: "This item has no SKU, so Card Shellz couldn't check its eBay listing and changed nothing.",
  DROPSHIP_MARKETPLACE_SYNC_REQUIRES_REVIEW:
    "Card Shellz couldn't check this eBay listing and its team is looking into it, so nothing was changed on eBay.",
};

/** A notice as the vendor reads it. */
export interface MarketplaceSyncNoticeWords { title: string; message: string }

const MAX_LINE_ITEM_LABEL = 120;
/** // PROPOSED (sync-back): why a shipping policy cannot be served, by the policy guard's issue code. */
const POLICY_REASON_WORDS: Readonly<Record<string, string>> = {
  international_direct_shipping_unsupported: "international shipping",
  local_pickup_unsupported: "local pickup",
  pickup_drop_off_unsupported: "pickup or drop-off",
  freight_shipping_unsupported: "freight shipping",
  handling_time_too_short: "faster handling than Card Shellz offers",
  destination_coverage_incomplete: "places Card Shellz doesn't ship to",
  shipping_option_type_unsupported: "a shipping option Card Shellz doesn't offer",
  domestic_shipping_service_required: "no domestic shipping service",
};

/** The words of one notice row. Unknown or missing facts fall back to plain words, never to a code. */
export function describeMarketplaceSyncNotice(kind: MarketplaceSyncNoticeKind, payload: Readonly<Record<string, unknown>>): string {
  const item = itemOf(payload);
  switch (kind) {
    case "price_below_cost": {
      const price = numberOrNull(payload.priceCents);
      const cost = numberOrNull(payload.unitCostCents);
      const loss = price !== null && cost !== null && cost > price ? ` You lose ${dollars(cost - price)} on each sale before eBay fees and shipping.` : "";
      return `${capitalized(item)} sells for ${dollars(price)} on eBay, below its Card Shellz cost of ${dollars(cost)}.${loss} We won't change your price.`;
    }
    case "policy_incompatible": {
      const name = quotedName(payload.policyName);
      const count = numberOrNull(payload.listingCount);
      const reasons = (Array.isArray(payload.reasons) ? payload.reasons : [])
        .map((reason) => (typeof reason === "string" ? POLICY_REASON_WORDS[reason] : undefined)).filter(Boolean) as string[];
      const promise = reasons.length > 0 ? joinWords(reasons) : "terms Card Shellz can't meet";
      const listings = count === null ? "" : ` (${count.toLocaleString("en-US")} listing${count === 1 ? "" : "s"})`;
      return `Your eBay shipping policy ${name}${listings} promises ${promise}, which Card Shellz can't do. We haven't changed your listings `
        + `and we keep updating them. Orders that need it can't be filled. Choose a policy Card Shellz can ship, on eBay or in Listing settings.`;
    }
    case "sku_changed": {
      const ours = textOr(payload.ours, "the Card Shellz custom label");
      return `The custom label of ${item} on eBay changed from ${ours} to ${textOr(payload.theirs, "another one")}. Card Shellz can't update `
        + `this listing until it's ${ours} again.`;
    }
    case "offer_missing":
      return `Card Shellz can't find ${item} on your eBay account any more, so we can't update it. If you deleted it, publish it again from Card Shellz.`;
    case "variation_unsupported":
      if (payload.reason === "format") {
        return `The eBay listing type of ${item} changed to one Card Shellz can't update, so we've stopped updating it. `
          + `Publish the size from Card Shellz again as a fixed-price listing.`;
      }
      return `${capitalized(item)} is now part of a multi-variation listing on eBay, which Card Shellz doesn't support. We've stopped updating it. `
        + `Publish the size from Card Shellz as its own listing.`;
    case "order_cancel_refunded": {
      const order = orderOf(payload);
      const cash = numberOrNull(payload.cashRefundCents);
      const fee = numberOrNull(payload.advanceFeeRefundCents);
      const points = numberOrNull(payload.rewardsRefundCents);
      const feeWords = fee !== null && fee > 0 ? `, including the ${dollars(fee)} fee for the bank transfer still on its way` : "";
      const pointsWords = points !== null && points > 0 ? ` and ${dollars(points)} in points` : "";
      return `${capitalized(order)} was cancelled on eBay before Card Shellz shipped it. We stopped it and put ${dollars(cash)} back in your wallet`
        + `${feeWords}${pointsWords}.`;
    }
    case "order_cancel_not_stopped": {
      const order = orderOf(payload);
      return payload.shipped === true
        ? `${capitalized(order)} was cancelled on eBay after Card Shellz shipped it. Card Shellz is looking into it and will tell you what happens next.`
        : `${capitalized(order)} was cancelled on eBay after Card Shellz started on it. Card Shellz is checking whether it left the warehouse. `
          + `We'll tell you before any refund.`;
    }
    case "unknown_item_number": {
      const itemNumber = textOr(payload.externalListingId, "an item");
      const sku = textOr(payload.sku, "a Card Shellz custom label");
      return `eBay item ${itemNumber} sold ${sku}, which is a Card Shellz custom label, but item ${itemNumber} isn't linked to Card Shellz, `
        + `so we haven't shipped it. If it's a copy of a Card Shellz listing, cancel the order on eBay and publish the size from Card Shellz. `
        + `If it's your own stock, ignore this.`;
    }
  }
}

/** The notification's message limit (dropship-notification-service.ts nullableTextSchema). */
export const MARKETPLACE_SYNC_MESSAGE_MAX_CHARS = 5_000;
const ROOM_FOR_MORE = 80;

/**
 * One notification for one batch (one store and kind): the kind's title, one
 * line per row in the order given, and a count of the rows that do not fit
 * the message.
 */
export function describeMarketplaceSyncNoticeBatch(kind: MarketplaceSyncNoticeKind,
  payloads: readonly Readonly<Record<string, unknown>>[]): MarketplaceSyncNoticeWords {
  let message = "";
  let shown = 0;
  for (const payload of payloads) {
    const line = describeMarketplaceSyncNotice(kind, payload);
    const next = message === "" ? line : `${message}\n${line}`;
    if (next.length > MARKETPLACE_SYNC_MESSAGE_MAX_CHARS - ROOM_FOR_MORE) break;
    message = next;
    shown += 1;
  }
  const more = payloads.length - shown;
  if (more > 0) message += `${message === "" ? "" : "\n"}And ${more.toLocaleString("en-US")} more like this.`;
  return { title: MARKETPLACE_SYNC_NOTICE_TITLES[kind], message };
}

/** Integer cents as dollars ("$1,234.50"); unknown amounts as "an unknown amount". */
export function dollars(cents: unknown): string {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 0) return "an unknown amount";
  const whole = Math.floor(cents / 100).toLocaleString("en-US");
  return `$${whole}.${String(cents % 100).padStart(2, "0")}`;
}

function itemOf(payload: Readonly<Record<string, unknown>>): string {
  const label = typeof payload.itemLabel === "string" ? payload.itemLabel.trim() : "";
  if (!label) return "a listing";
  return label.length > MAX_LINE_ITEM_LABEL ? `${label.slice(0, MAX_LINE_ITEM_LABEL - 1)}…` : label;
}

function orderOf(payload: Readonly<Record<string, unknown>>): string {
  const number = typeof payload.externalOrderNumber === "string" ? payload.externalOrderNumber.trim() : "";
  return number ? `eBay order ${number.slice(0, MAX_LINE_ITEM_LABEL)}` : "an eBay order";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function textOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function quotedName(value: unknown): string {
  return typeof value === "string" && value.trim() ? `"${value.trim()}"` : "you chose";
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
