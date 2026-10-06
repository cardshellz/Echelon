import { describe, expect, it } from "vitest";
import { refuseListingPriceSave } from "../../domain/listing-price-save-guard";

const usable = { priceCents: 1499, blockers: [] };
const blocked = { priceCents: 999, blockers: ["pricing:below_floor:policy_12"] };
const missing = { priceCents: null, blockers: ["vendor_retail_price_required"] };

describe("refuseListingPriceSave", () => {
  it.each([
    { name: "a typed price outside a blocking limit", before: usable, after: { ...blocked, typed: true }, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" },
    { name: "a typed price outside a limit on a size that had none", before: missing, after: { ...blocked, typed: true }, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" },
    { name: "a usable price left with no price", before: usable, after: { ...missing, typed: false }, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" },
    { name: "a usable price moved outside a limit", before: usable, after: { ...blocked, typed: false }, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" },
    { name: "a usable price moved to another usable one", before: usable, after: { priceCents: 1299, blockers: [], typed: false }, refusal: null },
    { name: "a typed usable price", before: missing, after: { priceCents: 1299, blockers: [], typed: true }, refusal: null },
    { name: "a size with no price that stays without one", before: missing, after: { ...missing, typed: false }, refusal: null },
    { name: "a blocked size moved to another blocked price it did not type", before: blocked, after: { ...blocked, priceCents: 899, typed: false }, refusal: null },
    { name: "a blocked size given a usable price", before: blocked, after: { priceCents: 1299, blockers: [], typed: false }, refusal: null },
  ] as const)("$name", ({ before, after, refusal }) => {
    expect(refuseListingPriceSave({ before, after })).toBe(refusal);
  });

  it("treats a missing price as unusable even when no blocker names it", () => {
    expect(refuseListingPriceSave({ before: usable, after: { priceCents: null, blockers: [], typed: false } }))
      .toBe("DROPSHIP_LISTING_PRICE_WOULD_BE_LOST");
    expect(refuseListingPriceSave({ before: { priceCents: null, blockers: [] }, after: { priceCents: null, blockers: [], typed: false } }))
      .toBeNull();
  });
});
