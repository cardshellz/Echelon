import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";

type Warehouse = SupplySnapshotDto["warehouses"][number];

/**
 * Resolve validated promise roots to distinct physical warehouses. A hub owns
 * the ATP pool of its directly linked, active reserves; selecting a reserve
 * does not select its hub or siblings. This is the existing one-hop warehouse
 * contract, not a recursive transfer route or a change of inventory custody.
 */
export function resolvePromiseWarehouseIds(
  warehouses: readonly Warehouse[],
  sourceWarehouseIds: readonly number[],
): number[] {
  const byId = new Map(warehouses.map(warehouse => [warehouse.id, warehouse] as const));
  const reservesByHub = new Map<number, number[]>();
  for (const warehouse of warehouses) {
    if (!warehouse.isActive || warehouse.hubWarehouseId === null) continue;
    const reserves = reservesByHub.get(warehouse.hubWarehouseId) ?? [];
    reserves.push(warehouse.id);
    reservesByHub.set(warehouse.hubWarehouseId, reserves);
  }

  const physicalIds = new Set<number>();
  for (const rootId of [...new Set(sourceWarehouseIds)].sort((left, right) => left - right)) {
    // Retain an unavailable root so the planner reports WAREHOUSE_NOT_ACTIVE,
    // but do not let its reserves bypass the inactive/missing hub.
    physicalIds.add(rootId);
    if (!byId.get(rootId)?.isActive) continue;
    // Prefer the requested hub's own stock before claiming its reserves.
    for (const reserveId of (reservesByHub.get(rootId) ?? []).sort((left, right) => left - right)) {
      physicalIds.add(reserveId);
    }
  }
  return [...physicalIds];
}
