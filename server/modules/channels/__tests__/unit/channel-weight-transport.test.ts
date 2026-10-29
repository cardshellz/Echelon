import { describe, expect, it, vi } from "vitest";
import type { ChannelListingPayload } from "../../channel-adapter.interface";
import { ShopifyMarketplaceListingConnector } from "../../listing-connectors/shopify-listing.connector";
import { walmartShippingWeightAttributes } from "../../adapters/walmart/walmart-listing-schema";

function weightListing(weightGrams: number | null): ChannelListingPayload {
  return { productId: 20, title: "Product", description: null, category: null, tags: null, status: "active", images: [],
    variants: [{ variantId: 101, sku: "WEIGHT-TEST", name: "Pack", barcode: null, gtin: null, mpn: null,
      weightGrams, priceCents: 1000, compareAtPriceCents: null, isListed: true, externalVariantId: null,
      externalInventoryItemId: null }] };
}

describe("channel weight wire contracts", () => {
  it.each([null, 28, 120.25])("Shopify sends whole ounces for %s grams without changing its source", async weight => {
    const sent: Array<{ product: { variants: Array<{ weight?: number; weight_unit?: string }> } }> = [];
    const connector = new ShopifyMarketplaceListingConnector({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ product: { id: "remote-20", variants: [{ id: "remote-101", sku: "WEIGHT-TEST" }] } }), { status: 200 });
    }) });
    const listing = weightListing(weight), before = structuredClone(listing);
    const request = { credentials: { shopDomain: "example.myshopify.com", accessToken: "test", apiVersion: "2026-04" }, listing };
    await connector.pushChannelListing(request);
    await connector.pushChannelListing(request);
    expect(sent[1]).toEqual(sent[0]);
    expect(listing).toEqual(before);
    expect(sent[0].product.variants[0]).toMatchObject(weight === null ? {} : { weight: weight === 28 ? 1 : 5, weight_unit: "oz" });
    if (weight === null) expect(sent[0].product.variants[0]).not.toHaveProperty("weight");
  });
  it.each([[0.01, 0.063], [0.1, 0.125], [1, 1], [1.00001, 1.063]] as const)(
    "Walmart encodes %s lb upward to %s lb at its native schema precision", (source, expected) => {
      const attributes = Object.freeze({ ShippingWeight: source, condition: "New" });
      expect(walmartShippingWeightAttributes(attributes)).toEqual({ ...attributes, ShippingWeight: expected });
      expect(walmartShippingWeightAttributes(attributes)).toEqual(walmartShippingWeightAttributes(attributes));
      expect(attributes.ShippingWeight).toBe(source);
      expect(expected).toBeGreaterThanOrEqual(source);
    });
  it.each([{}, { ShippingWeight: 0 }, { ShippingWeight: -1 }, { ShippingWeight: "invalid" }])(
    "Walmart preserves missing and native-schema-invalid values for validation (%j)", attributes => {
      expect(walmartShippingWeightAttributes(attributes)).toEqual(attributes);
    });
});
