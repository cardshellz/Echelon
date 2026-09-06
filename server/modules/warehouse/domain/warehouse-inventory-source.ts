import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  warehouseInventorySourceWarehouseSchema,
  type PrepareWarehouseInventorySourceRequest,
  type WarehouseInventorySourceWarehouse,
  type WarehouseConfiguredSource,
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

/** Translate saved behavior, not names: building type controls fulfillment;
 * inventory source controls stock direction. Preparing a node grants no publication authority. */
export function resolveConfiguredWarehouseSource(warehouse: WarehouseInventorySourceWarehouse): WarehouseConfiguredSource {
  const fulfillmentAuthority = warehouse.warehouseType === "bulk_storage" ? "none"
    : warehouse.warehouseType === "3pl" ? "external_provider" : "echelon";
  switch (warehouse.inventorySourceType) {
    case "internal":
      return { status: "ready", inventoryAuthority: "echelon", fulfillmentAuthority,
        inventoryDirection: "internal", sourceChannelId: null };
    case "manual":
      return { status: "ready", inventoryAuthority: "manual", fulfillmentAuthority,
        inventoryDirection: "manual", sourceChannelId: null };
    case "channel": {
      const value = warehouse.inventorySourceChannelId;
      if (!value || !/^[1-9][0-9]*$/.test(value) || Number(value) > 2_147_483_647) {
        return { status: "blocked", message: "The warehouse's incoming inventory feed needs a valid source channel in Warehouse settings." };
      }
      return { status: "ready", inventoryAuthority: "external_provider", fulfillmentAuthority,
        inventoryDirection: "inbound", sourceChannelId: Number(value) };
    }
    default:
      // The existing stock importer supports channel feeds, not integration adapters.
      return { status: "blocked", message: "This inventory source is not supported for automatic setup. Check Warehouse settings; no source was prepared." };
  }
}

/** Copy the physical identity; new UI requests reuse saved settings under the row lock.
 * The original explicit-authority request remains compatible for existing API clients. */
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
  const configured = request.authoritySource === "warehouse_settings" ? resolveConfiguredWarehouseSource(warehouse) : null;
  if (configured?.status === "blocked") {
    throw new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_CONFIGURATION_REQUIRED", configured.message);
  }
  const inventoryAuthority = configured?.status === "ready" ? configured.inventoryAuthority : request.inventoryAuthority;
  const fulfillmentAuthority = configured?.status === "ready" ? configured.fulfillmentAuthority : request.fulfillmentAuthority;
  if (!inventoryAuthority || !fulfillmentAuthority) {
    throw new WarehouseInventorySourceError(400, "WAREHOUSE_INVENTORY_SOURCE_INVALID_REQUEST", "Warehouse source authorities are required.");
  }
  return {
    warehouseId: warehouse.id,
    code: warehouse.code,
    name: warehouse.name,
    nodeType: warehouse.warehouseType === "3pl" ? "third_party_logistics" : "internal_warehouse",
    inventoryAuthority,
    fulfillmentAuthority,
    // External identity is not inferred from a warehouse or channel name. This
    // command only prepares a draft, with no authority activation operation.
    providerAccountId: null,
    providerLocationId: null,
    lifecycleStatus: "draft" as const,
  };
}
