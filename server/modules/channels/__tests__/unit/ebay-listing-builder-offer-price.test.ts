/**
 * The eBay offer's price strings come from integer cents (S4): the same
 * strings as before for whole, non-negative cents, and a build error naming
 * the SKU for an amount that is not whole, non-negative cents.
 */

import { describe, expect, it } from "vitest";
import { EbayListingBuilder } from "../../adapters/ebay/ebay-listing-builder";
import type { ChannelListingPayload, ChannelVariantPayload } from "../../channel-adapter.interface";

const CONFIG = {
  merchantLocationKey: "test-warehouse",
  listingPolicies: { paymentPolicyId: "pay-1", returnPolicyId: "ret-1", fulfillmentPolicyId: "ful-1" },
  marketplaceId: "EBAY_US",
};

function listingWith(prices: Pick<ChannelVariantPayload, "priceCents" | "compareAtPriceCents">): ChannelListingPayload {
  return {
    productId: 42,
    title: "Card Shellz 35pt Toploaders",
    description: "Toploaders for standard trading cards.",
    category: "Toploaders",
    tags: [],
    status: "active",
    variants: [{
      variantId: 101,
      sku: "CS-TL35-P25",
      name: "25 Pack",
      barcode: null,
      gtin: null,
      mpn: "CS-TL35",
      weightGrams: 120,
      isListed: true,
      externalVariantId: null,
      externalInventoryItemId: null,
      ...prices,
    }],
    images: [],
  };
}

function offerFor(prices: Pick<ChannelVariantPayload, "priceCents" | "compareAtPriceCents">) {
  const offers = new EbayListingBuilder().buildOffers(listingWith(prices), CONFIG);
  expect(offers).toHaveLength(1);
  return offers[0].payload;
}

describe("eBay offer price strings", () => {
  it.each([
    [0, "0.00"],
    [1, "0.01"],
    [99, "0.99"],
    [799, "7.99"],
    [1005, "10.05"],
    [16999, "169.99"],
    [1_000_000, "10000.00"],
    [Number.MAX_SAFE_INTEGER, "90071992547409.91"],
  ])("sends %i cents as %s", (cents, expected) => {
    expect(offerFor({ priceCents: cents, compareAtPriceCents: null }).pricingSummary.price)
      .toEqual({ value: expected, currency: "USD" });
  });

  it("sends a missing price as 0.00, as before", () => {
    expect(offerFor({ priceCents: null, compareAtPriceCents: null }).pricingSummary.price.value).toBe("0.00");
  });

  it("sends the compare-at price as the original retail price", () => {
    expect(offerFor({ priceCents: 799, compareAtPriceCents: 999 }).pricingSummary.originalRetailPrice)
      .toEqual({ value: "9.99", currency: "USD" });
  });

  it.each([null, 0])("sends no original retail price for a compare-at of %s, as before", (compareAtPriceCents) => {
    expect(offerFor({ priceCents: 799, compareAtPriceCents }).pricingSummary.originalRetailPrice).toBeUndefined();
  });

  it.each([
    ["a negative", -1],
    ["a fractional", 1234.5],
    ["a NaN", Number.NaN],
    ["an infinite", Number.POSITIVE_INFINITY],
    ["an unsafe (above 2^53)", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses %s price and names the SKU", (_label, priceCents) => {
    expect(() => offerFor({ priceCents, compareAtPriceCents: null }))
      .toThrow(/eBay offer priceCents must be whole, non-negative cents for SKU CS-TL35-P25/);
  });

  it.each([
    ["a negative", -999],
    ["a fractional", 999.5],
    ["an infinite", Number.POSITIVE_INFINITY],
  ])("refuses %s compare-at price and names the SKU", (_label, compareAtPriceCents) => {
    expect(() => offerFor({ priceCents: 799, compareAtPriceCents }))
      .toThrow(/eBay offer compareAtPriceCents must be whole, non-negative cents for SKU CS-TL35-P25/);
  });
});
