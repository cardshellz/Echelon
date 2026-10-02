export interface WarehouseIdentity {
  id: number;
  code: string;
  name: string;
}

/** Never turn a missing warehouse lookup into an apparently unqualified bin. */
export function warehouseLabel(
  warehouseId: number | null | undefined,
  warehouses: readonly WarehouseIdentity[],
): string {
  if (warehouseId == null) return "Warehouse unassigned";
  const warehouse = warehouses.find((entry) => entry.id === warehouseId);
  if (!warehouse) return `Warehouse #${warehouseId}`;
  return warehouse.name && warehouse.name !== warehouse.code
    ? `${warehouse.code} — ${warehouse.name}`
    : warehouse.code;
}
