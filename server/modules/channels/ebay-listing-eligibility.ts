export interface EffectiveListingInput {
  productExcluded?: boolean | null;
  productOverrideIsListed?: number | boolean | null;
  variantExcluded?: boolean | null;
  variantOverrideIsListed?: number | boolean | null;
  typeListingEnabled?: boolean | null;
}

export interface VariantSellabilityInput extends EffectiveListingInput {
  productActive: boolean | null | undefined;
  variantActive: boolean | null | undefined;
  salesEligibility?: VariantSalesEligibility | null;
}

function isListedOverride(value: number | boolean | null | undefined): boolean {
  return value !== 0 && value !== false;
}

export function isProductEffectivelyListed(input: EffectiveListingInput): boolean {
  return (
    input.productExcluded !== true &&
    input.typeListingEnabled !== false &&
    isListedOverride(input.productOverrideIsListed)
  );
}

export function isVariantEffectivelyListed(input: EffectiveListingInput): boolean {
  return (
    isProductEffectivelyListed(input) &&
    input.variantExcluded !== true &&
    isListedOverride(input.variantOverrideIsListed)
  );
}

export function isVariantSellable(input: VariantSellabilityInput): boolean {
  return (
    input.productActive === true &&
    input.variantActive === true &&
    isCustomerSellableVariant(input) &&
    isVariantEffectivelyListed(input)
  );
}

import {
  isCustomerSellableVariant,
  type VariantSalesEligibility,
} from "@shared/catalog/variant-sales-eligibility";
