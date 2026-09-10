import type {
  ChannelPackagingPolicy,
  WarehouseSuiteAssignment,
} from "@shared/shipping/packaging-policy";

/** Apply a selected-warehouse delta, never replace unrelated assignments. */
export function planWarehouseSuiteAssignment(
  current: ReadonlyArray<ChannelPackagingPolicy["overrides"][number]>,
  command: Pick<
    WarehouseSuiteAssignment,
    "warehouseIds" | "suiteId" | "replaceExisting"
  >,
) {
  const overrides = new Map(current.map((o) => [o.warehouseId, o.suiteId]));
  let changed = 0;
  for (const warehouseId of command.warehouseIds) {
    if (overrides.has(warehouseId) && !command.replaceExisting) continue;
    if ((overrides.get(warehouseId) ?? null) === command.suiteId) continue;
    if (command.suiteId === null) overrides.delete(warehouseId);
    else overrides.set(warehouseId, command.suiteId);
    changed++;
  }
  return {
    changed,
    skipped: command.warehouseIds.length - changed,
    overrides: [...overrides]
      .sort(([a], [b]) => a - b)
      .map(([warehouseId, suiteId]) => ({ warehouseId, suiteId })),
  };
}
