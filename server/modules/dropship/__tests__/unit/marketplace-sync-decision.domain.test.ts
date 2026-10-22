import { describe, expect, it } from "vitest";
import {
  parseMarketplaceListingObservation,
  sha256Hex,
  type MarketplaceListingObservation,
} from "../../domain/marketplace-listing-observation";
import {
  decideMarketplaceSync,
  decideVendorOwnedField,
  isLivePolicyIncompatibilityTolerated,
  keepVendorText,
  MARKETPLACE_ISSUE_CODES,
  MARKETPLACE_SYNC_NOTICE_KINDS,
  type FieldHistory,
  type MarketplaceIssueCode,
  type MarketplaceSyncInput,
  type MarketplaceSyncListingState,
} from "../../domain/marketplace-sync-decision";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";

const AT = new Date("2026-10-22T12:00:00.000Z");
const PUSHED_AT = new Date("2026-10-22T10:00:00.000Z");
const OUR_DESCRIPTION = "<p>Card Shellz toploaders.</p>";
const OUR_TITLE = "Card Shellz Toploaders 3x4 (100)";
/** What the newest completed push wrote (review OR-1: fingerprints): the fixture's own title and description. */
const LAST_SENT = { title: { baseline: sha256Hex(OUR_TITLE), attempted: [] as string[] },
  description: { baseline: sha256Hex(OUR_DESCRIPTION), attempted: [] as string[] } };
const NO_RECORD = { baseline: null, attempted: [] as string[] };
const PUSH = { kind: "push", relistAllowed: false, lastSentText: LAST_SENT } as const;
const VENDOR_PUSH = { kind: "push", relistAllowed: true, lastSentText: LAST_SENT } as const;

function observation(offer: Record<string, unknown> = rawOffer(), item: Record<string, unknown> = rawInventoryItem()): MarketplaceListingObservation {
  const parsed = parseMarketplaceListingObservation({ offer, inventoryItem: item, expectedOfferId: READ_OFFER_ID });
  if (parsed.kind !== "observed") throw new Error(`unreadable: ${parsed.reason}`);
  return parsed.observation;
}

function history<T>(baseline: T | null, attempted: T[] = []): FieldHistory<T> {
  return { baseline, attempted };
}

function listing(overrides: Partial<MarketplaceSyncListingState> = {}): MarketplaceSyncListingState {
  return {
    listingId: 77, itemLabel: "Toploaders 3x4 · 100 pack · CS-TOP-100", sku: READ_SKU, externalListingId: READ_LISTING_ID,
    status: "active", issueCodes: [], marketplaceEndedAt: null, latestPublishedQuantity: 10, ...overrides,
  };
}

/** A listing Card Shellz pushed at 11.00 with F-1/R-1/P-1, read back unchanged. */
function input(overrides: Partial<MarketplaceSyncInput> = {}): MarketplaceSyncInput {
  return {
    trigger: { kind: "sweep" },
    read: { kind: "observed", observation: observation() },
    observedAt: AT,
    listing: listing(),
    ours: { priceCents: history(1100), fulfillmentPolicyId: history("F-1"), returnPolicyId: history("R-1"), paymentPolicyId: history("P-1") },
    echelon: { priceCents: 1100, fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", unitCostCents: 700 },
    ...overrides,
  };
}

function withObservation(offer: Record<string, unknown>, item: Record<string, unknown> = rawInventoryItem(),
  overrides: Partial<MarketplaceSyncInput> = {}): MarketplaceSyncInput {
  return input({ read: { kind: "observed", observation: observation(offer, item) }, ...overrides });
}

function kinds(decision: ReturnType<typeof decideMarketplaceSync>): string[] {
  return decision.notices.map((notice) => notice.kind);
}

describe("decideVendorOwnedField (plan §4.1)", () => {
  it("V ∈ Ours (B): not a vendor change", () => {
    expect(decideVendorOwnedField({ observed: 1100, history: history(1100), echelon: 1200 })).toEqual({ kind: "unchanged" });
  });

  it("V ∈ Ours (an attempted value after B, a partial push): not a vendor change (FF-1)", () => {
    expect(decideVendorOwnedField({ observed: 1300, history: history(1100, [1300]), echelon: 1400 })).toEqual({ kind: "unchanged" });
  });

  it("V ∉ Ours and V = E: confirm", () => {
    expect(decideVendorOwnedField({ observed: 1400, history: history(1100), echelon: 1400 })).toEqual({ kind: "confirm" });
  });

  it("V ∉ Ours and V ≠ E: adopt; E also moved since B is said", () => {
    expect(decideVendorOwnedField({ observed: 1400, history: history(1100), echelon: 1100 })).toEqual({ kind: "adopt", echelonAlsoChanged: false });
    expect(decideVendorOwnedField({ observed: 1400, history: history(1100), echelon: 1200 })).toEqual({ kind: "adopt", echelonAlsoChanged: true });
  });

  it("with no record of what was sent: confirm when V = E, adopt otherwise, never 'E also moved'", () => {
    expect(decideVendorOwnedField({ observed: 1400, history: history<number>(null), echelon: 1400 })).toEqual({ kind: "confirm" });
    expect(decideVendorOwnedField({ observed: 1400, history: history<number>(null), echelon: 1100 })).toEqual({ kind: "adopt", echelonAlsoChanged: false });
  });

  it("with no Card Shellz value now: adopt", () => {
    expect(decideVendorOwnedField({ observed: "F-9", history: history<string>("F-1"), echelon: null }))
      .toEqual({ kind: "adopt", echelonAlsoChanged: true });
  });
});

describe("isLivePolicyIncompatibilityTolerated (SB10)", () => {
  const live = { effectivePolicyId: "F-9", observedPolicyId: "F-9", listingLive: true, issueCodes: ["international_direct_shipping_unsupported"] };
  it("tolerates the incompatible policy already live on this listing", () => {
    expect(isLivePolicyIncompatibilityTolerated(live)).toBe(true);
  });
  it.each([
    ["a policy Card Shellz would introduce", { observedPolicyId: "F-1" }],
    ["a listing not live", { listingLive: false }],
    ["a listing never read", { observedPolicyId: null }],
    ["a verdict that could not be verified", { issueCodes: ["verification_unavailable"] }],
  ])("never tolerates %s", (_name, change) => {
    expect(isLivePolicyIncompatibilityTolerated({ ...live, ...change })).toBe(false);
  });
});

describe("decideMarketplaceSync: a read with nothing new", () => {
  it("changes nothing, writes no event and no notice, and lets the push proceed with the read as its guard", () => {
    const decision = decideMarketplaceSync(input({ trigger: PUSH }));
    expect(decision).toMatchObject({ price: { kind: "unchanged" }, policies: { kind: "unchanged" },
      status: { endListing: false, reactivate: false, relink: null }, syncedBaseline: null, notices: [],
      issues: { add: [], remove: [], after: [] } });
    expect(decision.push).toEqual({
      kind: "proceed",
      guard: { offerId: READ_OFFER_ID, listingId: READ_LISTING_ID, priceCents: 1100, currency: "USD", fulfillmentPolicyId: "F-1",
        returnPolicyId: "R-1", paymentPolicyId: "P-1", bestOfferTermsHash: null, offerDescriptionHash: sha256Hex(OUR_DESCRIPTION),
        availableQuantity: 10 },
      liveFulfillmentPolicyId: "F-1",
      passthrough: { bestOfferTerms: null, title: null, description: null, carriedFingerprints: { title: null, description: null } },
    });
  });

  it("has no push decision on a sweep", () => {
    expect(decideMarketplaceSync(input()).push).toBeNull();
  });
});

describe("decideMarketplaceSync: identity (§4.2)", () => {
  it("flags a missing offer once, adopts nothing and stops pushes", () => {
    const first = decideMarketplaceSync(input({ read: { kind: "offer_missing" }, trigger: VENDOR_PUSH }));
    expect(first.issues).toEqual({ add: ["offer_missing"], remove: [], after: ["offer_missing"] });
    expect(kinds(first)).toEqual(["offer_missing"]);
    expect(first.notices[0]).toMatchObject({ critical: true });
    expect(first.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN" });
    const again = decideMarketplaceSync(input({ read: { kind: "offer_missing" }, listing: listing({ issueCodes: ["offer_missing"] }) }));
    expect(again.notices).toEqual([]);
    expect(again.issues.add).toEqual([]);
  });

  it("flags an unreadable answer for ops only, clears offer_missing (eBay answered) and stops pushes", () => {
    const decision = decideMarketplaceSync(input({ read: { kind: "unreadable", reason: "currency" },
      listing: listing({ issueCodes: ["offer_missing"] }), trigger: PUSH }));
    expect(decision.issues).toEqual({ add: ["observation_unreadable"], remove: ["offer_missing"], after: ["observation_unreadable"] });
    expect(decision.notices).toEqual([]);
    expect(decision.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN" });
  });

  it("flags a changed custom label once with both labels, adopts nothing and stops pushes", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ sku: "VENDOR-1", pricingSummary: { price: { value: "14.00", currency: "USD" } } }),
      rawInventoryItem(), { trigger: VENDOR_PUSH }));
    expect(decision.issues.add).toEqual(["sku_changed"]);
    expect(decision.price).toEqual({ kind: "unchanged" });
    expect(decision.syncedBaseline).toBeNull();
    expect(decision.notices).toEqual([expect.objectContaining({ kind: "sku_changed", critical: true,
      payload: expect.objectContaining({ ours: READ_SKU, theirs: "VENDOR-1" }) })]);
    expect(decision.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN" });
  });

  it.each([
    ["an inventory item group", rawOffer(), rawInventoryItem({ groupIds: ["G-1"] }), "group"],
    ["an auction format", rawOffer({ format: "AUCTION" }), rawInventoryItem(), "format"],
  ])("flags a variation listing (%s) and stops pushes (F9); the notice says why (OR-7)", (_name, offer, item, reason) => {
    const decision = decideMarketplaceSync(withObservation(offer, item, { trigger: VENDOR_PUSH }));
    expect(decision.issues.add).toEqual(["variation_listing_unsupported"]);
    expect(kinds(decision)).toEqual(["variation_unsupported"]);
    expect(decision.notices[0]?.payload).toMatchObject({ reason });
    expect(decision.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN" });
  });

  it("clears every identity issue a good read disproves", () => {
    const decision = decideMarketplaceSync(input({ listing: listing({
      issueCodes: ["sku_changed", "offer_missing", "variation_listing_unsupported", "observation_unreadable"] }) }));
    expect(decision.issues).toEqual({ add: [], after: [],
      remove: ["sku_changed", "offer_missing", "variation_listing_unsupported", "observation_unreadable"] });
  });
});

describe("decideMarketplaceSync: price (vendor-owned, §4.2)", () => {
  const vendorPrice = rawOffer({ pricingSummary: { price: { value: "14.00", currency: "USD" } } });

  it("adopts the vendor's eBay price and records the new baseline, with no notice (owner rule 7: no digest) (FF-5)", () => {
    const decision = decideMarketplaceSync(withObservation(vendorPrice));
    expect(decision.price).toEqual({ kind: "adopt", priceCents: 1400, echelonAlsoChanged: false, belowCost: false });
    expect(decision.syncedBaseline).toEqual({ priceCents: 1400, currency: "USD", sku: READ_SKU,
      fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" });
    expect(decision.notices).toEqual([]);
  });

  it("still adopts when the vendor's Card Shellz price also moved since B; eBay wins (D3)", () => {
    const decision = decideMarketplaceSync(withObservation(vendorPrice, rawInventoryItem(),
      { echelon: { ...input().echelon, priceCents: 1250 } }));
    expect(decision.price).toMatchObject({ kind: "adopt", priceCents: 1400, echelonAlsoChanged: true });
    expect(decision.notices).toEqual([]);
  });

  it("adopts a price below what Card Shellz charges and warns now, once per listing per UTC day (owner rule 7a)", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ pricingSummary: { price: { value: "6.50", currency: "USD" } } })));
    expect(decision.price).toEqual({ kind: "adopt", priceCents: 650, echelonAlsoChanged: false, belowCost: true });
    expect(decision.notices).toEqual([expect.objectContaining({ kind: "price_below_cost", critical: false,
      subjectKey: "below-cost:77:2026-10-22", payload: expect.objectContaining({ priceCents: 650, unitCostCents: 700 }) })]);
  });

  it("confirms a price Card Shellz already has, and clears a price-limit flag when the price is ours", () => {
    const confirmed = decideMarketplaceSync(withObservation(vendorPrice, rawInventoryItem(), { echelon: { ...input().echelon, priceCents: 1400 } }));
    expect(confirmed.price).toEqual({ kind: "confirm", priceCents: 1400 });
    expect(confirmed.notices).toEqual([]);
    expect(confirmed.syncedBaseline).toMatchObject({ priceCents: 1400 });
    const unchanged = decideMarketplaceSync(input({ listing: listing({ issueCodes: ["price_outside_card_shellz_limit"] }) }));
    expect(unchanged.issues.remove).toEqual(["price_outside_card_shellz_limit"]);
  });

  it("clears a price-limit flag when it adopts the vendor's price (W9 puts it back inside the transaction if it refuses)", () => {
    const decision = decideMarketplaceSync(withObservation(vendorPrice, rawInventoryItem(),
      { listing: listing({ issueCodes: ["price_outside_card_shellz_limit"] }) }));
    expect(decision.price).toMatchObject({ kind: "adopt", priceCents: 1400 });
    expect(decision.issues.remove).toEqual(["price_outside_card_shellz_limit"]);
    expect(decision.issues.after).toEqual([]);
  });

  it("does not adopt our own attempted price after a partial push (FF-1)", () => {
    const decision = decideMarketplaceSync(withObservation(vendorPrice, rawInventoryItem(),
      { ours: { ...input().ours, priceCents: history(1100, [1400]) }, echelon: { ...input().echelon, priceCents: 1500 } }));
    expect(decision.price).toEqual({ kind: "unchanged" });
  });
});

describe("decideMarketplaceSync: business policies (vendor-owned)", () => {
  it("adopts only the policy the vendor changed", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingPolicies:
      { fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1" } })));
    expect(decision.policies).toEqual({ kind: "adopt", changes: { fulfillmentPolicyId: "F-9" }, echelonAlsoChanged: false });
    expect(decision.syncedBaseline).toMatchObject({ fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1" });
    // Kept without a notice; only a policy Card Shellz cannot ship under is told, by the per-store check (owner rule 7b).
    expect(decision.notices).toEqual([]);
  });

  it("confirms a policy Card Shellz already moved to", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingPolicies:
      { fulfillmentPolicyId: "F-2", returnPolicyId: "R-1", paymentPolicyId: "P-1" } }), rawInventoryItem(),
    { echelon: { ...input().echelon, fulfillmentPolicyId: "F-2" } }));
    expect(decision.policies).toEqual({ kind: "confirm" });
    expect(decision.notices).toEqual([]);
  });
});

describe("title and description (owner rule 2: never ingested; a push keeps a vendor's edit)", () => {
  it("keepVendorText: the live value only when it differs from what Card Shellz last sent", () => {
    expect(keepVendorText("Vendor title", LAST_SENT.title)).toBe("Vendor title");
    expect(keepVendorText(OUR_TITLE, LAST_SENT.title)).toBeNull();
    // No record of what was sent, or nothing live: Card Shellz's value goes as today.
    expect(keepVendorText("Vendor title", NO_RECORD)).toBeNull();
    expect(keepVendorText(null, LAST_SENT.title)).toBeNull();
  });

  // Review OR-1: a push that wrote its refreshed text, or an attempt that may have written it, is Card Shellz's own.
  it("keepVendorText: any text Card Shellz wrote since its last completed push is its own, not the vendor's", () => {
    const sent = { baseline: sha256Hex("T2 (refreshed)"), attempted: [sha256Hex("T3 (attempted)")] };
    expect(keepVendorText("T2 (refreshed)", sent)).toBeNull();
    expect(keepVendorText("T3 (attempted)", sent)).toBeNull();
    expect(keepVendorText("T1 (queued, never sent)", sent)).toBe("T1 (queued, never sent)");
    expect(keepVendorText("T3 (attempted)", { baseline: null, attempted: [sha256Hex("T3 (attempted)")] })).toBeNull();
  });

  it("compares exactly: spacing, case and markup differences are the vendor's edit", () => {
    expect(keepVendorText(` ${OUR_TITLE}`, LAST_SENT.title)).toBe(` ${OUR_TITLE}`);
    expect(keepVendorText(OUR_TITLE.toUpperCase(), LAST_SENT.title)).toBe(OUR_TITLE.toUpperCase());
    expect(keepVendorText("<p><b>Card Shellz</b> toploaders.</p>", LAST_SENT.description)).toBe("<p><b>Card Shellz</b> toploaders.</p>");
  });

  it("a passed-through field carries Card Shellz's own fingerprint forward, so the vendor's text never becomes what Card Shellz sent", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer(), rawInventoryItem({}, { title: "Vendor title" }), { trigger: PUSH }));
    expect(decision.push).toMatchObject({ passthrough: { title: "Vendor title", description: null,
      carriedFingerprints: { title: sha256Hex(OUR_TITLE), description: null } } });
  });

  it("a push sends the vendor's edited title and description back unchanged (FF-14)", () => {
    const vendorHtml = '<p style="color:red">Vendor words <img src="x"></p>';
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingDescription: vendorHtml }),
      rawInventoryItem({}, { title: "Vendor title" }), { trigger: PUSH }));
    expect(decision.push).toMatchObject({ kind: "proceed",
      passthrough: { title: "Vendor title", description: vendorHtml }, guard: { offerDescriptionHash: sha256Hex(vendorHtml) } });
  });

  it("a push sends Card Shellz's current text when eBay still shows what Card Shellz last sent", () => {
    // A Card Shellz fix still reaches an untouched listing: the passthrough is null, so the refreshed intent goes.
    expect(decideMarketplaceSync(input({ trigger: PUSH })).push).toMatchObject({ passthrough: { title: null, description: null } });
  });

  it("keeps each field on its own: only the edited one is sent back", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer(), rawInventoryItem({}, { title: "Vendor title" }), { trigger: PUSH }));
    expect(decision.push).toMatchObject({ passthrough: { title: "Vendor title", description: null } });
  });

  it("compares the description eBay shows: the offer's, else the inventory item's", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingDescription: undefined }),
      rawInventoryItem({}, { description: "<p>Item words</p>" }), { trigger: PUSH }));
    expect(decision.push).toMatchObject({ passthrough: { description: "<p>Item words</p>" }, guard: { offerDescriptionHash: null } });
  });

  it("with no record of what was sent, sends Card Shellz's text as today", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingDescription: "<p>Other</p>" }),
      rawInventoryItem({}, { title: "Other" }), { trigger: { ...PUSH, lastSentText: { title: NO_RECORD, description: NO_RECORD } } }));
    expect(decision.push).toMatchObject({ passthrough: { title: null, description: null } });
  });

  it("a sweep read records nothing about the text: no event, issue or notice", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingDescription: "<p>Vendor words</p>" }),
      rawInventoryItem({}, { title: "Vendor title" })));
    expect(decision).toMatchObject({ syncedBaseline: null, notices: [], issues: { add: [], remove: [], after: [] }, push: null });
    expect(JSON.stringify({ ...decision, push: null })).not.toContain("Vendor");
  });
});

describe("photos, item specifics, condition and category (owner rule 3: not looked at)", () => {
  it("a read with other photos, item specifics, condition and category decides nothing and warns no one", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ categoryId: "999" }),
      rawInventoryItem({ condition: "USED_GOOD" }, { imageUrls: ["https://i.ebayimg.com/other.jpg"], aspects: { Brand: ["Other"] } }),
      { trigger: PUSH }));
    expect(decision).toMatchObject({ syncedBaseline: null, notices: [], issues: { add: [], remove: [], after: [] } });
    expect(decision.push).toMatchObject({ kind: "proceed" });
  });
});

describe("decideMarketplaceSync: ended, out of stock and relisted (SB7, SB8, SB9)", () => {
  const ended = (quantity: number) => rawOffer({ listing: { listingId: READ_LISTING_ID, listingStatus: "ENDED" }, availableQuantity: quantity });
  const itemAt = (quantity: number) => rawInventoryItem({ availability: { shipToLocationAvailability: { quantity } } });

  it("a stock-out end (eBay shows 0) keeps the status, flags ended_out_of_stock with no notice, and lets a push republish", () => {
    const decision = decideMarketplaceSync(withObservation(ended(0), itemAt(0), { trigger: PUSH }));
    expect(decision.status).toEqual({ endListing: false, reactivate: false, relink: null });
    expect(decision.issues.add).toEqual(["ended_out_of_stock"]);
    expect(decision.notices).toEqual([]);
    expect(decision.push?.kind).toBe("proceed");
  });

  it("is a stock-out end too when Card Shellz last published 0, even if eBay shows more", () => {
    const decision = decideMarketplaceSync(withObservation(ended(5), itemAt(5), { listing: listing({ latestPublishedQuantity: 0 }) }));
    expect(decision.issues.add).toEqual(["ended_out_of_stock"]);
    expect(decision.status.endListing).toBe(false);
  });

  it("a vendor end (stock on both sides) ends the listing and stops system pushes, but the vendor's own press relists", () => {
    const decision = decideMarketplaceSync(withObservation(ended(4), itemAt(4), { trigger: PUSH }));
    expect(decision.status).toEqual({ endListing: true, reactivate: false, relink: null });
    expect(decision.notices).toEqual([]);
    expect(decision.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_ENDED_ON_EBAY" });
    const relist = decideMarketplaceSync(withObservation(ended(4), itemAt(4), { trigger: VENDOR_PUSH }));
    expect(relist.push?.kind).toBe("proceed");
  });

  it("an unpublished offer is not live: the vendor's end when both sides have stock", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ status: "UNPUBLISHED", listing: undefined, listingPolicies: undefined }),
      rawInventoryItem()));
    expect(decision.status.endListing).toBe(true);
    expect(decision.policies).toEqual({ kind: "unchanged" });
  });

  it("an ended listing stays ended while eBay shows it ended, and refuses system pushes (SB8)", () => {
    const decision = decideMarketplaceSync(withObservation(ended(4), itemAt(4), {
      listing: listing({ status: "ended", marketplaceEndedAt: PUSHED_AT }), trigger: PUSH }));
    expect(decision.status).toEqual({ endListing: false, reactivate: false, relink: null });
    expect(decision.notices).toEqual([]);
    expect(decision.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_ENDED_ON_EBAY" });
  });

  it("follows a relist to the new item number, with no notice (SB6)", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listing: { listingId: "110000000999", listingStatus: "ACTIVE" } })));
    expect(decision.status.relink).toEqual({ previousListingId: READ_LISTING_ID, listingId: "110000000999" });
    expect(decision.notices).toEqual([]);
    expect(decision.syncedBaseline).not.toBeNull();
  });

  it("reopens a listing Card Shellz marked ended from a read when it is on sale again, following any new number", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listing: { listingId: "110000000999", listingStatus: "ACTIVE" } }),
      rawInventoryItem(), { listing: listing({ status: "ended", marketplaceEndedAt: PUSHED_AT }), trigger: PUSH }));
    expect(decision.status).toEqual({ endListing: false, reactivate: true,
      relink: { previousListingId: READ_LISTING_ID, listingId: "110000000999" } });
    expect(decision.push).toMatchObject({ kind: "proceed", guard: { listingId: "110000000999" } });
  });

  it("only flags a listing ended some other way (an end request) that is on sale again: never reopened or relinked here", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listing: { listingId: "110000000999", listingStatus: "ACTIVE" } }),
      rawInventoryItem(), { listing: listing({ status: "ended", marketplaceEndedAt: null }), trigger: PUSH }));
    expect(decision.status).toEqual({ endListing: false, reactivate: false, relink: null });
    expect(decision.issues.add).toEqual(["relisted_after_end"]);
    expect(decision.push).toEqual({ kind: "stop", code: "DROPSHIP_LISTING_ENDED_ON_EBAY" });
  });

  it("clears ended_out_of_stock and relisted_after_end once the listing is on sale under a read-ended or live status", () => {
    const decision = decideMarketplaceSync(input({ listing: listing({ issueCodes: ["ended_out_of_stock", "relisted_after_end"] }) }));
    expect(decision.issues.remove).toEqual(["ended_out_of_stock", "relisted_after_end"]);
  });
});

describe("decideMarketplaceSync: issue bookkeeping and Best Offer", () => {
  it("reports issues in the migration's code order and never touches quantity_restore_blocked", () => {
    const start: MarketplaceIssueCode[] = ["quantity_restore_blocked"];
    const decision = decideMarketplaceSync(withObservation(rawOffer({ sku: "OTHER" }), rawInventoryItem({ groupIds: ["G"] }),
      { listing: listing({ issueCodes: start }) }));
    expect(decision.issues.after).toEqual(["sku_changed", "variation_listing_unsupported", "quantity_restore_blocked"]);
    expect(MARKETPLACE_ISSUE_CODES.filter((code) => decision.issues.after.includes(code))).toEqual(decision.issues.after);
  });

  it("carries the vendor's Best Offer terms into the push and guards them by hash (SB25)", () => {
    const terms = { bestOfferEnabled: true, autoDeclinePrice: { value: "9.00", currency: "USD" } };
    const offer = rawOffer({ listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", bestOfferTerms: terms } });
    const decision = decideMarketplaceSync(withObservation(offer, rawInventoryItem(), { trigger: PUSH }));
    expect(decision.push).toMatchObject({ kind: "proceed", passthrough: { bestOfferTerms: terms },
      guard: { bestOfferTermsHash: observation(offer).bestOfferTermsHash } });
  });

  it("guards the offer description only when eBay sent it on the offer", () => {
    const decision = decideMarketplaceSync(withObservation(rawOffer({ listingDescription: undefined }), rawInventoryItem(),
      { trigger: PUSH }));
    expect(decision.push).toMatchObject({ kind: "proceed", guard: { offerDescriptionHash: null } });
  });
});

describe("vendor notice kinds (owner rule 7)", () => {
  it("are only a price below cost, an unshippable policy, a changed custom label, a listing Card Shellz can no longer update and the order-side events", () => {
    expect(Object.keys(MARKETPLACE_SYNC_NOTICE_KINDS).sort()).toEqual(
      ["offer_missing", "order_cancel_not_stopped", "order_cancel_refunded", "policy_incompatible", "price_below_cost", "sku_changed",
        "unknown_item_number", "variation_unsupported"]);
  });

  it("sends an eBay cancel Card Shellz could not stop even to a vendor who turned optional notices off (plan v4 §7.2)", () => {
    expect(MARKETPLACE_SYNC_NOTICE_KINDS.order_cancel_not_stopped.critical).toBe(true);
    expect(MARKETPLACE_SYNC_NOTICE_KINDS.order_cancel_refunded.critical).toBe(false);
    expect(MARKETPLACE_SYNC_NOTICE_KINDS.unknown_item_number.critical).toBe(false);
  });
});

describe("OR-3: the below-cost warning of an accepted order (plan v3 §7.4, owner rule 7a)", () => {
  it("is one notice per listing, under the listing's below-cost subject for the UTC day, in integer cents", async () => {
    const { orderBelowCostNotices } = await import("../../domain/marketplace-sync-decision");
    const at = new Date("2026-10-22T23:59:00.000Z");
    const notices = orderBelowCostNotices({ at, lines: [
      { listingId: 7, retailUnitPriceCents: 650, unitCostCents: 700, itemLabel: "Toploaders" },
      { listingId: 7, retailUnitPriceCents: 600, unitCostCents: 700, itemLabel: "Toploaders" },
      { listingId: 8, retailUnitPriceCents: 700, unitCostCents: 700, itemLabel: "At cost" },
    ] });
    expect(notices).toEqual([{ kind: "price_below_cost", critical: false, subjectKey: "below-cost:7:2026-10-22",
      payload: { listingId: 7, itemLabel: "Toploaders", priceCents: 600, unitCostCents: 700, source: "order" } }]);
  });
});
