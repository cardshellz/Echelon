export const VARIANT_SALES_ELIGIBILITIES = ["sellable", "internal_only"] as const;

export type VariantSalesEligibility = typeof VARIANT_SALES_ELIGIBILITIES[number];

// PostgreSQL two-key advisory-lock namespace shared by the catalog transition
// and every promise writer that must serialize with it.
export const VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE = 918424;

export interface VariantSalesEligibilityIdentity {
  salesEligibility?: VariantSalesEligibility | null;
}

/**
 * Catalog-level customer promise identity.
 *
 * `internal_only` variants remain valid physical inventory and transformation
 * identities, but they can never be selected, listed, allocated, published, or
 * reserved as customer-facing SKUs. Missing/null values retain the historical
 * sellable default while older projections and test fixtures are migrated.
 */
export function isCustomerSellableVariant(
  variant: VariantSalesEligibilityIdentity,
): boolean {
  return variant.salesEligibility === undefined
    || variant.salesEligibility === null
    || variant.salesEligibility === "sellable";
}
