import type { ProductAssetScopeCommand } from "@shared/catalog/product-asset-scope";
import { ProductAssetError } from "./product-asset-errors";

/** Validate the observed assignment before treating a new command as a no-op. */
export function planProductAssetScopeChange(currentVariantId: number | null, command: ProductAssetScopeCommand): boolean {
  if (currentVariantId !== command.expectedProductVariantId) {
    throw new ProductAssetError("ASSET_SCOPE_CHANGED", "This photo's assignment changed in another session. Review the refreshed gallery and try again.", 409);
  }
  return currentVariantId !== command.productVariantId;
}
