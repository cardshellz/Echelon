import type {
  FulfillmentChannel,
  PackagingAssignment,
} from "@shared/shipping/configuration";
import { ShippingConfigurationError } from "./configuration-error";

/** Warehouse override replaces the channel default; suites are never unioned. */
export function resolvePackagingAssignment(
  assignments: readonly PackagingAssignment[],
  channel: FulfillmentChannel,
  warehouseId: number,
): PackagingAssignment {
  if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0)
    throw new ShippingConfigurationError(
      "SHIPPING_WAREHOUSE_REQUIRED",
      "SHIPPING_WAREHOUSE_REQUIRED: choose an origin warehouse.",
      400,
    );
  const matches = assignments.filter((a) => a.channel === channel);
  const exact = matches.filter((a) => a.warehouseId === warehouseId);
  const selected = exact.length
    ? exact
    : matches.filter((a) => a.warehouseId === null);
  if (selected.length !== 1)
    throw new ShippingConfigurationError(
      selected.length
        ? "SHIPPING_PACKAGING_ASSIGNMENT_AMBIGUOUS"
        : "SHIPPING_PACKAGING_ASSIGNMENT_REQUIRED",
      selected.length
        ? "SHIPPING_PACKAGING_ASSIGNMENT_AMBIGUOUS: conflicting suite assignments."
        : "SHIPPING_PACKAGING_ASSIGNMENT_REQUIRED: choose a box suite for this channel and warehouse.",
    );
  return selected[0];
}
