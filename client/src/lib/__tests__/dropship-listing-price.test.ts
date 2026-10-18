import { describe, expect, it } from "vitest";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import { displayListingPrice, inheritedListingPrice, listingPriceEndpoint, listingPriceInput, parseListingPriceCents, readListingPrice,
  readSavedListingPrice } from "../dropship-listing-price";

const identity = { storeConnectionId: 12, productVariantId: 34 };
function price(): ListingPriceSetting {
  return { ...identity, revisionId: 9, overridePriceCents: 999, effectivePriceCents: 999,
    defaultPriceCents: 899, source: "override", updatedAt: "2026-09-06T12:00:00.000Z" };
}

describe("listing-price decimal boundary", () => {
  it.each([["8.99", 899], ["1", 100], ["1.2", 120], ["0.01", 1], [" 08.09 ", 809],
    ["21474836.47", 2147483647], ["0.29", 29]] as const)("parses %s into exact integer cents", (text, cents) => {
    expect(parseListingPriceCents(text)).toBe(cents);
  });
  it.each(["", " ", "0", "0.00", "-1", "+1", "1.001", "1e3", "1,000", "$8.99", ".99", "9.",
    "Infinity", "NaN", "21474836.48", "9999999999999999999999999999999999999", "0x10"])("rejects %s without rounding", (text) => {
    expect(() => parseListingPriceCents(text)).toThrow();
  });
  it("formats cents without treating an unavailable amount as zero", () => {
    expect(listingPriceInput(809)).toBe("8.09");
    expect(listingPriceInput(1)).toBe("0.01");
    expect(listingPriceInput(null)).toBe("");
    expect(displayListingPrice(null)).toBe("Unavailable");
    expect(displayListingPrice(999)).toBe("$9.99");
    expect(() => listingPriceInput(1.5)).toThrow();
  });
});

// The draft, retry-key, built-from and below-cost cases tested the per-size price editor's helpers, deleted with
// the editor in Listing settings PR 12. The two kept exports they also covered keep their assertions here.
describe("the price endpoint", () => {
  it("names one size of one store, and refuses an invalid identity", () => {
    expect(() => listingPriceEndpoint({ ...identity, storeConnectionId: 0 })).toThrow();
    expect(() => listingPriceEndpoint({ ...identity, productVariantId: 2147483648 })).toThrow();
    expect(listingPriceEndpoint(identity)).toBe("/api/dropship/listings/stores/12/variants/34/price");
  });
});

describe("what an inherit save would price a size at (A3, L1)", () => {
  it("says what an inherit save would price the size at: the rule price, else retail, else nothing", () => {
    expect(inheritedListingPrice({ rulePriceCents: 1152, defaultPriceCents: 899 })).toEqual({ priceCents: 1152, from: "rules" });
    expect(inheritedListingPrice({ rulePriceCents: null, defaultPriceCents: 899 })).toEqual({ priceCents: 899, from: "retail" });
    expect(inheritedListingPrice({ defaultPriceCents: 899 })).toEqual({ priceCents: 899, from: "retail" });
    expect(inheritedListingPrice({ rulePriceCents: null, defaultPriceCents: null })).toEqual({ priceCents: null, from: null });
  });
  it("says an inherit save takes the retail price when a blocking Card Shellz limit refuses the rule price (L1)", () => {
    // W9 names the refused rule price; the server then saves inherit at the retail price.
    expect(inheritedListingPrice({ rulePriceCents: 500, defaultPriceCents: 1200, pricingIssue: "pricing_rule_outside_limit" }))
      .toEqual({ priceCents: 1200, from: "retail" });
    expect(inheritedListingPrice({ rulePriceCents: 500, defaultPriceCents: null, pricingIssue: "pricing_rule_outside_limit" }))
      .toEqual({ priceCents: null, from: null });
    expect(inheritedListingPrice({ rulePriceCents: 500, defaultPriceCents: 1200, pricingIssue: null })).toEqual({ priceCents: 500, from: "rules" });
  });
});

describe("price response boundary", () => {
  it("validates reads and saves, including idempotent replays", () => {
    expect(readListingPrice({ price: price() }, identity)).toEqual(price());
    expect(readSavedListingPrice({ price: price(), idempotentReplay: true }, identity)).toEqual(price());
  });
  it("reads an inherit answer", () => {
    const inherit = { ...price(), overridePriceCents: null, effectivePriceCents: 899, source: "catalog_default" as const, pricingMode: "inherit" as const };
    expect(readListingPrice({ price: inherit }, identity)).toEqual(inherit);
  });
  it.each([{ storeConnectionId: 99 }, { productVariantId: 99 }, { effectivePriceCents: -1 },
    { revisionId: "9" }, { source: "guessed" }, { pricingMode: "auction" }, { extraSecret: "not allowed" }])("rejects mismatched or malformed responses %s", (change) => {
    expect(() => readListingPrice({ price: { ...price(), ...change } }, identity)).toThrow();
    expect(() => readSavedListingPrice({ price: { ...price(), ...change }, idempotentReplay: false }, identity)).toThrow();
  });
  it("requires the save replay indicator and does not accept a save response for a GET", () => {
    expect(() => readSavedListingPrice({ price: price() }, identity)).toThrow();
    expect(() => readListingPrice({ price: price(), idempotentReplay: true }, identity)).toThrow();
  });
});
