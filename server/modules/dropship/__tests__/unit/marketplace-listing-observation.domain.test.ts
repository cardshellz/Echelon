import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  parseEbayListingPriceCents,
  parseMarketplaceListingObservation,
  sha256Hex,
  type MarketplaceListingObservation,
} from "../../domain/marketplace-listing-observation";
import { rawInventoryItem, rawOffer, READ_LISTING_ID, READ_OFFER_ID, READ_SKU } from "../fixtures/ebay-sync-back-reads.fixture";

function observe(offer: Record<string, unknown> = rawOffer(), item: Record<string, unknown> = rawInventoryItem()): MarketplaceListingObservation {
  const parsed = parseMarketplaceListingObservation({ offer, inventoryItem: item, expectedOfferId: READ_OFFER_ID });
  if (parsed.kind !== "observed") throw new Error(`unreadable: ${parsed.reason}`);
  return parsed.observation;
}

function reason(offer: unknown, item: unknown = rawInventoryItem()): string {
  const parsed = parseMarketplaceListingObservation({ offer, inventoryItem: item, expectedOfferId: READ_OFFER_ID });
  return parsed.kind === "unreadable" ? parsed.reason : "observed";
}

describe("parseEbayListingPriceCents (plan §4.4: integer cents, USD only)", () => {
  it.each([
    ["11", 1100], ["11.5", 1150], ["11.50", 1150], ["0.01", 1], ["21474836.47", 2_147_483_647],
  ])("%s USD is %i cents", (value, cents) => {
    expect(parseEbayListingPriceCents({ value, currency: "USD" })).toEqual({ ok: true, cents });
  });

  it.each(["0", "0.00", "21474836.48", "99999999.99", "-1", "1e3", " 11.00", "11.000", "11.", ".50", "", "1,100.00", "123456789"])(
    "refuses %j as a price", (value) => {
      expect(parseEbayListingPriceCents({ value, currency: "USD" })).toEqual({ ok: false, reason: "price" });
    });

  it("refuses any currency but USD, whatever the value", () => {
    expect(parseEbayListingPriceCents({ value: "11.00", currency: "CAD" })).toEqual({ ok: false, reason: "currency" });
    expect(parseEbayListingPriceCents({ value: "11.00", currency: "usd" })).toEqual({ ok: false, reason: "currency" });
  });
});

describe("parseMarketplaceListingObservation", () => {
  it("reads a live published offer and its inventory item into the fields sync-back decides on", () => {
    const observation = observe();
    expect(observation).toMatchObject({
      offerId: READ_OFFER_ID, sku: READ_SKU, inventoryItemSku: READ_SKU, marketplaceId: "EBAY_US", format: "FIXED_PRICE",
      offerStatus: "PUBLISHED", listingId: READ_LISTING_ID, listingStatus: "ACTIVE", live: true, priceCents: 1100, currency: "USD",
      policies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1" },
      bestOfferTerms: null, bestOfferTermsHash: null, quantity: { offer: 10, inventoryItem: 10, observed: 10 },
      title: "Card Shellz Toploaders 3x4 (100)", description: "<p>Card Shellz toploaders.</p>",
      offerDescriptionHash: sha256Hex("<p>Card Shellz toploaders.</p>"), groupIds: [],
    });
    // Fields sync-back does not model are not kept: no photos, item specifics, condition or category (owner rule 3).
    const kept = JSON.stringify(observation);
    for (const unmodelled of ["cs-wh-1", "183454", "NEW", "i.ebayimg.com", "Brand"]) expect(kept).not.toContain(unmodelled);
  });

  it("takes Qe as the lower of the offer's and the item's quantities", () => {
    const observation = observe(rawOffer({ availableQuantity: 7 }), rawInventoryItem({ availability: { shipToLocationAvailability: { quantity: 4 } } }));
    expect(observation.quantity).toEqual({ offer: 7, inventoryItem: 4, observed: 4 });
  });

  it("is live only when published and ACTIVE or OUT_OF_STOCK", () => {
    expect(observe(rawOffer({ listing: { listingId: READ_LISTING_ID, listingStatus: "OUT_OF_STOCK" } })).live).toBe(true);
    for (const status of ["ENDED", "EBAY_ENDED", "INACTIVE", "NOT_LISTED"]) {
      expect(observe(rawOffer({ listing: { listingId: READ_LISTING_ID, listingStatus: status } })).live).toBe(false);
    }
    const unpublished = observe(rawOffer({ status: "UNPUBLISHED", listing: undefined, listingPolicies: undefined }));
    expect(unpublished).toMatchObject({ live: false, listingId: null, listingStatus: null,
      policies: { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null } });
  });

  it("treats an unknown status, or a published offer without one, as unreadable, never as ended (SB7)", () => {
    expect(reason(rawOffer({ listing: { listingId: READ_LISTING_ID, listingStatus: "SOMETHING_NEW" } }))).toBe("listing_status_unknown");
    expect(reason(rawOffer({ listing: { listingId: READ_LISTING_ID } }))).toBe("listing_status_unknown");
    expect(reason(rawOffer({ status: "PUBLISHED_LATER" }))).toBe("offer_status_unknown");
  });

  it.each([
    ["a missing offer field", rawOffer({ pricingSummary: undefined }), "offer_schema"],
    ["a fractional quantity", rawOffer({ availableQuantity: 1.5 }), "offer_schema"],
    ["a negative quantity", rawOffer({ availableQuantity: -1 }), "offer_schema"],
    ["an SKU with spaces", rawOffer({ sku: " CS-TOP-100" }), "offer_schema"],
    ["another offer's answer", rawOffer({ offerId: "OFFER-1" }), "offer_id_mismatch"],
    ["a non-USD price", rawOffer({ pricingSummary: { price: { value: "11.00", currency: "EUR" } } }), "currency"],
    ["a malformed price", rawOffer({ pricingSummary: { price: { value: "eleven", currency: "USD" } } }), "price"],
    ["a published offer missing a policy", rawOffer({ listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1" } }), "policies_missing"],
  ])("is unreadable on %s", (_name, offer, expected) => {
    expect(reason(offer)).toBe(expected);
  });

  it("is unreadable when the inventory item answer is not one", () => {
    expect(reason(rawOffer(), { sku: READ_SKU })).toBe("inventory_item_schema");
    expect(reason(rawOffer(), rawInventoryItem({ availability: { shipToLocationAvailability: { quantity: "4" } } }))).toBe("inventory_item_schema");
  });

  it("carries Best Offer terms opaque, hashed independent of key order, and bounded", () => {
    const terms = { bestOfferEnabled: true, autoAcceptPrice: { value: "10.00", currency: "USD" } };
    const reordered = { autoAcceptPrice: { currency: "USD", value: "10.00" }, bestOfferEnabled: true };
    const first = observe(rawOffer({ listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", bestOfferTerms: terms } }));
    const second = observe(rawOffer({ listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", bestOfferTerms: reordered } }));
    expect(first.bestOfferTerms).toEqual(terms);
    expect(first.bestOfferTermsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.bestOfferTermsHash).toBe(first.bestOfferTermsHash);
    const huge = { note: "x".repeat(5_000) };
    expect(reason(rawOffer({ listingPolicies: { fulfillmentPolicyId: "F-1", returnPolicyId: "R-1", paymentPolicyId: "P-1", bestOfferTerms: huge } })))
      .toBe("best_offer_terms");
  });

  it("prefers the offer's listing description and falls back to the item's (plan v4 §4.5); only the offer's is guarded", () => {
    const fromItem = observe(rawOffer({ listingDescription: undefined }), rawInventoryItem({}, { description: "<p>From the item.</p>" }));
    expect(fromItem).toMatchObject({ description: "<p>From the item.</p>", offerDescriptionHash: null });
    const none = observe(rawOffer({ listingDescription: undefined }), rawInventoryItem({}, { description: undefined }));
    expect(none.description).toBeNull();
    expect(observe(rawOffer(), rawInventoryItem({}, { title: undefined })).title).toBeNull();
  });

  it("keeps the live title and description exactly as eBay sent them: no trimming, sanitizing or length rule (owner rule 2)", () => {
    const html = '  <p style="color:red">Vendor <img src="x"> words</p><script>x</script>\n';
    const title = `  ${"T".repeat(200)}\t`;
    const observation = observe(rawOffer({ listingDescription: html }), rawInventoryItem({}, { title }));
    expect(observation.title).toBe(title);
    expect(observation.description).toBe(html);
    expect(observation.offerDescriptionHash).toBe(sha256Hex(html));
    const long = "a".repeat(1_000_001);
    expect(observe(rawOffer({ listingDescription: long })).description).toBe(long);
  });

  it("reports variation groups from either eBay field (F9)", () => {
    expect(observe(rawOffer(), rawInventoryItem({ groupIds: ["G-1"] })).groupIds).toEqual(["G-1"]);
    expect(observe(rawOffer(), rawInventoryItem({ inventoryItemGroupKeys: ["K-1"] })).groupIds).toEqual(["K-1"]);
  });
});

describe("canonicalJson", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
  });

  it("is null for values JSON cannot carry exactly", () => {
    expect(canonicalJson({ a: Number.NaN })).toBeNull();
    expect(canonicalJson({ a: Number.POSITIVE_INFINITY })).toBeNull();
    expect(canonicalJson({ a: () => 1 })).toBeNull();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(canonicalJson(cycle)).toBeNull();
  });
});
