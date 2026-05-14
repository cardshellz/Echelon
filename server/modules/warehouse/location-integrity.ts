import type { InsertWarehouseLocation, WarehouseLocation } from "../../../shared/schema";

const OPERATIONAL_LOCATION_TYPES = new Set(["pick", "reserve", "receiving", "staging"]);

export function normalizeLocationType(locationType: unknown): string {
  const value = typeof locationType === "string" && locationType.trim()
    ? locationType.trim().toLowerCase()
    : "pick";
  return value === "bin" ? "pick" : value;
}

export function normalizeLocationInput<T extends Partial<InsertWarehouseLocation> | Partial<WarehouseLocation>>(location: T): T {
  return {
    ...location,
    locationType: normalizeLocationType((location as any).locationType),
  };
}

export function validateWarehouseLocationIntegrity(
  location: Partial<InsertWarehouseLocation> | Partial<WarehouseLocation>,
): void {
  const normalized = normalizeLocationInput(location);
  const locationType = normalized.locationType ?? "pick";
  const isActive = normalized.isActive ?? 1;
  const isPickable = normalized.isPickable ?? 1;
  const warehouseId = normalized.warehouseId;
  const code = typeof normalized.code === "string" && normalized.code.trim()
    ? normalized.code.trim().toUpperCase()
    : "location";

  if (isActive === 1 && OPERATIONAL_LOCATION_TYPES.has(locationType) && warehouseId == null) {
    throw new Error(`Location ${code} must be assigned to a warehouse`);
  }

  if (isActive === 1 && isPickable === 1 && locationType !== "pick") {
    throw new Error(`Location ${code} is pickable but has location_type "${locationType}"`);
  }

  if (isActive === 1 && locationType === "pick" && isPickable !== 1) {
    throw new Error(`Pick location ${code} must have is_pickable = 1`);
  }
}
