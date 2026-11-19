import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { listingIntentBase } from "../fixtures/listing-intent.fixture";
import { prepareEbayListingPackages } from "../../../channels/adapters/ebay/ebay-listing-package";
import { EbayMarketplaceListingConnector } from "../../../channels/listing-connectors/ebay-listing.connector";
import { ShopifyMarketplaceListingConnector } from "../../../channels/listing-connectors/shopify-listing.connector";
import { syncProviderFixture } from "../../../channels/__tests__/fixtures/ebay-listing-sync.fixture";
import type { ChannelListingPayload } from "../../../channels/channel-adapter.interface";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

(url && disposable ? describe : describe.skip).sequential("publication weights from real PostgreSQL catalog measurements", () => {
  let database: InventoryCutoverTestDatabase;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, listingIntentBase);
    await database.pool.query(`ALTER TABLE catalog.product_variants ADD COLUMN weight_grams numeric(10,2),
      ADD COLUMN length_mm numeric(10,2),ADD COLUMN width_mm numeric(10,2),ADD COLUMN height_mm numeric(10,2);
      UPDATE catalog.product_variants SET weight_grams=28.00 WHERE id=101;`);
    await database.pool.query(await readFile("migrations/900000018000018580002_listing_intent_propagation.sql", "utf8"));
  });
  afterEach(async () => { await database?.close(); });

  it.each([["28.00", 1], ["120.25", 5]] as const)("publishes %s grams through both adapters without rewriting catalog decimals or creating change work", async (weightGrams, expectedOunces) => {
    const variantId = 101;
    await database.pool.query("UPDATE catalog.product_variants SET weight_grams=$1 WHERE id=$2", [weightGrams, variantId]);
    // This is the source edit under test; publication itself must not generate
    // any additional source changes.
    const beforeChanges = (await database.pool.query("SELECT count(*)::int AS n FROM marketplace.listing_intent_changes")).rows[0].n;
    const readSource = async () => (await database.pool.query<{ sku: string; weight_grams: string }>(
      "SELECT sku,weight_grams FROM catalog.product_variants WHERE id=$1", [variantId])).rows[0];
    const source = await readSource();
    const provider = syncProviderFixture(), prepared = await provider.prepare();
    prepared.draft.inventoryItems[0].packageSource = { productId: 20, variantId,
      facts: { weightGrams: source.weight_grams }, requirements: { weight: true, dimensions: "recommended" } };
    const draft = await prepareEbayListingPackages(provider.client, prepared.draft);
    await new EbayMarketplaceListingConnector({ delay: async () => {} }).syncExistingListing({ client: provider.client, draft, identity: prepared.identity });
    expect(vi.mocked(provider.client.createOrReplaceInventoryItem).mock.calls[0][1].packageWeightAndSize?.weight)
      .toEqual({ value: expectedOunces, unit: "OUNCE" });

    const sent: Array<{ product: { variants: Array<{ weight: number; weight_unit: string }> } }> = [];
    const shopify = new ShopifyMarketplaceListingConnector({ fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ product: { id: "100", variants: [{ id: "200", sku: source.sku }] } }));
    }) });
    const listing: ChannelListingPayload = { productId: 20, title: "Product A", description: null, category: null,
      tags: null, status: "active", images: [], variants: [{ variantId, sku: source.sku, name: "Pack",
        barcode: null, gtin: null, mpn: null, weightGrams: Number(source.weight_grams), priceCents: 1000,
        compareAtPriceCents: null, isListed: true, externalVariantId: null, externalInventoryItemId: null }] };
    const request = { credentials: { shopDomain: "example.myshopify.com", accessToken: "test", apiVersion: "2026-04" }, listing };
    await shopify.pushChannelListing(request);
    await shopify.pushChannelListing(request);
    expect(sent[0].product.variants[0]).toMatchObject({ weight: expectedOunces, weight_unit: "oz" });
    expect(sent[1]).toEqual(sent[0]);
    expect(await readSource()).toEqual(source);
    expect(listing.variants[0].weightGrams).toBe(Number(source.weight_grams));
    expect((await database.pool.query("SELECT count(*)::int AS n FROM marketplace.listing_intent_changes")).rows[0].n).toBe(beforeChanges);
  });
});
