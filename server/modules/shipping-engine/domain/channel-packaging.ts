import type {
  ChannelPackagingPolicy,
  PackagingRequirement,
} from "@shared/shipping/packaging-policy";
import {
  packagingBrandingAllowed,
  type PackagingBoxAvailability,
} from "@shared/shipping/packaging-eligibility";
export {
  packagingBrandingAllowed,
  eligiblePackagingBoxes,
} from "@shared/shipping/packaging-eligibility";
import { ShippingConfigurationError } from "./configuration-error";

export function resolveChannelSuite(
  policy: ChannelPackagingPolicy,
  warehouseId: number,
): { suiteId: number; source: "default" | "warehouse" } {
  if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) {
    throw new ShippingConfigurationError(
      "SHIPPING_WAREHOUSE_REQUIRED",
      "A concrete fulfillment warehouse is required.",
      400,
    );
  }
  const overrides = policy.overrides.filter(
    (o) => o.warehouseId === warehouseId,
  );
  if (overrides.length > 1)
    throw new ShippingConfigurationError(
      "SHIPPING_PACKAGING_ASSIGNMENT_AMBIGUOUS",
      "Conflicting warehouse packaging assignments.",
    );
  return overrides.length
    ? { suiteId: overrides[0].suiteId, source: "warehouse" }
    : { suiteId: policy.defaultSuiteId, source: "default" };
}

export function assertSuiteBranding(
  requirement: PackagingRequirement,
  boxes: readonly PackagingBoxAvailability[],
): void {
  if (
    boxes.some((box) => !packagingBrandingAllowed(requirement, box.branding))
  ) {
    throw new ShippingConfigurationError(
      "SHIPPING_SUITE_BRANDING_CONFLICT",
      "White-label fulfillment requires every suite member to be classified as unbranded. Edit the suite or classify its boxes first.",
    );
  }
}
