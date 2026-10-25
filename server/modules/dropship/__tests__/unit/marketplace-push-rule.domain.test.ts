import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import { decideListingPushTransientPause, PAUSABLE_LISTING_PUSH_CODES } from "../../domain/listing-push-run";
import {
  observedOfferGuardFields,
  parseMarketplaceListingObservation,
  sha256Hex,
} from "../../domain/marketplace-listing-observation";
import { isVendorRelistAllowed, RELIST_ALLOWED_RESULT_FIELD } from "../../domain/marketplace-push-rule";
import { decideMarketplaceSync, marketplacePushGuardChanges, type MarketplacePushGuard } from "../../domain/marketplace-sync-decision";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../../domain/marketplace-sync-errors";
import { hasUnsettledPushAttempt, type MarketplaceSyncEvent } from "../../domain/marketplace-sync-history";
import { marketplacePublishBaseline } from "../../domain/marketplace-sync-sweep";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";

/**
 * eBay sync-back's push-time rule (plan v4 §5), its pure parts: the guard the
 * connector re-checks just before its first write (SB5), which items may relist
 * a listing the vendor ended (SB9), the pausable refusals (SB26), and when a
 * push attempt leaves Card Shellz's quantity unsettled.
 */
const AT = new Date("2026-10-22T12:00:00.000Z");

/** The guard a pre-read of `offer` answers (decision.ts decidePush). */
function guardFromPreRead(offer: Record<string, unknown> = rawOffer()): MarketplacePushGuard {
  const parsed = parseMarketplaceListingObservation({ offer, inventoryItem: rawInventoryItem(), expectedOfferId: READ_OFFER_ID });
  if (parsed.kind !== "observed") throw new Error(parsed.reason);
  const decision = decideMarketplaceSync({
    trigger: { kind: "push", relistAllowed: false, lastSentText: { title: { baseline: null, attempted: [] }, description: { baseline: null, attempted: [] } } },
    read: { kind: "observed", observation: parsed.observation }, observedAt: AT,
    listing: { listingId: 77, itemLabel: "Toploaders", sku: READ_SKU, externalListingId: READ_LISTING_ID, status: "active", issueCodes: [],
      marketplaceEndedAt: null, latestPublishedQuantity: 10 },
    ours: { priceCents: { baseline: 1100, attempted: [] }, fulfillmentPolicyId: { baseline: "F-1", attempted: [] },
      returnPolicyId: { baseline: "R-1", attempted: [] }, paymentPolicyId: { baseline: "P-1", attempted: [] } },
    echelon: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", unitCostCents: 700 },
  });
  if (decision.push?.kind !== "proceed") throw new Error("expected proceed");
  return decision.push.guard;
}

describe("the connector's last look before its first write (SB5)", () => {
  it("finds no change when the connector sees exactly the offer the pre-read saw", () => {
    expect(marketplacePushGuardChanges(guardFromPreRead(), rawOffer())).toEqual([]);
  });

  it("computes the offer's guard fields the way the pre-read's parser does", () => {
    const offer = rawOffer({ listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1",
      bestOfferTerms: { bestOfferEnabled: true } } });
    const guard = guardFromPreRead(offer);
    expect(observedOfferGuardFields(offer)).toEqual({ offerId: guard.offerId, listingId: guard.listingId, priceCents: guard.priceCents,
      currency: guard.currency, policies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" },
      bestOfferTermsHash: guard.bestOfferTermsHash, offerDescriptionHash: sha256Hex("<p>Card Shellz toploaders.</p>"), availableQuantity: 10 });
    expect(guard.bestOfferTermsHash).not.toBeNull();
  });

  it.each([
    ["a price edit", { pricingSummary: { price: { value: "14.00", currency: "USD" } } }, ["priceCents"]],
    ["a shipping policy edit", { listingPolicies: { fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1" } },
      ["fulfillmentPolicyId"]],
    ["a description edit (rule 2)", { listingDescription: "<p>Theirs</p>" }, ["offerDescriptionHash"]],
    ["new Best Offer terms", { listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1",
      bestOfferTerms: { bestOfferEnabled: true } } }, ["bestOfferTermsHash"]],
    ["a quantity edit or a sale", { availableQuantity: 7 }, ["availableQuantity"]],
    ["a relist under a new item number", { listing: { listingId: "110000000999", listingStatus: "ACTIVE" } }, ["listingId"]],
  ])("names %s made after the pre-read", (_name, patch, fields) => {
    expect(marketplacePushGuardChanges(guardFromPreRead(), rawOffer(patch))).toEqual(fields);
  });

  it("treats no offer, or one it cannot read, as changed", () => {
    expect(marketplacePushGuardChanges(guardFromPreRead(), null)).toEqual(["offer"]);
    expect(marketplacePushGuardChanges(guardFromPreRead(), { offerId: READ_OFFER_ID })).toEqual(["offer_unreadable"]);
    expect(observedOfferGuardFields({ offerId: READ_OFFER_ID })).toBeNull();
  });

  it("answers the live shipping policy only for a listing on sale (the live-policy rule, SB10)", () => {
    const parsed = parseMarketplaceListingObservation({ offer: rawOffer({ listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" } }),
      inventoryItem: rawInventoryItem(), expectedOfferId: READ_OFFER_ID });
    if (parsed.kind !== "observed") throw new Error(parsed.reason);
    const decision = decideMarketplaceSync({
      trigger: { kind: "push", relistAllowed: true, lastSentText: { title: { baseline: null, attempted: [] }, description: { baseline: null, attempted: [] } } },
      read: { kind: "observed", observation: parsed.observation }, observedAt: AT,
      listing: { listingId: 77, itemLabel: "Toploaders", sku: READ_SKU, externalListingId: READ_LISTING_ID, status: "active", issueCodes: [],
        marketplaceEndedAt: null, latestPublishedQuantity: 10 },
      ours: { priceCents: { baseline: 1100, attempted: [] }, fulfillmentPolicyId: { baseline: "F-1", attempted: [] },
        returnPolicyId: { baseline: "R-1", attempted: [] }, paymentPolicyId: { baseline: "P-1", attempted: [] } },
      echelon: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", unitCostCents: 700 },
    });
    expect(decision.push).toMatchObject({ kind: "proceed", liveFulfillmentPolicyId: null });
  });
});

describe("which items may relist a listing the vendor ended (SB9)", () => {
  it("allows only an item the vendor's own press queued, on its first send", () => {
    expect(isVendorRelistAllowed({ [RELIST_ALLOWED_RESULT_FIELD]: true })).toBe(true);
    expect(isVendorRelistAllowed({ [RELIST_ALLOWED_RESULT_FIELD]: true, transientPauses: 2 })).toBe(true);
  });

  it.each([
    ["an automatic or staff push", {}],
    ["a null result", null],
    ["a value that is not true", { [RELIST_ALLOWED_RESULT_FIELD]: "true" }],
    ["an item sent before (any terminal write records push)", { [RELIST_ALLOWED_RESULT_FIELD]: true, push: { status: "failed" } }],
    ["a stale recovery", { [RELIST_ALLOWED_RESULT_FIELD]: true, staleRecovery: { at: "2026-10-22T12:00:00Z" } }],
  ])("never allows %s", (_name, result) => {
    expect(isVendorRelistAllowed(result)).toBe(false);
  });
});

describe("pausable push-time refusals (SB26)", () => {
  it("pauses, never fails, each sync-back refusal raised before any eBay write", () => {
    expect([...PAUSABLE_LISTING_PUSH_CODES].sort()).toEqual([MARKETPLACE_SYNC_CODES.changedDuringPush, MARKETPLACE_SYNC_CODES.adoptionRetry,
      MARKETPLACE_SYNC_CODES.quantityPending].sort());
    for (const code of PAUSABLE_LISTING_PUSH_CODES) {
      expect(decideListingPushTransientPause(marketplaceSyncError(code, "wait", "transient"))).toEqual({ pause: true, reason: "marketplace_sync" });
    }
  });

  it("does not pause the push's permanent stops", () => {
    for (const code of [MARKETPLACE_SYNC_CODES.endedOnEbay, MARKETPLACE_SYNC_CODES.identityUnproven, MARKETPLACE_SYNC_CODES.nothingToCompare]) {
      expect(decideListingPushTransientPause(marketplaceSyncError(code, "stop", "permanent"))).toEqual({ pause: false });
    }
    expect(decideListingPushTransientPause(new DropshipError("DROPSHIP_LISTING_PUSH_FAILED", "x"))).toEqual({ pause: false });
  });
});

describe("a push attempt that never completed leaves the quantity unsettled (§6.4)", () => {
  const event = (id: number, eventType: string): MarketplaceSyncEvent => ({ id, eventType, payload: {}, createdAt: AT });

  it("is unsettled only by an attempt after the newest completed push", () => {
    expect(hasUnsettledPushAttempt([])).toBe(false);
    expect(hasUnsettledPushAttempt([event(1, "listing_push_completed")])).toBe(false);
    expect(hasUnsettledPushAttempt([event(1, "listing_push_attempted"), event(2, "listing_push_completed")])).toBe(false);
    expect(hasUnsettledPushAttempt([event(1, "listing_push_completed"), event(2, "listing_push_attempted")])).toBe(true);
    expect(hasUnsettledPushAttempt([event(2, "listing_marketplace_synced"), event(3, "listing_push_attempted")])).toBe(true);
    // A read's synced event does not settle an attempt: only a completed push proves what reached eBay.
    expect(hasUnsettledPushAttempt([event(1, "listing_push_completed"), event(2, "listing_push_attempted"),
      event(3, "listing_marketplace_synced")])).toBe(true);
  });

  it("gives an unsettled baseline, so no limit is made from Card Shellz's own unfinished write", () => {
    const push = { pushedQuantity: 10, lastPushedAt: AT, hasOpenPushItem: false };
    expect(marketplacePublishBaseline({ authority: "legacy", push, published: null })).toMatchObject({ quantity: 10, settled: true });
    expect(marketplacePublishBaseline({ authority: "legacy", push: { ...push, hasUnsettledAttempt: true }, published: null }))
      .toMatchObject({ quantity: 10, settled: false });
  });
});
