import { describe, expect, it } from "vitest";
import {
  COST_ACTIONABLE_LISTING_STATUSES,
  classifyCostChangeListingPrice,
  costChangeHoldIdempotencyKey,
  costChangeListingNoticeIdempotencyKey,
  costChangeReleaseIdempotencyKey,
  costChangeRepriceIdempotencyKey,
  decideCostChangeHoldRelease,
  decideCostChangeListingAction,
  decideQueuedRulePricePublication,
  idSetHash,
  type CostChangeListingPriceClassification,
} from "../../domain/cost-change-listing-action";

const rulesOnCost: CostChangeListingPriceClassification = { source: "rules_cost", priceCents: 1152, followsCost: true };
const fixed = (priceCents: number | null): CostChangeListingPriceClassification => ({ source: "fixed", priceCents, followsCost: false });

describe("classifyCostChangeListingPrice", () => {
  it("names a rule-priced listing by what its recipe prices from", () => {
    expect(classifyCostChangeListingPrice({
      saved: { overridePriceCents: null, pricingMode: "rules" }, existingListingPriceCents: 999, defaultPriceCents: 899,
      rulePrice: { priceCents: 1152, basis: "product_cost" },
    })).toEqual({ source: "rules_cost", priceCents: 1152, followsCost: true });
    expect(classifyCostChangeListingPrice({
      saved: { overridePriceCents: null, pricingMode: "rules" }, existingListingPriceCents: 999, defaultPriceCents: 899,
      rulePrice: { priceCents: 1099, basis: "catalog_retail" },
    })).toEqual({ source: "rules_retail", priceCents: 1099, followsCost: false });
  });

  it("keeps a typed price, a published price and the catalog default apart, none of which follow the cost", () => {
    expect(classifyCostChangeListingPrice({
      saved: { overridePriceCents: 799, pricingMode: "fixed" }, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: null,
    })).toEqual({ source: "fixed", priceCents: 799, followsCost: false });
    expect(classifyCostChangeListingPrice({
      saved: null, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1152, basis: "product_cost" },
    })).toEqual({ source: "saved_listing", priceCents: 999, followsCost: false });
    expect(classifyCostChangeListingPrice({
      saved: { overridePriceCents: null, pricingMode: "catalog_default" }, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: null,
    })).toEqual({ source: "catalog_default", priceCents: 899, followsCost: false });
  });

  it("reports an unavailable price rather than inventing one", () => {
    expect(classifyCostChangeListingPrice({
      saved: { overridePriceCents: null, pricingMode: "rules" }, existingListingPriceCents: null, defaultPriceCents: null,
      rulePrice: { priceCents: null, basis: "product_cost" },
    })).toEqual({ source: "unavailable", priceCents: null, followsCost: false });
    expect(classifyCostChangeListingPrice({ saved: null, existingListingPriceCents: null, defaultPriceCents: null, rulePrice: null }))
      .toEqual({ source: "unavailable", priceCents: null, followsCost: false });
  });
});

describe("decideCostChangeListingAction", () => {
  const settings = { rulePricedListings: "reprice_automatically" as const, belowCostFixedListings: "warn" as const };

  it("reprices or holds back a listing that follows the cost, as the policy says", () => {
    expect(decideCostChangeListingAction({ listingStatus: "active", price: rulesOnCost, unitCostCents: 999, settings })).toBe("reprice_queued");
    expect(decideCostChangeListingAction({ listingStatus: "active", price: rulesOnCost, unitCostCents: 999,
      settings: { ...settings, rulePricedListings: "wait_for_review" } })).toBe("awaiting_review");
  });

  it("judges every other price against the cost per unit, and acts on an under-water one as the policy says", () => {
    expect(decideCostChangeListingAction({ listingStatus: "active", price: fixed(999), unitCostCents: 999, settings })).toBe("price_covers_cost");
    expect(decideCostChangeListingAction({ listingStatus: "active", price: fixed(998), unitCostCents: 999, settings })).toBe("below_cost_warned");
    expect(decideCostChangeListingAction({ listingStatus: "active", price: fixed(998), unitCostCents: 999,
      settings: { ...settings, belowCostFixedListings: "no_action" } })).toBe("below_cost_recorded");
    expect(decideCostChangeListingAction({ listingStatus: "active", price: fixed(998), unitCostCents: 999,
      settings: { ...settings, belowCostFixedListings: "pause_listing" } })).toBe("below_cost_paused");
    expect(decideCostChangeListingAction({ listingStatus: "active", price: { source: "rules_retail", priceCents: 500, followsCost: false },
      unitCostCents: 999, settings })).toBe("below_cost_warned");
  });

  it("leaves a listing that is not live, or whose price is unknown, alone", () => {
    expect(COST_ACTIONABLE_LISTING_STATUSES).toEqual(["active"]);
    for (const status of ["preview_ready", "queued", "pushing", "paused", "ended", "failed", "blocked", "drift_detected", "not_listed"]) {
      expect(decideCostChangeListingAction({ listingStatus: status, price: rulesOnCost, unitCostCents: 999, settings })).toBe("skipped_inactive_listing");
    }
    expect(decideCostChangeListingAction({ listingStatus: "active", price: fixed(null), unitCostCents: 999, settings })).toBe("skipped_price_unavailable");
  });

  it("refuses a cost or price that is not positive whole cents", () => {
    expect(() => decideCostChangeListingAction({ listingStatus: "active", price: fixed(999), unitCostCents: 0, settings })).toThrow(RangeError);
    expect(() => decideCostChangeListingAction({ listingStatus: "active", price: fixed(999), unitCostCents: 9.99, settings })).toThrow(RangeError);
    expect(() => decideCostChangeListingAction({ listingStatus: "active", price: fixed(-1), unitCostCents: 999, settings })).toThrow(RangeError);
  });
});

describe("decideCostChangeHoldRelease", () => {
  it("releases a hold once the price covers the cost in force, or the listing is no longer live", () => {
    expect(decideCostChangeHoldRelease({ listingStatus: "active", priceCents: 999, costInForceCents: 999 })).toBe("price_covers_cost");
    expect(decideCostChangeHoldRelease({ listingStatus: "active", priceCents: 998, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "ended", priceCents: 1, costInForceCents: 999 })).toBe("listing_inactive");
  });

  it("keeps the hold when the price or the cost is unknown", () => {
    expect(decideCostChangeHoldRelease({ listingStatus: "active", priceCents: null, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "active", priceCents: 999, costInForceCents: null })).toBeNull();
    expect(() => decideCostChangeHoldRelease({ listingStatus: "active", priceCents: 0, costInForceCents: 999 })).toThrow(RangeError);
  });
});

describe("idempotency keys", () => {
  it("fingerprints an id set regardless of order or repeats", () => {
    expect(idSetHash([3, 1, 2])).toBe(idSetHash([1, 2, 2, 3]));
    expect(idSetHash([1, 2])).not.toBe(idSetHash([1, 3]));
    expect(idSetHash([1, 2])).toMatch(/^[a-f0-9]{16}$/);
    expect(() => idSetHash([0])).toThrow(RangeError);
  });

  it("names the vendor, store, kind and set so a retried pass replays rather than repeats", () => {
    const hash = idSetHash([11, 12]);
    expect(costChangeRepriceIdempotencyKey({ vendorId: 5, storeConnectionId: 9, entryIds: [12, 11] })).toBe(`dropship-cost-change-reprice:5:9:${hash}`);
    expect(costChangeHoldIdempotencyKey({ storeConnectionId: 9, entryIds: [11, 12], productVariantIds: [66] }))
      .toBe(`dropship-cost-change-hold:9:${hash}:${idSetHash([66])}`);
    expect(costChangeReleaseIdempotencyKey({ storeConnectionId: 9, holdIds: [4] })).toBe(`dropship-cost-change-release:9:${idSetHash([4])}`);
    expect(costChangeListingNoticeIdempotencyKey({ vendorId: 5, kind: "paused", ids: [11, 12] })).toBe(`dropship-cost-change-listings:5:paused:${hash}`);
    expect(() => costChangeRepriceIdempotencyKey({ vendorId: 0, storeConnectionId: 9, entryIds: [1] })).toThrow(RangeError);
  });
});

describe("decideQueuedRulePricePublication", () => {
  it("holds back a rule price that moved since queueing only under wait_for_review", () => {
    expect(decideQueuedRulePricePublication({ rulePriced: true, queuedPriceCents: 1152, currentPriceCents: 1399, rulePricedListings: "wait_for_review" }))
      .toEqual({ publish: false, reason: "awaiting_review" });
    expect(decideQueuedRulePricePublication({ rulePriced: true, queuedPriceCents: 1152, currentPriceCents: 1399, rulePricedListings: "reprice_automatically" }))
      .toEqual({ publish: true });
    expect(decideQueuedRulePricePublication({ rulePriced: true, queuedPriceCents: 1399, currentPriceCents: 1399, rulePricedListings: "wait_for_review" }))
      .toEqual({ publish: true });
    expect(decideQueuedRulePricePublication({ rulePriced: false, queuedPriceCents: 1152, currentPriceCents: 1399, rulePricedListings: "wait_for_review" }))
      .toEqual({ publish: true });
    expect(() => decideQueuedRulePricePublication({ rulePriced: true, queuedPriceCents: 0, currentPriceCents: 1399, rulePricedListings: "wait_for_review" }))
      .toThrow(RangeError);
  });
});
