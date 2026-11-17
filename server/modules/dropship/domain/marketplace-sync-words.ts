// PROPOSED (sync-back)
import { EBAY_SELLER_HUB_POLICIES_URL } from "../../../../shared/ebay-business-policies";
import { marketplaceListingUrl, parseMarketplaceEnvironment } from "./marketplace-listing-url";
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

/** Links the words may carry, from the service's configuration (never from a notice row). */
export interface MarketplaceSyncNoticeLinks {
  /** The portal's Listing settings page (Catalog, step 2); null names the page without a link. */
  listingSettingsUrl: string | null;
}

const NO_LINKS: MarketplaceSyncNoticeLinks = { listingSettingsUrl: null };

const MAX_LINE_ITEM_LABEL = 120;
/** A policy notice names at most this many of the policy's listings, then "and N more" (the payload keeps the total). */
export const MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN = 5;
/** At most this many of Card Shellz's shipping services are named as examples ("such as ..."). */
const SUPPORTED_SERVICES_NAMED = 3;
const MAX_POLICY_NAME = 100;
const MAX_SERVICE_NAME = 60;
/** eBay shipping service codes (e.g. USPSPriority) are letters, digits and underscores; anything else is not echoed. */
const EBAY_SERVICE_CODE_PATTERN = /^[A-Za-z0-9_]{1,60}$/;
const UNSUPPORTED_SERVICE_PREFIX = "shipping_service_unsupported:";

/** One listing a policy notice names: its eBay item number, title (product and size) and SKU. */
export interface MarketplacePolicyNoticeListing {
  externalListingId: string;
  title: string | null;
  sku: string | null;
}

/** The facts a policy reason's words may use, from the notice payload. */
interface PolicyReasonFacts {
  /** "such as USPS Ground Advantage or UPS Ground", or "" when Card Shellz's services are unknown. */
  suchAs: string;
  handlingDays: number | null;
}

/**
 * // PROPOSED (sync-back): why a shipping policy cannot be served, by the
 * policy guard's issue code (domain/ebay-fulfillment-policy-compatibility.ts):
 * what the policy does, then what to change. Services are only ever named
 * from the store's own capability (the payload's supportedServiceNames).
 */
const POLICY_REASON_WORDS: Readonly<Record<string, (facts: PolicyReasonFacts) => string>> = {
  domestic_shipping_service_required: ({ suchAs }) =>
    `It has no US shipping service. Add a standard US service${suchAs}, or pick a different policy.`,
  international_direct_shipping_unsupported: () =>
    "It offers international shipping, and Card Shellz ships only within the US. Remove the international shipping services from it.",
  local_pickup_unsupported: () => "It offers local pickup, which Card Shellz can't do. Turn off local pickup in it.",
  pickup_drop_off_unsupported: () => "It offers pickup or drop-off, which Card Shellz can't do. Turn off pickup and drop-off in it.",
  freight_shipping_unsupported: ({ suchAs }) =>
    `It uses freight shipping, which Card Shellz can't do. Use a standard package service instead${suchAs}.`,
  handling_time_too_short: ({ handlingDays }) =>
    `Its handling time is shorter than Card Shellz needs. ${handlingDaysStep(handlingDays, "Set it to")}`,
  handling_time_missing: ({ handlingDays }) => `It has no handling time. ${handlingDaysStep(handlingDays, "Set one of")}`,
  handling_time_unit_unsupported: ({ handlingDays }) =>
    `Its handling time isn't set in business days. ${handlingDaysStep(handlingDays, "Set it in business days, to")}`,
  shipping_option_type_unsupported: () =>
    "It has a kind of shipping option Card Shellz doesn't offer. Keep only US (domestic) shipping options in it.",
  marketplace_missing: () => "eBay didn't say which eBay site it is for. Use a policy made for the eBay site your store sells on.",
  marketplace_mismatch: () => "It is for a different eBay site than your store. Use a policy made for the eBay site your store sells on.",
  // Card Shellz's side, not the vendor's: the words say so rather than ask for a change that would not help.
  destination_coverage_incomplete: () =>
    "Card Shellz couldn't confirm every US place it ships to, so it couldn't check this policy. This part is on Card Shellz's side, "
    + "and it checks again on its own.",
};

/** The words of one notice row. Unknown or missing facts fall back to plain words, never to a code. */
export function describeMarketplaceSyncNotice(kind: MarketplaceSyncNoticeKind, payload: Readonly<Record<string, unknown>>,
  links: MarketplaceSyncNoticeLinks = NO_LINKS): string {
  const item = itemOf(payload);
  switch (kind) {
    case "price_below_cost": {
      const price = numberOrNull(payload.priceCents);
      const cost = numberOrNull(payload.unitCostCents);
      const loss = price !== null && cost !== null && cost > price ? ` You lose ${dollars(cost - price)} on each sale before eBay fees and shipping.` : "";
      return `${capitalized(item)} sells for ${dollars(price)} on eBay, below its Card Shellz cost of ${dollars(cost)}.${loss} We won't change your price. `
        + `If you didn't mean to sell it for less than it costs you, raise its price on eBay.`;
    }
    case "policy_incompatible":
      return describePolicyIncompatible(payload, links);
    case "sku_changed": {
      const ours = textOr(payload.ours, "the Card Shellz custom label");
      return `The custom label of ${item} on eBay changed from ${ours} to ${textOr(payload.theirs, "another one")}. Card Shellz can't update `
        + `this listing until it's ${ours} again. To fix it, change the listing's custom label on eBay back to ${ours}.`;
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
  payloads: readonly Readonly<Record<string, unknown>>[], links: MarketplaceSyncNoticeLinks = NO_LINKS): MarketplaceSyncNoticeWords {
  let message = "";
  let shown = 0;
  for (const payload of payloads) {
    const line = describeMarketplaceSyncNotice(kind, payload, links);
    // A notice of several lines (a policy's) is kept apart from the next by a blank line.
    const separator = line.includes("\n") ? "\n\n" : "\n";
    const next = message === "" ? line : `${message}${separator}${line}`;
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

/**
 * The policy notice (owner report): what is wrong with which policy, the
 * listings it is on (each with its eBay item page), the exact places to fix
 * it, and what happens meanwhile. Links are plain URLs at a line's end: the
 * email makes them links (dropship-notification-email.sender.ts).
 */
function describePolicyIncompatible(payload: Readonly<Record<string, unknown>>, links: MarketplaceSyncNoticeLinks): string {
  const name = policyNameOf(payload.policyName);
  const count = numberOrNull(payload.listingCount);
  const policy = name === null ? "your eBay shipping policy" : `your eBay shipping policy "${name}"`;
  const usedBy = count === null || count < 1 ? ""
    : name === null ? ` that ${formatCount(count)} of your listings ${count === 1 ? "uses" : "use"}`
      : `, which ${formatCount(count)} of your listings ${count === 1 ? "uses" : "use"}`;
  const lines = [`Card Shellz can't ship orders under ${policy}${usedBy}:`];
  for (const reason of policyReasonLines(payload)) lines.push(`- ${reason}`);

  const listings = policyListingsOf(payload.listings);
  if (listings.length > 0) {
    const environment = parseMarketplaceEnvironment(payload.marketplaceEnvironment);
    lines.push("", "Affected listings:");
    for (const listing of listings) {
      const url = marketplaceListingUrl("ebay", listing.externalListingId, environment);
      const label = listing.title ?? "A listing";
      const sku = listing.sku ? ` (SKU ${listing.sku})` : "";
      lines.push(`- ${label}${sku}, eBay item ${listing.externalListingId}${url ? `: ${url}` : ""}`);
    }
    const more = count === null ? 0 : count - listings.length;
    if (more > 0) lines.push(`- and ${formatCount(more)} more`);
  }

  // eBay's business policies page is linked only on eBay's production site: the code has no sandbox address for it.
  const policiesUrl = parseMarketplaceEnvironment(payload.marketplaceEnvironment) === "sandbox" ? null : EBAY_SELLER_HUB_POLICIES_URL;
  const thePolicy = name === null ? "the policy" : `the policy "${name}"`;
  lines.push("", "To fix it:",
    `1. Edit ${thePolicy} in eBay Seller Hub > Account > Business policies${policiesUrl ? `: ${policiesUrl}` : "."}`,
    `2. Or choose a shipping policy Card Shellz can ship for these products in Card Shellz, Catalog > Listing settings${
      links.listingSettingsUrl ? `: ${links.listingSettingsUrl}` : ", in your Card Shellz dropship portal."}`,
    "",
    "Until then, your listings stay up on eBay and Card Shellz keeps updating them, but orders that need this shipping can't be filled.");
  return lines.join("\n");
}

/** One sentence per reason, known reasons in the guard's order, duplicates once; none known: one plain sentence. */
function policyReasonLines(payload: Readonly<Record<string, unknown>>): string[] {
  const facts: PolicyReasonFacts = { suchAs: suchAsServices(payload.supportedServiceNames),
    handlingDays: positiveIntegerOrNull(payload.requiredHandlingTimeBusinessDays) };
  const reasons = Array.isArray(payload.reasons) ? payload.reasons.filter((reason): reason is string => typeof reason === "string") : [];
  const lines: string[] = [];
  for (const reason of new Set(reasons)) {
    if (reason.startsWith(UNSUPPORTED_SERVICE_PREFIX)) {
      const code = reason.slice(UNSUPPORTED_SERVICE_PREFIX.length);
      const service = EBAY_SERVICE_CODE_PATTERN.test(code) ? `the shipping service ${code}` : "a shipping service";
      lines.push(`It uses ${service}, which Card Shellz doesn't ship with. Replace it with a service Card Shellz ships with${facts.suchAs}.`);
      continue;
    }
    // Own keys only: a stored reason such as "toString" must never reach Object.prototype.
    if (Object.prototype.hasOwnProperty.call(POLICY_REASON_WORDS, reason)) lines.push(POLICY_REASON_WORDS[reason]!(facts));
  }
  if (lines.length === 0) lines.push("It has a setting Card Shellz can't ship under. Check its shipping services, handling time and pickup options.");
  return lines;
}

function handlingDaysStep(days: number | null, verb: string): string {
  return days === null ? "Set a longer handling time, or pick a different policy."
    : `${verb} at least ${formatCount(days)} business day${days === 1 ? "" : "s"}, or pick a different policy.`;
}

/** " such as USPS Ground Advantage or UPS Ground", from the store's capability only; "" when unknown. */
function suchAsServices(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const names = [...new Set(value.filter((name): name is string => typeof name === "string")
    .map((name) => name.trim()).filter((name) => name.length > 0 && name.length <= MAX_SERVICE_NAME))].slice(0, SUPPORTED_SERVICES_NAMED);
  if (names.length === 0) return "";
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  return ` such as ${listed}`;
}

function policyNameOf(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return null;
  return name.length > MAX_POLICY_NAME ? `${name.slice(0, MAX_POLICY_NAME - 1)}…` : name;
}

/** The listings a payload names, each with a usable item number; at most MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN. */
function policyListingsOf(value: unknown): MarketplacePolicyNoticeListing[] {
  if (!Array.isArray(value)) return [];
  const listings: MarketplacePolicyNoticeListing[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const externalListingId = typeof record.externalListingId === "string" ? record.externalListingId.trim() : "";
    if (!/^\d{1,20}$/.test(externalListingId)) continue;
    listings.push({ externalListingId, title: clipped(record.title), sku: clipped(record.sku) });
    if (listings.length === MARKETPLACE_POLICY_NOTICE_LISTINGS_SHOWN) break;
  }
  return listings;
}

function clipped(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return text.length > MAX_LINE_ITEM_LABEL ? `${text.slice(0, MAX_LINE_ITEM_LABEL - 1)}…` : text;
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
