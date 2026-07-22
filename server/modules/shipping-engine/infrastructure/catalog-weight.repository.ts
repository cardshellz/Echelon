import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  productVariants,
  products,
  shippingGroups,
  shippingVariantAttrs,
} from "@shared/schema";
import { db } from "../../../db";

export interface CatalogShippingFact {
  productVariantId: number;
  weightGrams: number | null;
  shippingGroupCode: string | null;
  shipsInOwnContainer: boolean;
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
      shipsInOwnContainer: shippingVariantAttrs.shipsInOwnContainer,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(shippingGroups, eq(shippingGroups.id, products.shippingGroupId))
    .leftJoin(shippingVariantAttrs, eq(shippingVariantAttrs.productVariantId, productVariants.id))
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
        weightGrams: row.weightGrams,
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
