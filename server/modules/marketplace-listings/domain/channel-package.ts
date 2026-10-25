import { ChannelListingValidationError } from "@shared/channel-listing-validation";
import type { ChannelPackageRequirements } from "@shared/catalog/shipping-package";

export interface ListingPackageValues {
  weightGrams?: number | string | null;
  lengthMm?: number | string | null;
  widthMm?: number | string | null;
  heightMm?: number | string | null;
}
export type PackageFieldSource = "catalog" | "channel" | "absent";
export interface ChannelPackagePlan {
  values: ListingPackageValues;
  sources: { weight: PackageFieldSource; dimensions: PackageFieldSource };
}

/** One ownership rule for full-replacement channel APIs. Null is an unknown
 * catalog fact, never a request to erase a known channel fact. Dimensions are
 * atomic: combining two different packages' measurements is unsafe. */
export function prepareChannelPackage(input: {
  productId: number; variantId: number; sku: string;
  catalog: ListingPackageValues; observed: ListingPackageValues;
  requirements: ChannelPackageRequirements;
}): ChannelPackagePlan {
  const fail = (field: "package_weight" | "package_dimensions", reason: "required" | "invalid"): never => {
    throw new ChannelListingValidationError({ field, reason, productId: input.productId,
      variantId: input.variantId, variantSku: input.sku });
  };
  const positive = (value: number | string | null | undefined, field: "package_weight" | "package_dimensions"): number | null => {
    if (value === null || value === undefined) return null;
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return fail(field, "invalid");
    return number;
  };
  const sourceFor = (present: boolean, observed: boolean): PackageFieldSource => present ? "catalog" : observed ? "channel" : "absent";
  const weightSource = sourceFor(input.catalog.weightGrams != null, input.observed.weightGrams != null);
  const weightGrams = positive((weightSource === "catalog" ? input.catalog : input.observed).weightGrams, "package_weight");
  if (weightGrams === null && input.requirements.weight) fail("package_weight", "required");
  const dimensions = ["lengthMm", "widthMm", "heightMm"] as const;
  const dimensionSource = sourceFor(dimensions.some(key => input.catalog[key] != null), dimensions.some(key => input.observed[key] != null));
  const dimensionValues = dimensionSource === "catalog" ? input.catalog : input.observed;
  const [lengthMm, widthMm, heightMm] = dimensions.map(key => positive(dimensionValues[key], "package_dimensions"));
  if ((dimensionSource !== "absent" || input.requirements.dimensions) && [lengthMm, widthMm, heightMm].some(value => value === null))
    fail("package_dimensions", "required");
  return { values: { weightGrams, lengthMm, widthMm, heightMm },
    sources: { weight: weightSource, dimensions: dimensionSource } };
}
