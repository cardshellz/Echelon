export type WarehouseLocationLike = {
  id: number;
  code: string;
  name?: string | null;
  zone?: string | null;
  locationType?: string | null;
  warehouseId?: number | null;
  isActive?: number | null;
};

type LocationFilterOptions = {
  search?: string;
  excludeId?: number | null;
  warehouseId?: number | null;
  locationType?: string | string[];
};

export function isActiveWarehouseLocation(location: WarehouseLocationLike | null | undefined) {
  return !!location && location.isActive !== 0;
}

export function isActionableWarehouseLocation(location: WarehouseLocationLike | null | undefined) {
  return isActiveWarehouseLocation(location) && location?.warehouseId != null;
}

export function locationMatchesSearch(location: WarehouseLocationLike, search?: string) {
  const term = search?.trim().toLowerCase();
  if (!term) return true;
  return location.code.toLowerCase().includes(term)
    || (location.name?.toLowerCase().includes(term) ?? false)
    || (location.zone?.toLowerCase().includes(term) ?? false)
    || (location.locationType?.toLowerCase().includes(term) ?? false);
}

export function filterActiveWarehouseLocations<T extends WarehouseLocationLike>(locations: T[]) {
  return locations.filter(isActiveWarehouseLocation);
}

export function filterActionableWarehouseLocations<T extends WarehouseLocationLike>(
  locations: T[],
  options: LocationFilterOptions = {},
) {
  const allowedTypes = Array.isArray(options.locationType)
    ? options.locationType
    : options.locationType
      ? [options.locationType]
      : null;

  return locations.filter((location) => {
    if (!isActionableWarehouseLocation(location)) return false;
    if (options.excludeId != null && location.id === options.excludeId) return false;
    if (options.warehouseId != null && location.warehouseId !== options.warehouseId) return false;
    if (allowedTypes && !allowedTypes.includes(location.locationType || "")) return false;
    return locationMatchesSearch(location, options.search);
  });
}
