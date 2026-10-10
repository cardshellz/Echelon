import { createHash } from "node:crypto";
import type { DropshipCostChangePolicySettings } from "../../../../shared/dropship/cost-change-policy";
import { resolveListingPrice, type SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import type { RulePriceBasis } from "../../../../shared/dropship/pricing-rules";

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
 * Decide one listing under the policy once an increase to `unitCostCents` is
 * in force. The listing's price is compared with the cost per variant unit,
 * the same unit an accepted order is charged at.
 */
export function decideCostChangeListingAction(input: {
  listingStatus: string;
  price: CostChangeListingPriceClassification;
  unitCostCents: number;
  settings: Pick<DropshipCostChangePolicySettings, "rulePricedListings" | "belowCostFixedListings">;
}): CostChangeListingAction {
  assertPositiveCents(input.unitCostCents, "unitCostCents");
  if (!COST_ACTIONABLE_LISTING_STATUSES.includes(input.listingStatus)) return "skipped_inactive_listing";
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
 * Whether a listing paused for being under water may sell again: its price
 * now covers the cost in force, or it is no longer live and the hold would
 * only linger. An unknown price or cost keeps the hold; nothing is released
 * on a guess.
 */
export function decideCostChangeHoldRelease(input: {
  listingStatus: string;
  priceCents: number | null;
  costInForceCents: number | null;
}): CostChangeHoldReleaseReason | null {
  if (!COST_ACTIONABLE_LISTING_STATUSES.includes(input.listingStatus)) return "listing_inactive";
  if (input.priceCents === null || input.costInForceCents === null) return null;
  assertPositiveCents(input.priceCents, "priceCents");
  assertPositiveCents(input.costInForceCents, "costInForceCents");
  return input.priceCents >= input.costInForceCents ? "price_covers_cost" : null;
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

function assertPositiveCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive whole number of cents.`);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer.`);
}
