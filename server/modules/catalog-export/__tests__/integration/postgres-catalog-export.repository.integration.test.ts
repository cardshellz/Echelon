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

describeWithDisposableDb("catalog export PostgreSQL repository", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    db = getTestDb();
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateTestData();
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
});
