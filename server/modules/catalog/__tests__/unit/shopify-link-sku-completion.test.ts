import { describe, expect, it } from "vitest";
import { assertLinkSkuProgress, assertLinkSkusAvailable, planLinkSkuAssignments, shopifyConnectionRemoteFingerprint } from "../../shopify-link-sku-completion";
import { connectionSource, existingConnectionProduct } from "../support/shopify-product-connection.fixture";

function fixture() {
  const source = connectionSource(); const remote = existingConnectionProduct(source);
  remote.variants[0].sku = null; remote.variants[1].sku = "  ";
  const bindings = source.variants.map((variant, index) => ({ variantId: variant.id, remoteVariantId: remote.variants[index].id }));
  return { source, remote, bindings };
}

describe("reviewed Shopify SKU completion", () => {
  it("plans only blanks, uses channel overrides, and never mutates source evidence", () => {
    const f = fixture(); f.source.variants[0].stockSku = "CHANNEL-P1"; f.remote.variants[1].sku = "EXISTING-SKU";
    const before = structuredClone(f);
    expect(planLinkSkuAssignments(f.source, f.remote, f.bindings)).toEqual([{ variantId: 51, remoteVariantId: "901", inventoryItemId: "1901", beforeSku: null, sku: "CHANNEL-P1" }]);
    expect(f).toEqual(before);
  });
  it.each([null, " ", "x".repeat(101), "bad\u0000sku"])("rejects invalid desired SKU %s", sku => {
    const f = fixture(); f.source.variants[0].sku = sku;
    expect(() => planLinkSkuAssignments(f.source, f.remote, f.bindings)).toThrow(/valid catalog or channel SKU/);
  });
  it("handles unresolved selection, duplicate local SKUs and a product-only default variant", () => {
    const f = fixture(); expect(planLinkSkuAssignments(f.source, f.remote, [])).toEqual([]);
    f.source.variants[1].sku = f.source.variants[0].sku;
    expect(() => planLinkSkuAssignments(f.source, f.remote, f.bindings)).toThrow(/duplicate SKUs/);
    f.source.variants = []; f.remote.variants = [f.remote.variants[0]];
    expect(planLinkSkuAssignments(f.source, f.remote, [])).toMatchObject([{ variantId: null, sku: "BINDER" }]);
  });
  it("accepts partial retry progress but requires every fill before mapping", () => {
    const f = fixture(); const skuAssignments = planLinkSkuAssignments(f.source, f.remote, f.bindings);
    const review = { remoteProductId: f.remote.id, remoteFingerprint: shopifyConnectionRemoteFingerprint(f.remote), bindings: f.bindings, skuAssignments };
    f.remote.variants[0].sku = skuAssignments[0].sku;
    expect(() => assertLinkSkuProgress(f.remote, review)).not.toThrow();
    expect(() => assertLinkSkuProgress(f.remote, review, true)).toThrow(/not confirmed every/);
    f.remote.variants[1].sku = skuAssignments[1].sku;
    expect(() => assertLinkSkuProgress(f.remote, review, true)).not.toThrow();
    f.remote.variants[0].sku = "OTHER";
    expect(() => assertLinkSkuProgress(f.remote, review)).toThrow(/not overwritten/);
  });
  it("rejects changed variant identities, product status and duplicate remote SKUs", () => {
    const f = fixture(); const skuAssignments = planLinkSkuAssignments(f.source, f.remote, f.bindings);
    const review = { remoteProductId: f.remote.id, remoteFingerprint: shopifyConnectionRemoteFingerprint(f.remote), bindings: f.bindings, skuAssignments };
    const changed = structuredClone(f.remote); changed.variants[0].inventoryItemId = "999";
    expect(() => assertLinkSkuProgress(changed, review)).toThrow(/identity changed/);
    changed.variants[0].inventoryItemId = "1901"; changed.status = "ARCHIVED";
    expect(() => assertLinkSkuProgress(changed, review)).toThrow(/identities changed/);
    changed.variants[1].sku = skuAssignments[0].sku.toLowerCase();
    expect(() => assertLinkSkusAvailable(skuAssignments, [changed])).toThrow(/already uses/);
  });
});
