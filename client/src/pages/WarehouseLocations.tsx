import { useState, useMemo } from "react";
import { useDebounce } from "@/hooks/use-debounce";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Edit, MapPin, Layers, Box, ArrowRight, Upload, Download, CheckSquare, MoveRight, Package, Star, Search } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

interface WarehouseZone {
  id: number;
  code: string;
  name: string;
  description: string | null;
  locationType: string;
  isPickable: number;
}

interface WarehouseLocation {
  id: number;
  code: string;
  name: string | null;
  zone: string | null;
  aisle: string | null;
  bay: string | null;
  level: string | null;
  bin: string | null;
  locationType: string;
  isPickable: number;
  pickSequence: number | null;
  parentLocationId: number | null;
  capacityCubicMm: number | null;
  maxWeightG: number | null;
  widthMm: number | null;
  heightMm: number | null;
  depthMm: number | null;
  warehouseId: number | null;
  primarySku?: string | null;
}

interface Warehouse {
  id: number;
  name: string;
  code: string;
}

const LOCATION_TYPES = [
  { value: "bin", label: "Bin (Eaches Pick)" },
  { value: "pallet", label: "Pallet (Case Pick)" },
  { value: "carton_flow", label: "Carton Flow" },
  { value: "shelf", label: "Shelf" },
  { value: "floor", label: "Floor" },
  { value: "receiving", label: "Receiving" },
  { value: "putaway_staging", label: "Putaway Staging" },
  { value: "packing", label: "Packing" },
  { value: "shipping_lane", label: "Shipping Lane" },
  { value: "staging", label: "Staging" },
  { value: "returns", label: "Returns" },
  { value: "quarantine", label: "Quarantine" },
  { value: "crossdock", label: "Crossdock" },
  { value: "hazmat", label: "Hazmat" },
  { value: "cold_storage", label: "Cold Storage" },
  { value: "secure", label: "Secure" },
];

const DEFAULT_ZONES = [
  { code: "RCV", name: "Receiving Dock", locationType: "receiving" },
  { code: "BULK", name: "Bulk Reserve", locationType: "pallet" },
  { code: "FWD", name: "Forward Pick", locationType: "bin" },
  { code: "PACK", name: "Packing Station", locationType: "packing" },
  { code: "SHIP", name: "Shipping Lane", locationType: "shipping_lane" },
];

export default function WarehouseLocations() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("locations");
  const [isCreateLocationOpen, setIsCreateLocationOpen] = useState(false);
  const [isCreateZoneOpen, setIsCreateZoneOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<WarehouseLocation | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [csvData, setCsvData] = useState("");
  const [importWarehouseId, setImportWarehouseId] = useState<string>("");
  const [isReassignOpen, setIsReassignOpen] = useState(false);
  const [targetLocationId, setTargetLocationId] = useState<string>("");
  const [isAssignProductsOpen, setIsAssignProductsOpen] = useState(false);
  const [assigningToLocation, setAssigningToLocation] = useState<WarehouseLocation | null>(null);
  const [reassignLocationSearch, setReassignLocationSearch] = useState("");
  const [reassignLocationOpen, setReassignLocationOpen] = useState(false);
  const [newLocation, setNewLocation] = useState({
    zone: "",
    aisle: "",
    bay: "",
    level: "",
    bin: "",
    name: "",
    locationType: "bin",
    isPickable: 1,
    pickSequence: "",
    warehouseId: "",
  });
  const [newZone, setNewZone] = useState({
    code: "",
    name: "",
    description: "",
    locationType: "bin",
    isPickable: 1,
  });
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>("all");
  const [binSearchQuery, setBinSearchQuery] = useState<string>("");

  const canView = hasPermission("inventory", "view");
  const canEdit = hasPermission("inventory", "edit");
  const canCreate = hasPermission("inventory", "create");

  const { data: locations = [], isLoading: locationsLoading } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
    enabled: canView,
  });

  const { data: zones = [], isLoading: zonesLoading } = useQuery<WarehouseZone[]>({
    queryKey: ["/api/warehouse/zones"],
    enabled: canView,
  });

  const { data: warehouses = [] } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
    enabled: canView,
  });

  interface ProductSearchResult {
    id: number;
    title: string;
    sku: string | null;
    imageUrl: string | null;
    matchedVariantSku: string | null;
  }

  interface ProductInBin {
    id: number;
    productId: number | null;
    name: string;
    sku: string | null;
    locationType: string;
    isPrimary: number;
    warehouseLocationId?: number;
  }

  interface InventoryInBin {
    id: number;
    variantId: number;
    qty: number;
    reservedQty: number;
    pickedQty: number;
    sku: string | null;
    variantName: string | null;
    unitsPerVariant: number;
    productTitle: string | null;
    productId: number | null;
    imageUrl: string | null;
    barcode: string | null;
  }

  const { data: inventoryInBin = [], refetch: refetchInventoryInBin } = useQuery<InventoryInBin[]>({
    queryKey: ["/api/warehouse/locations", assigningToLocation?.id, "inventory"],
    queryFn: async () => {
      if (!assigningToLocation) return [];
      const res = await fetch(`/api/warehouse/locations/${assigningToLocation.id}/inventory`);
      if (!res.ok) throw new Error("Failed to fetch inventory");
      return res.json();
    },
    enabled: !!assigningToLocation,
  });

  const { data: productsInBin = [], refetch: refetchProductsInBin } = useQuery<ProductInBin[]>({
    queryKey: ["/api/warehouse/locations", assigningToLocation?.id, "products"],
    queryFn: async () => {
      if (!assigningToLocation) return [];
      const res = await fetch(`/api/warehouse/locations/${assigningToLocation.id}/products`);
      if (!res.ok) throw new Error("Failed to fetch products");
      return res.json();
    },
    enabled: !!assigningToLocation && isAssignProductsOpen,
  });

  const [assignSkuSearch, setAssignSkuSearch] = useState("");
  const [assignSkuOpen, setAssignSkuOpen] = useState(false);
  const debouncedAssignSkuSearch = useDebounce(assignSkuSearch, 300);

  // Server-side search across products AND variant SKUs
  const { data: productSearchResults = [] } = useQuery<ProductSearchResult[]>({
    queryKey: ["/api/catalog/products/search", debouncedAssignSkuSearch],
    queryFn: async () => {
      if (!debouncedAssignSkuSearch || debouncedAssignSkuSearch.length < 2) return [];
      const res = await fetch(`/api/catalog/products/search?q=${encodeURIComponent(debouncedAssignSkuSearch)}&limit=20`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedAssignSkuSearch.length >= 2 && assignSkuOpen,
  });

  // Filter out already-assigned products
  const filteredProducts = useMemo(() => {
    const assignedIds = new Set(productsInBin.map(p => p.productId));
    return productSearchResults.filter(p => !assignedIds.has(p.id));
  }, [productSearchResults, productsInBin]);

  const assignProductMutation = useMutation({
    mutationFn: async ({ locationId, productId }: { locationId: number; productId: number }) => {
      const res = await fetch(`/api/warehouse/locations/${locationId}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, locationType: "pick", isPrimary: 1 }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to assign product");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "SKU assigned to location" });
      refetchProductsInBin();
      refetchInventoryInBin();
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      setAssignSkuSearch("");
      setAssignSkuOpen(false);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to assign", description: error.message, variant: "destructive" });
    },
  });

  const unassignProductMutation = useMutation({
    mutationFn: async (productLocationId: number) => {
      const res = await fetch(`/api/locations/${productLocationId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to unassign product");
    },
    onSuccess: () => {
      toast({ title: "SKU unassigned from location" });
      refetchProductsInBin();
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to unassign", description: error.message, variant: "destructive" });
    },
  });


  const createLocationMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch("/api/warehouse/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create location");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      setIsCreateLocationOpen(false);
      resetLocationForm();
      toast({ title: "Location created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateLocationMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => {
      const res = await fetch(`/api/warehouse/locations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update location");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      setEditingLocation(null);
      toast({ title: "Location updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteLocationMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/warehouse/locations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete location");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      toast({ title: "Location deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete location", variant: "destructive" });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await fetch("/api/warehouse/locations/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error("Failed to delete locations");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      setSelectedIds(new Set());
      if (data.errors?.length > 0) {
        toast({ 
          title: `Deleted ${data.deleted} locations`, 
          description: `${data.errors.length} errors: ${data.errors.slice(0, 3).join(", ")}${data.errors.length > 3 ? "..." : ""}`,
          variant: "destructive" 
        });
      } else {
        toast({ title: `Deleted ${data.deleted} locations` });
      }
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete locations", variant: "destructive" });
    },
  });

  const bulkReassignMutation = useMutation({
    mutationFn: async ({ sourceIds, targetId }: { sourceIds: number[]; targetId: number }) => {
      const res = await fetch("/api/warehouse/locations/bulk-reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceLocationIds: sourceIds, targetLocationId: targetId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to reassign products");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/product-locations"] });
      setSelectedIds(new Set());
      setIsReassignOpen(false);
      setTargetLocationId("");
      toast({ title: `Moved ${data.reassigned} products to new location` });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const bulkImportMutation = useMutation({
    mutationFn: async ({ locations, warehouseId }: { locations: any[]; warehouseId: number | null }) => {
      const res = await fetch("/api/warehouse/locations/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locations, warehouseId }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to import locations");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/locations"] });
      setIsImportOpen(false);
      setCsvData("");
      setImportWarehouseId("");
      const summary = [
        data.created > 0 ? `${data.created} created` : null,
        data.updated > 0 ? `${data.updated} updated` : null,
      ].filter(Boolean).join(", ");
      if (data.errors?.length > 0) {
        toast({ 
          title: `Import complete: ${summary || "0 changes"}`, 
          description: `${data.errors.length} errors: ${data.errors.slice(0, 3).join(", ")}${data.errors.length > 3 ? "..." : ""}`,
          variant: "default" 
        });
      } else {
        toast({ title: `Import complete: ${summary}` });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Import failed", description: error.message, variant: "destructive" });
    },
  });

  const createZoneMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch("/api/warehouse/zones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create zone");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/zones"] });
      setIsCreateZoneOpen(false);
      setNewZone({ code: "", name: "", description: "", locationType: "bin", isPickable: 1 });
      toast({ title: "Zone created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });



  const deleteZoneMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/warehouse/zones/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete zone");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse/zones"] });
      toast({ title: "Zone deleted" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete zone", variant: "destructive" });
    },
  });

  const resetLocationForm = () => {
    setNewLocation({
      zone: "",
      aisle: "",
      bay: "",
      level: "",
      bin: "",
      name: "",
      locationType: "bin",
      isPickable: 1,
      pickSequence: "",
      warehouseId: "",
    });
  };

  const handleCreateLocation = () => {
    const data: any = {
      locationType: newLocation.locationType,
      isPickable: newLocation.isPickable,
    };
    if (newLocation.zone) data.zone = newLocation.zone.toUpperCase();
    if (newLocation.aisle) data.aisle = newLocation.aisle.toUpperCase();
    if (newLocation.bay) data.bay = newLocation.bay.padStart(2, '0');
    if (newLocation.level) data.level = newLocation.level.toUpperCase();
    if (newLocation.bin) data.bin = newLocation.bin;
    if (newLocation.name) data.name = newLocation.name;
    if (newLocation.pickSequence) data.pickSequence = parseInt(newLocation.pickSequence);
    if (newLocation.warehouseId) data.warehouseId = parseInt(newLocation.warehouseId);
    
    createLocationMutation.mutate(data);
  };

  const handleUpdateLocation = () => {
    if (!editingLocation) return;
    const data: any = {
      locationType: editingLocation.locationType,
      isPickable: editingLocation.isPickable,
      zone: editingLocation.zone?.trim()?.toUpperCase() || null,
      aisle: editingLocation.aisle?.trim()?.toUpperCase() || null,
      bay: editingLocation.bay?.trim() ? editingLocation.bay.trim().padStart(2, '0') : null,
      level: editingLocation.level?.trim()?.toUpperCase() || null,
      bin: editingLocation.bin?.trim() || null,
      name: editingLocation.name?.trim() || null,
      pickSequence: editingLocation.pickSequence || null,
      warehouseId: editingLocation.warehouseId || null,
    };
    
    updateLocationMutation.mutate({ id: editingLocation.id, data });
  };

  const previewCode = () => {
    const parts = [
      newLocation.zone?.toUpperCase(),
      newLocation.aisle?.toUpperCase(),
      newLocation.bay?.padStart(2, '0'),
      newLocation.level?.toUpperCase(),
      newLocation.bin,
    ].filter(Boolean);
    return parts.join('-') || '---';
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === locations.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(locations.map(l => l.id)));
    }
  };

  const toggleSelect = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    if (confirm(`Delete ${selectedIds.size} location(s)? This cannot be undone.`)) {
      bulkDeleteMutation.mutate(Array.from(selectedIds));
    }
  };

  const parseCsv = (csv: string) => {
    const normalized = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const lines = normalized.split('\n').filter(line => line.trim());
    if (lines.length < 2) return [];
    
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const values: string[] = [];
      let current = '';
      let inQuotes = false;
      
      for (const char of line) {
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          values.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      values.push(current.trim());
      
      const row: any = {};
      headers.forEach((header, idx) => {
        const val = values[idx]?.replace(/^"|"$/g, '');
        if (val) row[header] = val;
      });
      if (Object.keys(row).length > 0) rows.push(row);
    }
    return rows;
  };

  const handleImport = () => {
    const locations = parseCsv(csvData);
    if (locations.length === 0) {
      toast({ title: "No data found", description: "Please check your CSV format", variant: "destructive" });
      return;
    }
    const warehouseId = importWarehouseId ? parseInt(importWarehouseId) : null;
    bulkImportMutation.mutate({ locations, warehouseId });
  };

  const downloadTemplate = () => {
    const template = "zone,aisle,bay,level,bin,name,location_type,bin_type,is_pickable,pick_sequence,warehouse_id\nFWD,A,01,A,1,Forward Pick A1,pick,bin,1,1,\nBULK,B,02,B,,Bulk B2,reserve,pallet,0,,\nFWD,F,01,,,Floor Pallet F1,pick,pallet,1,,";
    const blob = new Blob([template], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'warehouse_locations_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportLocations = () => {
    window.location.href = "/api/warehouse/locations/export/csv";
  };

  if (!canView) {
    return (
      <div className="p-2 md:p-8 text-center text-muted-foreground">
        You don't have permission to view warehouse locations.
      </div>
    );
  }

  const filteredLocations = useMemo(() => {
    let result = locations;
    
    if (selectedWarehouseId !== "all") {
      result = result.filter(loc => loc.warehouseId === parseInt(selectedWarehouseId));
    }
    
    if (binSearchQuery.trim()) {
      const query = binSearchQuery.toLowerCase().trim();
      result = result.filter(loc => 
        loc.code?.toLowerCase().includes(query) ||
        loc.name?.toLowerCase().includes(query) ||
        loc.zone?.toLowerCase().includes(query) ||
        loc.aisle?.toLowerCase().includes(query) ||
        loc.bay?.toLowerCase().includes(query) ||
        loc.level?.toLowerCase().includes(query) ||
        loc.bin?.toLowerCase().includes(query)
      );
    }
    
    return result;
  }, [locations, selectedWarehouseId, binSearchQuery]);

  const getWarehouseName = (warehouseId: number | null) => {
    if (!warehouseId) return "-";
    const wh = warehouses.find(w => w.id === warehouseId);
    return wh ? wh.code : "-";
  };

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-5 w-5 md:h-6 md:w-6" />
            Bin Locations
          </h1>
          <p className="text-xs md:text-sm text-muted-foreground">
            Manage your warehouse bins and set primary SKU slotting
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto -mx-2 px-2 md:mx-0 md:px-0">
          <TabsList className="w-max min-w-full md:w-auto">
            <TabsTrigger value="locations" className="min-h-[44px]" data-testid="tab-locations">
              <Box className="h-4 w-4 mr-2" />
              Locations ({filteredLocations.length})
            </TabsTrigger>
            <TabsTrigger value="zones" className="min-h-[44px]" data-testid="tab-zones">
              <Layers className="h-4 w-4 mr-2" />
              Zones ({zones.length})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="locations" className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search bins..."
                  value={binSearchQuery}
                  onChange={(e) => setBinSearchQuery(e.target.value)}
                  className="pl-9 h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-bin-search"
                />
              </div>
              <Select value={selectedWarehouseId} onValueChange={setSelectedWarehouseId}>
                <SelectTrigger className="w-full sm:w-48 h-11" data-testid="select-warehouse-filter">
                  <SelectValue placeholder="All Warehouses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Warehouses</SelectItem>
                  {warehouses.map((wh) => (
                    <SelectItem key={wh.id} value={wh.id.toString()}>
                      {wh.name} ({wh.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">
                <code className="bg-muted px-1 rounded hidden sm:inline">ZONE-AISLE-BAY-LEVEL-BIN</code>
                {selectedIds.size > 0 && (
                  <span className="sm:ml-4 text-primary font-medium">{selectedIds.size} selected</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              {selectedIds.size > 0 && canEdit && (
                <>
                  <Button 
                    variant="outline" 
                    onClick={() => setIsReassignOpen(true)}
                    disabled={bulkReassignMutation.isPending}
                    data-testid="btn-bulk-reassign"
                    className="flex-1 sm:flex-none min-h-[44px]"
                  >
                    <MoveRight className="h-4 w-4 mr-2" />
                    <span className="hidden sm:inline">Move Products</span>
                    <span className="sm:hidden">Move</span> ({selectedIds.size})
                  </Button>
                  <Button 
                    variant="destructive" 
                    onClick={handleBulkDelete}
                    disabled={bulkDeleteMutation.isPending}
                    data-testid="btn-bulk-delete"
                    className="flex-1 sm:flex-none min-h-[44px]"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    <span className="hidden sm:inline">Delete Selected</span>
                    <span className="sm:hidden">Delete</span> ({selectedIds.size})
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={handleExportLocations} data-testid="btn-export-csv" className="flex-1 sm:flex-none min-h-[44px]">
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
              {canCreate && (
                <>
                  <Button variant="outline" onClick={() => setIsImportOpen(true)} data-testid="btn-import-csv" className="flex-1 sm:flex-none min-h-[44px]">
                    <Upload className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Import CSV</span>
                  </Button>
                  <Button onClick={() => setIsCreateLocationOpen(true)} data-testid="btn-create-location" className="flex-1 sm:flex-none min-h-[44px]">
                    <Plus className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Add Location</span>
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Mobile card layout */}
          <div className="md:hidden space-y-3">
            {locationsLoading ? (
              <div className="text-center py-8">Loading...</div>
            ) : filteredLocations.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No locations defined yet. Add your first location or import from CSV.
                </CardContent>
              </Card>
            ) : (
              filteredLocations.map((loc) => (
                <Card key={loc.id} data-testid={`location-card-${loc.id}`} className={selectedIds.has(loc.id) ? "border-primary" : ""}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        {canEdit && (
                          <Checkbox
                            checked={selectedIds.has(loc.id)}
                            onCheckedChange={() => toggleSelect(loc.id)}
                            data-testid={`checkbox-location-mobile-${loc.id}`}
                            className="mt-1"
                          />
                        )}
                        <div className="space-y-1">
                          <div className="font-mono font-medium text-sm">{loc.code}</div>
                          <div className="flex flex-wrap gap-1">
                            <Badge variant="outline" className="text-xs">{loc.locationType.replace('_', ' ')}</Badge>
                            {loc.zone && <Badge variant="secondary" className="text-xs">{loc.zone}</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {loc.name && <div>{loc.name}</div>}
                            <div>Warehouse: {getWarehouseName(loc.warehouseId)}</div>
                          </div>
                        </div>
                      </div>
                      {canEdit && (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-[44px] min-w-[44px]"
                            onClick={() => setEditingLocation(loc)}
                            data-testid={`btn-edit-location-mobile-${loc.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-[44px] min-w-[44px]"
                            onClick={() => deleteLocationMutation.mutate(loc.id)}
                            data-testid={`btn-delete-location-mobile-${loc.id}`}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>

          {/* Desktop table layout */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  {canEdit && (
                    <TableHead className="w-[40px]">
                      <Checkbox
                        checked={locations.length > 0 && selectedIds.size === locations.length}
                        onCheckedChange={toggleSelectAll}
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                  )}
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Location Code</TableHead>
                  <TableHead>Primary SKU</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Aisle</TableHead>
                  <TableHead>Bay</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Bin</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Pick Seq</TableHead>
                  {canEdit && <TableHead className="w-[120px]"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {locationsLoading ? (
                  <TableRow>
                    <TableCell colSpan={canEdit ? 13 : 11} className="text-center py-8">Loading...</TableCell>
                  </TableRow>
                ) : locations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canEdit ? 13 : 11} className="text-center py-8 text-muted-foreground">
                      No locations defined yet. Add your first location or import from CSV.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLocations.map((loc) => (
                    <TableRow key={loc.id} data-testid={`location-row-${loc.id}`} className={selectedIds.has(loc.id) ? "bg-muted/50" : ""}>
                      {canEdit && (
                        <TableCell>
                          <Checkbox
                            checked={selectedIds.has(loc.id)}
                            onCheckedChange={() => toggleSelect(loc.id)}
                            data-testid={`checkbox-location-${loc.id}`}
                          />
                        </TableCell>
                      )}
                      <TableCell>{getWarehouseName(loc.warehouseId)}</TableCell>
                      <TableCell className="font-mono font-medium">{loc.code}</TableCell>
                      <TableCell className="font-mono text-sm">
                        {loc.primarySku || <span className="text-muted-foreground">-</span>}
                      </TableCell>
                      <TableCell>{loc.zone || '-'}</TableCell>
                      <TableCell>{loc.aisle || '-'}</TableCell>
                      <TableCell>{loc.bay || '-'}</TableCell>
                      <TableCell>{loc.level || '-'}</TableCell>
                      <TableCell>{loc.bin || '-'}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{loc.locationType.replace('_', ' ')}</Badge>
                      </TableCell>
                      <TableCell>{loc.pickSequence ?? '-'}</TableCell>
                      {canEdit && (
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setAssigningToLocation(loc);
                                setIsAssignProductsOpen(true);
                              }}
                              title="View Inventory"
                              data-testid={`btn-view-inventory-${loc.id}`}
                            >
                              <Package className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingLocation(loc)}
                              data-testid={`btn-edit-location-${loc.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteLocationMutation.mutate(loc.id)}
                              data-testid={`btn-delete-location-${loc.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="zones" className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div className="text-xs md:text-sm text-muted-foreground">
              Zones organize your warehouse into logical areas
            </div>
            {canCreate && (
              <Button onClick={() => setIsCreateZoneOpen(true)} data-testid="btn-create-zone" className="w-full sm:w-auto min-h-[44px]">
                <Plus className="h-4 w-4 mr-2" />
                Add Zone
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
            {zonesLoading ? (
              <div className="col-span-full text-center py-8">Loading...</div>
            ) : zones.length === 0 ? (
              <Card className="col-span-full">
                <CardContent className="py-8 text-center text-muted-foreground">
                  <p>No zones defined yet.</p>
                  <p className="text-xs md:text-sm mt-2">Common zones: RCV (Receiving), BULK (Bulk Storage), FWD (Forward Pick), PACK, SHIP</p>
                </CardContent>
              </Card>
            ) : (
              zones.map((zone) => (
                <Card key={zone.id} data-testid={`zone-card-${zone.id}`}>
                  <CardHeader className="pb-2 p-3 md:p-6">
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-base md:text-lg font-mono">{zone.code}</CardTitle>
                        <CardDescription className="text-xs md:text-sm">{zone.name}</CardDescription>
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="min-h-[44px] min-w-[44px]"
                          onClick={() => deleteZoneMutation.mutate(zone.id)}
                          data-testid={`btn-delete-zone-${zone.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
                    <div className="flex gap-2">
                      <Badge variant="outline" className="text-xs">{zone.locationType.replace('_', ' ')}</Badge>
                      {zone.isPickable === 1 && <Badge variant="secondary" className="text-xs">Pickable</Badge>}
                    </div>
                    {zone.description && (
                      <p className="text-xs text-muted-foreground mt-2">{zone.description}</p>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Create Location Dialog */}
      <Dialog open={isCreateLocationOpen} onOpenChange={setIsCreateLocationOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add New Location</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted p-3 rounded-lg text-center">
              <span className="text-xs text-muted-foreground">Preview: </span>
              <span className="font-mono font-bold text-base md:text-lg">{previewCode()}</span>
            </div>
            
            <div className="grid grid-cols-5 gap-2">
              <div>
                <Label className="text-xs">Zone</Label>
                <Input
                  placeholder="FWD"
                  value={newLocation.zone}
                  onChange={(e) => setNewLocation({ ...newLocation, zone: e.target.value })}
                  className="uppercase h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-location-zone"
                />
              </div>
              <div>
                <Label className="text-xs">Aisle</Label>
                <Input
                  placeholder="A"
                  value={newLocation.aisle}
                  onChange={(e) => setNewLocation({ ...newLocation, aisle: e.target.value })}
                  className="uppercase h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-location-aisle"
                />
              </div>
              <div>
                <Label className="text-xs">Bay</Label>
                <Input
                  placeholder="01"
                  value={newLocation.bay}
                  onChange={(e) => setNewLocation({ ...newLocation, bay: e.target.value })}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-location-bay"
                />
              </div>
              <div>
                <Label className="text-xs">Level</Label>
                <Input
                  placeholder="B"
                  value={newLocation.level}
                  onChange={(e) => setNewLocation({ ...newLocation, level: e.target.value })}
                  className="uppercase h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-location-level"
                />
              </div>
              <div>
                <Label className="text-xs">Bin</Label>
                <Input
                  placeholder="1"
                  value={newLocation.bin}
                  onChange={(e) => setNewLocation({ ...newLocation, bin: e.target.value })}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-location-bin"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Warehouse</Label>
                <Select
                  value={newLocation.warehouseId}
                  onValueChange={(v) => setNewLocation({ ...newLocation, warehouseId: v })}
                >
                  <SelectTrigger className="h-11" data-testid="select-location-warehouse">
                    <SelectValue placeholder="Select warehouse..." />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses.map((wh) => (
                      <SelectItem key={wh.id} value={wh.id.toString()}>
                        {wh.name} ({wh.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Location Type</Label>
                <Select
                  value={newLocation.locationType}
                  onValueChange={(v) => setNewLocation({ ...newLocation, locationType: v })}
                >
                  <SelectTrigger className="h-11" data-testid="select-location-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <details className="group">
              <summary className="text-xs font-medium cursor-pointer list-none flex items-center gap-2 py-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Optional Fields
              </summary>
              <div className="space-y-3 pt-2">
                <div>
                  <Label className="text-xs">Friendly Name</Label>
                  <Input
                    placeholder="Main floor left"
                    value={newLocation.name}
                    onChange={(e) => setNewLocation({ ...newLocation, name: e.target.value })}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-location-name"
                  />
                </div>

                <div>
                  <Label className="text-xs">Pick Sequence</Label>
                  <Input
                    type="number"
                    placeholder="Auto"
                    value={newLocation.pickSequence}
                    onChange={(e) => setNewLocation({ ...newLocation, pickSequence: e.target.value })}
                    className="h-11"
                    autoComplete="off"
                    data-testid="input-location-sequence"
                  />
                </div>
              </div>
            </details>

            <div className="flex items-center space-x-2 min-h-[44px]">
              <Checkbox
                id="create-is-pickable"
                checked={newLocation.isPickable === 1}
                onCheckedChange={(checked) => setNewLocation({ ...newLocation, isPickable: checked ? 1 : 0 })}
                data-testid="checkbox-location-pickable"
              />
              <Label htmlFor="create-is-pickable" className="text-xs md:text-sm font-normal cursor-pointer">
                Forward Pick Location (direct picker access)
              </Label>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setIsCreateLocationOpen(false)} className="min-h-[44px] w-full sm:w-auto">Cancel</Button>
            <Button 
              onClick={handleCreateLocation}
              disabled={createLocationMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="btn-save-location"
            >
              Create Location
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Location Dialog */}
      <Dialog open={!!editingLocation} onOpenChange={(open) => !open && setEditingLocation(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Edit Location</DialogTitle>
          </DialogHeader>
          {editingLocation && (
            <div className="space-y-4">
              <div className="bg-muted p-3 rounded-lg text-center">
                <span className="font-mono font-bold text-base md:text-lg">{editingLocation.code}</span>
              </div>
              
              <div className="grid grid-cols-5 gap-2">
                <div>
                  <Label className="text-xs">Zone</Label>
                  <Input
                    value={editingLocation.zone || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, zone: e.target.value || null })}
                    className="uppercase h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <Label className="text-xs">Aisle</Label>
                  <Input
                    value={editingLocation.aisle || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, aisle: e.target.value || null })}
                    className="uppercase h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <Label className="text-xs">Bay</Label>
                  <Input
                    value={editingLocation.bay || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, bay: e.target.value || null })}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <Label className="text-xs">Level</Label>
                  <Input
                    value={editingLocation.level || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, level: e.target.value || null })}
                    className="uppercase h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
                <div>
                  <Label className="text-xs">Bin</Label>
                  <Input
                    value={editingLocation.bin || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, bin: e.target.value || null })}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Warehouse</Label>
                  <Select
                    value={editingLocation.warehouseId?.toString() || "none"}
                    onValueChange={(v) => setEditingLocation({ ...editingLocation, warehouseId: v && v !== "none" ? parseInt(v) : null })}
                  >
                    <SelectTrigger className="h-11" data-testid="select-edit-warehouse">
                      <SelectValue placeholder="Select warehouse..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No warehouse</SelectItem>
                      {warehouses.map((wh) => (
                        <SelectItem key={wh.id} value={wh.id.toString()}>
                          {wh.name} ({wh.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Location Type</Label>
                  <Select
                    value={editingLocation.locationType}
                    onValueChange={(v) => setEditingLocation({ ...editingLocation, locationType: v })}
                  >
                    <SelectTrigger className="h-11">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCATION_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <details className="group">
                <summary className="text-xs font-medium cursor-pointer list-none flex items-center gap-2 py-2">
                  <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                  Optional Fields
                </summary>
                <div className="space-y-3 pt-2">
                  <div>
                    <Label className="text-xs">Friendly Name</Label>
                    <Input
                      value={editingLocation.name || ""}
                      onChange={(e) => setEditingLocation({ ...editingLocation, name: e.target.value || null })}
                      className="h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </div>

                  <div>
                    <Label className="text-xs">Pick Sequence</Label>
                    <Input
                      type="number"
                      value={editingLocation.pickSequence ?? ""}
                      onChange={(e) => setEditingLocation({ 
                        ...editingLocation, 
                        pickSequence: e.target.value ? parseInt(e.target.value) : null 
                      })}
                      className="h-11"
                      autoComplete="off"
                    />
                  </div>
                </div>
              </details>

              <div className="flex items-center space-x-2 min-h-[44px]">
                <Checkbox
                  id="edit-is-pickable"
                  checked={editingLocation.isPickable === 1}
                  onCheckedChange={(checked) => setEditingLocation({ 
                    ...editingLocation, 
                    isPickable: checked ? 1 : 0 
                  })}
                  data-testid="checkbox-edit-location-pickable"
                />
                <Label htmlFor="edit-is-pickable" className="text-xs md:text-sm font-normal cursor-pointer">
                  Forward Pick Location (direct picker access)
                </Label>
              </div>
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setEditingLocation(null)} className="min-h-[44px] w-full sm:w-auto">Cancel</Button>
            <Button 
              onClick={handleUpdateLocation}
              disabled={updateLocationMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Zone Dialog */}
      <Dialog open={isCreateZoneOpen} onOpenChange={setIsCreateZoneOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add New Zone</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Zone Code</Label>
                <Input
                  placeholder="FWD"
                  value={newZone.code}
                  onChange={(e) => setNewZone({ ...newZone, code: e.target.value })}
                  className="uppercase h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-zone-code"
                />
                <p className="text-xs text-muted-foreground mt-1">Short code like RCV, BULK, FWD</p>
              </div>
              <div>
                <Label className="text-xs">Zone Name</Label>
                <Input
                  placeholder="Forward Pick Area"
                  value={newZone.name}
                  onChange={(e) => setNewZone({ ...newZone, name: e.target.value })}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-zone-name"
                />
              </div>
            </div>
            
            <details className="group">
              <summary className="text-xs font-medium cursor-pointer list-none flex items-center gap-2 py-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Optional Fields
              </summary>
              <div className="space-y-3 pt-2">
                <div>
                  <Label className="text-xs">Description</Label>
                  <Input
                    placeholder="Main picking area for fast-moving items"
                    value={newZone.description}
                    onChange={(e) => setNewZone({ ...newZone, description: e.target.value })}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-zone-description"
                  />
                </div>
              </div>
            </details>
            
            <div>
              <Label className="text-xs">Default Location Type</Label>
              <Select
                value={newZone.locationType}
                onValueChange={(v) => setNewZone({ ...newZone, locationType: v })}
              >
                <SelectTrigger className="h-11" data-testid="select-zone-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCATION_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setIsCreateZoneOpen(false)} className="min-h-[44px] w-full sm:w-auto">Cancel</Button>
            <Button 
              onClick={() => createZoneMutation.mutate(newZone)}
              disabled={!newZone.code || !newZone.name || createZoneMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="btn-save-zone"
            >
              Create Zone
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV Import Dialog */}
      <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
        <DialogContent className="max-w-md md:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Import Locations from CSV</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <p className="text-xs md:text-sm text-muted-foreground">
                Upload a CSV file with location data. Set a default warehouse or include warehouse_id in CSV.
              </p>
              <Button variant="outline" size="sm" onClick={downloadTemplate} className="min-h-[44px]" data-testid="btn-download-template">
                <Download className="h-4 w-4 mr-2" />
                Template
              </Button>
            </div>

            <div>
              <Label className="text-xs">Default Warehouse</Label>
              <Select value={importWarehouseId || "none"} onValueChange={(v) => setImportWarehouseId(v === "none" ? "" : v)}>
                <SelectTrigger className="h-11" data-testid="select-import-warehouse">
                  <SelectValue placeholder="Select warehouse..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No default (use CSV values)</SelectItem>
                  {warehouses.map((wh) => (
                    <SelectItem key={wh.id} value={wh.id.toString()}>
                      {wh.name} ({wh.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <Label htmlFor="csv-file-input" className="cursor-pointer">
                  <div className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-accent transition-colors min-h-[44px]">
                    <Upload className="h-4 w-4" />
                    <span className="text-sm">Choose CSV File</span>
                  </div>
                  <input
                    id="csv-file-input"
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (event) => {
                          const text = event.target?.result as string;
                          if (text) setCsvData(text);
                        };
                        reader.readAsText(file);
                      }
                      e.target.value = "";
                    }}
                    data-testid="input-csv-file"
                  />
                </Label>
                <span className="text-xs text-muted-foreground">or paste data below</span>
              </div>
              
              <div>
                <Label className="text-xs">CSV Data</Label>
                <Textarea
                  className="font-mono text-xs h-32 md:h-48"
                  placeholder="zone,aisle,bay,level,bin,name,location_type,is_pickable,pick_sequence
FWD,A,01,A,1,Forward Pick A1,bin,1,1
BULK,B,02,B,,Bulk B2,pallet,0,"
                  value={csvData}
                  onChange={(e) => setCsvData(e.target.value)}
                  data-testid="textarea-csv-data"
                />
              </div>
            </div>

            <details className="group">
              <summary className="text-xs font-medium cursor-pointer list-none flex items-center gap-2 py-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Column Reference
              </summary>
              <div className="text-xs text-muted-foreground pt-2">
                <ul className="list-disc list-inside space-y-1">
                  <li><code>zone, aisle, bay, level, bin</code> - Location hierarchy</li>
                  <li><code>name</code> - Friendly name (optional)</li>
                  <li><code>location_type</code> - bin, shelf, pallet, carton_flow, floor</li>
                  <li><code>is_pickable</code> - 1 or 0</li>
                  <li><code>pick_sequence</code> - Picking order (optional)</li>
                  <li><code>warehouse_id</code> - Warehouse ID (optional)</li>
                </ul>
              </div>
            </details>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setIsImportOpen(false); setCsvData(""); setImportWarehouseId(""); }} className="min-h-[44px] w-full sm:w-auto">Cancel</Button>
            <Button 
              onClick={handleImport}
              disabled={!csvData.trim() || bulkImportMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="btn-run-import"
            >
              <Upload className="h-4 w-4 mr-2" />
              {bulkImportMutation.isPending ? "Importing..." : "Import Locations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Reassign Dialog */}
      <Dialog open={isReassignOpen} onOpenChange={(open) => {
        setIsReassignOpen(open);
        if (!open) {
          setTargetLocationId("");
          setReassignLocationSearch("");
        }
      }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Move Products to New Location</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs md:text-sm text-muted-foreground">
              Move all products from the {selectedIds.size} selected location(s) to a new location.
              This will update the product-location mappings so you can delete the old locations.
            </p>
            <div>
              <Label className="text-xs">Target Location (Holding Bin)</Label>
              <Popover open={reassignLocationOpen} onOpenChange={setReassignLocationOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={reassignLocationOpen}
                    className="w-full justify-between mt-1 h-11"
                    data-testid="select-target-location"
                  >
                    {targetLocationId
                      ? (() => {
                          const loc = locations.find(l => l.id.toString() === targetLocationId);
                          return loc ? loc.code : "Select...";
                        })()
                      : "Search for location..."}
                    <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-full p-0" align="start">
                  <Command>
                    <CommandInput
                      placeholder="Search by bin code..."
                      value={reassignLocationSearch}
                      onValueChange={setReassignLocationSearch}
                      className="h-11"
                      data-testid="input-reassign-location-search"
                    />
                    <CommandList>
                      <CommandEmpty>No locations found.</CommandEmpty>
                      <CommandGroup>
                        {locations
                          .filter(loc => !selectedIds.has(loc.id))
                          .filter(loc => 
                            loc.code.toLowerCase().includes(reassignLocationSearch.toLowerCase()) ||
                            (loc.zone && loc.zone.toLowerCase().includes(reassignLocationSearch.toLowerCase()))
                          )
                          .sort((a, b) => {
                            if (a.locationType === 'staging' && b.locationType !== 'staging') return -1;
                            if (a.locationType !== 'staging' && b.locationType === 'staging') return 1;
                            return a.code.localeCompare(b.code);
                          })
                          .slice(0, 50)
                          .map(loc => (
                              <CommandItem
                                key={loc.id}
                                value={`${loc.code} ${loc.zone || ''}`}
                                onSelect={() => {
                                  setTargetLocationId(loc.id.toString());
                                  setReassignLocationOpen(false);
                                }}
                                className="flex justify-between items-center min-h-[44px]"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-sm">{loc.code}</div>
                                  <div className="text-xs text-muted-foreground truncate">
                                    {loc.locationType.replace('_', ' ')}
                                    {loc.zone && ` • Zone ${loc.zone}`}
                                  </div>
                                </div>
                              </CommandItem>
                            ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-xs text-muted-foreground mt-1">
                Tip: Empty bins are shown first. Create a staging location for products awaiting reassignment.
              </p>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => { setIsReassignOpen(false); setTargetLocationId(""); setReassignLocationSearch(""); }} className="min-h-[44px] w-full sm:w-auto">
              Cancel
            </Button>
            <Button 
              onClick={() => bulkReassignMutation.mutate({ 
                sourceIds: Array.from(selectedIds), 
                targetId: parseInt(targetLocationId) 
              })}
              disabled={!targetLocationId || bulkReassignMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="btn-confirm-reassign"
            >
              <MoveRight className="h-4 w-4 mr-2" />
              {bulkReassignMutation.isPending ? "Moving..." : "Move Products"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Inventory / Assign SKU Dialog */}
      <Dialog open={isAssignProductsOpen} onOpenChange={(open) => {
        setIsAssignProductsOpen(open);
        if (!open) {
          setAssigningToLocation(null);
          setAssignSkuSearch("");
          setAssignSkuOpen(false);
        }
      }}>
        <DialogContent className="max-w-md md:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Location {assigningToLocation?.code}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Assigned SKUs Section */}
            <div>
              <Label className="text-xs md:text-sm font-medium">Assigned SKUs ({productsInBin.length})</Label>
              {productsInBin.length === 0 ? (
                <p className="text-xs md:text-sm text-muted-foreground py-2">No SKUs assigned to this location.</p>
              ) : (
                <div className="mt-2 space-y-1">
                  {productsInBin.map((p) => (
                    <div key={p.id} className="flex items-center justify-between bg-muted/50 rounded px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <div className="font-medium text-xs md:text-sm">{p.sku || "No SKU"}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[250px]">{p.name}</div>
                        </div>
                        {p.isPrimary === 1 && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Primary</Badge>
                        )}
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => unassignProductMutation.mutate(p.id)}
                          disabled={unassignProductMutation.isPending}
                          title="Unassign SKU"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Assign SKU Search */}
              {canEdit && (
                <div className="mt-3">
                  <Popover open={assignSkuOpen} onOpenChange={setAssignSkuOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="w-full justify-start gap-2 h-10">
                        <Plus className="h-4 w-4" />
                        Assign SKU to this location
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[350px] p-0" align="start">
                      <Command shouldFilter={false}>
                        <CommandInput
                          placeholder="Search by SKU or product name..."
                          value={assignSkuSearch}
                          onValueChange={setAssignSkuSearch}
                        />
                        <CommandList>
                          {assignSkuSearch.length < 2 ? (
                            <CommandEmpty>Type at least 2 characters to search...</CommandEmpty>
                          ) : filteredProducts.length === 0 ? (
                            <CommandEmpty>No matching products found.</CommandEmpty>
                          ) : (
                            <CommandGroup>
                              {filteredProducts.map((product) => (
                                <CommandItem
                                  key={product.id}
                                  onSelect={() => {
                                    if (assigningToLocation) {
                                      assignProductMutation.mutate({
                                        locationId: assigningToLocation.id,
                                        productId: product.id,
                                      });
                                    }
                                  }}
                                  className="cursor-pointer"
                                >
                                  <div className="flex items-center gap-2 w-full">
                                    {product.imageUrl && (
                                      <img src={product.imageUrl} alt="" className="w-8 h-8 object-cover rounded" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="font-medium text-sm">{product.sku || "No SKU"}</div>
                                      {product.matchedVariantSku && product.matchedVariantSku !== product.sku && (
                                        <div className="text-xs text-blue-600 font-mono">variant: {product.matchedVariantSku}</div>
                                      )}
                                      <div className="text-xs text-muted-foreground truncate">{product.title}</div>
                                    </div>
                                  </div>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              )}
            </div>

            {/* Current Inventory Section */}
            <div>
              <Label className="text-xs md:text-sm font-medium">Inventory on Hand ({inventoryInBin.length} items)</Label>
              {inventoryInBin.length === 0 ? (
                <p className="text-xs md:text-sm text-muted-foreground py-2">No inventory at this location.</p>
              ) : (
                <ScrollArea className="h-48 border rounded-md mt-2">
                  <div className="p-2 space-y-2">
                    {inventoryInBin.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between bg-muted/50 rounded px-3 py-2">
                        <div className="flex items-center gap-3">
                          {inv.imageUrl && (
                            <img src={inv.imageUrl} alt="" className="w-10 h-10 object-cover rounded" />
                          )}
                          <div>
                            <div className="font-medium text-xs md:text-sm">{inv.sku || inv.variantName || "Unknown"}</div>
                            <div className="text-xs text-muted-foreground">
                              {inv.productTitle && <span className="truncate max-w-[200px] block">{inv.productTitle}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-bold text-sm">{inv.qty}</div>
                          <div className="text-xs text-muted-foreground">on hand</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAssignProductsOpen(false)} className="min-h-[44px] w-full sm:w-auto">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
