import { describe, expect, it } from "vitest";
import { ebayListingPushRequestSchema } from "../../../../modules/channels/ebay-listing-push.service";
import { normalizeEbayObservedOffers } from "../../ebay-listing-connector-client";

const preview = {
  productId: 20,
  groupKey: "provider-group",
  currentExternalListingId: "listing-20",
  sourceState: "active",
  currentSkus: ["PACK", "CASE"],
  activeSkus: ["PACK", "CASE"],
  inactiveSkus: [],
  desiredSkus: ["PACK"],
  addedSkus: [],
  removedSkus: ["CASE"],
  rebuildRequired: true,
  confirmationToken: "a".repeat(64),
};

// The shared application service owns this contract after route extraction.
// Mapping removal, rollback and concurrent edits run against real PostgreSQL in
// ebay-listing-push.integration.test.ts rather than matching SQL source text.
describe("eBay reviewed listing-change request contract", () => {
  it("accepts a read-only preview without accepting an unreviewed execution", () => {
    expect(ebayListingPushRequestSchema.parse({ productIds: [20], rebuild: { mode: "preview" } }).rebuild)
      .toEqual({ mode: "preview" });
    for (const field of ["rebuild", "updateExisting"]) {
      expect(ebayListingPushRequestSchema.safeParse({ productIds: [20], [field]: { mode: "execute" } }).success)
        .toBe(false);
    }
  });

  it.each(["active", "withdrawn"])("accepts a complete reviewed %s source for resumption", sourceState => {
    expect(ebayListingPushRequestSchema.safeParse({
      productIds: [20], rebuild: { mode: "execute", preview: { ...preview, sourceState } },
    }).success).toBe(true);
  });

  it("makes in-place update and replacement mutually exclusive", () => {
    expect(ebayListingPushRequestSchema.safeParse({
      productIds: [20], updateExisting: { mode: "execute", preview }, rebuild: { mode: "execute", preview },
    }).success).toBe(false);
  });

  it("binds an execution to exactly the reviewed product", () => {
    for (const productIds of [[21], [20, 21]]) {
      expect(ebayListingPushRequestSchema.safeParse({
        productIds, rebuild: { mode: "execute", preview },
      }).success).toBe(false);
    }
  });

  it("never adds destructive options to an ordinary publication request", () => {
    expect(ebayListingPushRequestSchema.parse({ productIds: [20] })).toEqual({ productIds: [20] });
    expect(ebayListingPushRequestSchema.safeParse({ productIds: [20], forceRebuild: true }).success).toBe(false);
  });

  it("normalizes the real nested eBay listing identity", () => {
    const [offer] = normalizeEbayObservedOffers({
      offers: [{
        offerId: "offer-c750", sku: "ARM-ENV-SGL-C750", status: "PUBLISHED", availableQuantity: 870,
        listing: { listingId: "298569307307", listingStatus: "ACTIVE" },
      }],
    });
    expect(offer).toMatchObject({
      offerId: "offer-c750", status: "PUBLISHED", listingId: "298569307307", availableQuantity: 870,
    });
  });
});
