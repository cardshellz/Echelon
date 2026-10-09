import { describe, expect, it } from "vitest";
import { findEbaySyncContentMismatch, syncContentIntentHash } from "../../ebay-listing-sync-content";
import { syncProviderFixture } from "../fixtures/ebay-listing-sync.fixture";

describe("eBay content intent and readback", () => {
  it("keeps ATP changes outside the content checkpoint without mutating drafts", async () => {
    const fixture = syncProviderFixture();
    const first = await fixture.prepare();
    const original = structuredClone(first.draft);
    fixture.setQuantity(0);
    const latest = await fixture.prepare();
    expect(syncContentIntentHash(latest.draft)).toBe(syncContentIntentHash(first.draft));
    expect(first.draft).toEqual(original);
  });
  it.each(["photo", "price", "policy", "members"])("invalidates an accepted checkpoint when %s changes", async field => {
    const { draft } = await syncProviderFixture().prepare();
    const changed = structuredClone(draft);
    if (field === "photo") changed.itemGroup!.payload.imageUrls = ["https://example.com/new.jpg"];
    if (field === "price") changed.offers[0].payload.pricingSummary.price.value = "11.50";
    if (field === "policy") changed.offers[0].payload.listingPolicies.returnPolicyId = "new-policy";
    if (field === "members") changed.itemGroup!.payload.variantSKUs = ["OTHER-SKU"];
    expect(syncContentIntentHash(changed)).not.toBe(syncContentIntentHash(draft));
  });
  it("treats group membership as unordered but preserves gallery order and exact member identity", () => {
    expect(findEbaySyncContentMismatch({ variantSKUs: ["B", "A"] }, { variantSKUs: ["A", "B"] })).toBeNull();
    expect(findEbaySyncContentMismatch({ variantSKUs: ["A", "A"] }, { variantSKUs: ["A", "B"] })).toBe("content.variantSKUs");
    expect(findEbaySyncContentMismatch({ imageUrls: ["b", "a"] }, { imageUrls: ["a", "b"] })).toBe("content.imageUrls");
  });
  it.each(["11.490", "11.499", "invalid"])("compares money %s exactly and reports only a field path", value => {
    expect(findEbaySyncContentMismatch({ price: { currency: "USD", value } }, { price: { currency: "USD", value: "11.49" } }))
      .toBe(value === "11.490" ? null : "content.price.value");
  });
});
