import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { cutoverLineIdentityConflicts, cutoverLineTracksInventory, isProductOnlyNonInventoryLine } from "@shared/inventory/cutover-line-policy";

type AcceptedDemand = CutoverReconstructionEvidence["acceptedOmsDemand"][number];
type Item = CutoverReconstructionEvidence["items"][number];
type Variant = CutoverReconstructionEvidence["variants"][number];

/** Materialization records the original WMS obligation. Provider authority can
 * subsequently report only the unfulfilled balance. Accept either proven basis,
 * but never turn a reduction beyond recorded fulfillment into fresh demand. */
export function acceptedDemandQuantitiesMatch(demand: AcceptedDemand, items: readonly Item[]): boolean {
  if (items.length === 0 || items.some(item => item.quantity < 0 || item.fulfilledQuantity < 0
    || item.fulfilledQuantity > item.quantity)) return false;
  const original = items.reduce((total, item) => total + BigInt(item.quantity), BigInt(0));
  const remaining = items.reduce((total, item) => total + BigInt(item.quantity - item.fulfilledQuantity), BigInt(0));
  const authorized = BigInt(demand.authorizedQty);
  return original > BigInt(0) && BigInt(demand.materializedQty) === original
    && (authorized === original || authorized === remaining);
}

/** Coverage is exact line/catalog identity, not provider display text. A saved
 * product-only non-stock identity does not require a stock variant. Otherwise,
 * blank provider SKUs require both owners to name the same catalog variant.
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
  if (isProductOnlyNonInventoryLine(item)) {
    return demand.inventoryTracking === false && demand.catalogProductId === item.catalogProductId
      && demand.productVariantId === null;
  }
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
