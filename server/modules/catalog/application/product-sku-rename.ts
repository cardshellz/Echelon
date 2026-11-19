import { synchronizeProcurementSkuReferences } from "../../procurement";
import { MAX_SKU_LENGTH } from "@shared/catalog/product-merge";
import { deriveVariantSku } from "../domain/product-merge";

/**
 * When a product's SKU changes, every variant SKU equal to, or prefixed by,
 * the old product SKU follows it, and the operational SKU caches (bins, WMS
 * order items, picking logs, order financials, procurement references) are
 * renamed in the same transaction. Shared by the product edit route and the
 * product merge so both rename identically.
 */
export interface ProductSkuRenameStorage {
  getProductVariantsByProductId(productId: number, executor?: any): Promise<Array<{ id: number; sku: string | null }>>;
  updateProductVariant(id: number, updates: { sku: string }, executor?: any): Promise<unknown>;
  cascadeOperationalSkuRename(variantId: number, oldSku: string, newSku: string, executor?: any): Promise<void>;
}

export class ProductSkuRenameError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); this.name = "ProductSkuRenameError"; }
}

/** Returns the number of variants renamed. The caller owns the transaction and
 * has already locked the product and its variants. */
export async function renameDerivedVariantSkus(
  tx: any,
  storage: ProductSkuRenameStorage,
  input: { productId: number; oldProductSku: string | null; newProductSku: string | null; actor: string },
): Promise<number> {
  const { oldProductSku, newProductSku } = input;
  if (!newProductSku || !oldProductSku || newProductSku === oldProductSku) return 0;
  let renamed = 0;
  const variants = await storage.getProductVariantsByProductId(input.productId, tx);
  for (const variant of variants) {
    const oldVariantSku = variant.sku;
    const newVariantSku = deriveVariantSku(oldProductSku, newProductSku, oldVariantSku);
    if (!oldVariantSku || !newVariantSku || newVariantSku === oldVariantSku) continue;
    if (newVariantSku.length > MAX_SKU_LENGTH) {
      throw new ProductSkuRenameError(`Derived variant SKU exceeds ${MAX_SKU_LENGTH} characters: ${newVariantSku}`, 400);
    }
    const updated = await storage.updateProductVariant(variant.id, { sku: newVariantSku }, tx);
    if (!updated) throw new Error(`Variant ${variant.id} disappeared during SKU rename`);
    await storage.cascadeOperationalSkuRename(variant.id, oldVariantSku, newVariantSku, tx);
    await synchronizeProcurementSkuReferences({
      productVariantId: variant.id, oldSku: oldVariantSku, newSku: newVariantSku, actor: input.actor,
    }, { executor: tx });
    renamed++;
  }
  return renamed;
}
