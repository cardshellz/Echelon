import { warehouseSourceActivationEvidenceSchema, type WarehouseSourceActivationEvidence } from "@shared/types/warehouse-source-activation";
import { WarehouseInventorySourceError } from "./warehouse-inventory-source";

export function validateWarehouseSourceActivation(input: unknown): WarehouseSourceActivationEvidence {
  const parsed = warehouseSourceActivationEvidenceSchema.safeParse(input);
  if (!parsed.success) throw new WarehouseInventorySourceError(409, "WAREHOUSE_SOURCE_ACTIVATION_INVALID",
    "The reviewed warehouse source identity is incomplete or invalid.");
  if (parsed.data.lifecycleStatus === "retired" || parsed.data.warehouseActive !== 1) {
    throw new WarehouseInventorySourceError(409, "WAREHOUSE_SOURCE_ACTIVATION_UNAVAILABLE",
      "A retired source or inactive warehouse cannot participate in cutover activation.");
  }
  // Provider account/location and capability commissioning is a separate owner.
  // Do not turn an uncommissioned external custody source on during ATP cutover.
  if (parsed.data.lifecycleStatus === "draft" && (parsed.data.inventoryAuthority === "external_provider"
    || parsed.data.fulfillmentAuthority === "external_provider")) {
    throw new WarehouseInventorySourceError(409, "WAREHOUSE_SOURCE_PROVIDER_COMMISSIONING_REQUIRED",
      "An external warehouse source must complete its provider commissioning before it can be used by an Echelon publication target.");
  }
  return parsed.data;
}
