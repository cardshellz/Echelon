import { MARKETPLACE_SYNC_CODES } from "./marketplace-sync-errors";
import {
  marketplaceListingSubjectKey,
  marketplaceBelowCostSubjectKey,
  shortHash,
} from "./marketplace-sync-keys";
import {
  observedOfferGuardFields,
  sha256Hex,
  type MarketplaceListingObservation,
  type MarketplaceObservationUnreadableReason,
} from "./marketplace-listing-observation";

/**
 * eBay sync-back (plan v4 §4, §5, SB7): the pure decision for one read of one
 * listing. What each field is:
 * - the vendor's: price, Best Offer and the three business policies. A value
 *   eBay shows that Card Shellz never sent (V not in Ours) is the vendor's
 *   change and is kept (adopted), or confirmed when Card Shellz already has
 *   it (V = E).
 * - title and description: never read into Echelon (owner rule 2). A push
 *   only sends back unchanged a live value that differs from what Card Shellz
 *   last sent, so it never overwrites a vendor's edit (`keepVendorText`).
 * - photos, item specifics, condition and category: not looked at; pushes
 *   send ours as they do today (owner rule 3).
 * - quantity: decided separately on a saved observation (marketplace-quantity-decision.ts).
 * Nothing here reads a clock, the database or the network: the caller passes
 * the read, the listing's state, what Card Shellz sent (Ours) and what it
 * would send now (E).
 */

/** The listing issue codes (the migration's dropship_listing_marketplace_issue_codes_chk, in the same order). */
export const MARKETPLACE_ISSUE_CODES = [
  "sku_changed", "offer_missing", "variation_listing_unsupported", "observation_unreadable", "ended_out_of_stock",
  "relisted_after_end", "price_outside_card_shellz_limit", "quantity_restore_blocked",
  // The sweep met a permanent failure of its own on this listing (CLAUDE.md §6): dead-lettered, never read again
  // until a person (or a later completed push) clears it. Never raised by a read, so a read never removes it.
  "sync_requires_review",
] as const;
export type MarketplaceIssueCode = (typeof MARKETPLACE_ISSUE_CODES)[number];
/** Issues that mean the read does not prove the listing is ours: nothing is adopted and pushes stop (§4.2). */
export const MARKETPLACE_IDENTITY_ISSUE_CODES: readonly MarketplaceIssueCode[] = [
  "sku_changed", "offer_missing", "variation_listing_unsupported", "observation_unreadable",
];

/**
 * The vendor notice kinds a listing read can raise (owner rule 7): a price
 * below what Card Shellz charges (a), a shipping policy Card Shellz cannot
 * ship under (b), and a changed custom label or a listing Card Shellz can no
 * longer update (c); and the order-side events (d, plan v4 §7.2-§7.3): an
 * accepted order eBay cancelled that Card Shellz stopped and refunded, one it
 * could not stop, and an order on an eBay item number Card Shellz does not
 * know that sold one of its custom labels. Every notice is sent on the tick
 * that claims it; there is no digest. Critical ones are sent even to a vendor
 * who turned optional notices off.
 */
export const MARKETPLACE_SYNC_NOTICE_KINDS = {
  price_below_cost: { critical: false },
  policy_incompatible: { critical: true },
  sku_changed: { critical: true },
  offer_missing: { critical: true },
  variation_unsupported: { critical: false },
  order_cancel_refunded: { critical: false },
  order_cancel_not_stopped: { critical: true },
  unknown_item_number: { critical: false },
} as const satisfies Record<string, { critical: boolean }>;
export type MarketplaceSyncNoticeKind = keyof typeof MARKETPLACE_SYNC_NOTICE_KINDS;

/** One vendor notice to write to the outbox in the change's own transaction (SB24). */
export interface MarketplaceSyncNoticeIntent {
  kind: MarketplaceSyncNoticeKind;
  critical: boolean;
  /** Unique per store and kind: a replay of the same decision writes the same key and is a no-op. */
  subjectKey: string;
  payload: Record<string, unknown>;
}

export function marketplaceSyncNotice(kind: MarketplaceSyncNoticeKind, subjectKey: string,
  payload: Record<string, unknown>): MarketplaceSyncNoticeIntent {
  return { kind, critical: MARKETPLACE_SYNC_NOTICE_KINDS[kind].critical, subjectKey, payload };
}

/**
 * Owner rule 2, for one of the title and the description: the live eBay value
 * to send back unchanged, or null to send Card Shellz's current value as
 * today. `sent` holds the fingerprints (sha256Hex) of the text Card Shellz's
 * pushes actually wrote (marketplaceSyncSentTextFromHistory, review OR-1):
 * the newest completed push's and every attempt after it. The live value is
 * the vendor's only when its fingerprint is none of them; with no record at
 * all, Card Shellz's value goes as today. Values are compared exactly as eBay
 * holds them: no trimming, sanitizing or length rule. No text is stored.
 */
export function keepVendorText(live: string | null, sent: FieldHistory<string>): string | null {
  if (live === null || (sent.baseline === null && sent.attempted.length === 0)) return null;
  const fingerprint = sha256Hex(live);
  return fingerprint === sent.baseline || sent.attempted.includes(fingerprint) ? null : live;
}

/**
 * The fingerprint a push records for a field it passes through (review
 * OR-1): Card Shellz's own last one, carried forward, so the vendor's text
 * never becomes "what Card Shellz last sent" and stays theirs on later pushes.
 */
function carriedFingerprint(passedThrough: string | null, sent: FieldHistory<string>): string | null {
  return passedThrough === null ? null : sent.baseline ?? sent.attempted[0] ?? null;
}

/**
 * What Card Shellz sent for one field (SB3): B is the value of the newest
 * listing_push_completed or listing_marketplace_synced event that records it
 * (or, before the first such event, the newest completed job's stored intent,
 * §4.1 last row); `attempted` are the values of every later
 * listing_push_attempted event. Ours = {B} ∪ attempted. Both empty means
 * Card Shellz has no record of what it sent.
 */
export interface FieldHistory<T> {
  baseline: T | null;
  attempted: readonly T[];
}

export type VendorOwnedFieldDecision =
  /** V ∈ Ours: not a vendor change; the next push sends E. */
  | { kind: "unchanged" }
  /** V ∉ Ours and V = E: both sides have it; record B := V, write nothing else. */
  | { kind: "confirm" }
  /** V ∉ Ours and V ≠ E: the vendor changed it on eBay and eBay wins (D3), even when E also moved since B. */
  | { kind: "adopt"; echelonAlsoChanged: boolean };

/** The §4.1 rule for one vendor-owned field. `echelon` null means Card Shellz has no value now: V ≠ E. */
export function decideVendorOwnedField<T extends string | number>(input: {
  observed: T; history: FieldHistory<T>; echelon: T | null;
}): VendorOwnedFieldDecision {
  const ours = input.history.baseline === null ? input.history.attempted : [input.history.baseline, ...input.history.attempted];
  if (ours.includes(input.observed)) return { kind: "unchanged" };
  if (input.echelon !== null && input.echelon === input.observed) return { kind: "confirm" };
  return { kind: "adopt", echelonAlsoChanged: input.history.baseline !== null && input.echelon !== input.history.baseline };
}

/**
 * The live-policy rule (SB10, §4.3): an incompatible shipping policy is a
 * warning, not a blocker, only when the id Card Shellz would send is the one
 * already live on this listing. A policy Card Shellz would introduce is never
 * observed yet, so it stays a blocker; a verdict that could not be verified
 * never tolerates anything.
 */
export function isLivePolicyIncompatibilityTolerated(input: {
  effectivePolicyId: string | null; observedPolicyId: string | null; listingLive: boolean; issueCodes: readonly string[];
}): boolean {
  return input.listingLive && input.observedPolicyId !== null && input.effectivePolicyId === input.observedPolicyId
    && !input.issueCodes.includes("verification_unavailable");
}

/** A shipping policy verdict's hash (§6.3): its issue codes, sorted, so the same verdict always hashes the same. */
export function fulfillmentPolicyVerdictHash(issueCodes: readonly string[]): string {
  return sha256Hex(JSON.stringify([...new Set(issueCodes)].sort()));
}

export type FulfillmentPolicyNoticeDecision =
  | { kind: "none" }
  /** A newly incompatible verdict, or another one than last told: one critical notice, remembered by its hash. */
  | { kind: "notify_incompatible"; notifiedVerdictHash: string }
  /** The policy works again after the vendor was told it did not: no notice (owner rule 7), and nothing remembered. */
  | { kind: "forget_notified"; notifiedVerdictHash: null };

/**
 * The per-store policy check's notice (§6.3, SB27, owner rule 7b). A read
 * that failed gives no verdict at all, so the caller never calls this for it
 * and the previous verdict stands.
 */
export function decideFulfillmentPolicyCheckNotice(input: {
  compatible: boolean; verdictHash: string; notifiedVerdictHash: string | null;
}): FulfillmentPolicyNoticeDecision {
  if (!input.compatible) {
    return input.notifiedVerdictHash === input.verdictHash ? { kind: "none" }
      : { kind: "notify_incompatible", notifiedVerdictHash: input.verdictHash };
  }
  return input.notifiedVerdictHash === null ? { kind: "none" } : { kind: "forget_notified", notifiedVerdictHash: null };
}

export type PolicyField = "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId";
export const POLICY_FIELDS: readonly PolicyField[] = ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"];

/** The read of one listing as the sync use case got it. */
export type MarketplaceListingRead =
  | { kind: "observed"; observation: MarketplaceListingObservation }
  | { kind: "offer_missing" }
  | { kind: "unreadable"; reason: MarketplaceObservationUnreadableReason };

export interface MarketplaceSyncListingState {
  listingId: number;
  /** The words a notice names the listing by (product, size, SKU), made by the caller. */
  itemLabel: string;
  sku: string;
  externalListingId: string | null;
  status: string;
  issueCodes: readonly MarketplaceIssueCode[];
  marketplaceEndedAt: Date | null;
  /** Card Shellz's latest published quantity (SB7): the settled publish, else pushed_quantity. */
  latestPublishedQuantity: number;
}

export interface MarketplaceSyncOurs {
  priceCents: FieldHistory<number>;
  fulfillmentPolicyId: FieldHistory<string>;
  returnPolicyId: FieldHistory<string>;
  paymentPolicyId: FieldHistory<string>;
}

/** What Card Shellz would send now (E). Null where it has no value. */
export interface MarketplaceSyncEchelon {
  priceCents: number | null;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  /** What Card Shellz charges the vendor for one unit, in cents (the below-cost warning); null when unknown. */
  unitCostCents: number | null;
}

/**
 * The fingerprints of the title and description Card Shellz's pushes wrote
 * (marketplaceSyncSentTextFromHistory, review OR-1); both histories empty
 * means there is no record of the field.
 */
export interface MarketplaceLastSentText { title: FieldHistory<string>; description: FieldHistory<string> }

export type MarketplaceSyncTrigger =
  | { kind: "sweep" }
  /** `relistAllowed` only on an item a vendor's own press created (SB9). */
  | { kind: "push"; relistAllowed: boolean; lastSentText: MarketplaceLastSentText };

export interface MarketplaceSyncInput {
  trigger: MarketplaceSyncTrigger;
  read: MarketplaceListingRead;
  observedAt: Date;
  listing: MarketplaceSyncListingState;
  ours: MarketplaceSyncOurs;
  echelon: MarketplaceSyncEchelon;
}

export type PriceDecision =
  | { kind: "unchanged" }
  | { kind: "confirm"; priceCents: number }
  | { kind: "adopt"; priceCents: number; echelonAlsoChanged: boolean; belowCost: boolean };

export type PolicyDecision =
  | { kind: "unchanged" }
  | { kind: "confirm" }
  | { kind: "adopt"; changes: Partial<Record<PolicyField, string>>; echelonAlsoChanged: boolean };

export interface MarketplaceStatusDecision {
  /** The vendor ended it on eBay: status 'ended', marketplace_ended_at := observedAt (SB7). */
  endListing: boolean;
  /** A listing Card Shellz marked ended from a read is on sale again: back to 'active' (SB8). */
  reactivate: boolean;
  /** eBay now shows another item number for our offer (a relist): follow it and keep the old one (SB6, §7.3). */
  relink: { previousListingId: string | null; listingId: string } | null;
}

/** The values a listing_marketplace_synced event records as the new baseline B for every field. */
export interface MarketplaceSyncedBaseline {
  /**
   * Null only when the read's price could not be kept (W9 refused it) and Card
   * Shellz has no recorded price: B for price is then not recorded, and the
   * stored intent stays its fallback (marketplace-sync-history.ts).
   */
  priceCents: number | null;
  currency: string;
  sku: string;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
}

/** The re-check the connector runs just before its first eBay write (SB5): any difference pauses the push. */
export interface MarketplacePushGuard {
  offerId: string;
  listingId: string | null;
  priceCents: number;
  currency: string;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  bestOfferTermsHash: string | null;
  /** sha256 of the offer's listing description as read: a vendor edit after the pre-read pauses the push (rule 2). */
  offerDescriptionHash: string | null;
  /** The offer's available quantity as read: a vendor quantity edit (or a sale) after the pre-read pauses the push. */
  availableQuantity: number;
}

/**
 * The guard fields that differ between the pre-read and the offer the
 * connector observed just before its first write (SB5): empty when eBay did
 * not change in between. No offer, or one that cannot be read, is a change.
 * Pure; the caller refuses the push retryably on any change.
 */
export function marketplacePushGuardChanges(guard: MarketplacePushGuard, observedOffer: unknown): string[] {
  if (observedOffer === null || observedOffer === undefined) return ["offer"];
  const seen = observedOfferGuardFields(observedOffer);
  if (seen === null) return ["offer_unreadable"];
  const changes: string[] = [];
  const compare = (field: string, before: unknown, after: unknown) => { if (before !== after) changes.push(field); };
  compare("offerId", guard.offerId, seen.offerId);
  compare("listingId", guard.listingId, seen.listingId);
  compare("priceCents", guard.priceCents, seen.priceCents);
  compare("currency", guard.currency, seen.currency);
  compare("fulfillmentPolicyId", guard.fulfillmentPolicyId, seen.policies.fulfillmentPolicyId);
  compare("returnPolicyId", guard.returnPolicyId, seen.policies.returnPolicyId);
  compare("paymentPolicyId", guard.paymentPolicyId, seen.policies.paymentPolicyId);
  compare("bestOfferTermsHash", guard.bestOfferTermsHash, seen.bestOfferTermsHash);
  compare("offerDescriptionHash", guard.offerDescriptionHash, seen.offerDescriptionHash);
  compare("availableQuantity", guard.availableQuantity, seen.availableQuantity);
  return changes;
}

/**
 * What a push carries from the read into its writes, unchanged: the vendor's
 * Best Offer terms (SB25), and the live title and description when the vendor
 * edited them (keepVendorText; null = Card Shellz's current value as today).
 */
export interface MarketplacePushPassthrough {
  bestOfferTerms: Readonly<Record<string, unknown>> | null;
  title: string | null;
  description: string | null;
  /**
   * What the push records as sent for a passed-through field (carriedFingerprint);
   * null for a field not passed through, whose sent fingerprint is that of the
   * Card Shellz text the push writes.
   */
  carriedFingerprints: { title: string | null; description: string | null };
}

export type MarketplacePushDecision =
  | {
    kind: "proceed"; guard: MarketplacePushGuard; passthrough: MarketplacePushPassthrough;
    /**
     * The shipping policy live on this listing now (null when eBay does not
     * show it on sale): the live-policy rule (SB10) lets a push keep exactly
     * this policy even when the fresh compatibility check flags it.
     */
    liveFulfillmentPolicyId: string | null;
  }
  | { kind: "stop"; code: typeof MARKETPLACE_SYNC_CODES.endedOnEbay | typeof MARKETPLACE_SYNC_CODES.identityUnproven };

export interface MarketplaceSyncDecision {
  price: PriceDecision;
  policies: PolicyDecision;
  status: MarketplaceStatusDecision;
  issues: { add: MarketplaceIssueCode[]; remove: MarketplaceIssueCode[]; after: MarketplaceIssueCode[] };
  /** Null when nothing moved B: no event is written. */
  syncedBaseline: MarketplaceSyncedBaseline | null;
  notices: MarketplaceSyncNoticeIntent[];
  /** Only for a push trigger: whether the push may write, and what it must re-check and carry. */
  push: MarketplacePushDecision | null;
}

const NO_STATUS: MarketplaceStatusDecision = { endListing: false, reactivate: false, relink: null };

export function decideMarketplaceSync(input: MarketplaceSyncInput): MarketplaceSyncDecision {
  const { read, listing } = input;
  if (read.kind !== "observed") return decideWithoutObservation(input, read);
  const observation = read.observation;
  const notices: MarketplaceSyncNoticeIntent[] = [];
  const add = new Set<MarketplaceIssueCode>();
  const remove = new Set<MarketplaceIssueCode>(["offer_missing", "observation_unreadable"]);

  // Identity first (§4.2): a read that does not prove the listing is ours adopts nothing.
  const skuChanged = observation.sku !== listing.sku || observation.inventoryItemSku !== listing.sku;
  const variation = observation.groupIds.length > 0 || observation.format !== "FIXED_PRICE";
  (skuChanged ? add : remove).add("sku_changed");
  (variation ? add : remove).add("variation_listing_unsupported");
  if (skuChanged && !listing.issueCodes.includes("sku_changed")) {
    notices.push(marketplaceSyncNotice("sku_changed", marketplaceListingSubjectKey(listing.listingId, "sku", shortHash(observation.sku)),
      { listingId: listing.listingId, itemLabel: listing.itemLabel, ours: listing.sku, theirs: observation.sku }));
  }
  if (variation && !listing.issueCodes.includes("variation_listing_unsupported")) {
    // Why (review OR-7): part of a multi-variation group, or a listing type other than fixed price; the words differ.
    notices.push(marketplaceSyncNotice("variation_unsupported", marketplaceListingSubjectKey(listing.listingId, "variation"),
      { listingId: listing.listingId, itemLabel: listing.itemLabel, reason: observation.groupIds.length > 0 ? "group" : "format" }));
  }
  if (skuChanged || variation) {
    return finish(input, { price: UNCHANGED, policies: UNCHANGED, status: NO_STATUS, add, remove, syncedBaseline: null, notices });
  }

  const status = decideStatus(input, observation, add, remove);
  const price = decidePrice(input, observation);
  if (price.kind === "adopt" && price.belowCost) {
    notices.push(marketplaceSyncNotice("price_below_cost", marketplaceBelowCostSubjectKey(listing.listingId, input.observedAt),
      { listingId: listing.listingId, itemLabel: listing.itemLabel, priceCents: price.priceCents,
        unitCostCents: input.echelon.unitCostCents }));
  }
  // The flag means eBay shows a price W9 refused to keep. Any price this read keeps (or that is already ours) clears
  // it; a W9 refusal of an adoption puts it back inside the adoption transaction (decisionWithoutPriceAdoption).
  remove.add("price_outside_card_shellz_limit");
  const policies = decidePolicies(input, observation);
  const movesBaseline = [price, policies].some((field) => field.kind === "confirm" || field.kind === "adopt")
    || status.relink !== null || status.reactivate;
  return finish(input, { price, policies, status, add, remove, notices,
    syncedBaseline: movesBaseline ? syncedBaseline(input, observation) : null });
}

const UNCHANGED = { kind: "unchanged" } as const;

/** One line of a freshly accepted order the buyer paid less for than Card Shellz charges the vendor (integer cents per unit). */
export interface BelowCostSaleLine {
  listingId: number;
  itemLabel: string;
  retailUnitPriceCents: number;
  unitCostCents: number;
}

/**
 * The below-cost warning of an accepted order (plan v3 §7.4, owner rule 7a):
 * one price_below_cost notice per listing, under the listing's subject for
 * the UTC day, so it never repeats within a day, whether a price adoption or
 * another order wrote it first. The lowest price sold shows. Lines at or
 * above the cost say nothing.
 */
export function orderBelowCostNotices(input: { lines: readonly BelowCostSaleLine[]; at: Date }): MarketplaceSyncNoticeIntent[] {
  const lowest = new Map<number, BelowCostSaleLine>();
  for (const line of input.lines) {
    if (line.retailUnitPriceCents >= line.unitCostCents) continue;
    const seen = lowest.get(line.listingId);
    if (!seen || line.retailUnitPriceCents < seen.retailUnitPriceCents) lowest.set(line.listingId, line);
  }
  return [...lowest.values()].map((line) => marketplaceSyncNotice("price_below_cost",
    marketplaceBelowCostSubjectKey(line.listingId, input.at),
    { listingId: line.listingId, itemLabel: line.itemLabel, priceCents: line.retailUnitPriceCents, unitCostCents: line.unitCostCents,
      source: "order" }));
}

/** A 404 or an answer that cannot be used: flag it, adopt nothing, change no status (SB7). */
function decideWithoutObservation(input: MarketplaceSyncInput,
  read: Exclude<MarketplaceListingRead, { kind: "observed" }>): MarketplaceSyncDecision {
  const { listing } = input;
  const add = new Set<MarketplaceIssueCode>();
  const remove = new Set<MarketplaceIssueCode>();
  const notices: MarketplaceSyncNoticeIntent[] = [];
  if (read.kind === "offer_missing") {
    add.add("offer_missing");
    remove.add("observation_unreadable");
    if (!listing.issueCodes.includes("offer_missing")) {
      notices.push(marketplaceSyncNotice("offer_missing",
        marketplaceListingSubjectKey(listing.listingId, "offer-missing", String(input.observedAt.getTime())),
        { listingId: listing.listingId, itemLabel: listing.itemLabel }));
    }
  } else {
    // eBay answered, so the offer exists; what it said is not usable. Ops only, no vendor notice (§4.2).
    add.add("observation_unreadable");
    remove.add("offer_missing");
  }
  return finish(input, { price: UNCHANGED, policies: UNCHANGED, status: NO_STATUS, add, remove, syncedBaseline: null, notices });
}

/** SB7: live, a stock-out end eBay made, or the vendor's end; and relists (SB6, SB8). No vendor notice (owner rule 7). */
function decideStatus(input: MarketplaceSyncInput, observation: MarketplaceListingObservation,
  add: Set<MarketplaceIssueCode>, remove: Set<MarketplaceIssueCode>): MarketplaceStatusDecision {
  const { listing } = input;
  const ended = listing.status === "ended";
  if (observation.live) {
    remove.add("ended_out_of_stock");
    if (ended && listing.marketplaceEndedAt === null) {
      // Ended by something other than a read (an end request): only flagged, never relinked or reopened here.
      add.add("relisted_after_end");
      return NO_STATUS;
    }
    remove.add("relisted_after_end");
    const relink = observation.listingId !== null && observation.listingId !== listing.externalListingId
      ? { previousListingId: listing.externalListingId, listingId: observation.listingId } : null;
    return { endListing: false, reactivate: ended, relink };
  }
  remove.add("relisted_after_end");
  if (ended) return NO_STATUS;
  if (observation.quantity.observed === 0 || listing.latestPublishedQuantity === 0) {
    // eBay ended it for lack of stock: the status stays, and it comes back with stock (SB-C1).
    add.add("ended_out_of_stock");
    return NO_STATUS;
  }
  remove.add("ended_out_of_stock");
  return { endListing: true, reactivate: false, relink: null };
}

function decidePrice(input: MarketplaceSyncInput, observation: MarketplaceListingObservation): PriceDecision {
  const decision = decideVendorOwnedField({ observed: observation.priceCents, history: input.ours.priceCents,
    echelon: input.echelon.priceCents });
  if (decision.kind === "unchanged") return UNCHANGED;
  if (decision.kind === "confirm") return { kind: "confirm", priceCents: observation.priceCents };
  const cost = input.echelon.unitCostCents;
  return { kind: "adopt", priceCents: observation.priceCents, echelonAlsoChanged: decision.echelonAlsoChanged,
    belowCost: cost !== null && observation.priceCents < cost };
}

/** Each policy by the §4.1 rule; the ones the vendor changed are adopted together into the size's policy row. */
function decidePolicies(input: MarketplaceSyncInput, observation: MarketplaceListingObservation): PolicyDecision {
  const changes: Partial<Record<PolicyField, string>> = {};
  let confirmed = false;
  let echelonAlsoChanged = false;
  for (const field of POLICY_FIELDS) {
    const observed = observation.policies[field];
    // An ended offer may carry no policy: nothing to compare.
    if (observed === null) continue;
    const decision = decideVendorOwnedField({ observed, history: input.ours[field], echelon: input.echelon[field] });
    if (decision.kind === "confirm") confirmed = true;
    if (decision.kind === "adopt") {
      changes[field] = observed;
      echelonAlsoChanged ||= decision.echelonAlsoChanged;
    }
  }
  if (Object.keys(changes).length > 0) return { kind: "adopt", changes, echelonAlsoChanged };
  return confirmed ? { kind: "confirm" } : UNCHANGED;
}

/** B := V for every field the read proved; a policy an ended offer does not carry keeps the old B. */
function syncedBaseline(input: MarketplaceSyncInput, observation: MarketplaceListingObservation): MarketplaceSyncedBaseline {
  return {
    priceCents: observation.priceCents, currency: observation.currency, sku: observation.sku,
    fulfillmentPolicyId: observation.policies.fulfillmentPolicyId ?? input.ours.fulfillmentPolicyId.baseline,
    returnPolicyId: observation.policies.returnPolicyId ?? input.ours.returnPolicyId.baseline,
    paymentPolicyId: observation.policies.paymentPolicyId ?? input.ours.paymentPolicyId.baseline,
  };
}

function finish(input: MarketplaceSyncInput, parts: {
  price: PriceDecision; policies: PolicyDecision; status: MarketplaceStatusDecision;
  add: Set<MarketplaceIssueCode>; remove: Set<MarketplaceIssueCode>; syncedBaseline: MarketplaceSyncedBaseline | null;
  notices: MarketplaceSyncNoticeIntent[];
}): MarketplaceSyncDecision {
  for (const code of parts.add) parts.remove.delete(code);
  const after = MARKETPLACE_ISSUE_CODES.filter((code) => parts.add.has(code)
    || (input.listing.issueCodes.includes(code) && !parts.remove.has(code)));
  const add = MARKETPLACE_ISSUE_CODES.filter((code) => parts.add.has(code) && !input.listing.issueCodes.includes(code));
  const remove = MARKETPLACE_ISSUE_CODES.filter((code) => parts.remove.has(code) && input.listing.issueCodes.includes(code));
  return {
    price: parts.price, policies: parts.policies, status: parts.status, issues: { add, remove, after },
    syncedBaseline: parts.syncedBaseline, notices: parts.notices,
    push: input.trigger.kind === "push" ? decidePush(input, input.trigger, after, parts.status) : null,
  };
}

/** §5 step 2: stop for good on identity, and on a vendor end unless the vendor's own press relists it. */
function decidePush(input: MarketplaceSyncInput, trigger: Extract<MarketplaceSyncTrigger, { kind: "push" }>,
  issues: readonly MarketplaceIssueCode[], status: MarketplaceStatusDecision): MarketplacePushDecision {
  if (input.read.kind !== "observed" || issues.some((code) => MARKETPLACE_IDENTITY_ISSUE_CODES.includes(code))) {
    return { kind: "stop", code: MARKETPLACE_SYNC_CODES.identityUnproven };
  }
  const endedAfter = status.endListing || (input.listing.status === "ended" && !status.reactivate);
  if (endedAfter && !trigger.relistAllowed) return { kind: "stop", code: MARKETPLACE_SYNC_CODES.endedOnEbay };
  const observation = input.read.observation;
  const title = keepVendorText(observation.title, trigger.lastSentText.title);
  const description = keepVendorText(observation.description, trigger.lastSentText.description);
  return {
    kind: "proceed",
    guard: {
      offerId: observation.offerId,
      listingId: status.relink?.listingId ?? observation.listingId,
      priceCents: observation.priceCents,
      currency: observation.currency,
      fulfillmentPolicyId: observation.policies.fulfillmentPolicyId,
      returnPolicyId: observation.policies.returnPolicyId,
      paymentPolicyId: observation.policies.paymentPolicyId,
      bestOfferTermsHash: observation.bestOfferTermsHash,
      offerDescriptionHash: observation.offerDescriptionHash,
      availableQuantity: observation.quantity.offer,
    },
    liveFulfillmentPolicyId: observation.live ? observation.policies.fulfillmentPolicyId : null,
    passthrough: {
      bestOfferTerms: observation.bestOfferTerms,
      title,
      description,
      carriedFingerprints: { title: carriedFingerprint(title, trigger.lastSentText.title),
        description: carriedFingerprint(description, trigger.lastSentText.description) },
    },
  };
}
