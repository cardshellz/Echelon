import { describe, expect, it } from "vitest";
import { buildEbayRouteListingDraft } from "../../ebay-listing-draft";
import { buildEbayListingPhotoPlan } from "../../ebay-listing-photos.domain";

function draft(shape: "standalone" | "group" | "one-member-group", mpn: string | null = null,
  aspects: Record<string, string[]> = { Brand: ["Shellz"] }) {
  const variants = Array.from({ length: shape === "group" ? 2 : 1 }, (_, index) => ({
    id: 101 + index, sku: `ITEM-${101 + index}`, name: `Pack ${index + 1}`, mpn,
    weight_grams: 120, price_cents: 1000,
  }));
  return buildEbayRouteListingDraft({ productId: 20,
    product: { name: "Catalog product", sku: "CATALOG-PRODUCT", description: "Current description" },
    variants, photoPlan: buildEbayListingPhotoPlan([], variants.map(variant => ({
      variantId: variant.id, sku: variant.sku, isListed: true,
    }))), aspects, isMultiVariant: shape !== "standalone",
    existingGroupKey: shape === "standalone" ? null : "CATALOG-PRODUCT",
    variationAspectName: shape === "standalone" ? "" : "Pack Size",
    variantPrices: new Map(variants.map(variant => [variant.id, 1000])),
    atpByVariantId: new Map(variants.map(variant => [variant.id, 7])),
    marketplaceId: "EBAY_US", ebayBrowseCategoryId: "183442",
    resolvedPoliciesByVariantId: new Map(variants.map(variant => [variant.id, {
      fulfillmentPolicyId: "shipping", returnPolicyId: "returns", paymentPolicyId: "payment",
    }])), storeCategoryNames: [], merchantLocationKey: "HQ",
  });
}

describe("eBay identifier encoding from canonical variants", () => {
  it.each(["standalone", "group", "one-member-group"] as const)(
    "keeps Brand as an item specific without an incomplete native pair for %s", shape => {
      for (const mpn of [null, "", "   "]) {
        const result = draft(shape, mpn);
        for (const item of result.inventoryItems) {
          expect(item.payload.product.aspects?.Brand).toEqual(["Shellz"]);
          expect(item.payload.product).not.toHaveProperty("brand");
          expect(item.payload.product).not.toHaveProperty("mpn");
          expect(item.payload.product.aspects).not.toHaveProperty("MPN");
        }
        expect(Boolean(result.itemGroup)).toBe(shape !== "standalone");
      }
    });

  it.each(["standalone", "group", "one-member-group"] as const)(
    "preserves an actual catalog MPN in a complete native pair for %s", shape => {
      const result = draft(shape, " PART-123 ");
      for (const item of result.inventoryItems) {
        expect(item.payload.product).toMatchObject({ brand: "Shellz", mpn: "PART-123",
          aspects: { Brand: ["Shellz"], MPN: ["PART-123"] } });
      }
    });

  it("does not emit a native MPN when the resolved brand is empty", () => {
    const product = draft("standalone", "PART-123", { Brand: [] }).inventoryItems[0].payload.product;
    expect(product.aspects?.MPN).toEqual(["PART-123"]);
    expect(product).not.toHaveProperty("brand");
    expect(product).not.toHaveProperty("mpn");
  });

  it("retains explicitly saved item specifics without inventing a canonical MPN or mutating inputs", () => {
    const aspects = { Brand: ["Shellz"], MPN: ["ASPECT-PART"] };
    const before = structuredClone(aspects);
    const product = draft("standalone", null, aspects).inventoryItems[0].payload.product;
    expect(product.aspects?.MPN).toEqual(["ASPECT-PART"]);
    expect(product).not.toHaveProperty("brand");
    expect(product).not.toHaveProperty("mpn");
    expect(aspects).toEqual(before);
  });
});
