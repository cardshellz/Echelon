import type { InventoryLevel, ProductVariant } from "@shared/schema";

/**
 * Cube-capacity utility functions for warehouse locations.
 *
 * These are pure computational helpers (no DB access) used by the
 * replenishment task generation logic in routes.ts.
 */

/** Calculate cubic volume for a variant in mm³. Returns null if dimensions not set. */
export function getVariantCubicMm(variant: {
  widthMm: number | null;
  heightMm: number | null;
  lengthMm?: number | null;
}): number | null {
  if (variant.widthMm && variant.heightMm && variant.lengthMm) {
    return variant.widthMm * variant.heightMm * variant.lengthMm;
  }
  return null;
}

/** Calculate total capacity of a location in mm³. Uses capacityCubicMm if set, else dimensions. */
export function getLocationCapacityCubicMm(location: {
  capacityCubicMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  depthMm: number | null;
}): number | null {
  if (location.capacityCubicMm) {
    return location.capacityCubicMm;
  }
  if (location.widthMm && location.heightMm && location.depthMm) {
    return location.widthMm * location.heightMm * location.depthMm;
  }
  return null;
}

/** Calculate occupied cube at a location based on current inventory. */
export function getLocationOccupiedCubicMm(
  locationId: number,
  inventoryLevels: InventoryLevel[],
  variantMap: Map<number, ProductVariant>,
): number {
  let occupied = 0;

  for (const level of inventoryLevels) {
    if (level.warehouseLocationId !== locationId) continue;
    if (!level.productVariantId || level.variantQty <= 0) continue;

    const variant = variantMap.get(level.productVariantId);
    if (!variant) continue;

    const variantCube = getVariantCubicMm(variant);
    if (variantCube) {
      occupied += variantCube * level.variantQty;
    }
  }

  return occupied;
}

/** Calculate remaining capacity at a location. Returns null if capacity not enforced. */
export function calculateRemainingCapacity(
  location: {
    id: number;
    capacityCubicMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    depthMm: number | null;
  },
  variant: { widthMm: number | null; heightMm: number | null; depthMm: number | null },
  inventoryLevels: InventoryLevel[],
  variantMap: Map<number, ProductVariant>,
): { remainingCubicMm: number; maxUnits: number } | null {
  const locationCapacity = getLocationCapacityCubicMm(location);
  if (!locationCapacity) return null;

  const variantCube = getVariantCubicMm(variant);
  if (!variantCube) return null;

  const occupied = getLocationOccupiedCubicMm(location.id, inventoryLevels, variantMap);
  const remaining = Math.max(0, locationCapacity - occupied);
  const maxUnits = Math.floor(remaining / variantCube);

  return { remainingCubicMm: remaining, maxUnits };
}

/** Find best overflow bin for excess inventory. Prioritizes most available capacity. */
export function findOverflowBin(
  warehouseId: number | null,
  variant: { widthMm: number | null; heightMm: number | null; depthMm: number | null },
  requiredUnits: number,
  inventoryLevels: InventoryLevel[],
  variantMap: Map<number, ProductVariant>,
  allLocations: Array<{
    id: number;
    warehouseId: number | null;
    locationType: string;
    capacityCubicMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    depthMm: number | null;
  }>,
  minUnitsRequired?: number,
): { locationId: number; maxUnits: number } | null {
  const variantCube = getVariantCubicMm(variant);
  if (!variantCube) return null;

  const overflowLocations = allLocations.filter(
    (l) => l.locationType === "overflow" && (warehouseId === null || l.warehouseId === warehouseId),
  );

  let bestBin: { locationId: number; maxUnits: number; remainingCube: number } | null = null;

  for (const loc of overflowLocations) {
    const capacity = calculateRemainingCapacity(loc, variant, inventoryLevels, variantMap);
    if (!capacity || capacity.maxUnits <= 0) continue;

    if (minUnitsRequired && capacity.maxUnits < minUnitsRequired) continue;

    if (!bestBin || capacity.remainingCubicMm > bestBin.remainingCube) {
      bestBin = {
        locationId: loc.id,
        maxUnits: capacity.maxUnits,
        remainingCube: capacity.remainingCubicMm,
      };
    }
  }

  return bestBin ? { locationId: bestBin.locationId, maxUnits: bestBin.maxUnits } : null;
}
