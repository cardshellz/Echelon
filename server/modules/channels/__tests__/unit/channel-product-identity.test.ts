import { afterEach, describe, expect, it, vi } from "vitest";
const fixtures = vi.hoisted(() => ({
  catalog: {
    getProductById: vi.fn(async () => ({ id: 1, name: "Product", shopifyProductId: "999", status: "active" })),
    getProductVariantsByProductId: vi.fn(async () => [{ id: 10, sku: "SKU", name: "Each", shopifyVariantId: "9999", priceCents: 100, requiresShipping: true, trackInventory: true }]),
    getProductAssetsByProductId: vi.fn(async () => []), updateProduct: vi.fn(async () => undefined),
  },
  channels: {
    getChannelProductOverride: vi.fn(async () => undefined), getChannelVariantOverridesByProduct: vi.fn(async () => []),
    getChannelPricingByProduct: vi.fn(async () => []), getChannelAssetOverridesByProduct: vi.fn(async () => []),
    getChannelListingsByProduct: vi.fn(async (channelId: number) => [{ productVariantId: 10, externalProductId: `${channelId}01`, externalVariantId: `${channelId}02` }]),
    getChannelFeedByChannelAndVariant: vi.fn(async () => ({ id: 1, isActive: 0 })),
    setChannelFeedActive: vi.fn(), upsertChannelListing: vi.fn(async () => undefined),
  },
}));
vi.mock("../../../catalog", () => ({ catalogStorage: fixtures.catalog }));
vi.mock("../../index", () => ({ channelsStorage: fixtures.channels }));
vi.mock("../../../../infrastructure/auditLogger", () => ({ persistAuditEvent: vi.fn() }));
import { createChannelProductPushService } from "../../product-push.service";
import { ChannelIdentityService } from "../../channel-identity.service";
import { ShopifyIdentityReader } from "../../adapters/shopify-identity.reader";

afterEach(() => vi.restoreAllMocks());
function service() {
  const query = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn(async () => [{ provider: "shopify" }]) };
  return createChannelProductPushService({ select: () => query });
}
describe("channel-specific product identities", () => {
  it("resolves one internal product to independent store identities, never catalog IDs", async () => {
    const push = service();
    const first = await push.getResolvedProductForChannel(1, 1);
    const second = await push.getResolvedProductForChannel(1, 2);
    expect(first).toMatchObject({ shopifyProductId: "101", variants: [{ id: 10, shopifyVariantId: "102" }] });
    expect(second).toMatchObject({ shopifyProductId: "201", variants: [{ id: 10, shopifyVariantId: "202" }] });
  });
  it("never creates a product when the destination mapping is missing", async () => {
    fixtures.channels.getChannelListingsByProduct.mockResolvedValueOnce([]);
    const request = vi.spyOn(globalThis, "fetch");
    const result = await service().pushProduct(1, 2);
    expect(result.status).toBe("error");
    expect(result.error).toContain("routine sync cannot create");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects inconsistent product mappings before contacting the provider", async () => {
    fixtures.channels.getChannelListingsByProduct.mockResolvedValueOnce([
      { productVariantId: 10, externalProductId: "201", externalVariantId: "202" },
      { productVariantId: 11, externalProductId: "301", externalVariantId: "302" },
    ]);
    await expect(service().getResolvedProductForChannel(1, 2)).rejects.toMatchObject({ code: "CHANNEL_PRODUCT_IDENTITY_AMBIGUOUS" });
  });
  it("updates only verified store IDs and does not reactivate disabled inventory", async () => {
    vi.spyOn(ChannelIdentityService.prototype, "shopifyConnection").mockResolvedValue({ id: 7, channelId: 2,
      shopDomain: "second.myshopify.com", accessToken: "test", apiVersion: "2024-01", shopifyLocationId: null });
    vi.spyOn(ShopifyIdentityReader.prototype, "product").mockResolvedValue({ id: "201", title: "Product", body_html: null,
      variants: [{ id: "202", product_id: "201", inventory_item_id: "203", sku: "SKU" }] });
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ product: { id: 201 } })));
    const result = await service().pushProduct(1, 2);
    expect(result.status).toBe("updated");
    expect(request.mock.calls[0][0]).toBe("https://second.myshopify.com/admin/api/2024-01/products/201.json");
    const body = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(body.product.id).toBe(201);
    expect(body.product.variants[0].id).toBe(202);
    expect(fixtures.channels.setChannelFeedActive).not.toHaveBeenCalled();
  });
});
