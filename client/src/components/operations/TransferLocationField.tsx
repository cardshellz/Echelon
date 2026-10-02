import { useId, useState } from "react";
import { z } from "zod";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { filterActionableWarehouseLocations } from "@/lib/warehouse-locations";
import { warehouseLabel } from "@/lib/warehouse-label";

export const transferLocationSchema = z.object({
  id: z.number().int().positive(),
  code: z.string().min(1),
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
  const [search, setSearch] = useState("");
  const selected = locations.find((location) => location.id === locationId);
  const resolvedWarehouseId = selected?.warehouseId ?? warehouseId;
  const filtered = filterActionableWarehouseLocations(locations, {
    warehouseId: resolvedWarehouseId, excludeId: excludeLocationId, search,
  });

  return <fieldset className="grid gap-3 sm:grid-cols-2" disabled={disabled}>
    <div className="space-y-2 min-w-0">
    <Label htmlFor={`${id}-warehouse`} className="block">{direction} Warehouse</Label>
    {fixed ? (
      <Input id={`${id}-warehouse`} value={selected ? warehouseLabel(selected.warehouseId, warehouses) : "Loading warehouse…"} readOnly />
    ) : (
      <Select value={resolvedWarehouseId?.toString() ?? ""} disabled={disabled}
        onValueChange={(value) => { setSearch(""); onWarehouseChange(Number(value)); }}>
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
    ) : <>
      <Input aria-label={`Search ${direction.toLowerCase()} locations`} placeholder="Search locations…"
        value={search} disabled={disabled || resolvedWarehouseId == null}
        onChange={(event) => setSearch(event.target.value)} className="h-9" />
      <Select value={locationId?.toString() ?? ""} disabled={disabled || resolvedWarehouseId == null}
        onValueChange={(value) => { setSearch(""); onLocationChange(Number(value)); }}>
        <SelectTrigger id={`${id}-location`}><SelectValue placeholder="Select location" /></SelectTrigger>
        <SelectContent className="max-h-[200px]">
          {filtered.map((location) => <SelectItem key={location.id} value={String(location.id)}>
            {location.code} ({location.locationType.replaceAll("_", " ")})
          </SelectItem>)}
          {filtered.length === 0 && <div className="p-2 text-sm text-muted-foreground">No active locations found.</div>}
        </SelectContent>
      </Select>
    </>}
    </div>
  </fieldset>;
}
