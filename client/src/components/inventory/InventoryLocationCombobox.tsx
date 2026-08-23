import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { WarehouseLocationLike } from "@/lib/warehouse-locations";

export type InventoryLocationComboboxOption = WarehouseLocationLike;

interface InventoryLocationComboboxProps<TLocation extends InventoryLocationComboboxOption> {
  locations: readonly TLocation[];
  value: number | null;
  onValueChange(locationId: number | null): void;
  ariaLabel: string;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
}

export function InventoryLocationCombobox<TLocation extends InventoryLocationComboboxOption>({
  locations,
  value,
  onValueChange,
  ariaLabel,
  placeholder = "Select inventory location",
  searchPlaceholder = "Search locations...",
  emptyMessage = "No matching locations found.",
  disabled = false,
  loading = false,
  allowClear = false,
  triggerClassName,
  contentClassName,
}: InventoryLocationComboboxProps<TLocation>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedLocation = useMemo(
    () => locations.find((location) => location.id === value) ?? null,
    [locations, value],
  );

  const closeAndReset = () => {
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled || loading}
          className={cn("w-full justify-between gap-2 px-3 font-normal", triggerClassName)}
        >
          <span className={cn("min-w-0 truncate text-left", !selectedLocation && "text-muted-foreground")}>
            {loading
              ? "Loading locations..."
              : selectedLocation
                ? formatInventoryLocationLabel(selectedLocation)
                : placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className={cn(
          "w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0",
          contentClassName,
        )}
      >
        <Command shouldFilter>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <CommandList className="max-h-64 overflow-y-auto overscroll-contain">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {allowClear && value !== null && (
                <CommandItem
                  value="clear inventory location selection"
                  onSelect={() => {
                    onValueChange(null);
                    closeAndReset();
                  }}
                >
                  Clear selection
                </CommandItem>
              )}
              {locations.map((location) => (
                <CommandItem
                  key={location.id}
                  value={inventoryLocationSearchValue(location)}
                  onSelect={() => {
                    onValueChange(location.id);
                    closeAndReset();
                  }}
                  className="min-h-11"
                >
                  <Check
                    className={cn("h-4 w-4 shrink-0", location.id === value ? "opacity-100" : "opacity-0")}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{location.code}</span>
                    {formatInventoryLocationDetail(location) && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {formatInventoryLocationDetail(location)}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function formatInventoryLocationLabel(location: InventoryLocationComboboxOption): string {
  const name = location.name?.trim();
  return name ? `${location.code} — ${name}` : location.code;
}

export function inventoryLocationSearchValue(location: InventoryLocationComboboxOption): string {
  return [
    location.code,
    location.name,
    location.zone,
    location.locationType,
    String(location.id),
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
}

function formatInventoryLocationDetail(location: InventoryLocationComboboxOption): string {
  return [location.name, location.zone, location.locationType]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" · ");
}
