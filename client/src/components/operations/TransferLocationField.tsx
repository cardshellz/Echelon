import { useId } from "react";
import { z } from "zod";
import { InventoryLocationCombobox } from "@/components/inventory/InventoryLocationCombobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { filterActionableWarehouseLocations } from "@/lib/warehouse-locations";
import { warehouseLabel } from "@/lib/warehouse-label";

export const transferLocationSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
  name: z.string().nullable().optional(),
  locationType: z.string(),
  zone: z.string().nullable(),
  warehouseId: z.number().int().positive().nullable(),
  isActive: z.number().int(),
});
export const transferWarehouseSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
  name: z.string(),
  isActive: z.number().int(),
});
export type TransferLocation = z.infer<typeof transferLocationSchema>;
export type TransferWarehouse = z.infer<typeof transferWarehouseSchema>;

export function transferLocationLabel(location: TransferLocation, warehouses: readonly TransferWarehouse[]): string {
  return `${warehouseLabel(location.warehouseId, warehouses)} · ${location.code} (${location.locationType.replaceAll("_", " ")})`;
}

/** One independent warehouse/bin selector for each end of a transfer. */
export function TransferLocationField({
  direction, locations, warehouses, locationId, warehouseId, fixed, fallbackCode,
  excludeLocationId, disabled, onWarehouseChange, onLocationChange,
}: {
  direction: "From" | "To";
  locations: TransferLocation[];
  warehouses: TransferWarehouse[];
  locationId: number | null;
  warehouseId: number | null;
  fixed: boolean;
  fallbackCode?: string;
  excludeLocationId?: number | null;
  disabled: boolean;
  onWarehouseChange: (warehouseId: number) => void;
  onLocationChange: (locationId: number) => void;
}) {
  const id = useId();
  const selected = locations.find((location) => location.id === locationId);
  const resolvedWarehouseId = selected?.warehouseId ?? warehouseId;
  // Apply transfer eligibility before the shared picker searches its options.
  const eligibleLocations = filterActionableWarehouseLocations(locations, {
    warehouseId: resolvedWarehouseId, excludeId: excludeLocationId,
  });

  return <fieldset className="grid gap-3 sm:grid-cols-2" disabled={disabled}>
    <div className="space-y-2 min-w-0">
      <Label htmlFor={`${id}-warehouse`} className="block">{direction} Warehouse</Label>
      {fixed ? (
        <Input id={`${id}-warehouse`} value={selected ? warehouseLabel(selected.warehouseId, warehouses) : "Loading warehouse…"} readOnly />
      ) : (
        <Select value={resolvedWarehouseId?.toString() ?? ""} disabled={disabled}
          onValueChange={(value) => onWarehouseChange(Number(value))}>
          <SelectTrigger id={`${id}-warehouse`}><SelectValue placeholder="Select warehouse" /></SelectTrigger>
          <SelectContent>
            {warehouses.filter((warehouse) => warehouse.isActive === 1).map((warehouse) =>
              <SelectItem key={warehouse.id} value={String(warehouse.id)}>{warehouseLabel(warehouse.id, warehouses)}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
    <div className="space-y-2 min-w-0">
      <Label htmlFor={`${id}-location`} className="block">{direction} Location</Label>
      {fixed ? (
        <Input id={`${id}-location`} value={selected?.code ?? fallbackCode ?? "Loading location…"} readOnly className="font-mono" />
      ) : (
        <InventoryLocationCombobox
          key={resolvedWarehouseId ?? "unselected"}
          id={`${id}-location`}
          locations={eligibleLocations}
          value={locationId}
          onValueChange={(value) => { if (value !== null) onLocationChange(value); }}
          ariaLabel={`${direction} Location`}
          placeholder="Select location"
          searchPlaceholder={`Search ${direction.toLowerCase()} locations`}
          emptyMessage="No matching active locations found."
          disabled={disabled || resolvedWarehouseId == null}
        />
      )}
    </div>
  </fieldset>;
}
