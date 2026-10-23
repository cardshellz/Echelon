import { describe, expect, it } from "vitest";
import { decideMarketplaceSync, type MarketplaceSyncInput } from "../../domain/marketplace-sync-decision";
import { parseMarketplaceListingObservation } from "../../domain/marketplace-listing-observation";
import type { MarketplaceQuantityDecision, QuantityBaseline } from "../../domain/marketplace-quantity-decision";
import {
  decisionWithoutPriceAdoption,
  dropObservationWrites,
  isRepublishWanted,
  isStockOutEndProven,
  marketplacePublishBaseline,
  marketplaceSyncStoreListingCap,
  MARKETPLACE_SYNC_SWEPT_STATUSES,
  publishableQuantity,
  quantityDecisionWrites,
} from "../../domain/marketplace-sync-sweep";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";

const PUSHED = new Date("2026-10-22T09:00:00.000Z");
const SETTLED = new Date("2026-10-22T10:00:00.000Z");
const READ = new Date("2026-10-22T12:00:00.000Z");
const EXPECTED = { low: 10, high: 10 };

describe("the sweep's per-store read cap (plan v4 §6.2, SB14)", () => {
  it("reads at least 50 a tick, and a whole store in 24 ticks", () => {
    expect(marketplaceSyncStoreListingCap(0)).toBe(50);
    expect(marketplaceSyncStoreListingCap(100)).toBe(50);
    expect(marketplaceSyncStoreListingCap(1_200)).toBe(50);
    expect(marketplaceSyncStoreListingCap(1_201)).toBe(51);
    expect(marketplaceSyncStoreListingCap(10_000)).toBe(417);
    expect(marketplaceSyncStoreListingCap(-1)).toBe(50);
    expect(marketplaceSyncStoreListingCap(Number.NaN)).toBe(50);
  });

  it("reads listings for sale and those a read ended, never a never-published draft", () => {
    expect([...MARKETPLACE_SYNC_SWEPT_STATUSES]).toEqual(["active", "drift_detected", "queued", "failed", "blocked"]);
  });
});

describe("Card Shellz's quantity baseline B (plan v4 §6.4)", () => {
  const push = { pushedQuantity: 10, lastPushedAt: PUSHED, hasOpenPushItem: false };

  it("is the last completed push under legacy authority, never IP's figure", () => {
    expect(marketplacePublishBaseline({ authority: "legacy", push, published: { desiredQuantity: 4, settledAt: SETTLED } }))
      .toEqual({ quantity: 10, at: PUSHED, settled: true });
    expect(marketplacePublishBaseline({ authority: "legacy", push: { ...push, lastPushedAt: null }, published: null })).toBeNull();
  });

  it("is the newer of the push and IP's settled publish under canonical authority, so an IP publish never reads as the vendor's", () => {
    expect(marketplacePublishBaseline({ authority: "canonical", push, published: { desiredQuantity: 4, settledAt: SETTLED } }))
      .toEqual({ quantity: 4, at: SETTLED, settled: true });
    const pushedLater = { ...push, lastPushedAt: new Date(SETTLED.getTime() + 60_000) };
    expect(marketplacePublishBaseline({ authority: "canonical", push: pushedLater, published: { desiredQuantity: 4, settledAt: SETTLED } }))
      .toEqual({ quantity: 10, at: pushedLater.lastPushedAt, settled: true });
    expect(marketplacePublishBaseline({ authority: "canonical", push: { ...push, lastPushedAt: null }, published: { desiredQuantity: 4, settledAt: SETTLED } }))
      .toEqual({ quantity: 4, at: SETTLED, settled: true });
    expect(marketplacePublishBaseline({ authority: "canonical", push, published: null })).toEqual({ quantity: 10, at: PUSHED, settled: true });
  });

  it("is never settled while a write is in flight: IP's newest row not confirmed, or a push queued or running", () => {
    expect(marketplacePublishBaseline({ authority: "canonical", push, published: { desiredQuantity: 4, settledAt: null } }))
      .toMatchObject({ settled: false });
    expect(marketplacePublishBaseline({ authority: "canonical", push: { ...push, hasOpenPushItem: true },
      published: { desiredQuantity: 4, settledAt: SETTLED } })).toMatchObject({ settled: false });
    expect(marketplacePublishBaseline({ authority: "legacy", push: { ...push, hasOpenPushItem: true }, published: null }))
      .toMatchObject({ settled: false });
  });
});

describe("what a quantity decision writes (owner rule 1, plan v4 §6.4)", () => {
  it("publishes min(ATP, limit), ATP without a limit, never below 0", () => {
    expect(publishableQuantity(20, null)).toBe(20);
    expect(publishableQuantity(20, 5)).toBe(5);
    expect(publishableQuantity(3, 5)).toBe(3);
    expect(publishableQuantity(20, 0)).toBe(0);
    expect(publishableQuantity(-1, null)).toBe(0);
  });

  it("writes nothing while it waits for the order poll", () => {
    expect(quantityDecisionWrites({ kind: "wait", reason: "order_poll_behind" }, [])).toBeNull();
  });

  it("clears an observation nothing can be decided on, leaving an earlier blocked restore flagged", () => {
    expect(quantityDecisionWrites({ kind: "drop_observation", reason: "no_baseline" }, ["quantity_restore_blocked"]))
      .toEqual(dropObservationWrites());
    expect(dropObservationWrites()).toEqual({ limitChange: null, baseline: null, clearObservation: true, restore: "none",
      issues: { add: [], remove: [] } });
  });

  it("clears the observation and a blocked-restore flag when nothing changes", () => {
    expect(quantityDecisionWrites({ kind: "no_change", reason: "explained_by_sales", expected: EXPECTED }, ["quantity_restore_blocked"]))
      .toEqual({ limitChange: null, baseline: null, clearObservation: true, restore: "none",
        issues: { add: [], remove: ["quantity_restore_blocked"] } });
  });

  it("sets a limit with eBay's number as the new baseline, and lets the limit writer clear the observation", () => {
    const decision: MarketplaceQuantityDecision = { kind: "set_limit", limit: 4, previousLimit: null, baseline: { quantity: 4, at: READ },
      restore: null, expected: EXPECTED };
    expect(quantityDecisionWrites(decision, [])).toEqual({ limitChange: { kind: "set", limit: 4 }, baseline: { quantity: 4, at: READ },
      clearObservation: false, restore: "none", issues: { add: [], remove: [] } });
  });

  it("clears a limit and queues ATP back when the vendor set more than ATP", () => {
    const decision: MarketplaceQuantityDecision = { kind: "clear_limit", previousLimit: 5, baseline: null,
      restore: { quantity: 20, blocked: false }, expected: EXPECTED };
    expect(quantityDecisionWrites(decision, [])).toEqual({ limitChange: { kind: "clear" }, baseline: null, clearObservation: false,
      restore: "queue", issues: { add: [], remove: [] } });
  });

  it("queues a restore with the limit unchanged, and flags (staff only) a restore to 0 a push cannot send", () => {
    expect(quantityDecisionWrites({ kind: "restore", restore: { quantity: 3, blocked: false }, expected: EXPECTED }, []))
      .toMatchObject({ limitChange: null, clearObservation: true, restore: "queue" });
    expect(quantityDecisionWrites({ kind: "restore", restore: { quantity: 0, blocked: true }, expected: EXPECTED }, []))
      .toEqual({ limitChange: null, baseline: null, clearObservation: true, restore: "blocked",
        issues: { add: ["quantity_restore_blocked"], remove: [] } });
    expect(quantityDecisionWrites({ kind: "restore", restore: { quantity: 0, blocked: true }, expected: EXPECTED }, ["quantity_restore_blocked"]))
      .toMatchObject({ issues: { add: [], remove: [] } });
  });
});

describe("republishing a listing eBay ended for lack of stock (SB-C1)", () => {
  it("joins the restore push only while it is for sale in Card Shellz, proven ours, and has stock to publish", () => {
    const proven = { stockOutProven: true };
    expect(isRepublishWanted({ issuesAfter: ["ended_out_of_stock"], listingStatus: "active", publishableQuantity: 3, ...proven })).toBe(true);
    expect(isRepublishWanted({ issuesAfter: ["ended_out_of_stock"], listingStatus: "active", publishableQuantity: 0, ...proven })).toBe(false);
    expect(isRepublishWanted({ issuesAfter: ["ended_out_of_stock"], listingStatus: "ended", publishableQuantity: 3, ...proven })).toBe(false);
    expect(isRepublishWanted({ issuesAfter: ["ended_out_of_stock", "sku_changed"], listingStatus: "active", publishableQuantity: 3,
      ...proven })).toBe(false);
    expect(isRepublishWanted({ issuesAfter: [], listingStatus: "active", publishableQuantity: 3, ...proven })).toBe(false);
    // Review MS2: a 0 that is not Card Shellz's own settled 0 may be the vendor's end; the system never relists it.
    expect(isRepublishWanted({ issuesAfter: ["ended_out_of_stock"], listingStatus: "active", publishableQuantity: 3,
      stockOutProven: false })).toBe(false);
  });

  it("calls a 0 on eBay its own out-of-stock end only after Card Shellz's own settled 0 (review MS2)", () => {
    const at = new Date("2026-10-22T12:00:00.000Z");
    const before = new Date("2026-10-22T09:00:00.000Z");
    const proven = (observedQuantity: number, baseline: QuantityBaseline | null) => isStockOutEndProven({ observedQuantity, observedAt: at, baseline });
    expect(proven(0, { quantity: 0, at: before, settled: true })).toBe(true);
    expect(proven(0, { quantity: 0, at, settled: true })).toBe(true);
    expect(proven(0, { quantity: 0, at: new Date(at.getTime() + 1), settled: true })).toBe(false);
    expect(proven(0, { quantity: 0, at: before, settled: false })).toBe(false);
    expect(proven(0, { quantity: 10, at: before, settled: true })).toBe(false);
    expect(proven(0, null)).toBe(false);
    expect(proven(3, { quantity: 0, at: before, settled: true })).toBe(false);
  });
});

describe("a price W9 refused to keep (plan v4 §6.6)", () => {
  function decision(priceValue: string, overrides: Partial<MarketplaceSyncInput> = {}) {
    const parsed = parseMarketplaceListingObservation({ offer: rawOffer({ pricingSummary: { price: { value: priceValue, currency: "USD" } } }),
      inventoryItem: rawInventoryItem(), expectedOfferId: READ_OFFER_ID });
    if (parsed.kind !== "observed") throw new Error(parsed.reason);
    return decideMarketplaceSync({
      trigger: { kind: "sweep" }, read: { kind: "observed", observation: parsed.observation }, observedAt: READ,
      listing: { listingId: 77, itemLabel: "Toploaders", sku: READ_SKU, externalListingId: READ_LISTING_ID, status: "active", issueCodes: [],
        marketplaceEndedAt: null, latestPublishedQuantity: 10 },
      ours: { priceCents: { baseline: 1100, attempted: [] }, fulfillmentPolicyId: { baseline: "F-1", attempted: [] },
        returnPolicyId: { baseline: "R-1", attempted: [] }, paymentPolicyId: { baseline: "P-1", attempted: [] } },
      echelon: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", unitCostCents: 700 },
      ...overrides,
    });
  }

  it("flags a price outside a Card Shellz limit, keeps B for price and sends no below-cost notice", () => {
    const adopted = decision("6.50");
    expect(adopted.price).toMatchObject({ kind: "adopt", belowCost: true });
    const refused = decisionWithoutPriceAdoption(adopted, "outside_limit", { listingIssueCodes: [], oursPriceBaseline: 1100 });
    expect(refused.price).toEqual({ kind: "unchanged" });
    expect(refused.notices).toEqual([]);
    expect(refused.syncedBaseline).toMatchObject({ priceCents: 1100 });
    expect(refused.issues).toEqual({ add: ["price_outside_card_shellz_limit"], remove: [], after: ["price_outside_card_shellz_limit"] });
  });

  it("records no price as B when Card Shellz had none, so the stored intent stays its fallback", () => {
    const refused = decisionWithoutPriceAdoption(decision("6.50"), "outside_limit", { listingIssueCodes: [], oursPriceBaseline: null });
    expect(refused.syncedBaseline).toMatchObject({ priceCents: null });
  });

  it("changes no flag when the vendor or store may not change prices now (terminal), and keeps one already set", () => {
    const terminal = decisionWithoutPriceAdoption(decision("14.00"), "terminal", { listingIssueCodes: [], oursPriceBaseline: 1100 });
    expect(terminal.price).toEqual({ kind: "unchanged" });
    expect(terminal.issues.after).toEqual([]);
    const flagged = decision("14.00", { listing: { listingId: 77, itemLabel: "Toploaders", sku: READ_SKU, externalListingId: READ_LISTING_ID,
      status: "active", issueCodes: ["price_outside_card_shellz_limit"], marketplaceEndedAt: null, latestPublishedQuantity: 10 } });
    const kept = decisionWithoutPriceAdoption(flagged, "terminal", { listingIssueCodes: ["price_outside_card_shellz_limit"], oursPriceBaseline: 1100 });
    expect(kept.issues).toEqual({ add: [], remove: [], after: ["price_outside_card_shellz_limit"] });
  });
});
