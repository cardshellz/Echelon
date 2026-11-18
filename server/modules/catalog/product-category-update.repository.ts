import { eq } from "drizzle-orm";
import { productCategories, products, type ProductCategory } from "@shared/schema";
import type { db } from "../../db";
import { retryPublicationSelectionWrite } from "../inventory-planning/publication-selection-retry";

/** Lock not available (a held publication gate or cutover fence), deadlock, serialization failure. */
const BUSY_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "40P01", "40001"]);

export const PRODUCT_CATEGORY_BUSY = {
  code: "PRODUCT_CATEGORY_BUSY",
  error: "Inventory is busy right now, so this category was not saved. Try again in a moment.",
} as const;

export type ProductCategoryChanges = Partial<Pick<ProductCategory, "name" | "slug" | "description" | "sortOrder" | "isActive">>;

export interface ProductCategoryUpdateOptions {
  sleep?: (milliseconds: number) => Promise<void>;
}

export function isProductCategoryBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && BUSY_SQLSTATES.has(code);
}

/**
 * Saves one category, or nothing. Returns null when the category does not exist.
 * The denormalized name on catalog.products is the only other copy, so that
 * table is written only by a rename: its writer triggers can refuse any
 * statement, even one that matches no rows, and an archive has no reason to
 * depend on them.
 */
export async function updateProductCategory(
  database: Pick<typeof db, "transaction">,
  id: number,
  changes: ProductCategoryChanges,
  options: ProductCategoryUpdateOptions = {},
): Promise<ProductCategory | null> {
  return retryPublicationSelectionWrite(() => database.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(productCategories)
      .where(eq(productCategories.id, id))
      .for("no key update");
    if (!existing) return null;

    const [category] = await tx
      .update(productCategories)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(productCategories.id, id))
      .returning();

    if (category.name !== existing.name) {
      await tx
        .update(products)
        .set({ category: category.name, updatedAt: new Date() })
        .where(eq(products.categoryId, id));
    }
    return category;
  }), { sleep: options.sleep, isRetryable: isProductCategoryBusy });
}
