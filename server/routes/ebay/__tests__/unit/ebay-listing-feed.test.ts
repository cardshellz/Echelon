import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ variants: [] as Array<Record<string, unknown>>,
  query: vi.fn(), release: vi.fn(), getQuantities: vi.fn(), price: vi.fn(), hasPhotos: true, productExcluded: false, secondProduct: false,
}));
vi.mock("../../../../db", () => ({ db: {}, pool: { connect: async () => ({ query: fixture.query, release: fixture.release }) } }));
vi.mock("../../../middleware", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthOrInternalApiKey: (_req: unknown, _res: unknown, next: () => void) => next(), requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../../ebay-utils", () => ({ EBAY_CHANNEL_ID: 67, getAuthService: vi.fn(), getChannelConnection: vi.fn(),
  atpService: { getAtpPerVariant: fixture.getQuantities } }));
vi.mock("../../../../modules/channels/infrastructure/ebay-listing-helpers", () => ({ resolveChannelPrice: fixture.price }));
vi.mock("../../../../modules/channels/ebay-listing-push", () => ({ ebayListingPushRequestSchema: {}, ebayListingPushService: {}, readEbayPushRecoveryIdentity: vi.fn() }));
vi.mock("../../../../modules/channels/ebay-listing-sync", () => ({ syncActiveListings: vi.fn(), ebayListingSyncService: {}, EbayListingRecoveryService: class {} }));
vi.mock("../../../../modules/inventory-planning/quantity-publication", () => ({ EbayPublicationRecoveryService: class {}, PostgresEbayPublicationRecoveryRepository: class {} }));
vi.mock("../../../../modules/channels/variant-availability-sync.service", () => ({ queueVariantAvailabilityRepair: vi.fn() }));
vi.mock("../../ebay-listing-connector-client", () => ({ createEbayRouteListingClient: vi.fn() }));
vi.mock("../../ebay-listing-recovery.routes", () => ({ registerEbayListingRecoveryRoutes: vi.fn() }));
vi.mock("../../../../modules/channels/ebay-listing-mapping", () => ({ ebayListingMappingService: {} }));
vi.mock("../../ebay-listing-mapping.routes", () => ({ registerEbayListingMappingRoutes: vi.fn() }));
import { router } from "../../ebay-listings.routes";
import { ChannelPricingResolutionError } from "../../../../modules/channels/channel-pricing-resolver";
import { InventoryChannelQuantityRuntimeError } from "../../../../modules/inventory-planning/application/inventory-channel-quantity-runtime.service";
import { ebayListingIssueSchema } from "@shared/types/ebay-listing-issue";
import { resolveEbayFeedListingState } from "../../../../modules/channels/ebay-listing-feed-status";

describe("eBay listing feed current content intent", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let url: string;
  beforeEach(async () => {
    fixture.productExcluded = false;
    fixture.hasPhotos = true;
    fixture.price.mockReset().mockResolvedValue(1000);
    fixture.secondProduct = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.getQuantities.mockReset().mockImplementation(async (productId: number) => fixture.variants
      .filter(variant => variant.product_id === productId).map(variant => ({ productVariantId: variant.id, atpUnits: 17 })));
    fixture.variants = [1, 2, 3].map(id => ({ id, product_id: 20, sku: `SKU-${id}`, name: `Variant ${id}`, price_cents: 1000,
      requires_shipping: true, track_inventory: true,
      ebay_listing_excluded: id === 3, variant_override_is_listed: id === 3 ? 0 : 1,
      listing_id: id, external_listing_id: "listing-20", external_offer_id: `offer-${id}`, listing_status: id === 3 ? "error" : "synced", listing_sync_error: id === 3 ? "Old excluded member failed" : null }));
    fixture.query.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('AS "assetIds"')) return { rows: [{
        variants: fixture.variants.filter(variant => variant.product_id === params[0]).map(variant => ({ variantId: variant.id, sku: variant.sku })),
        assetIds: fixture.hasPhotos ? [100] : [],
      }] };
      if (sql.includes('WITH overrides AS')) return { rows: fixture.hasPhotos ? (params[0] as number[]).map(variantId => ({
        forProductVariantId: variantId, id: 100, productId: params[4], productVariantId: null,
        position: 0, publicationPosition: 0, url: 'https://images.example.com/product.jpg',
        isPrimary: true, included: true, storageType: 'url', mimeType: null, fileBytes: null, fileHash: null, fileHeader: null,
      })) : [] };
      if (sql.includes("FROM products p")) return { rows: (fixture.secondProduct ? [20, 21] : [20]).map(id => ({ id, name: `Product ${id}`, sku: `PRODUCT-${id}`, product_type: "Toploaders", product_type_name: "Toploaders",
        is_active: true, ebay_browse_category_id: "183454", variant_count: "3", image_count: "1", type_listing_enabled: true,
        ebay_listing_excluded: fixture.productExcluded, product_override_is_listed: 1, external_product_id: "listing-20", external_product_id_count: 1,
        // The former product-wide selector picked this retained member error.
        listing_id: 3, listing_status: "error", listing_sync_error: "Old excluded member failed" })) };
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
    vi.restoreAllMocks();
  });

  it("uses the canonical photo selection instead of the raw asset count", async () => {
    fixture.hasPhotos = false;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const { feed } = await response.json();
    expect(feed[0]).toMatchObject({ status: "missing_config", imageCount: 0, missingItems: ["images"] });
    expect(feed[0].mediaReadiness.ready).toBe(false);
  });

  it("keeps a known price-source conflict actionable without hiding healthy products", async () => {
    fixture.secondProduct = true;
    fixture.variants.push({ ...fixture.variants[0], id: 4, product_id: 21, sku: "HEALTHY", external_listing_id: "listing-21" });
    fixture.price.mockImplementation(async (_db, _channel, productId) => {
      if (productId === 20) throw new ChannelPricingResolutionError("RETAIL_PRICE_SOURCE_REQUIRED", "Select the exact retail price source.", {});
      return 1000;
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const { feed } = await response.json();
    expect(feed[0]).toMatchObject({ status: "missing_config", priceIssue: { code: "RETAIL_PRICE_SOURCE_REQUIRED", action: { href: "/catalog/variants" } } });
    expect(feed[0].missingPriceSkus).toEqual(["SKU-1", "SKU-2"]);
    expect(feed[1]).toMatchObject({ status: "listed", priceIssue: null });
    expect(fixture.query.mock.calls.every(([sql]) => !/^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(true);
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

  it("does not present a quantity-synced offer-only row as a published listing", async () => {
    for (const variant of fixture.variants.slice(0, 2)) variant.external_listing_id = null;
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false, canSyncExistingListing: true });
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes("cl.external_product_id AS external_listing_id"))).toBe(true);
  });

  it("offers normal Sync for pending saved offers without declaring their publication complete", async () => {
    for (const variant of fixture.variants.slice(0, 2)) Object.assign(variant, { listing_status: "pending", external_listing_id: null });
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false, canSyncExistingListing: true });
  });

  it.each(["ended", "deleted", "no_identity"])("does not nominate %s mappings for Sync All", async status => {
    for (const variant of fixture.variants.slice(0, 2)) Object.assign(variant, status === "no_identity"
      ? { listing_status: "pending", external_listing_id: null, external_offer_id: null }
      : { listing_status: status });
    const { feed } = await (await fetch(url)).json();
    expect(feed[0].canSyncExistingListing).toBe(false);
  });

  it("requires publication identity for every included member", async () => {
    fixture.variants[0].external_listing_id = null;
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false });
  });

  it("keeps an existing listing syncable when a newly selected variant has never been listed", async () => {
    Object.assign(fixture.variants[1], { listing_id: null, external_listing_id: null, listing_status: null, listing_sync_error: null });
    const before = structuredClone(fixture.variants);
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "listed", isListed: true, externalListingId: "listing-20",
      unlinkedVariants: [{ id: 2, sku: "SKU-2" }] });
    expect(fixture.variants).toEqual(before);
    expect(fixture.query.mock.calls.every(([sql]) => !/^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(true);
  });

  it("does not make an ended listing syncable just because a new variant is selected", async () => {
    fixture.variants[0].listing_status = "ended";
    Object.assign(fixture.variants[1], { listing_id: null, external_listing_id: null, listing_status: null, listing_sync_error: null });
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false });
  });

  it("requires a provider check for mixed active and ended members even when their saved listing ID agrees", async () => {
    fixture.variants[0].listing_status = "ended";
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false });
  });

  it("does not treat duplicate ended rows as a fully ended selected listing", () => {
    const state = resolveEbayFeedListingState([
      { variantId: 1, listingRecordId: 1, externalListingId: "listing-20", syncStatus: "ended", syncError: null },
      { variantId: 1, listingRecordId: 4, externalListingId: "listing-20", syncStatus: "ended", syncError: null },
      { variantId: 2, listingRecordId: null, externalListingId: null, syncStatus: null, syncError: null },
    ], [1, 2]);
    expect(state).toMatchObject({ isEnded: false, isListed: false, needsPublicationCheck: true });
  });

  it("routes conflicting saved listing identities to a fresh publication review", async () => {
    fixture.variants[0].external_listing_id = "another-listing";
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false });
  });

  it("does not offer an initial push when one member is ended and another has incomplete publication", async () => {
    fixture.variants[1].listing_status = "ended";
    fixture.variants[0].external_listing_id = null;
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false });
  });

  it("keeps a saved pending mapping out of initial publication even when it has a listing ID", async () => {
    fixture.variants[0].listing_status = "pending";
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "publication_incomplete", isListed: false });
  });

  it("keeps a failed product visible with unavailable stock and preserves other products' real zero stock", async () => {
    fixture.secondProduct = true;
    fixture.variants.push({ ...fixture.variants[0], id: 4, product_id: 21, sku: "HEALTHY", external_listing_id: "listing-21" });
    fixture.getQuantities.mockImplementation(async (productId: number) => {
      if (productId === 20) throw new InventoryChannelQuantityRuntimeError("CANONICAL_CHANNEL_QUANTITY_BLOCKED",
        "private runtime diagnostic", { productVariantId: 1, publicationTargetId: 67, blockerCodes: ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE"] });
      return [{ productVariantId: 4, atpUnits: 0 }];
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.feed[0]).toMatchObject({ status: "listed", syncError: null,
      inventoryIssue: { code: "CANONICAL_CHANNEL_QUANTITY_BLOCKED", action: { kind: "edit_listing", href: "/channels/inventory?product=20" } } });
    expect(body.feed[0].variants.map((variant: { inventoryQuantity: unknown }) => variant.inventoryQuantity)).toEqual([null, null, null]);
    expect(body.feed[1]).toMatchObject({ inventoryIssue: null, variants: [{ id: 4, inventoryQuantity: 0 }] });
    expect(ebayListingIssueSchema.safeParse(body.feed[0].inventoryIssue).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("private runtime diagnostic");
    expect(fixture.query.mock.calls.every(([sql]) => !/^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(true);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("does not display missing quantity rows as zero and reloads current quantities without changing listing state", async () => {
    fixture.getQuantities.mockResolvedValueOnce([{ productVariantId: 1, atpUnits: 8 }]);
    const first = await (await fetch(url)).json();
    expect(first.feed[0]).toMatchObject({ status: "listed", inventoryIssue: { code: "EBAY_FEED_QUANTITY_MISSING" } });
    expect(first.feed[0].variants.map((variant: { inventoryQuantity: unknown }) => variant.inventoryQuantity)).toEqual([8, null, null]);
    const second = await (await fetch(url)).json();
    expect(second.feed[0]).toMatchObject({ status: "listed", inventoryIssue: null });
    expect(second.feed[0].variants.every((variant: { inventoryQuantity: unknown }) => variant.inventoryQuantity === 17)).toBe(true);
  });

  it("does not require a stock row for an excluded variant that has no retained provider identity", async () => {
    fixture.variants[2].listing_id = null;
    fixture.variants[2].external_listing_id = null;
    fixture.getQuantities.mockResolvedValueOnce([{ productVariantId: 1, atpUnits: 17 }, { productVariantId: 2, atpUnits: 9 }]);
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ inventoryIssue: null, status: "listed" });
    expect(feed[0].variants.map((variant: { inventoryQuantity: unknown }) => variant.inventoryQuantity)).toEqual([17, 9, null]);
  });

  it.each(["requires_shipping", "track_inventory"])("does not require stock for a selected variant with %s disabled", async field => {
    fixture.variants[1][field] = false;
    fixture.getQuantities.mockResolvedValueOnce([{ productVariantId: 1, atpUnits: 17 }]);
    const { feed } = await (await fetch(url)).json();
    expect(feed[0].inventoryIssue).toBeNull();
    expect(feed[0].variants[0].inventoryQuantity).toBe(17);
    expect(feed[0].variants[1].inventoryQuantity).toBeNull();
  });

  it("shows an excluded product with no stock rows without creating a false inventory error", async () => {
    fixture.productExcluded = true;
    fixture.getQuantities.mockResolvedValueOnce([]);
    const { feed } = await (await fetch(url)).json();
    expect(feed[0]).toMatchObject({ status: "excluded", inventoryIssue: null, canSyncExistingListing: false });
  });

  it("returns safe diagnostics and a reference when the feed itself cannot be read", async () => {
    fixture.query.mockRejectedValueOnce(new Error("SELECT secret_column FROM private_table password=private-value"));
    const response = await fetch(url);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ code: "EBAY_LISTING_FEED_UNAVAILABLE", issue: { code: "EBAY_LISTING_FEED_UNAVAILABLE",
      action: { kind: "contact_support" } } });
    expect(ebayListingIssueSchema.safeParse(body.issue).success).toBe(true);
    expect(body.issue.reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/secret_column|private_table|private-value/);
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
