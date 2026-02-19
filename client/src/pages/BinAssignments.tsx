import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { MapPin, Search, Upload, Download, FileDown, Trash2, ChevronsUpDown, Check, X, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";

type BinAssignment = {
  productVariantId: number;
  productId: number;
  sku: string | null;
  productName: string;
  variantName: string;
  unitsPerVariant: number;
  productLocationId: number | null;
  assignedLocationCode: string | null;
  assignedLocationId: number | null;
  zone: string | null;
  isPrimary: number | null;
  currentQty: number | null;
};

type WarehouseLocation = {
  id: number;
  code: string;
  zone: string | null;
  locationType: string;
  warehouseId: number | null;
  isPickable: number;
};

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function BinAssignments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Filters
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [zoneFilter, setZoneFilter] = useState("");

  // Sort state
  type SortKey = "sku" | "productName" | "variantName" | "assignedLocationCode" | "zone" | "isPrimary" | "currentQty";
  const [sortKey, setSortKey] = useState<SortKey>("sku");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // Import dialog
  const [importOpen, setImportOpen] = useState(false);
  const [csvData, setCsvData] = useState("");

  // Inline edit state
  const [editingVariantId, setEditingVariantId] = useState<number | null>(null);
  const [locationSearch, setLocationSearch] = useState("");
  const [locationPopoverOpen, setLocationPopoverOpen] = useState(false);

  // Data queries
  const { data: assignments = [], isLoading } = useQuery<BinAssignment[]>({
    queryKey: ["/api/bin-assignments", { search: debouncedSearch, unassignedOnly, zone: zoneFilter }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (unassignedOnly) params.set("unassignedOnly", "true");
      if (zoneFilter) params.set("zone", zoneFilter);
      const res = await fetch(`/api/bin-assignments?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: locations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse/locations", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  // Distinct zones from locations
  const zones = useMemo(() => {
    const zoneSet = new Set(locations.map(l => l.zone).filter(Boolean) as string[]);
    return Array.from(zoneSet).sort();
  }, [locations]);

  // Pickable locations only for assignment (uses is_pickable flag, not location_type)
  const pickLocations = useMemo(() => {
    return locations.filter(l => l.isPickable === 1);
  }, [locations]);

  // Sorted assignments
  const sortedAssignments = useMemo(() => {
    return [...assignments].sort((a, b) => {
      const mul = sortDir === "asc" ? 1 : -1;
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (valA == null && valB == null) return 0;
      if (valA == null) return 1;
      if (valB == null) return -1;
      if (typeof valA === "number" && typeof valB === "number") return (valA - valB) * mul;
      return String(valA).localeCompare(String(valB)) * mul;
    });
  }, [assignments, sortKey, sortDir]);

  // Mutations
  const assignMutation = useMutation({
    mutationFn: async (params: { productVariantId: number; warehouseLocationId: number }) => {
      const res = await fetch("/api/bin-assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to assign");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bin-assignments"] });
      setEditingVariantId(null);
      setLocationSearch("");
      toast({ title: "Assignment updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to assign", description: error.message, variant: "destructive" });
    },
  });

  const unassignMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/bin-assignments/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to unassign");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bin-assignments"] });
      toast({ title: "Assignment removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to remove", description: error.message, variant: "destructive" });
    },
  });

  const importMutation = useMutation({
    mutationFn: async (data: { assignments: { sku: string; locationCode: string }[] }) => {
      const res = await fetch("/api/bin-assignments/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to import");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bin-assignments"] });
      setImportOpen(false);
      setCsvData("");
      toast({
        title: "Import complete",
        description: `Created: ${data.created}, Updated: ${data.updated}${data.errors?.length ? `, Errors: ${data.errors.length}` : ""}`,
      });
      if (data.errors?.length > 0) {
        console.warn("Import errors:", data.errors);
      }
    },
    onError: (error: Error) => {
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  // CSV parsing
  function parseCsv(csv: string): { sku: string; locationCode: string }[] {
    const normalized = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const lines = normalized.split("\n").filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].toLowerCase().split(",").map(h => h.trim().replace(/^"|"$/g, ""));
    const skuIdx = headers.indexOf("sku");
    const locIdx = headers.findIndex(h => h === "location_code" || h === "location" || h === "bin");

    if (skuIdx === -1 || locIdx === -1) return [];

    return lines.slice(1).map(line => {
      const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
      return { sku: cols[skuIdx] || "", locationCode: cols[locIdx] || "" };
    }).filter(r => r.sku && r.locationCode);
  }

  function handleImport() {
    const parsed = parseCsv(csvData);
    if (parsed.length === 0) {
      toast({ title: "No valid rows found", description: "CSV must have sku and location_code columns", variant: "destructive" });
      return;
    }
    importMutation.mutate({ assignments: parsed });
  }

  function downloadTemplate() {
    const template = "sku,location_code\nFONT-001-P,FWD-A-01-A-1\nPOKE-002-B,FWD-A-02-B-1\n";
    const blob = new Blob([template], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bin-assignments-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExport() {
    window.location.href = "/api/bin-assignments/export";
  }

  // Stats
  const totalVariants = assignments.length;
  const assignedCount = assignments.filter(a => a.productLocationId !== null).length;
  const unassignedCount = totalVariants - assignedCount;

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6" />
            Bin Assignments
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage which SKU picks from which bin location
          </p>
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex gap-4 text-sm">
        <span>{totalVariants} variants</span>
        <span className="text-emerald-600">{assignedCount} assigned</span>
        <span className="text-amber-600">{unassignedCount} unassigned</span>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search SKU or product..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        {/* Zone filter */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-10">
              {zoneFilter || "All Zones"}
              <ChevronsUpDown className="ml-1 h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-0" align="start">
            <Command>
              <CommandList>
                <CommandItem onSelect={() => setZoneFilter("")}>
                  All Zones
                  {!zoneFilter && <Check className="ml-auto h-4 w-4" />}
                </CommandItem>
                {zones.map(z => (
                  <CommandItem key={z} onSelect={() => setZoneFilter(z)}>
                    {z}
                    {zoneFilter === z && <Check className="ml-auto h-4 w-4" />}
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {/* Unassigned toggle */}
        <Button
          variant={unassignedOnly ? "default" : "outline"}
          size="sm"
          className="h-10"
          onClick={() => setUnassignedOnly(!unassignedOnly)}
        >
          Unassigned Only
        </Button>

        <div className="flex-1" />

        <Button variant="outline" size="sm" onClick={downloadTemplate}>
          <FileDown className="h-4 w-4 mr-1" /> Template
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1" /> Export
        </Button>
        <Button size="sm" onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4 mr-1" /> Import CSV
        </Button>
      </div>

      {/* Table */}
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              {([
                ["sku", "SKU", "w-[140px]", ""],
                ["productName", "Product", "", ""],
                ["variantName", "Variant", "w-[120px]", ""],
                ["assignedLocationCode", "Pick Location", "w-[220px]", ""],
                ["zone", "Zone", "w-[80px]", ""],
                ["isPrimary", "Primary", "w-[80px]", "text-center"],
                ["currentQty", "Qty", "w-[80px]", "text-right"],
              ] as [SortKey, string, string, string][]).map(([key, label, width, align]) => (
                <TableHead key={key} className={cn(width, "cursor-pointer select-none", align)} onClick={() => toggleSort(key)}>
                  <span className="inline-flex items-center gap-1">
                    {label}
                    {sortKey === key ? (
                      sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-30" />
                    )}
                  </span>
                </TableHead>
              ))}
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : assignments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  No variants found
                </TableCell>
              </TableRow>
            ) : sortedAssignments.map((a) => (
              <TableRow key={a.productVariantId}>
                <TableCell className="font-mono text-xs">{a.sku || "-"}</TableCell>
                <TableCell className="truncate max-w-[250px]">{a.productName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{a.variantName}</TableCell>
                <TableCell>
                  {editingVariantId === a.productVariantId ? (
                    <LocationPicker
                      locations={pickLocations}
                      selectedId={a.assignedLocationId}
                      open={locationPopoverOpen}
                      onOpenChange={setLocationPopoverOpen}
                      search={locationSearch}
                      onSearchChange={setLocationSearch}
                      onSelect={(loc) => {
                        assignMutation.mutate({
                          productVariantId: a.productVariantId,
                          warehouseLocationId: loc.id,
                        });
                      }}
                      onCancel={() => {
                        setEditingVariantId(null);
                        setLocationSearch("");
                      }}
                    />
                  ) : (
                    <button
                      className="text-left w-full hover:bg-muted/50 rounded px-2 py-1 -mx-2 -my-1 transition-colors"
                      onClick={() => {
                        setEditingVariantId(a.productVariantId);
                        setLocationSearch("");
                        setLocationPopoverOpen(true);
                      }}
                    >
                      {a.assignedLocationCode ? (
                        <span className="font-mono text-sm">{a.assignedLocationCode}</span>
                      ) : (
                        <span className="text-muted-foreground text-sm italic">Click to assign...</span>
                      )}
                    </button>
                  )}
                </TableCell>
                <TableCell className="text-sm">{a.zone || "-"}</TableCell>
                <TableCell className="text-center">
                  {a.isPrimary === 1 && <Badge variant="outline" className="text-xs">Primary</Badge>}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">{a.currentQty ?? "-"}</TableCell>
                <TableCell>
                  {a.productLocationId && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => unassignMutation.mutate(a.productLocationId!)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Import CSV Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Bin Assignments</DialogTitle>
            <DialogDescription>
              Upload a CSV with <code>sku</code> and <code>location_code</code> columns.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <input
                id="csv-file-input"
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = (evt) => setCsvData(evt.target?.result as string);
                    reader.readAsText(file);
                  }
                }}
              />
              <Button variant="outline" onClick={() => document.getElementById("csv-file-input")?.click()}>
                Choose File
              </Button>
              {csvData && (
                <span className="ml-2 text-sm text-muted-foreground">
                  {parseCsv(csvData).length} rows parsed
                </span>
              )}
            </div>
            <textarea
              className="w-full h-32 border rounded p-2 font-mono text-xs"
              placeholder="Or paste CSV data here..."
              value={csvData}
              onChange={(e) => setCsvData(e.target.value)}
            />
            {csvData && parseCsv(csvData).length > 0 && (
              <div className="text-sm">
                <p className="font-medium mb-1">Preview (first 5 rows):</p>
                <div className="border rounded text-xs">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        <th className="px-2 py-1 text-left">SKU</th>
                        <th className="px-2 py-1 text-left">Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parseCsv(csvData).slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b last:border-0">
                          <td className="px-2 py-1 font-mono">{row.sku}</td>
                          <td className="px-2 py-1 font-mono">{row.locationCode}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setImportOpen(false); setCsvData(""); }}>
              Cancel
            </Button>
            <Button
              onClick={handleImport}
              disabled={!csvData || parseCsv(csvData).length === 0 || importMutation.isPending}
            >
              {importMutation.isPending ? "Importing..." : `Import ${parseCsv(csvData).length} rows`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Location Picker Component (Command+Popover pattern per MEMORY.md)
function LocationPicker({
  locations,
  selectedId,
  open,
  onOpenChange,
  search,
  onSearchChange,
  onSelect,
  onCancel,
}: {
  locations: WarehouseLocation[];
  selectedId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onSelect: (loc: WarehouseLocation) => void;
  onCancel: () => void;
}) {
  const filtered = locations
    .filter(l =>
      l.code.toLowerCase().includes(search.toLowerCase()) ||
      (l.zone || "").toLowerCase().includes(search.toLowerCase())
    )
    .slice(0, 50);

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) onCancel(); }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className="w-full justify-between h-8 font-normal text-xs"
          >
            Select location...
            <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search bin code..."
              value={search}
              onValueChange={onSearchChange}
            />
            <CommandList>
              <CommandEmpty>No locations found.</CommandEmpty>
              <CommandGroup>
                {filtered.map(loc => (
                  <CommandItem
                    key={loc.id}
                    onSelect={() => onSelect(loc)}
                  >
                    <div className="flex-1">
                      <span className="font-mono font-medium">{loc.code}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        {loc.locationType} {loc.zone ? `- ${loc.zone}` : ""}
                      </span>
                    </div>
                    {loc.id === selectedId && <Check className="ml-auto h-4 w-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
