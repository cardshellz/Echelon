import type { BoxBranding, PackagingRequirement } from "./packaging-policy";
export interface PackagingBoxAvailability {
  id: number;
  isActive: boolean;
  branding: BoxBranding;
  availabilityReviewed: boolean;
  warehouseIds: readonly number[];
}
export function packagingBrandingAllowed(
  requirement: PackagingRequirement,
  branding: BoxBranding,
): boolean {
  return requirement === "any" || branding === "unbranded";
}
/** Used by both server enforcement and the admin availability read model. */
export function eligiblePackagingBoxes<T extends PackagingBoxAvailability>(
  boxes: readonly T[],
  warehouseId: number,
  requirement: PackagingRequirement,
): T[] {
  return boxes.filter(
    (box) =>
      box.isActive &&
      box.availabilityReviewed &&
      box.warehouseIds.includes(warehouseId) &&
      packagingBrandingAllowed(requirement, box.branding),
  );
}
