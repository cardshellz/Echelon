export interface VariantAvailabilityTargetInput {
  desiredActive: boolean;
  catalogVariantActive: boolean;
  catalogProductActive: boolean;
  catalogProductStatus: string | null;
  productExcluded: boolean | null;
  variantExcluded: boolean | null;
  productOverrideIsListed: number | boolean | null;
  variantOverrideIsListed: number | boolean | null;
  allocatedQuantity: number;
}

export interface VariantAvailabilityTarget {
  feedActive: boolean;
  channelEligible: boolean;
  quantity: number;
}

function isListed(value: number | boolean | null): boolean {
  return value !== 0 && value !== false;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

/**
 * Resolve the marketplace quantity implied by catalog availability.
 *
 * Variant is_active is the authoritative feed gate. Physical inventory stays
 * in Echelon while an inactive variant receives marketplace quantity zero.
 * Independent channel exclusions remain stricter quantity gates without
 * changing the catalog lifecycle state.
 */
export function resolveVariantAvailabilityTarget(
  input: VariantAvailabilityTargetInput,
): VariantAvailabilityTarget {
  assertNonNegativeInteger(input.allocatedQuantity, "allocatedQuantity");

  const feedActive = input.desiredActive && input.catalogVariantActive;
  const channelEligible =
    feedActive &&
    input.catalogProductActive &&
    input.catalogProductStatus === "active" &&
    input.productExcluded !== true &&
    input.variantExcluded !== true &&
    isListed(input.productOverrideIsListed) &&
    isListed(input.variantOverrideIsListed);

  return {
    feedActive,
    channelEligible,
    quantity: channelEligible ? input.allocatedQuantity : 0,
  };
}
