import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  warehouseInventorySourceWarehouseSchema,
  type PrepareWarehouseInventorySourceRequest,
  type WarehouseInventorySourceWarehouse,
} from "@shared/types/warehouse-inventory-source";

export class WarehouseInventorySourceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly classification: "permanent" | "transient" | "fatal" = "permanent",
  ) {
    super(message);
    this.name = "WarehouseInventorySourceError";
  }
}

export function warehouseInventorySourceFingerprint(input: WarehouseInventorySourceWarehouse): string {
  const warehouse = warehouseInventorySourceWarehouseSchema.parse(input);
  return createHash("sha256").update(canonicalJson(warehouse)).digest("hex");
}

/** Copy the existing physical warehouse identity; authority choices are never inferred. */
export function planWarehouseInventorySource(
  input: WarehouseInventorySourceWarehouse,
  request: PrepareWarehouseInventorySourceRequest,
) {
  const warehouse = warehouseInventorySourceWarehouseSchema.parse(input);
  if (warehouse.id !== request.warehouseId
    || warehouseInventorySourceFingerprint(warehouse) !== request.expectedWarehouseFingerprint) {
    throw new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_STALE",
      "The warehouse settings changed. Reload them before preparing a source.");
  }
  if (warehouse.isActive !== 1) {
    throw new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_INACTIVE",
      "An inactive warehouse cannot be prepared as a new inventory source.");
  }
  return {
    warehouseId: warehouse.id,
    code: warehouse.code,
    name: warehouse.name,
    nodeType: warehouse.warehouseType === "3pl" ? "third_party_logistics" : "internal_warehouse",
    inventoryAuthority: request.inventoryAuthority,
    fulfillmentAuthority: request.fulfillmentAuthority,
    // External identity is not inferred from a warehouse or channel name. This
    // command only prepares a draft, with no authority activation operation.
    providerAccountId: null,
    providerLocationId: null,
    lifecycleStatus: "draft" as const,
  };
}
