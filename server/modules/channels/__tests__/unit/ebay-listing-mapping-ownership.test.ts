import { describe, expect, it, vi } from "vitest";
import { assertEbayMappingOwnership } from "../../infrastructure/ebay-listing-mapping-ownership";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

describe("unpublished eBay mapping ownership", () => {
  const identity = { ...syncIdentity, variants: [101, 102].map(variantId => ({ variantId, sku: `SKU-${variantId}`,
    externalSku: `SKU-${variantId}`, offerId: null, listingId: null })) };
  it("does not treat two missing offer IDs as a shared provider identity", async () => {
    const query = vi.fn(async () => ({ rows: identity.variants.map(member => ({ product_variant_id: member.variantId,
      external_sku: member.sku, external_variant_id: null, external_product_id: null })) }));
    await expect(assertEbayMappingOwnership(identity, { query } as never)).resolves.toBeUndefined();
  });
  it("still rejects an actual offer ID owned by the other selected variant", async () => {
    const target = { ...identity, variants: identity.variants.map(member => ({ ...member, offerId: member.variantId === 101 ? "offer-1" : null })) };
    const query = vi.fn(async () => ({ rows: [{ product_variant_id: 102, external_sku: "SKU-102", external_variant_id: "offer-1", external_product_id: null }] }));
    await expect(assertEbayMappingOwnership(target, { query } as never)).rejects.toMatchObject({ code: "EBAY_MAPPING_OWNERSHIP_CONFLICT" });
  });
  it("rejects a SKU mapped to a different product's variant", async () => {
    const query = vi.fn(async () => ({ rows: [{ product_variant_id: 999, external_sku: "SKU-101", external_variant_id: null, external_product_id: null }] }));
    await expect(assertEbayMappingOwnership(identity, { query } as never)).rejects.toMatchObject({ code: "EBAY_MAPPING_OWNERSHIP_CONFLICT" });
  });
});
