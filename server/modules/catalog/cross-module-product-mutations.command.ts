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
): Promise<void> {
  await executor.execute(sql`
    UPDATE catalog.product_variants
    SET last_cost_cents = ${unitCostCents},
        standard_cost_cents = CASE
          WHEN standard_cost_cents IS NULL OR standard_cost_cents = 0
          THEN ${unitCostCents}
          ELSE standard_cost_cents
        END,
        updated_at = NOW()
    WHERE id = ${variantId}
  `);
}

export async function updateVariantReceiptCostRollupInCatalog(
  executor: { update: (...args: any[]) => any },
  input: {
    productVariantId: number;
    lastCostCents: number;
    avgCostCents: number;
    updatedAt?: Date;
  },
): Promise<void> {
  await executor
    .update(productVariants)
    .set({
      lastCostCents: input.lastCostCents,
      avgCostCents: input.avgCostCents,
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
