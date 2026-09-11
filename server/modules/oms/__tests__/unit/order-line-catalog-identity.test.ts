import { describe, expect, it } from "vitest";
import { normalizeShopifyLineItems } from "../../shopify-line-item-normalizer";
import {
  selectOrderLineCatalogIdentity, selectWmsCatalogSku, normalizeShopifyLineVariantId,
  type CatalogIdentityCandidate,
} from "../../domain/order-line-catalog-identity";

const variant: CatalogIdentityCandidate = { id: 11, sku: "EXAMPLE-P5", isActive: true, compareAtPriceCents: 2500 };
const input = { channelId: 2, externalVariantId: "1001", externalProductId: "1000", sku: null };
const channelVariant = { ...variant, externalProductId: "1000" };

describe("order line catalog identity", () => {
  it("resolves a missing SKU through the channel variant without mutating source evidence", () => {
    const frozenInput = Object.freeze(input);
    expect(selectOrderLineCatalogIdentity(frozenInput, [Object.freeze(channelVariant)], []))
      .toEqual({ ...variant, matchedBy: "channel_variant_id" });
    expect(frozenInput.sku).toBeNull();
  });
  it("preserves SKU-only resolution for existing channels", () => {
    expect(selectOrderLineCatalogIdentity({ channelId: 2, sku: variant.sku }, [], [variant]))
      .toEqual({ ...variant, matchedBy: "sku" });
  });
  it("accepts agreeing SKU and channel identities", () => {
    expect(selectOrderLineCatalogIdentity({ ...input, sku: variant.sku }, [channelVariant], [variant])?.id).toBe(11);
  });
  it("does not use titles or unscoped provider IDs when the channel mapping is absent", () => {
    expect(selectOrderLineCatalogIdentity(input, [], [])).toBeNull();
  });
  it("does not silently replace an existing order-line variant", () => {
    expect(() => selectOrderLineCatalogIdentity({ ...input, previousVariantId: 12 }, [channelVariant], []))
      .toThrow("would replace the catalog identity");
    expect(selectOrderLineCatalogIdentity({ ...input, previousVariantId: 11 }, [channelVariant], [])?.id).toBe(11);
    expect(() => selectOrderLineCatalogIdentity({ channelId: 2, sku: variant.sku, previousVariantId: 12 }, [], [variant]))
      .toThrow("would replace the catalog identity");
  });
  it("preserves an already-bound inactive identity but never makes a new inactive SKU assignment", () => {
    expect(selectOrderLineCatalogIdentity({ ...input, previousVariantId: 11 }, [{ ...channelVariant, isActive: false }], [])?.id).toBe(11);
    expect(selectOrderLineCatalogIdentity({ channelId: 2, sku: variant.sku }, [], [{ ...variant, isActive: false }])).toBeNull();
  });
  it("classifies malformed catalog evidence instead of accepting it", () => {
    expect(() => selectOrderLineCatalogIdentity(input, [{ ...channelVariant, id: -1 }], []))
      .toThrow("Catalog identity evidence is malformed");
  });
  it.each([
    ["duplicate channel mapping", [channelVariant, { ...channelVariant, id: 12 }], [], "ORDER_LINE_IDENTITY_AMBIGUOUS"],
    ["duplicate SKU", [], [variant, { ...variant, id: 12 }], "ORDER_LINE_IDENTITY_AMBIGUOUS"],
    ["conflicting SKU", [channelVariant], [{ ...variant, id: 12 }], "ORDER_LINE_IDENTITY_CONFLICT"],
    ["conflicting product", [{ ...channelVariant, externalProductId: "999" }], [], "ORDER_LINE_PRODUCT_IDENTITY_CONFLICT"],
    ["inactive mapping", [{ ...channelVariant, isActive: false }], [], "ORDER_LINE_VARIANT_INACTIVE"],
  ] as const)("rejects %s explicitly", (_name, channel, sku, code) => {
    try { selectOrderLineCatalogIdentity(input, channel, sku); throw new Error("Expected failure"); }
    catch (error) { expect(error).toMatchObject({ code, classification: "manual_review", message: expect.stringContaining(code) }); }
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])("rejects invalid channel %s", channelId => {
    expect(() => selectOrderLineCatalogIdentity({ ...input, channelId }, [], []))
      .toThrow("Order line identity is malformed");
  });
  it("rejects control characters and overlong source identities", () => {
    for (const externalVariantId of ["bad\nidentity", "a".repeat(101)]) {
      expect(() => selectOrderLineCatalogIdentity({ ...input, externalVariantId }, [], [])).toThrow();
    }
  });
  it.each([
    [null, "EXAMPLE-P5", "EXAMPLE-P5"], ["CHANNEL-ALIAS", "EXAMPLE-P5", "EXAMPLE-P5"],
    [" source ", null, "source"], ["  ", null, "UNKNOWN"], [null, null, "UNKNOWN"],
  ])("chooses the WMS catalog SKU (%s, %s)", (source, catalog, expected) => {
    expect(selectWmsCatalogSku(source, catalog)).toBe(expected);
  });
});

describe("Shopify line variant identity normalization", () => {
  it.each([[123, "123"], ["123", "123"], ["gid://shopify/ProductVariant/123", "123"],
    ["9007199254740993", "9007199254740993"], [null, null], [undefined, null]])("normalizes %s losslessly", (value, expected) => {
    expect(normalizeShopifyLineVariantId(value)).toBe(expected);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, "-2", "gid://shopify/Product/123", "1e3", "1/2"])("rejects invalid variant ID %s", value => {
    expect(() => normalizeShopifyLineVariantId(value)).toThrow("SHOPIFY_LINE_VARIANT_ID_INVALID");
  });
  it("retains variant IDs and original blank SKUs through the real normalizer", () => {
    const source = [{ id: 21, product_id: 1000, variant_id: 1001, sku: null,
      title: "Example item", quantity: 2, price: "10.00", requires_shipping: true }];
    expect(normalizeShopifyLineItems(source, [])[0]).toMatchObject({
      externalVariantId: "1001", externalProductId: "1000", sku: null, quantity: 2, requiresShipping: true,
    });
    expect(source[0].sku).toBeNull();
  });
});
