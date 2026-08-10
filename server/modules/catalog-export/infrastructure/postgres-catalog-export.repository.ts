import { asc, eq, gt } from "drizzle-orm";
import { productVariants, products } from "@shared/schema";
import { db } from "../../../db";
import type { CatalogExportRepository } from "../application/catalog-export.service";

export class PostgresCatalogExportRepository implements CatalogExportRepository {
  constructor(private readonly database: typeof db = db) {}

  async listVariantSnapshots(input: {
    afterVariantId: number | null;
    limit: number;
  }) {
    return this.database.select({
      variantId: productVariants.id,
      productId: products.id,
      variantName: productVariants.name,
      productName: products.name,
      variantSku: productVariants.sku,
      productSku: products.sku,
      gtin: productVariants.gtin,
      barcode: productVariants.barcode,
      mpn: productVariants.mpn,
      brand: products.brand,
      baseUnit: products.baseUnit,
      inventoryType: products.inventoryType,
      productStatus: products.status,
      productIsActive: products.isActive,
      variantIsActive: productVariants.isActive,
      productUpdatedAt: products.updatedAt,
      variantUpdatedAt: productVariants.updatedAt,
    })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(input.afterVariantId === null
        ? undefined
        : gt(productVariants.id, input.afterVariantId))
      .orderBy(asc(productVariants.id))
      .limit(input.limit);
  }
}
