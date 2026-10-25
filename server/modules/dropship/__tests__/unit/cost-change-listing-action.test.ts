import { describe, expect, it } from "vitest";
import {
  COST_ACTIONABLE_LISTING_STATUSES,
  classifyCostChangeListingPrice,
  costChangeHoldIdempotencyKey,
  costChangeListingFollowUpNoticeIdempotencyKey,
  costChangeListingNoticeIdempotencyKey,
  costChangeRecheckHoldIdempotencyKey,
  costChangeRecheckRepriceIdempotencyKey,
  costChangeReleaseIdempotencyKey,
  costChangeRepriceIdempotencyKey,
  decideCostChangeHoldRelease,
  decideCostChangeListingAction,
  decideQueuedRulePricePublication,
  idSetHash,
  judgeAgainstPublishedPrice,
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
      saved: null, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: null,
    })).toEqual({ source: "saved_listing", priceCents: 999, followsCost: false });
    expect(classifyCostChangeListingPrice({
      saved: { overridePriceCents: null, pricingMode: "catalog_default" }, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: null,
    })).toEqual({ source: "catalog_default", priceCents: 899, followsCost: false });
  });

  it("lets the rules price a listing whose only price was saved by an earlier push", () => {
    expect(classifyCostChangeListingPrice({
      saved: null, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1152, basis: "product_cost" },
    })).toEqual({ source: "rules_cost", priceCents: 1152, followsCost: true });
  });

  it("classifies an inherit listing by the rules when they give a price, else at retail (A3, L1)", () => {
    const inherit = { overridePriceCents: null, pricingMode: "inherit" as const };
    expect(classifyCostChangeListingPrice({
      saved: inherit, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1152, basis: "product_cost" },
    })).toEqual({ source: "rules_cost", priceCents: 1152, followsCost: true });
    expect(classifyCostChangeListingPrice({
      saved: inherit, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: 1099, basis: "catalog_retail" },
    })).toEqual({ source: "rules_retail", priceCents: 1099, followsCost: false });
    // No rules: the retail price, not the $9.99 an earlier push saved.
    expect(classifyCostChangeListingPrice({ saved: inherit, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: null }))
      .toEqual({ source: "catalog_default", priceCents: 899, followsCost: false });
    // Rules that can't price it (no cost on file): retail too, so the cost does not decide its price.
    expect(classifyCostChangeListingPrice({
      saved: inherit, existingListingPriceCents: 999, defaultPriceCents: 899, rulePrice: { priceCents: null, basis: "product_cost" },
    })).toEqual({ source: "catalog_default", priceCents: 899, followsCost: false });
    expect(classifyCostChangeListingPrice({ saved: inherit, existingListingPriceCents: 999, defaultPriceCents: null, rulePrice: null }))
      .toEqual({ source: "unavailable", priceCents: null, followsCost: false });
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
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: rulesOnCost, unitCostCents: 999, settings })).toBe("reprice_queued");
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: rulesOnCost, unitCostCents: 999,
      settings: { ...settings, rulePricedListings: "wait_for_review" } })).toBe("awaiting_review");
  });

  it("judges every other price against the cost per unit, and acts on an under-water one as the policy says", () => {
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(999), unitCostCents: 999, settings })).toBe("price_covers_cost");
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(998), unitCostCents: 999, settings })).toBe("below_cost_warned");
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(998), unitCostCents: 999,
      settings: { ...settings, belowCostFixedListings: "no_action" } })).toBe("below_cost_recorded");
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(998), unitCostCents: 999,
      settings: { ...settings, belowCostFixedListings: "pause_listing" } })).toBe("below_cost_paused");
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: { source: "rules_retail", priceCents: 500, followsCost: false },
      unitCostCents: 999, settings })).toBe("below_cost_warned");
  });

  it("leaves a listing that is not live, or whose price is unknown, alone", () => {
    expect(COST_ACTIONABLE_LISTING_STATUSES).toEqual(["active"]);
    for (const status of ["preview_ready", "queued", "pushing", "paused", "ended", "failed", "blocked", "drift_detected", "not_listed"]) {
      expect(decideCostChangeListingAction({ listingStatus: status, externalListingId: null, price: rulesOnCost, unitCostCents: 999, settings })).toBe("skipped_inactive_listing");
    }
    expect(decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(null), unitCostCents: 999, settings })).toBe("skipped_price_unavailable");
  });

  it("acts on a listing being re-sent that eBay still lists (review MC1): the push-progress statuses with a listing id", () => {
    // Orders on these listings are accepted (order-listing-acceptability.ts), so their cost protection must hold too.
    for (const status of ["queued", "pushing", "failed", "blocked"]) {
      expect(decideCostChangeListingAction({ listingStatus: status, externalListingId: "v1|1234|0", price: rulesOnCost, unitCostCents: 999,
        settings })).toBe("reprice_queued");
      expect(decideCostChangeListingAction({ listingStatus: status, externalListingId: "v1|1234|0", price: fixed(998), unitCostCents: 999,
        settings: { ...settings, belowCostFixedListings: "pause_listing" } })).toBe("below_cost_paused");
      // A blank id, or none, is no listing on eBay: left alone as before.
      for (const externalListingId of [null, "", "   "]) {
        expect(decideCostChangeListingAction({ listingStatus: status, externalListingId, price: rulesOnCost, unitCostCents: 999, settings }))
          .toBe("skipped_inactive_listing");
      }
    }
    // Statuses outside push progress keep their earlier meaning, with an id or not (not changed by publish runs).
    for (const status of ["ended", "not_listed", "preview_ready", "paused", "drift_detected"]) {
      expect(decideCostChangeListingAction({ listingStatus: status, externalListingId: "v1|1234|0", price: rulesOnCost, unitCostCents: 999,
        settings })).toBe("skipped_inactive_listing");
    }
  });

  it("refuses a cost or price that is not positive whole cents", () => {
    expect(() => decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(999), unitCostCents: 0, settings })).toThrow(RangeError);
    expect(() => decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(999), unitCostCents: 9.99, settings })).toThrow(RangeError);
    expect(() => decideCostChangeListingAction({ listingStatus: "active", externalListingId: null, price: fixed(-1), unitCostCents: 999, settings })).toThrow(RangeError);
  });
});

describe("decideCostChangeHoldRelease", () => {
  it("releases a hold once the price buyers see covers the cost in force, or the listing is no longer live", () => {
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 999, publishedPriceCents: 999, costInForceCents: 999 })).toBe("price_covers_cost");
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 998, publishedPriceCents: 999, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "ended", externalListingId: null, priceCents: 1, publishedPriceCents: null, costInForceCents: 999 })).toBe("listing_inactive");
  });

  it("keeps the hold while a covering price is saved or queued but not yet published, or a lower one is queued over it", () => {
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 1500, publishedPriceCents: 899, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 899, publishedPriceCents: 1500, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 1500, publishedPriceCents: 1500, costInForceCents: 999 })).toBe("price_covers_cost");
  });

  it("keeps the hold when the price, the published price or the cost is unknown", () => {
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: null, publishedPriceCents: 999, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 999, publishedPriceCents: null, costInForceCents: 999 })).toBeNull();
    expect(decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 999, publishedPriceCents: 999, costInForceCents: null })).toBeNull();
    expect(() => decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 0, publishedPriceCents: 999, costInForceCents: 999 })).toThrow(RangeError);
    expect(() => decideCostChangeHoldRelease({ listingStatus: "active", externalListingId: null, priceCents: 999, publishedPriceCents: -1, costInForceCents: 999 })).toThrow(RangeError);
  });

  it("keeps a below-cost hold while eBay still lists a listing that is being re-sent (review MC1)", () => {
    for (const status of ["queued", "pushing", "failed", "blocked"]) {
      expect(decideCostChangeHoldRelease({ listingStatus: status, externalListingId: "v1|1234|0", priceCents: 998, publishedPriceCents: 998, costInForceCents: 999 }))
        .toBeNull();
      // The price that covers the cost is only Echelon's intent until a push completes: eBay may still show the old
      // one, and orders are taken there (review round 2 MC2). The hold stays until the listing is active again.
      expect(decideCostChangeHoldRelease({ listingStatus: status, externalListingId: "v1|1234|0", priceCents: 999, publishedPriceCents: 999, costInForceCents: 999 }))
        .toBeNull();
      expect(decideCostChangeHoldRelease({ listingStatus: status, externalListingId: "v1|1234|0", priceCents: 5_000, publishedPriceCents: 5_000, costInForceCents: 999 }))
        .toBeNull();
      expect(decideCostChangeHoldRelease({ listingStatus: status, externalListingId: null, priceCents: 998, publishedPriceCents: 998, costInForceCents: 999 }))
        .toBe("listing_inactive");
    }
  });
});

describe("judgeAgainstPublishedPrice", () => {
  it("judges a live listing at the lower of its settings price and its published price", () => {
    expect(judgeAgainstPublishedPrice(fixed(1500), 899)).toEqual(fixed(899));
    expect(judgeAgainstPublishedPrice(fixed(899), 1500)).toEqual(fixed(899));
    expect(judgeAgainstPublishedPrice(fixed(1500), 1500)).toEqual(fixed(1500));
  });

  it("leaves the price as it is with no published price on record, no settings price, or a rule price that follows the cost", () => {
    expect(judgeAgainstPublishedPrice(fixed(1500), null)).toEqual(fixed(1500));
    expect(judgeAgainstPublishedPrice(fixed(null), 899)).toEqual(fixed(null));
    expect(judgeAgainstPublishedPrice(rulesOnCost, 899)).toEqual(rulesOnCost);
    expect(() => judgeAgainstPublishedPrice(fixed(1500), 0)).toThrow(RangeError);
    expect(() => judgeAgainstPublishedPrice(fixed(1500), 899.5)).toThrow(RangeError);
  });

  it("never changes the classification it is given", () => {
    const price = fixed(1500);
    judgeAgainstPublishedPrice(price, 899);
    expect(price).toEqual(fixed(1500));
  });
});

describe("follow-up idempotency keys", () => {
  it("keys a recheck's sends by the skipped actions, apart from any first decision's keys", () => {
    const hash = idSetHash([3, 4]);
    expect(costChangeRecheckRepriceIdempotencyKey({ vendorId: 5, storeConnectionId: 9, actionIds: [4, 3] })).toBe(`dropship-cost-change-reprice:recheck:5:9:${hash}`);
    expect(costChangeRecheckHoldIdempotencyKey({ storeConnectionId: 9, actionIds: [3, 4], productVariantIds: [61] }))
      .toBe(`dropship-cost-change-hold:recheck:9:${hash}:${idSetHash([61])}`);
    expect(costChangeRecheckRepriceIdempotencyKey({ vendorId: 5, storeConnectionId: 9, actionIds: [3, 4] }))
      .not.toBe(costChangeRepriceIdempotencyKey({ vendorId: 5, storeConnectionId: 9, entryIds: [3, 4] }));
  });

  it("keeps a recheck's and a put-back pause's notices apart from the first notices, even for the same ids", () => {
    const first = costChangeListingNoticeIdempotencyKey({ vendorId: 5, kind: "paused", ids: [7] });
    const recheck = costChangeListingFollowUpNoticeIdempotencyKey({ vendorId: 5, kind: "paused", basis: "recheck", ids: [7] });
    const restored = costChangeListingFollowUpNoticeIdempotencyKey({ vendorId: 5, kind: "paused", basis: "restored_hold", ids: [7] });
    expect(new Set([first, recheck, restored]).size).toBe(3);
    expect(restored).toBe(`dropship-cost-change-listings:5:paused:restored_hold:${idSetHash([7])}`);
    expect(() => costChangeListingFollowUpNoticeIdempotencyKey({ vendorId: 0, kind: "paused", basis: "recheck", ids: [7] })).toThrow(RangeError);
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
