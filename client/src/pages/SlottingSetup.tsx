import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  MapPin,
  Package,
  Search,
  Trash2,
} from "lucide-react";

type WarehouseLocation = {
  id: number;
  code: string;
  name: string | null;
  zone: string | null;
  aisle: string | null;
  bay: string | null;
  level: string | null;
  bin: string | null;
  locationType: string;
  binType: string;
  isPickable: number;
  isActive: number;
  warehouseId: number | null;
  primarySku?: string | null;
};

type Warehouse = {
  id: number;
  code: string;
  name: string;
};

type BinAssignment = {
  productVariantId: number;
  productId: number;
  sku: string | null;
  productName: string;
  variantName: string;
  productLocationId: number | null;
  assignedLocationCode: string | null;
  assignedLocationId: number | null;
  zone: string | null;
  isPrimary: number | null;
  currentQty: number | null;
  slotStatus: "valid" | "unassigned" | "invalid" | "duplicate";
  slotIssue: string | null;
  assignmentCount: number;
  validAssignmentCount: number;
};

type InventoryInSlot = {
  id: number;
  variantId: number;
  qty: number;
  reservedQty: number;
  pickedQty: number;
  sku: string | null;
  variantName: string | null;
  productTitle: string | null;
  productId: number | null;
  imageUrl: string | null;
};

type ProductSearchResult = {
  id: number;
  variantId: number;
  title: string;
  sku: string | null;
  imageUrl: string | null;
  matchedVariantSku: string | null;
};

type CandidateSku = {
  variantId: number;
  sku: string | null;
  title: string;
  source: "search" | "inventory" | "shortcut";
};

function parseNumberParam(params: URLSearchParams, key: string) {
  const value = params.get(key);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isAssignablePickFace(location: WarehouseLocation | null | undefined) {
  return !!location
    && location.isActive === 1
    && location.warehouseId != null
    && location.locationType === "pick"
    && location.isPickable === 1;
}

function slotBlockReason(location: WarehouseLocation | null | undefined) {
  if (!location) return "Select a slot first.";
  if (location.isActive !== 1) return "This location is inactive.";
  if (location.warehouseId == null) return "This location is not assigned to a warehouse.";
  if (location.locationType !== "pick") return "This location is not a pick slot.";
  if (location.isPickable !== 1) return "This pick location is not marked pickable.";
  return null;
}

function displaySku(candidate: CandidateSku | null) {
  if (!candidate) return "Select SKU";
  return candidate.sku || `Variant ${candidate.variantId}`;
}

export default function SlottingSetup() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const initialLocationId = parseNumberParam(initialParams, "locationId");
  const initialVariantId = parseNumberParam(initialParams, "variantId");
  const initialSku = initialParams.get("sku") || "";

  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(initialLocationId);
  const [slotSearch, setSlotSearch] = useState(initialSku || "");
  const [skuSearch, setSkuSearch] = useState(initialSku || "");
  const [skuPickerOpen, setSkuPickerOpen] = useState(false);
  const [candidate, setCandidate] = useState<CandidateSku | null>(
    initialVariantId
      ? { variantId: initialVariantId, sku: initialSku || null, title: initialSku || `Variant ${initialVariantId}`, source: "shortcut" }
      : null,
  );

  const debouncedSlotSearch = useDebounce(slotSearch, 200);
  const debouncedSkuSearch = useDebounce(skuSearch, 250);

  const { data: locations = [], isLoading: locationsLoading } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse/locations", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch locations");
      return res.json();
    },
  });

  const { data: warehouses = [] } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
    queryFn: async () => {
      const res = await fetch("/api/warehouses", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warehouses");
      return res.json();
    },
  });

  const { data: assignments = [], isLoading: assignmentsLoading } = useQuery<BinAssignment[]>({
    queryKey: ["/api/bin-assignments"],
    queryFn: async () => {
      const res = await fetch("/api/bin-assignments", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch slot assignments");
      return res.json();
    },
  });

  const selectedLocation = useMemo(
    () => locations.find(location => location.id === selectedLocationId) || null,
    [locations, selectedLocationId],
  );

  useEffect(() => {
    if (!selectedLocationId && locations.length > 0) {
      const firstAssignable = locations.find(isAssignablePickFace);
      setSelectedLocationId(firstAssignable?.id ?? locations[0].id);
    }
  }, [locations, selectedLocationId]);

  const warehouseNameById = useMemo(() => {
    const map = new Map<number, string>();
    warehouses.forEach(warehouse => map.set(warehouse.id, warehouse.code || warehouse.name));
    return map;
  }, [warehouses]);

  const assignmentsByLocation = useMemo(() => {
    const map = new Map<number, BinAssignment[]>();
    for (const assignment of assignments) {
      if (!assignment.assignedLocationId) continue;
      const existing = map.get(assignment.assignedLocationId) || [];
      existing.push(assignment);
      map.set(assignment.assignedLocationId, existing);
    }
    return map;
  }, [assignments]);

  const selectedAssignments = useMemo(
    () => selectedLocationId ? assignmentsByLocation.get(selectedLocationId) || [] : [],
    [assignmentsByLocation, selectedLocationId],
  );

  const { data: inventoryInSlot = [], isLoading: inventoryLoading } = useQuery<InventoryInSlot[]>({
    queryKey: ["/api/warehouse/locations", selectedLocationId, "inventory"],
    queryFn: async () => {
      if (!selectedLocationId) return [];
      const res = await fetch(`/api/warehouse/locations/${selectedLocationId}/inventory`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch slot inventory");
      return res.json();
    },
    enabled: !!selectedLocationId,
  });

  const { data: productSearchResults = [] } = useQuery<ProductSearchResult[]>({
    queryKey: ["/api/catalog/products/search", debouncedSkuSearch],
    queryFn: async () => {
      if (debouncedSkuSearch.length < 2) return [];
      const res = await fetch(`/api/catalog/products/search?q=${encodeURIComponent(debouncedSkuSearch)}&limit=25`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedSkuSearch.length >= 2 && skuPickerOpen,
  });

  const filteredLocations = useMemo(() => {
    const term = debouncedSlotSearch.trim().toUpperCase();
    return locations
      .filter(location => {
        if (!term) return true;
        const assigned = assignmentsByLocation.get(location.id) || [];
        return location.code.toUpperCase().includes(term)
          || (location.zone || "").toUpperCase().includes(term)
          || (location.primarySku || "").toUpperCase().includes(term)
          || assigned.some(a =>
            (a.sku || "").toUpperCase().includes(term)
            || a.productName.toUpperCase().includes(term)
            || a.variantName.toUpperCase().includes(term)
          );
      })
      .sort((a, b) => {
        const aAssignable = isAssignablePickFace(a) ? 0 : 1;
        const bAssignable = isAssignablePickFace(b) ? 0 : 1;
        if (aAssignable !== bAssignable) return aAssignable - bAssignable;
        return a.code.localeCompare(b.code);
      });
  }, [assignmentsByLocation, debouncedSlotSearch, locations]);

  const assignMutation = useMutation({
    mutationFn: async (params: { productVariantId: number; warehouseLocationId: number }) => {
      const res = await fetch("/api/bin-assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save slot assignment");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bin-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      toast({ title: "Slot assignment saved" });
      if (selectedLocationId) {
        const params = new URLSearchParams({ locationId: String(selectedLocationId) });
        navigate(`/slotting-setup?${params.toString()}`, { replace: true });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save slot assignment", description: error.message, variant: "destructive" });
    },
  });

  const unassignMutation = useMutation({
    mutationFn: async (productLocationId: number) => {
      const res = await fetch(`/api/bin-assignments/${productLocationId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to remove slot assignment");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bin-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      toast({ title: "Slot assignment removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to remove slot assignment", description: error.message, variant: "destructive" });
    },
  });

  const blockReason = slotBlockReason(selectedLocation);
  const canSave = !!selectedLocation && !!candidate && !blockReason && !assignMutation.isPending;

  function selectLocation(locationId: number) {
    setSelectedLocationId(locationId);
    const params = new URLSearchParams(window.location.search);
    params.set("locationId", String(locationId));
    if (candidate?.variantId) params.set("variantId", String(candidate.variantId));
    if (candidate?.sku) params.set("sku", candidate.sku);
    navigate(`/slotting-setup?${params.toString()}`, { replace: true });
  }

  function saveAssignment() {
    if (!selectedLocation || !candidate) return;
    assignMutation.mutate({
      productVariantId: candidate.variantId,
      warehouseLocationId: selectedLocation.id,
    });
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6" />
            Slotting Setup
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pick slot master data
          </p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(420px,0.95fr)_minmax(460px,1.05fr)]">
        <div className="rounded-md border bg-background">
          <div className="border-b px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">Slots</h2>
                <p className="text-xs text-muted-foreground">{filteredLocations.length} locations</p>
              </div>
              <div className="relative w-56">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={slotSearch}
                  onChange={(event) => setSlotSearch(event.target.value)}
                  placeholder="Slot or SKU"
                  className="pl-8"
                />
              </div>
            </div>
          </div>

          <div className="max-h-[calc(100vh-250px)] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead>Assigned SKU</TableHead>
                  <TableHead className="w-[110px]">State</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locationsLoading || assignmentsLoading ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      Loading slots...
                    </TableCell>
                  </TableRow>
                ) : filteredLocations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      No slots found
                    </TableCell>
                  </TableRow>
                ) : filteredLocations.map(location => {
                  const assigned = assignmentsByLocation.get(location.id) || [];
                  const isSelected = location.id === selectedLocationId;
                  const assignable = isAssignablePickFace(location);
                  const assignedLabel = assigned.length === 0
                    ? location.primarySku || null
                    : assigned.map(a => a.sku || `Variant ${a.productVariantId}`).join(", ");

                  return (
                    <TableRow
                      key={location.id}
                      className={cn("cursor-pointer", isSelected && "bg-muted/70")}
                      onClick={() => selectLocation(location.id)}
                    >
                      <TableCell>
                        <div className="font-mono text-sm">{location.code}</div>
                        <div className="text-xs text-muted-foreground">
                          {location.warehouseId ? warehouseNameById.get(location.warehouseId) || `Warehouse ${location.warehouseId}` : "No warehouse"}
                          {location.zone ? ` · ${location.zone}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        {assignedLabel ? (
                          <span className="font-mono text-xs">{assignedLabel}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {assignable ? (
                          <Badge variant="secondary" className="text-xs">Pickable</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">Blocked</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        <div className="rounded-md border bg-background">
          <div className="border-b px-4 py-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <h2 className="font-semibold">{selectedLocation?.code || "Select a slot"}</h2>
                {selectedLocation && (
                  <p className="text-xs text-muted-foreground">
                    {selectedLocation.locationType.replace("_", " ")}
                    {selectedLocation.binType ? ` · ${selectedLocation.binType.replace("_", " ")}` : ""}
                    {selectedLocation.zone ? ` · Zone ${selectedLocation.zone}` : ""}
                  </p>
                )}
              </div>
              {selectedLocation && (
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-xs">
                    {selectedLocation.warehouseId
                      ? warehouseNameById.get(selectedLocation.warehouseId) || `Warehouse ${selectedLocation.warehouseId}`
                      : "No warehouse"}
                  </Badge>
                  {selectedLocation.isPickable === 1 ? (
                    <Badge variant="secondary" className="text-xs">Pickable</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">Not pickable</Badge>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-5 p-4">
            {blockReason && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertTriangle className="mr-2 inline h-4 w-4" />
                {blockReason}
              </div>
            )}

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Assigned SKU</Label>
                <span className="text-xs text-muted-foreground">{selectedAssignments.length} active</span>
              </div>
              {selectedAssignments.length === 0 ? (
                <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
                  No SKU is intentionally slotted here.
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedAssignments.map(assignment => (
                    <div key={assignment.productLocationId || assignment.productVariantId} className="flex items-center justify-between rounded-md border px-3 py-2">
                      <div className="min-w-0">
                        <div className="font-mono text-sm">{assignment.sku || `Variant ${assignment.productVariantId}`}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {assignment.productName} · {assignment.variantName}
                        </div>
                      </div>
                      {assignment.productLocationId && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          disabled={unassignMutation.isPending}
                          onClick={() => unassignMutation.mutate(assignment.productLocationId!)}
                          title="Remove slot assignment"
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <Label className="text-sm font-medium">Set Assignment</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Popover open={skuPickerOpen} onOpenChange={setSkuPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      className="h-10 flex-1 justify-between font-normal"
                    >
                      <span className="truncate font-mono text-xs">{displaySku(candidate)}</span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[360px] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="Search SKU or product..."
                        value={skuSearch}
                        onValueChange={setSkuSearch}
                      />
                      <CommandList>
                        {debouncedSkuSearch.length < 2 ? (
                          <CommandEmpty>Type at least 2 characters.</CommandEmpty>
                        ) : productSearchResults.length === 0 ? (
                          <CommandEmpty>No matching SKUs found.</CommandEmpty>
                        ) : (
                          <CommandGroup>
                            {productSearchResults.map(result => (
                              <CommandItem
                                key={result.variantId}
                                value={String(result.variantId)}
                                onSelect={() => {
                                  setCandidate({
                                    variantId: result.variantId,
                                    sku: result.matchedVariantSku || result.sku,
                                    title: result.title,
                                    source: "search",
                                  });
                                  setSkuPickerOpen(false);
                                }}
                              >
                                <div className="min-w-0">
                                  <div className="font-mono text-xs">{result.matchedVariantSku || result.sku || `Variant ${result.variantId}`}</div>
                                  <div className="truncate text-xs text-muted-foreground">{result.title}</div>
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <Button
                  type="button"
                  onClick={saveAssignment}
                  disabled={!canSave}
                  className="h-10"
                >
                  <Check className="mr-2 h-4 w-4" />
                  Save Slot
                </Button>
              </div>
              {candidate && (
                <div className="text-xs text-muted-foreground">
                  Ready to assign <span className="font-mono">{candidate.sku || `Variant ${candidate.variantId}`}</span>
                  {selectedLocation ? ` to ${selectedLocation.code}` : ""}.
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Inventory At This Slot</Label>
                {inventoryLoading && <span className="text-xs text-muted-foreground">Loading...</span>}
              </div>
              {inventoryInSlot.length === 0 ? (
                <div className="rounded-md border px-3 py-4 text-sm text-muted-foreground">
                  No physical inventory is currently recorded here.
                </div>
              ) : (
                <div className="divide-y rounded-md border">
                  {inventoryInSlot.map(item => (
                    <div key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="font-mono text-xs">{item.sku || item.variantName || `Variant ${item.variantId}`}</div>
                          <div className="truncate text-xs text-muted-foreground">{item.productTitle || item.variantName || "Inventory item"}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="font-mono text-sm font-semibold">{item.qty}</div>
                          <div className="text-[11px] text-muted-foreground">on hand</div>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8"
                          onClick={() => {
                            setCandidate({
                              variantId: item.variantId,
                              sku: item.sku,
                              title: item.productTitle || item.variantName || item.sku || `Variant ${item.variantId}`,
                              source: "inventory",
                            });
                            setSkuSearch(item.sku || "");
                          }}
                        >
                          Use SKU
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
