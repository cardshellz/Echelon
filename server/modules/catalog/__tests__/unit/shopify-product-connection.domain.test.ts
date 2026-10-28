import { describe, expect, it } from "vitest";
import {
  formatShopifyConnectionMoney, parseShopifyConnectionMoney, shopifyProductConnectionRequestSchema,
} from "@shared/catalog/shopify-product-connection";
import {
  buildShopifyConnectionCreateSpec, connectionFingerprint, parseShopifyProductReference,
  resolveConnectionBindings, type ShopifyConnectionRemoteProduct, type ShopifyConnectionSource,
} from "../../shopify-product-connection.domain";
import { buildShopifyProductMappingSummary } from "../../shopify-product-mapping.domain";

function source(): ShopifyConnectionSource {
  return {
    product: { id: 41, sku: "BINDER", name: "Binder", title: null, description: "<p>A binder</p>",
      vendor: "Brand", productType: "Binders", isActive: true, requiresShipping: true, trackInventory: true },
    variants: [
      { id: 51, sku: "BINDER-P1", name: "Each", barcode: null, isActive: true, salesEligibility: "sellable", requiresShipping: true, trackInventory: true, priceCents: 1999, compareAtPriceCents: null },
      { id: 52, sku: "BINDER-C5", name: "Case of 5", barcode: null, isActive: true, salesEligibility: "sellable", requiresShipping: true, trackInventory: false, priceCents: 8995, compareAtPriceCents: 9995 },
    ],
    images: [],
    mapping: buildShopifyProductMappingSummary({ productId: 41, productName: "Binder", productSku: "BINDER", catalogProductId: null,
      channel: { id: 7, name: "Shopify" }, variants: [] }),
    channel: { id: 7, name: "Shopify", shopDomain: "test-store.myshopify.com", connectionId: 9, apiVersion: "2026-01" },
  };
}
const request = () => shopifyProductConnectionRequestSchema.parse({ channelId: 7, mode: "create" });
const remote = (): ShopifyConnectionRemoteProduct => ({
  id: "100", title: "Existing", handle: "existing", status: "ACTIVE", ownership: null,
  variants: [
    { id: "101", sku: "BINDER-P1", inventoryItemId: "201", barcode: null, title: "Each", priceCents: 1999, optionValue: "Each", localVariantId: null },
    { id: "102", sku: "BINDER-C5", inventoryItemId: "202", barcode: null, title: "Case", priceCents: 8995, optionValue: "Case", localVariantId: null },
  ],
});

describe("targeted Shopify product connection", () => {
  it("plans all active sellable variants while preserving each inventory and fulfillment policy", () => {
    const original = source();
    const frozen = structuredClone(original);
    original.variants.push({ ...original.variants[0], id: 53, isActive: false });
    original.variants.push({ ...original.variants[0], id: 54, salesEligibility: "internal_only" });
    const spec = buildShopifyConnectionCreateSpec(original, request());
    expect(spec.variants.map(row => [row.localVariantId, row.trackInventory])).toEqual([[51, true], [52, false]]);
    expect(original.product).toEqual(frozen.product);
    expect(original.variants[0]).toEqual(frozen.variants[0]);
  });
  it("creates a product-only Shopify identity without inventing warehouse variants", () => {
    const local = source(); local.variants = []; local.product.requiresShipping = false; local.product.trackInventory = false;
    const spec = buildShopifyConnectionCreateSpec(local, { ...request(), prices: [{ variantId: null, priceCents: 500 }] });
    expect(spec.variants).toMatchObject([{ localVariantId: null, sku: "BINDER", requiresShipping: false, trackInventory: false, priceCents: 500 }]);
    expect(local.variants).toEqual([]);
  });
  it("rejects an archived product or a product with only archived/internal variants", () => {
    const local = source(); local.product.isActive = false;
    expect(() => buildShopifyConnectionCreateSpec(local, request())).toThrow("Activate this catalog product");
    local.product.isActive = true; local.variants.forEach(row => { row.isActive = false; });
    expect(() => buildShopifyConnectionCreateSpec(local, request())).toThrow("no active customer-sellable variants");
  });
  it("refuses creation when an identity already exists, even with incomplete variants", () => {
    const local = source(); local.mapping.catalogProductId = "100";
    expect(() => buildShopifyConnectionCreateSpec(local, request())).toThrow("already has a Shopify identity");
  });
  it("requires an explicit valid price rather than creating an accidental free product", () => {
    const local = source(); local.variants[0].priceCents = null;
    expect(() => buildShopifyConnectionCreateSpec(local, request())).toThrow("Enter a price");
    expect(buildShopifyConnectionCreateSpec(local, { ...request(), prices: [{ variantId: 51, priceCents: 0 }] }).variants[0].priceCents).toBe(0);
  });
  it("rejects unrelated prices, invalid comparisons, and ambiguous mapping identities", () => {
    expect(() => buildShopifyConnectionCreateSpec(source(), { ...request(), prices: [{ variantId: 999, priceCents: 1 }] })).toThrow("selected sellable variants");
    expect(() => buildShopifyConnectionCreateSpec(source(), { ...request(), prices: [{ variantId: 51, priceCents: 100, compareAtPriceCents: 99 }] })).toThrow("compare-at price");
    const local = source(); local.mapping.status = "conflict";
    expect(() => buildShopifyConnectionCreateSpec(local, request())).toThrow("conflicting Shopify identities");
  });
  it("links by unique exact SKU and accepts explicit selections for missing/different SKUs", () => {
    expect(resolveConnectionBindings(source(), remote(), [])).toEqual([{ variantId: 51, remoteVariantId: "101" }, { variantId: 52, remoteVariantId: "102" }]);
    const target = remote(); target.variants[0].sku = null;
    expect(() => resolveConnectionBindings(source(), target, [])).toThrow("Select one distinct Shopify variant");
    expect(resolveConnectionBindings(source(), target, [{ variantId: 51, remoteVariantId: "101" }])).toHaveLength(2);
  });
  it("never assigns one Shopify variant to two local variants or accepts an unrelated local ID", () => {
    expect(() => resolveConnectionBindings(source(), remote(), [{ variantId: 51, remoteVariantId: "101" }, { variantId: 52, remoteVariantId: "101" }])).toThrow("Select one distinct Shopify variant");
    expect(() => resolveConnectionBindings(source(), remote(), [{ variantId: 999, remoteVariantId: "101" }])).toThrow("unrelated catalog variant");
  });
  it("requires explicit selections when remote SKUs are duplicated", () => {
    const target = remote(); target.variants.push({ ...target.variants[0], id: "103" });
    expect(() => resolveConnectionBindings(source(), target, [])).toThrow("Select one distinct Shopify variant");
  });
  it.each([
    "100", "gid://shopify/Product/100", "https://test-store.myshopify.com/admin/products/100",
    "https://admin.shopify.com/store/test-store/products/100",
  ])("accepts a product reference in the selected shop: %s", ref => {
    expect(parseShopifyProductReference(ref, "test-store.myshopify.com")).toBe("100");
  });
  it.each(["0", "https://other.myshopify.com/admin/products/100", "http://test-store.myshopify.com/admin/products/100", "https://test-store.myshopify.com.evil.com/admin/products/100", "https://admin.shopify.com/store/other/products/100", "https://user@test-store.myshopify.com/admin/products/100"])("rejects a malformed or wrong-shop reference: %s", ref => {
    expect(() => parseShopifyProductReference(ref, "test-store.myshopify.com")).toThrow("selected Shopify store");
  });
  it("fingerprints immutable review intent deterministically", () => {
    expect(connectionFingerprint(source())).toBe(connectionFingerprint(source()));
    expect(connectionFingerprint({ ...source(), images: [{ url: "https://example.com/a.jpg", alt: null }] })).not.toBe(connectionFingerprint(source()));
  });
});

describe("Shopify connection money boundaries", () => {
  it.each([["0", 0], ["0.01", 1], ["12.3", 1230], ["90071992547409.91", Number.MAX_SAFE_INTEGER]])("parses decimal text without floating point: %s", (text, expected) => {
    expect(parseShopifyConnectionMoney(text)).toBe(expected);
    expect(parseShopifyConnectionMoney(formatShopifyConnectionMoney(expected))).toBe(expected);
  });
  it.each(["", "-1", "1.234", "1e3", "Infinity", "90071992547409.92", "$10.00"])("rejects invalid or unsafe price %s", text => {
    expect(parseShopifyConnectionMoney(text)).toBeNull();
  });
  it("rejects duplicate bindings and price records at the HTTP boundary", () => {
    expect(shopifyProductConnectionRequestSchema.safeParse({ channelId: 7, mode: "link", targetProductRef: "100", bindings: [{ variantId: 51, remoteVariantId: "101" }, { variantId: 51, remoteVariantId: "102" }] }).success).toBe(false);
    expect(shopifyProductConnectionRequestSchema.safeParse({ channelId: 7, mode: "create", prices: [{ variantId: 51, priceCents: 1.1 }] }).success).toBe(false);
    expect(() => formatShopifyConnectionMoney(1.1)).toThrow("integer cents");
  });
});
