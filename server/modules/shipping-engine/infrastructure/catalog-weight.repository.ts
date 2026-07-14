import { and, inArray, isNotNull } from "drizzle-orm";
import { productVariants } from "@shared/schema";
import { db } from "../../../db";

/** Load canonical Echelon variant weights by exact SKU in one query. */
export async function loadCatalogWeightsBySku(
  skus: readonly string[],
): Promise<Map<string, number | null>> {
  const uniqueSkus = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
  if (uniqueSkus.length === 0) return new Map();

  const rows = await db
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      weightGrams: productVariants.weightGrams,
    })
    .from(productVariants)
    .where(and(
      isNotNull(productVariants.sku),
      inArray(productVariants.sku, uniqueSkus),
    ));

  const winnerBySku = new Map<string, { id: number; weightGrams: number | null }>();
  for (const row of rows) {
    if (row.sku == null) continue;
    const incumbent = winnerBySku.get(row.sku);
    if (!incumbent || row.id < incumbent.id) {
      winnerBySku.set(row.sku, { id: row.id, weightGrams: row.weightGrams });
    }
  }

  return new Map(
    [...winnerBySku].map(([sku, value]) => [sku, value.weightGrams]),
  );
}
