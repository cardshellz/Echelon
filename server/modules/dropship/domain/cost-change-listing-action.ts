import { createHash } from "node:crypto";
import type { DropshipCostChangePolicySettings } from "../../../../shared/dropship/cost-change-policy";
import { resolveListingPrice, type SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import type { RulePriceBasis } from "../../../../shared/dropship/pricing-rules";
import { isPushProgressListingOnMarketplace } from "./order-listing-acceptability";

/**
 * What happens to a vendor's listings when a .ops cost increase takes effect
 * (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C5). Pure rules over one listing,
 * the cost now in force and the policy: a listing whose price follows the
 * cost through pricing rules is repriced or waits for the vendor's review; a
 * listing whose price does not follow the cost is judged against it and,
 * when under water, recorded, warned about or paused. Money is integer cents.
 */

export const costChangeListingActionValues = [
  "reprice_queued",
  /** The policy asked for a reprice but the store cannot take a push now (the detail names why). */
  "reprice_refused",
  "awaiting_review",
  "price_covers_cost",
  "below_cost_recorded",
  "below_cost_warned",
  "below_cost_paused",
  "skipped_inactive_listing",
  "skipped_price_unavailable",
] as const;
export type CostChangeListingAction = (typeof costChangeListingActionValues)[number];

/** Where a listing's price comes from, and so whether the .ops cost moves it. */
export const costChangeListingPriceSourceValues = [
  "rules_cost",
  "rules_retail",
  "fixed",
  "catalog_default",
  "saved_listing",
  "unavailable",
] as const;
export type CostChangeListingPriceSource = (typeof costChangeListingPriceSourceValues)[number];

export const costChangeHoldReleaseReasons = ["price_covers_cost", "listing_inactive"] as const;
export type CostChangeHoldReleaseReason = (typeof costChangeHoldReleaseReasons)[number];

/**
 * What the release did at inventory planning. A SKU hold there has one holder
 * and any release deletes it, so a hold that another actor (the listing tier
 * reconciler) now owns is left in place, and one that is already gone needs
 * no command.
 */
export const costChangeHoldReleaseDetails = ["released", "held_by_other", "not_held"] as const;
export type CostChangeHoldReleaseDetail = (typeof costChangeHoldReleaseDetails)[number];

/** Only a listing live on the marketplace is repriced, warned about or paused. */
export const COST_ACTIONABLE_LISTING_STATUSES: readonly string[] = ["active"];

/**
 * Whether the cost-change actions treat a listing as live: `active`, or a
 * listing being re-sent that eBay still lists (a push-progress status with a
 * listing id; step 1 plan S2-5 review MC1). Orders are accepted on the second
 * kind (order-listing-acceptability.ts, §4.7), so a below-cost hold on one is
 * kept and a cost increase on one is acted on. Since PR 1b's guards a live
 * listing keeps its status through a queue, a failure, a Stop and the breaker
 * (domain/listing-live-status), so the second kind is a row written before
 * them, or by an older release during a deploy, until the listing-push
 * recovery repairs it; a listing live today stays `active`, and its hold is
 * protected by the published-price check (judgeAgainstPublishedPrice,
 * decideCostChangeHoldRelease). `paused` and `drift_detected` keep their
 * earlier meaning (publish runs did not change them).
 */
export function isCostActionableListing(input: { listingStatus: string; externalListingId: string | null }): boolean {
  return COST_ACTIONABLE_LISTING_STATUSES.includes(input.listingStatus)
    || isPushProgressListingOnMarketplace({ status: input.listingStatus, externalListingId: input.externalListingId });
}

export interface CostChangeListingPriceClassification {
  source: CostChangeListingPriceSource;
  priceCents: number | null;
  /** True when pricing rules price the listing from the .ops cost, so the cost decides the price. */
  followsCost: boolean;
}

/**
 * The same resolution the listing preview uses (`resolveListingPrice`), named
 * by what the .ops cost does to it. `rulePrice` is the rule price at the cost
 * being judged, so a rule-priced listing resolves even before it is repriced;
 * `blockedByLimit` says a blocking Card Shellz limit refuses that price, so an
 * `inherit` listing is on its retail price instead, as the preview prices it.
 */
export function classifyCostChangeListingPrice(input: {
  saved: Pick<SavedListingPriceRevision, "overridePriceCents" | "pricingMode"> | null;
  existingListingPriceCents: number | null;
  defaultPriceCents: number | null;
  rulePrice: { priceCents: number | null; basis: RulePriceBasis | null; blockedByLimit?: boolean } | null;
}): CostChangeListingPriceClassification {
  const resolved = resolveListingPrice(input);
  switch (resolved.source) {
    case "rules": {
      const followsCost = input.rulePrice?.basis === "product_cost";
      return { source: followsCost ? "rules_cost" : "rules_retail", priceCents: resolved.effectivePriceCents, followsCost };
    }
    case "override":
      return { source: "fixed", priceCents: resolved.effectivePriceCents, followsCost: false };
    case "saved_listing":
      return { source: "saved_listing", priceCents: resolved.effectivePriceCents, followsCost: false };
    case "catalog_default":
      return { source: "catalog_default", priceCents: resolved.effectivePriceCents, followsCost: false };
    case "unavailable":
      return { source: "unavailable", priceCents: null, followsCost: false };
  }
}

/**
 * The price a live listing is judged at: the lower of the price its settings
 * give now (`price`, as the preview resolves it) and the price its last
 * completed push published, which is what buyers see on the marketplace. A
 * queued, blocked or failed update keeps the listing live and orderable
 * (domain/listing-live-status), so a price that is saved or queued but not
 * yet published must not count as covering the cost; nor may an older,
 * higher published price hide a lower one queued to replace it.
 * A rule-priced listing follows the cost by a reprice, so its price is left
 * as the rules give it. With no published price on record, the settings
 * price is judged, as before (ASSUMPTION: every completed push records the
 * price it sent; dropship-listing-push-worker.repository completeItem).
 */
export function judgeAgainstPublishedPrice(
  price: CostChangeListingPriceClassification,
  publishedPriceCents: number | null,
): CostChangeListingPriceClassification {
  if (price.followsCost || price.priceCents === null || publishedPriceCents === null) return price;
  assertPositiveCents(publishedPriceCents, "publishedPriceCents");
  return publishedPriceCents < price.priceCents ? { ...price, priceCents: publishedPriceCents } : price;
}

/**
 * Decide one listing under the policy once an increase to `unitCostCents` is
 * in force. The listing's price is compared with the cost per variant unit,
 * the same unit an accepted order is charged at.
 */
export function decideCostChangeListingAction(input: {
  listingStatus: string;
  /** The listing's eBay listing id as stored: a re-sent listing with one is still live (isCostActionableListing). */
  externalListingId: string | null;
  price: CostChangeListingPriceClassification;
  unitCostCents: number;
  settings: Pick<DropshipCostChangePolicySettings, "rulePricedListings" | "belowCostFixedListings">;
}): CostChangeListingAction {
  assertPositiveCents(input.unitCostCents, "unitCostCents");
  if (!isCostActionableListing(input)) return "skipped_inactive_listing";
  if (input.price.followsCost) {
    return input.settings.rulePricedListings === "reprice_automatically" ? "reprice_queued" : "awaiting_review";
  }
  if (input.price.priceCents === null) return "skipped_price_unavailable";
  assertPositiveCents(input.price.priceCents, "priceCents");
  if (input.price.priceCents >= input.unitCostCents) return "price_covers_cost";
  switch (input.settings.belowCostFixedListings) {
    case "no_action":
      return "below_cost_recorded";
    case "warn":
      return "below_cost_warned";
    case "pause_listing":
      return "below_cost_paused";
  }
}

/**
 * Whether a listing paused for being under water may sell again: the price
 * buyers see covers the cost in force, or it is no longer live and the hold
 * would only linger. "Covers" needs both the price its settings give now and
 * the price its last completed push published to cover the cost: a raised
 * price that is saved or queued but not yet on the marketplace keeps the
 * hold (the listing stays orderable while its update is queued or failed),
 * and so does a lower price queued to replace a published one that covers
 * it. An unknown price, published price or cost keeps the hold; nothing is
 * released on a guess.
 *
 * A listing being re-sent that eBay still lists (a push-progress status with a
 * listing id) keeps its hold whatever its price says (step 1 plan S2-5 review
 * round 2 MC2): until a push completes (status `active` again, with the price
 * eBay accepted) its prices are Echelon's intent, not what buyers pay, and
 * orders are taken on that listing (§4.7). Since PR 1b's guards no queue,
 * failure, Stop or breaker writes that status over a live listing, so such a
 * row was written before them (or by an older release during a deploy) and
 * keeps its hold until a completed push or the listing-push recovery makes it
 * `active` again; a listing live today stays `active` and is judged by the
 * published price above. Only a listing that is neither active nor such a
 * re-sent listing is released as inactive (isCostActionableListing).
 */
export function decideCostChangeHoldRelease(input: {
  listingStatus: string;
  externalListingId: string | null;
  priceCents: number | null;
  /** The price the listing's last completed push published; null when none is on record. */
  publishedPriceCents: number | null;
  costInForceCents: number | null;
}): CostChangeHoldReleaseReason | null {
  if (!isCostActionableListing(input)) return "listing_inactive";
  if (isPushProgressListingOnMarketplace({ status: input.listingStatus, externalListingId: input.externalListingId })) return null;
  if (input.priceCents === null || input.publishedPriceCents === null || input.costInForceCents === null) return null;
  assertPositiveCents(input.priceCents, "priceCents");
  assertPositiveCents(input.publishedPriceCents, "publishedPriceCents");
  assertPositiveCents(input.costInForceCents, "costInForceCents");
  return Math.min(input.priceCents, input.publishedPriceCents) >= input.costInForceCents ? "price_covers_cost" : null;
}

/**
 * Whether a queued push may publish the rule price computed now. Under
 * "wait for review" a rule-priced listing whose price moved since it was
 * queued is the vendor's to review; anything else publishes as before.
 */
export function decideQueuedRulePricePublication(input: {
  rulePriced: boolean;
  queuedPriceCents: number;
  currentPriceCents: number;
  rulePricedListings: DropshipCostChangePolicySettings["rulePricedListings"];
}): { publish: true } | { publish: false; reason: "awaiting_review" } {
  assertPositiveCents(input.queuedPriceCents, "queuedPriceCents");
  assertPositiveCents(input.currentPriceCents, "currentPriceCents");
  if (input.rulePriced && input.rulePricedListings === "wait_for_review" && input.currentPriceCents !== input.queuedPriceCents) {
    return { publish: false, reason: "awaiting_review" };
  }
  return { publish: true };
}

/** A short, order-independent fingerprint of an id set for idempotency keys. */
export function idSetHash(ids: readonly number[]): string {
  for (const id of ids) assertPositiveInteger(id, "id");
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  return createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 16);
}

/** One reprice push job per store connection and set of increases. */
export function costChangeRepriceIdempotencyKey(input: { vendorId: number; storeConnectionId: number; entryIds: readonly number[] }): string {
  assertPositiveInteger(input.vendorId, "vendorId");
  assertPositiveInteger(input.storeConnectionId, "storeConnectionId");
  return `dropship-cost-change-reprice:${input.vendorId}:${input.storeConnectionId}:${idSetHash(input.entryIds)}`;
}

/** One hold command per store connection, set of increases and chunk of variants. */
export function costChangeHoldIdempotencyKey(input: {
  storeConnectionId: number;
  entryIds: readonly number[];
  productVariantIds: readonly number[];
}): string {
  assertPositiveInteger(input.storeConnectionId, "storeConnectionId");
  return `dropship-cost-change-hold:${input.storeConnectionId}:${idSetHash(input.entryIds)}:${idSetHash(input.productVariantIds)}`;
}

/**
 * A recheck re-judges a listing whose increase was skipped while an earlier
 * queue or failed push made it read as not live (see the service's recheck
 * pass). Its push job, hold command and notices are keyed by the skipped
 * listing actions it re-judges, apart from the first decision's keys, so a
 * replayed recheck reuses them and never collides with a first decision.
 */
export function costChangeRecheckRepriceIdempotencyKey(input: { vendorId: number; storeConnectionId: number; actionIds: readonly number[] }): string {
  assertPositiveInteger(input.vendorId, "vendorId");
  assertPositiveInteger(input.storeConnectionId, "storeConnectionId");
  return `dropship-cost-change-reprice:recheck:${input.vendorId}:${input.storeConnectionId}:${idSetHash(input.actionIds)}`;
}

export function costChangeRecheckHoldIdempotencyKey(input: {
  storeConnectionId: number;
  actionIds: readonly number[];
  productVariantIds: readonly number[];
}): string {
  assertPositiveInteger(input.storeConnectionId, "storeConnectionId");
  return `dropship-cost-change-hold:recheck:${input.storeConnectionId}:${idSetHash(input.actionIds)}:${idSetHash(input.productVariantIds)}`;
}

/** One release command per store connection and chunk of holds. */
export function costChangeReleaseIdempotencyKey(input: { storeConnectionId: number; holdIds: readonly number[] }): string {
  assertPositiveInteger(input.storeConnectionId, "storeConnectionId");
  return `dropship-cost-change-release:${input.storeConnectionId}:${idSetHash(input.holdIds)}`;
}

export const costChangeListingNoticeKinds = ["repriced", "review_needed", "below_cost", "paused", "resumed"] as const;
export type CostChangeListingNoticeKind = (typeof costChangeListingNoticeKinds)[number];

/** One notification per vendor, kind and set of increases (or of released holds). */
export function costChangeListingNoticeIdempotencyKey(input: { vendorId: number; kind: CostChangeListingNoticeKind; ids: readonly number[] }): string {
  assertPositiveInteger(input.vendorId, "vendorId");
  return `dropship-cost-change-listings:${input.vendorId}:${input.kind}:${idSetHash(input.ids)}`;
}

/**
 * Notices outside the first decision of an increase, each under its own
 * namespace so an id set never meets the same set of another kind of id:
 * a recheck's notices (keyed by the skipped listing actions it re-judged)
 * and the pause notice for put-back holds the review kept (keyed by hold).
 */
export function costChangeListingFollowUpNoticeIdempotencyKey(input: {
  vendorId: number;
  kind: CostChangeListingNoticeKind;
  basis: "recheck" | "restored_hold";
  ids: readonly number[];
}): string {
  assertPositiveInteger(input.vendorId, "vendorId");
  return `dropship-cost-change-listings:${input.vendorId}:${input.kind}:${input.basis}:${idSetHash(input.ids)}`;
}

function assertPositiveCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive whole number of cents.`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
}
