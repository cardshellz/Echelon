import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ variants: [] as Array<Record<string, unknown>>,
  query: vi.fn(), release: vi.fn(), productExcluded: false,
}));
vi.mock("../../../../db", () => ({ db: {}, pool: { connect: async () => ({ query: fixture.query, release: fixture.release }) } }));
vi.mock("../../../middleware", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthOrInternalApiKey: (_req: unknown, _res: unknown, next: () => void) => next(), requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../ebay-utils", () => ({ EBAY_CHANNEL_ID: 67, getAuthService: vi.fn(), getChannelConnection: vi.fn(),
  atpService: { getAtpPerVariant: async () => fixture.variants.map(variant => ({ productVariantId: variant.id, atpUnits: 17 })) } }));
vi.mock("../../../../modules/channels/infrastructure/ebay-listing-helpers", () => ({ resolveChannelPrice: async () => 1000 }));
vi.mock("../../../../modules/channels/ebay-listing-push", () => ({ ebayListingPushRequestSchema: {}, ebayListingPushService: {}, readEbayPushRecoveryIdentity: vi.fn() }));
vi.mock("../../../../modules/channels/ebay-listing-sync", () => ({ syncActiveListings: vi.fn(), ebayListingSyncService: {}, EbayListingRecoveryService: class {} }));
vi.mock("../../../../modules/inventory-planning/quantity-publication", () => ({ EbayPublicationRecoveryService: class {}, PostgresEbayPublicationRecoveryRepository: class {} }));
vi.mock("../../../../modules/channels/variant-availability-sync.service", () => ({ queueVariantAvailabilityRepair: vi.fn() }));
vi.mock("../../ebay-listing-connector-client", () => ({ createEbayRouteListingClient: vi.fn() }));
vi.mock("../../ebay-listing-recovery.routes", () => ({ registerEbayListingRecoveryRoutes: vi.fn() }));
vi.mock("../../../../modules/channels/ebay-listing-mapping", () => ({ ebayListingMappingService: {} }));
vi.mock("../../ebay-listing-mapping.routes", () => ({ registerEbayListingMappingRoutes: vi.fn() }));
import { router } from "../../ebay-listings.routes";

describe("eBay listing feed current content intent", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let url: string;
  beforeEach(async () => {
    fixture.productExcluded = false;
    fixture.variants = [1, 2, 3].map(id => ({ id, product_id: 20, sku: `SKU-${id}`, name: `Variant ${id}`, price_cents: 1000,
      ebay_listing_excluded: id === 3, variant_override_is_listed: id === 3 ? 0 : 1,
      listing_id: id, listing_status: id === 3 ? "error" : "synced", listing_sync_error: id === 3 ? "Old excluded member failed" : null }));
    fixture.query.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM products p")) return { rows: [{ id: 20, name: "Product", sku: "PRODUCT", product_type: "Toploaders", product_type_name: "Toploaders",
        is_active: true, ebay_browse_category_id: "183454", variant_count: "3", image_count: "1", type_listing_enabled: true,
        ebay_listing_excluded: fixture.productExcluded, product_override_is_listed: 1, external_product_id: "listing-20", external_product_id_count: 1,
        // The former product-wide selector picked this retained member error.
        listing_id: 3, listing_status: "error", listing_sync_error: "Old excluded member failed" }] };
      if (sql.includes("FROM product_variants pv")) return { rows: fixture.variants };
      return { rows: [] };
    });
    fixture.release.mockClear();
    const app = express(); app.use(router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ebay/listing-feed`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("shows the successful included members without clearing an excluded member's saved error", async () => {
    const before = structuredClone(fixture.variants);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const { feed } = await response.json();
    expect(feed[0]).toMatchObject({ status: "listed", isListed: true, includedVariantCount: 2, syncError: null });
    expect(feed[0].variants[2]).toMatchObject({ id: 3, effectivelyListed: false });
    expect(fixture.variants).toEqual(before);
    expect(fixture.query.mock.calls.every(([sql]) => !/^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(true);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("keeps a current included member's later failure visible despite other successful members", async () => {
    fixture.variants[0].listing_status = "error";
    fixture.variants[0].listing_sync_error = "New included member failure";
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "error", isListed: false, syncError: "New included member failure" });
  });

  it("restores the saved error if its member becomes included again", async () => {
    fixture.variants[2].ebay_listing_excluded = false;
    fixture.variants[2].variant_override_is_listed = 1;
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "error", includedVariantCount: 3, syncError: "Old excluded member failed" });
  });

  it("does not borrow a retained excluded listing's success when included members have no mapping", async () => {
    for (const variant of fixture.variants.slice(0, 2)) { variant.listing_id = null; variant.listing_status = null; variant.listing_sync_error = null; }
    fixture.variants[2].listing_status = "synced"; fixture.variants[2].listing_sync_error = null;
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "ready", isListed: false, syncError: null });
  });
});
