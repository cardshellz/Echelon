import type { WmsCutoverDemandItem } from "../types/inventory-cutover-demand";

type VariantPolicy = {
  id: number; productId: number; requiresShipping: boolean; trackInventory: boolean;
};

/** Inputs are validated census DTOs. Saved order policy wins over today's catalog
 * defaults. Older captures/unsnapshotted orders retain the explicit catalog
 * fallback; absent catalog evidence is unknown, not permission to omit demand. */
export function cutoverLineTracksInventory(
  item: WmsCutoverDemandItem,
  variant: VariantPolicy | null,
): boolean | null {
  if (item.requiresShipping === 0) return false;
  if (item.requiresShipping !== 1) return null;
  return item.inventoryTracking ?? (variant ? variant.requiresShipping && variant.trackInventory : null);
}

/** Historic WMS product_id could mean either product or variant. A saved catalog
 * product snapshot disambiguates it; never ignore a conflicting explicit ID. */
export function cutoverLineIdentityConflicts(item: WmsCutoverDemandItem, variant: VariantPolicy): boolean {
  if (item.catalogProductId != null) {
    return item.catalogProductId !== variant.productId || item.productId !== variant.id;
  }
  return item.productId !== null && item.productId !== variant.id && item.productId !== variant.productId;
}
