import type { InsertWarehouseLocation, WarehouseLocation } from "../../../shared/schema";

const OPERATIONAL_LOCATION_TYPES = new Set(["pick", "reserve", "receiving", "staging"]);
const PROTECTED_METADATA_PATCH_FIELDS = new Set([
  "id",
  "code",
  "cycleCountFreezeId",
  "createdAt",
  "updatedAt",
]);

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

/**
 * Normalize a partial update (`PATCH` / `updateWarehouseLocation`) without
 * injecting creation-time defaults for omitted fields (`WH-F02`) and without
 * allowing protected lifecycle fields (`cycleCountFreezeId`, `id`, `code`,
 * `createdAt`, `updatedAt`) to be written via metadata updates (`WH-F01`).
 */
export function normalizeLocationPatchInput<
  T extends Partial<InsertWarehouseLocation> | Partial<WarehouseLocation>,
>(updates: T): T {
  const raw = (updates ?? {}) as Record<string, unknown>;
  const forbiddenKeys = Object.keys(raw).filter((k) => PROTECTED_METADATA_PATCH_FIELDS.has(k));
  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Cannot modify protected field(s) via location metadata update: ${forbiddenKeys.join(", ")}`,
    );
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val === undefined) continue;
    if (key === "locationType") {
      normalized.locationType = normalizeLocationType(val);
    } else if (key === "binType" && typeof val === "string" && val.trim()) {
      normalized.binType = val.trim().toLowerCase();
    } else {
      normalized[key] = val;
    }
  }
  return normalized as T;
}

export function assertPickFaceAssignmentEligible(
  loc: Pick<WarehouseLocation, "code" | "isActive" | "warehouseId" | "locationType" | "isPickable"> & {
    cycleCountFreezeId?: number | null;
  },
): void {
  if (loc.isActive !== 1) {
    throw new Error(`Location ${loc.code} is inactive - cannot assign products to inactive locations`);
  }
  if (loc.warehouseId == null) {
    throw new Error(`Location ${loc.code} is not assigned to a warehouse - cannot assign products to orphan locations`);
  }
  if (loc.locationType !== "pick" || loc.isPickable !== 1) {
    throw new Error(`Location ${loc.code} is not a pick face - cannot assign products to non-pick locations`);
  }
  if (loc.cycleCountFreezeId != null) {
    throw new Error(
      `Location ${loc.code} is frozen for cycle count (#${loc.cycleCountFreezeId}) - cannot assign products while frozen`,
    );
  }
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
