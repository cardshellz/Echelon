import { productLineProducts, type ProductLineProduct } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";

export interface ProductLineMembershipExecutor {
  insert: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

export async function replaceProductLineProductsInCatalog(
  executor: ProductLineMembershipExecutor,
  lineId: number,
  productIds: number[],
): Promise<void> {
  await executor.delete(productLineProducts).where(eq(productLineProducts.productLineId, lineId));
  if (productIds.length > 0) {
    await executor
      .insert(productLineProducts)
      .values(productIds.map((pid: number) => ({ productLineId: lineId, productId: pid })))
      .onConflictDoNothing();
  }
}

export async function addProductToProductLineInCatalog(
  executor: ProductLineMembershipExecutor,
  lineId: number,
  productId: number,
): Promise<ProductLineProduct | null> {
  const [created] = await executor
    .insert(productLineProducts)
    .values({
      productLineId: lineId,
      productId,
    })
    .onConflictDoNothing()
    .returning();
  return created || null;
}

export async function removeProductFromProductLineInCatalog(
  executor: ProductLineMembershipExecutor,
  lineId: number,
  productId: number,
): Promise<void> {
  await executor
    .delete(productLineProducts)
    .where(and(eq(productLineProducts.productLineId, lineId), eq(productLineProducts.productId, productId)));
}

export async function addProductsToProductLineInCatalog(
  executor: ProductLineMembershipExecutor,
  lineId: number,
  productIds: number[],
): Promise<number> {
  if (productIds.length === 0) return 0;
  const result = await executor
    .insert(productLineProducts)
    .values(productIds.map((pid: number) => ({ productLineId: lineId, productId: pid })))
    .onConflictDoNothing()
    .returning({ id: productLineProducts.id });
  return result.length;
}

export async function removeProductsFromLineInCatalog(
  executor: ProductLineMembershipExecutor,
  lineId: number,
  productIds: number[],
): Promise<number> {
  if (productIds.length === 0) return 0;
  const result = await executor
    .delete(productLineProducts)
    .where(
      and(
        eq(productLineProducts.productLineId, lineId),
        inArray(productLineProducts.productId, productIds),
      ),
    )
    .returning({ id: productLineProducts.id });
  return result.length;
}

export async function removeProductsFromAllLinesInCatalog(
  executor: ProductLineMembershipExecutor,
  productIds: number[],
): Promise<number> {
  if (productIds.length === 0) return 0;
  const result = await executor
    .delete(productLineProducts)
    .where(inArray(productLineProducts.productId, productIds))
    .returning({ id: productLineProducts.id });
  return result.length;
}
