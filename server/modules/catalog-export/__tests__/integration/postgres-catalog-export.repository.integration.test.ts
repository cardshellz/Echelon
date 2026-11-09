import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  channelConnections,
  channelFeeds,
  channels,
  productVariants,
  products,
} from "@shared/schema";
import {
  closeTestDb,
  describeWithDisposableDb,
  getTestDb,
  runMigrations,
  truncateTestData,
} from "../../../../../test/setup-integration";
import { PostgresCatalogExportRepository } from "../../infrastructure/postgres-catalog-export.repository";

const CATALOG_EXPORT_CHANNEL_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS channels.channel_connections (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
    shop_domain varchar(255),
    access_token text,
    refresh_token text,
    webhook_secret varchar(255),
    api_version varchar(20),
    scopes text,
    shopify_location_id varchar(50),
    expires_at timestamp,
    last_sync_at timestamp,
    sync_status varchar(20) DEFAULT 'never',
    sync_error text,
    metadata jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    UNIQUE (id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS channels.channel_feeds (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id integer REFERENCES channels.channels(id) ON DELETE CASCADE,
    product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
    channel_type varchar(30) NOT NULL DEFAULT 'shopify',
    channel_variant_id varchar(100),
    channel_product_id varchar(100),
    channel_sku varchar(100),
    channel_inventory_item_id varchar(100),
    is_active integer NOT NULL DEFAULT 1,
    last_synced_at timestamp,
    last_synced_qty integer,
    consecutive_push_failures integer NOT NULL DEFAULT 0,
    quarantined_at timestamp,
    quarantine_reason text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    UNIQUE (channel_id, product_variant_id),
    CONSTRAINT channel_feeds_active_identity_chk
      CHECK (is_active = 0 OR NULLIF(btrim(channel_variant_id), '') IS NOT NULL)
  );
`;

describeWithDisposableDb("catalog export PostgreSQL repository", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    db = getTestDb();
    await runMigrations();
    await db.execute(sql.raw(CATALOG_EXPORT_CHANNEL_TABLES_SQL));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateTestData();
    await db.execute(
      sql.raw("TRUNCATE TABLE channels.channel_feeds, channels.channel_connections RESTART IDENTITY CASCADE"),
    );
  });

  it("joins product and variant identity using monotonic keyset pagination", async () => {
    const [product] = await db.insert(products).values({
      sku: "FAMILY-1",
      name: "Catalog family",
      brand: "Card Shellz",
      inventoryType: "inventory",
      status: "active",
      isActive: true,
      updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    }).returning();
    const variants = await db.insert(productVariants).values([
      {
        productId: product.id,
        sku: "VARIANT-1",
        name: "First variant",
        gtin: "00000000000001",
        isActive: true,
        updatedAt: new Date("2026-08-02T12:00:00.000Z"),
      },
      {
        productId: product.id,
        sku: "VARIANT-2",
        name: "Second variant",
        gtin: "00000000000002",
        isActive: true,
        updatedAt: new Date("2026-08-03T12:00:00.000Z"),
      },
      {
        productId: product.id,
        sku: "VARIANT-3",
        name: "Third variant",
        gtin: "00000000000003",
        isActive: false,
        updatedAt: new Date("2026-08-04T12:00:00.000Z"),
      },
    ]).returning();
    const repository = new PostgresCatalogExportRepository(db);

    const rows = await repository.listVariantSnapshots({
      afterVariantId: variants[0].id,
      limit: 2,
    });

    expect(rows.map((row) => row.variantId)).toEqual([variants[1].id, variants[2].id]);
    expect(rows[0]).toMatchObject({
      productId: product.id,
      productName: "Catalog family",
      productSku: "FAMILY-1",
      variantName: "Second variant",
      variantSku: "VARIANT-2",
      inventoryType: "inventory",
      productIsActive: true,
      variantIsActive: true,
    });
    expect(rows[1].variantIsActive).toBe(false);
  });

  it("exports inactive channel mappings as historical accounting identity evidence", async () => {
    const [product] = await db.insert(products).values({
      sku: "DONATION-FAMILY",
      name: "Customer donation",
      inventoryType: "non_inventory",
      status: "active",
      isActive: true,
    }).returning();
    const [variant] = await db.insert(productVariants).values({
      productId: product.id,
      sku: "SHOPIFY-WWP",
      name: "Wounded Warrior Project",
      isActive: true,
    }).returning();
    const [channel] = await db.insert(channels).values({
      name: "Card Shellz Shopify",
      type: "internal",
      provider: "shopify",
      status: "active",
    }).returning();
    await db.insert(channelConnections).values({
      channelId: channel.id,
      shopDomain: "Card-Shellz.MyShopify.com",
    });
    await db.insert(channelFeeds).values({
      channelId: channel.id,
      productVariantId: variant.id,
      channelType: "shopify",
      channelVariantId: "62621541925023",
      channelProductId: "9000000000001",
      channelSku: "SHOPIFY-WWP",
      isActive: 0,
    });
    const repository = new PostgresCatalogExportRepository(db);

    const rows = await repository.listVariantSnapshots({
      afterVariantId: null,
      limit: 10,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].externalIdentifiers).toEqual([
      {
        provider: "shopify",
        scope: "card-shellz.myshopify.com",
        identifierType: "variant_id",
        value: "62621541925023",
      },
      {
        provider: "shopify",
        scope: "card-shellz.myshopify.com",
        identifierType: "product_id",
        value: "9000000000001",
      },
      {
        provider: "shopify",
        scope: "card-shellz.myshopify.com",
        identifierType: "sku",
        value: "SHOPIFY-WWP",
      },
    ]);
  });

  it("does not export a relinquished remote identity from a retained inactive feed", async () => {
    const [product] = await db.insert(products).values({
      sku: "ARCHIVED-FAMILY",
      name: "Archived duplicate",
      inventoryType: "inventory",
      status: "archived",
      isActive: false,
    }).returning();
    const [variant] = await db.insert(productVariants).values({
      productId: product.id,
      sku: "ARCHIVED-SKU",
      name: "Archived duplicate pack",
      isActive: false,
    }).returning();
    const [channel] = await db.insert(channels).values({
      name: "Card Shellz Shopify",
      type: "internal",
      provider: "shopify",
      status: "active",
    }).returning();
    await db.insert(channelConnections).values({
      channelId: channel.id,
      shopDomain: "cardshellz.myshopify.com",
    });
    await db.insert(channelFeeds).values({
      channelId: channel.id,
      productVariantId: variant.id,
      channelType: "shopify",
      channelVariantId: null,
      channelProductId: null,
      channelSku: "ARCHIVED-SKU",
      isActive: 0,
    });

    const rows = await new PostgresCatalogExportRepository(db)
      .listVariantSnapshots({ afterVariantId: null, limit: 10 });

    expect(rows[0].externalIdentifiers).toEqual([{
      provider: "shopify",
      scope: "cardshellz.myshopify.com",
      identifierType: "sku",
      value: "ARCHIVED-SKU",
    }]);
  });
});
