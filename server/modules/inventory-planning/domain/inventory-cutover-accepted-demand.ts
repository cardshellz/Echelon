import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { cutoverLineIdentityConflicts, cutoverLineTracksInventory } from "@shared/inventory/cutover-line-policy";

type AcceptedDemand = CutoverReconstructionEvidence["acceptedOmsDemand"][number];
type Item = CutoverReconstructionEvidence["items"][number];
type Variant = CutoverReconstructionEvidence["variants"][number];

/** Coverage is exact line/catalog identity, not provider display text. Blank
 * provider SKUs are allowed only when both owners name the same catalog variant.
 * This proves identity only: quantity, terminal fulfillment and custody checks
 * remain the caller's responsibility for stock and non-stock lines alike. */
export function acceptedDemandIdentityMatches(
  demand: AcceptedDemand,
  item: Item,
  skuVariants: readonly Variant[],
): boolean {
  // The OMS census contains accepted shipping demand. A digital WMS row must
  // not count as its coverage merely because both owners are non-stock.
  if (item.requiresShipping !== 1) return false;
  if (demand.inventoryTracking != null && item.inventoryTracking != null
    && demand.inventoryTracking !== item.inventoryTracking) return false;
  const exactVariantId = demand.productVariantId !== null && demand.productVariantId === item.productId
    ? demand.productVariantId : null;
  const candidates = skuVariants.filter(variant => exactVariantId !== null ? variant.id === exactVariantId : variant.isActive);
  if (candidates.length !== 1) return false;
  const variant = candidates[0];
  if (cutoverLineIdentityConflicts(item, variant)
    || (demand.catalogProductId != null && demand.catalogProductId !== variant.productId)
    || (demand.productVariantId !== null && demand.productVariantId !== variant.id)
    || (demand.inventoryTracking != null && demand.inventoryTracking !== cutoverLineTracksInventory(item, variant))) return false;

  const sourceSku = demand.sku?.trim();
  if (sourceSku) return sourceSku.toUpperCase() === item.sku.toUpperCase();
  return demand.productVariantId === variant.id && item.productId === variant.id;
}
