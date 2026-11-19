import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  product: { id: 20, name: "Test product", status: "active" },
  variant: { id: 101, productId: 20, name: "Pack", sku: "WEIGHT-TEST", weightGrams: "28.00",
    priceCents: 1000, isActive: true, salesEligibility: "sellable", requiresShipping: true },
  variantOverrides: [] as Array<{ productVariantId: number; isListed: number; weightOverride: number }>,
  updateProduct: vi.fn(), upsertChannelListing: vi.fn(),
}));
vi.mock("../../../catalog", () => ({ catalogStorage: {
  getProductById: vi.fn(async () => fixture.product),
  getProductVariantsByProductId: vi.fn(async () => [fixture.variant]),
  getProductAssetsByProductId: vi.fn(async () => []),
  updateProduct: fixture.updateProduct,
} }));
vi.mock("../../../channels", () => ({ channelsStorage: {
  getChannelProductOverride: vi.fn(async () => null),
  getChannelVariantOverridesByProduct: vi.fn(async () => fixture.variantOverrides),
  getChannelPricingByProduct: vi.fn(async () => []),
  getChannelAssetOverridesByProduct: vi.fn(async () => []),
  getChannelListingsByProduct: vi.fn(async () => [{ externalProductId: "100", productVariantId: 101 }]),
  upsertChannelListing: fixture.upsertChannelListing,
  getChannelFeedByChannelAndVariant: vi.fn(async () => ({ id: 500, isActive: 1 })),
} }));
import { createChannelProductPushService } from "../../product-push.service";

afterEach(() => { vi.unstubAllGlobals(); fixture.variantOverrides = []; });
describe("product push weight through the existing Shopify writer", () => {
  it.each([false, true])("publishes whole ounces from the resolved source and preserves source facts (override=%s)", async override => {
    fixture.variantOverrides = override ? [{ productVariantId: 101, isListed: 1, weightOverride: 120.25 }] : [];
    const sent: Array<{ product: { variants: Array<{ weight: number; weight_unit: string }> } }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ product: { id: 100, variants: [{ id: 200, sku: fixture.variant.sku }] } }));
    }));
    const limit = vi.fn().mockResolvedValueOnce([{ provider: "shopify" }])
      .mockResolvedValueOnce([{ shopDomain: "example.myshopify.com", accessToken: "test", apiVersion: "2026-04" }]);
    const database = { select: () => ({ from: () => ({ where: () => ({ limit }) }) }) };
    const owner = createChannelProductPushService(database);
    const source = structuredClone(fixture.variant);
    const overrides = structuredClone(fixture.variantOverrides);
    expect(await owner.pushProduct(20, 35)).toMatchObject({ status: "updated" });
    expect(sent[0].product.variants[0]).toMatchObject({ weight: override ? 5 : 1, weight_unit: "oz" });
    expect(fixture.variant).toEqual(source);
    expect(fixture.variantOverrides).toEqual(overrides);
  });
});
