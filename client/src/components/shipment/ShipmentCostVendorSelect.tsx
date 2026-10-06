import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { ShipmentCostVendorOption } from "@/lib/shipment-cost-vendors";

type Props = {
  id: string;
  label: string;
  vendorId: number | null;
  recordedName: string;
  vendors: readonly ShipmentCostVendorOption[];
  loading: boolean;
  error: boolean;
  disabled?: boolean;
  allowClear?: boolean;
  onSelect: (vendor: ShipmentCostVendorOption | null) => void;
  onAddVendor: () => void;
  onRetry: () => void;
};

/** Both cost roles select from the same directory, with independent selections. */
export function ShipmentCostVendorSelect({
  id, label, vendorId, recordedName, vendors, loading, error,
  disabled = false, allowClear = false, onSelect, onAddVendor, onRetry,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = vendors.filter((vendor) => !query
    || vendor.name.toLowerCase().includes(query) || vendor.code?.toLowerCase().includes(query)).slice(0, 50);
  const close = () => { setOpen(false); setSearch(""); };
  const displayName = recordedName || vendors.find((vendor) => vendor.id === vendorId)?.name;

  return (
    <Popover open={open && !disabled} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button id={id} aria-label={label} aria-expanded={open && !disabled} disabled={disabled}
          variant="outline" role="combobox" className="h-auto min-h-10 w-full justify-between gap-2 py-2 text-left font-normal">
          <span className="min-w-0 flex-1 whitespace-normal break-words">{displayName || "Select vendor..."}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={`${label} vendors`} className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput aria-label={`${label} vendor search`} placeholder="Search vendors..." value={search} onValueChange={setSearch} />
          <CommandList>
            {loading ? <div className="p-3 text-sm" role="status">Loading vendors...</div>
              : error ? <CommandGroup>
                <div className="px-2 py-1 text-sm text-destructive" role="alert">Could not load vendors.</div>
                <CommandItem onSelect={onRetry}>Retry loading vendors</CommandItem>
              </CommandGroup> : <>
                {matches.length === 0 && <div className="p-3 text-sm text-muted-foreground">No vendors found</div>}
                <CommandGroup>
                  {matches.map((vendor) => (
                    <CommandItem key={vendor.id} value={`vendor:${vendor.id}`}
                      onSelect={() => { onSelect(vendor); close(); }}>
                      <Check className={`mr-2 h-4 w-4 shrink-0 ${vendorId === vendor.id ? "opacity-100" : "opacity-0"}`} />
                      <span className="min-w-0 flex-1 whitespace-normal break-words">{vendor.name}</span>
                      {vendor.code && <span className="ml-auto max-w-[35%] shrink-0 break-words pl-2 text-right text-xs text-muted-foreground">{vendor.code}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>}
            <CommandGroup>
              {allowClear && (vendorId !== null || recordedName) && <CommandItem value="clear-selection"
                onSelect={() => { onSelect(null); close(); }}>Clear selection</CommandItem>}
              <CommandItem value="add-vendor" onSelect={() => { close(); onAddVendor(); }} className="text-primary">
                <Plus className="mr-2 h-4 w-4" />Add New Vendor
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
