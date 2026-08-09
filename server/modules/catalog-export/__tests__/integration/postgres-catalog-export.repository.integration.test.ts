import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { productVariants, products } from "@shared/schema";
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
});
