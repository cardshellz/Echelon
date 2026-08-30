export interface VariantInventoryEligibility {
  requiresShipping?: boolean | null;
  trackInventory?: boolean | null;
}

/**
 * A variant participates in warehouse inventory only when it is both a
 * shippable item and inventory-managed. Null preserves the legacy default of
 * enabled until every historical row has been normalized.
 */
export function isInventoryManagedVariant(
  variant: VariantInventoryEligibility,
): boolean {
  return variant.requiresShipping !== false && variant.trackInventory !== false;
}

export function isDigitalVariant(
  variant: Pick<VariantInventoryEligibility, "requiresShipping">,
): boolean {
  return variant.requiresShipping === false;
}
