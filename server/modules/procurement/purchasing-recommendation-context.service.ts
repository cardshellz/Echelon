import { sql } from "drizzle-orm";
import { db } from "../../db";
import type {
  PurchasingRecommendationDefaults,
  PurchasingRecommendationExclusionRule,
  PurchasingRecommendationProductMeta,
} from "./purchasing-recommendation.engine";

export async function loadPurchasingRecommendationDefaults(): Promise<PurchasingRecommendationDefaults> {
  const defaultsQuery = await db.execute(sql`
    SELECT key, value FROM warehouse.echelon_settings
    WHERE key IN ('default_lead_time_days','default_safety_stock_days')
  `);
  const defaultsMap = new Map<string, string>();
  for (const row of defaultsQuery.rows as any[]) defaultsMap.set(row.key, row.value);

  return {
    leadTimeDays: Number.parseInt(defaultsMap.get("default_lead_time_days") ?? "14", 10) || 14,
    safetyStockDays: Number.parseInt(defaultsMap.get("default_safety_stock_days") ?? "7", 10) || 7,
  };
}

export async function loadPurchasingRecommendationContext(): Promise<{
  defaults: PurchasingRecommendationDefaults;
  rules: PurchasingRecommendationExclusionRule[];
  productMetaById: Map<number, PurchasingRecommendationProductMeta>;
}> {
  const { products: productsTable, reorderExclusionRules: exclRules } = await import("../../storage/base");
  const [defaults, rules, metaRows] = await Promise.all([
    loadPurchasingRecommendationDefaults(),
    db.select().from(exclRules),
    db.execute(sql`
      SELECT id, category, brand, product_type, sku, tags, reorder_excluded
      FROM ${productsTable}
      WHERE is_active = true
    `),
  ]);

  const productMetaById = new Map<number, PurchasingRecommendationProductMeta>();
  for (const row of metaRows.rows as any[]) {
    productMetaById.set(Number(row.id), row);
  }

  return {
    defaults,
    rules: rules as PurchasingRecommendationExclusionRule[],
    productMetaById,
  };
}
