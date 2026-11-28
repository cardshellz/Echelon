import { products, productVariants, type Product } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

export async function updateVariantWeightIfNullInCatalog(
  executor: { update: (...args: any[]) => any },
  variantId: number,
  grams: number,
): Promise<boolean> {
  const rows = await executor
    .update(productVariants)
    .set({ weightGrams: grams, updatedAt: new Date() })
    .where(and(eq(productVariants.id, variantId), isNull(productVariants.weightGrams)))
    .returning({ id: productVariants.id });

  return rows.length > 0;
}

export async function updateVariantBackfillCostsInCatalog(
  executor: { execute: (...args: any[]) => any },
  variantId: number,
  unitCostCents: number,
  unitCostMills?: number,
): Promise<void> {
  const resolvedMills = unitCostMills ?? unitCostCents * 100;
  await executor.execute(sql`
    WITH lot_rollup AS (
      SELECT
        CASE
          WHEN COALESCE(SUM(qty_on_hand), 0) > 0 THEN
            ROUND(
              SUM(qty_on_hand::numeric * COALESCE(total_unit_cost_mills, unit_cost_mills, COALESCE(unit_cost_cents, 0)::numeric * 100))
              / SUM(qty_on_hand::numeric),
              0
            )::bigint
          ELSE NULL
        END AS avg_mills
      FROM inventory.inventory_lots
      WHERE product_variant_id = ${variantId}
        AND status = 'active'
        AND qty_on_hand > 0
    )
    UPDATE catalog.product_variants pv
    SET last_cost_cents = ${unitCostCents},
        last_cost_mills = ${resolvedMills},
        avg_cost_mills = COALESCE(lot_rollup.avg_mills, ${resolvedMills}),
        avg_cost_cents = ROUND(COALESCE(lot_rollup.avg_mills, ${resolvedMills})::numeric / 100, 0)::integer,
        standard_cost_cents = CASE
          WHEN pv.standard_cost_cents IS NULL OR pv.standard_cost_cents = 0
          THEN ${unitCostCents}
          ELSE pv.standard_cost_cents
        END,
        standard_cost_mills = CASE
          WHEN pv.standard_cost_mills IS NULL OR pv.standard_cost_mills = 0
          THEN ${resolvedMills}
          ELSE pv.standard_cost_mills
        END,
        updated_at = NOW()
    FROM lot_rollup
    WHERE pv.id = ${variantId}
  `);
}

export async function syncVariantCostRollupFromLotsInCatalog(
  executor: { execute: (...args: any[]) => any },
  input: {
    productVariantId: number;
    lastCostMills?: number | null;
    updatedAt?: Date;
  },
): Promise<void> {
  const hasExplicitLast = input.lastCostMills !== undefined && input.lastCostMills !== null && input.lastCostMills > 0;
  const explicitLastMills = hasExplicitLast ? input.lastCostMills! : null;
  const explicitLastCents = hasExplicitLast ? Math.round((explicitLastMills! + 50) / 100) : null;
  const ts = input.updatedAt ?? new Date();
  await executor.execute(sql`
    WITH lot_rollup AS (
      SELECT
        CASE
          WHEN COALESCE(SUM(qty_on_hand), 0) > 0 THEN
            ROUND(
              SUM(qty_on_hand::numeric * COALESCE(total_unit_cost_mills, unit_cost_mills, COALESCE(unit_cost_cents, 0)::numeric * 100))
              / SUM(qty_on_hand::numeric),
              0
            )::bigint
          ELSE NULL
        END AS avg_mills
      FROM inventory.inventory_lots
      WHERE product_variant_id = ${input.productVariantId}
        AND status = 'active'
        AND qty_on_hand > 0
    )
    UPDATE catalog.product_variants pv
    SET avg_cost_mills = COALESCE(lot_rollup.avg_mills, ${explicitLastMills}, pv.avg_cost_mills),
        avg_cost_cents = CASE
          WHEN COALESCE(lot_rollup.avg_mills, ${explicitLastMills}) IS NOT NULL
          THEN ROUND(COALESCE(lot_rollup.avg_mills, ${explicitLastMills})::numeric / 100, 0)::integer
          ELSE pv.avg_cost_cents
        END,
        last_cost_mills = CASE
          WHEN ${explicitLastMills}::bigint IS NOT NULL THEN ${explicitLastMills}::bigint
          ELSE pv.last_cost_mills
        END,
        last_cost_cents = CASE
          WHEN ${explicitLastCents}::integer IS NOT NULL THEN ${explicitLastCents}::integer
          ELSE pv.last_cost_cents
        END,
        updated_at = ${ts}
    FROM lot_rollup
    WHERE pv.id = ${input.productVariantId}
  `);
}

export async function updateVariantReceiptCostRollupInCatalog(
  executor: { update: (...args: any[]) => any },
  input: {
    productVariantId: number;
    lastCostCents?: number | null;
    lastCostMills?: number | null;
    avgCostCents: number;
    avgCostMills?: number | null;
    updatedAt?: Date;
  },
): Promise<void> {
  const resolvedAvgMills = input.avgCostMills ?? input.avgCostCents * 100;
  const hasExplicitLastCost =
    (input.lastCostMills !== undefined && input.lastCostMills !== null) ||
    (input.lastCostCents !== undefined && input.lastCostCents !== null);
  const resolvedLastMills = hasExplicitLastCost
    ? (input.lastCostMills ?? (input.lastCostCents! * 100))
    : undefined;
  const resolvedLastCents = hasExplicitLastCost
    ? (input.lastCostCents ?? Math.round((resolvedLastMills! + 50) / 100))
    : undefined;

  await executor
    .update(productVariants)
    .set({
      ...(hasExplicitLastCost
        ? {
            lastCostCents: resolvedLastCents,
            lastCostMills: resolvedLastMills,
          }
        : {}),
      avgCostCents: input.avgCostCents,
      avgCostMills: resolvedAvgMills,
      updatedAt: input.updatedAt ?? new Date(),
    })
    .where(eq(productVariants.id, input.productVariantId));
}

export async function updateProductFromShopifyBackfillInCatalog(
  executor: { update: (...args: any[]) => any },
  productId: number,
  values: {
    title: string;
    description: string | null | undefined;
    brand: string | null | undefined;
    category: string | null | undefined;
    tags: string[] | null;
    status: string;
    shopifyProductId: string | null;
    updatedAt?: Date;
  },
): Promise<Product> {
  const [updated] = await executor
    .update(products)
    .set({
      title: values.title,
      description: values.description,
      brand: values.brand,
      category: values.category,
      tags: values.tags,
      status: values.status,
      shopifyProductId: values.shopifyProductId,
      updatedAt: values.updatedAt ?? new Date(),
    })
    .where(eq(products.id, productId))
    .returning();
  return updated;
}

export async function insertProductFromShopifyBackfillInCatalog(
  executor: { insert: (...args: any[]) => any },
  values: {
    sku: string | null;
    name: string;
    title: string;
    description: string | null | undefined;
    brand: string | null | undefined;
    category: string | null | undefined;
    tags: string[] | null;
    status: string;
    shopifyProductId: string | null;
    baseUnit: string;
  },
): Promise<Product> {
  const [created] = await executor
    .insert(products)
    .values({
      sku: values.sku,
      name: values.name,
      title: values.title,
      description: values.description,
      brand: values.brand,
      category: values.category,
      tags: values.tags,
      status: values.status,
      shopifyProductId: values.shopifyProductId,
      baseUnit: values.baseUnit,
    })
    .returning();
  return created;
}

export async function updateProductPulledContentFieldsInCatalog(
  executor: { update: (...args: any[]) => any },
  productId: number,
  updates: Partial<{ title: string; description: string | null; updatedAt: Date }>,
): Promise<void> {
  await executor
    .update(products)
    .set(updates)
    .where(eq(products.id, productId));
}

export async function setProductReorderExcludedInCatalog(
  executor: { update: (...args: any[]) => any },
  productId: number,
  excluded: boolean,
): Promise<void> {
  await executor
    .update(products)
    .set({ reorderExcluded: excluded })
    .where(eq(products.id, productId));
}
