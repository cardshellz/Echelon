import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  productVariants,
  products,
  shippingGroups,
} from "@shared/schema";
import { db } from "../../../db";
import { numericToNumber } from "@shared/utils/measurements";

export interface CatalogShippingFact {
  productVariantId: number;
  weightGrams: number | null;
  shippingGroupCode: string | null;
  shipsInOwnContainer: boolean;
}

export interface CatalogShippingFactByVariant extends CatalogShippingFact {
  sku: string | null;
}

/** Load immutable quote facts by exact SKU in one bounded query. */
export async function loadCatalogShippingFactsBySku(
  skus: readonly string[],
): Promise<Map<string, CatalogShippingFact>> {
  const uniqueSkus = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
  if (uniqueSkus.length === 0) return new Map();

  const rows = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      weightGrams: productVariants.weightGrams,
      shippingGroupCode: shippingGroups.code,
      // Canonical SIOC home is catalog.product_variants (migration 185).
      shipsInOwnContainer: productVariants.shipsInOwnContainer,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(shippingGroups, eq(shippingGroups.id, products.shippingGroupId))
    .where(and(
      isNotNull(productVariants.sku),
      inArray(productVariants.sku, uniqueSkus),
    ));

  const winnerBySku = new Map<string, CatalogShippingFact>();
  for (const row of rows) {
    if (row.sku == null) continue;
    const incumbent = winnerBySku.get(row.sku);
    if (!incumbent || row.id < incumbent.productVariantId) {
      winnerBySku.set(row.sku, {
        productVariantId: row.id,
        weightGrams: numericToNumber(row.weightGrams),
        shippingGroupCode: row.shippingGroupCode,
        shipsInOwnContainer: row.shipsInOwnContainer ?? false,
      });
    }
  }
  return winnerBySku;
}

/** Load canonical Echelon variant weights by exact SKU in one query. */
export async function loadCatalogWeightsBySku(
  skus: readonly string[],
): Promise<Map<string, number | null>> {
  const facts = await loadCatalogShippingFactsBySku(skus);
  return new Map([...facts].map(([sku, value]) => [sku, value.weightGrams]));
}

/** Load canonical quote facts by exact product-variant ID in one bounded query. */
export async function loadCatalogShippingFactsByVariantIds(
  productVariantIds: readonly number[],
): Promise<Map<number, CatalogShippingFactByVariant>> {
  const uniqueIds = [...new Set(productVariantIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  if (uniqueIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      weightGrams: productVariants.weightGrams,
      shippingGroupCode: shippingGroups.code,
      shipsInOwnContainer: productVariants.shipsInOwnContainer,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(shippingGroups, eq(shippingGroups.id, products.shippingGroupId))
    .where(inArray(productVariants.id, uniqueIds));

  return new Map(rows.map((row) => [
    row.id,
    {
      productVariantId: row.id,
      sku: row.sku,
      weightGrams: numericToNumber(row.weightGrams),
      shippingGroupCode: row.shippingGroupCode,
      shipsInOwnContainer: row.shipsInOwnContainer ?? false,
    },
  ]));
}
