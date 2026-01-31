import { useState, useMemo } from "react";
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
  minQty: number | null;
  maxQty: number | null;
  maxWeight: number | null;
  widthInches: number | null;
  heightInches: number | null;
  depthInches: number | null;
  warehouseId: number | null;
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
  { value: "bulk_reserve", label: "Bulk Reserve" },
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
  { code: "BULK", name: "Bulk Reserve", locationType: "bulk_reserve" },
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
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [productSearchOpen, setProductSearchOpen] = useState(false);
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [assignLocationType, setAssignLocationType] = useState("forward_pick");
  const [assignIsPrimary, setAssignIsPrimary] = useState(true);
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
    minQty: "",
    maxQty: "",
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

  interface CatalogProduct {
    id: number;
    title: string;
    sku: string | null;
    imageUrl: string | null;
  }
  const { data: catalogProducts = [] } = useQuery<CatalogProduct[]>({
    queryKey: ["/api/catalog/products"],
    enabled: isAssignProductsOpen,
  });

  interface ProductInBin {
    id: number;
    catalogProductId: number | null;
    name: string;
    sku: string | null;
    locationType: string;
    isPrimary: number;
    warehouseLocationId?: number;
  }
  const { data: productsInBin = [], refetch: refetchProductsInBin } = useQuery<ProductInBin[]>({
    queryKey: ["/api/warehouse/locations", assigningToLocation?.id, "products"],
    queryFn: async () => {
      if (!assigningToLocation) return [];
      const res = await fetch(`/api/warehouse/locations/${assigningToLocation.id}/products`);
      if (!res.ok) throw new Error("Failed to fetch products");
      return res.json();
    },
    enabled: !!assigningToLocation,
  });

  // Fetch all product locations to show SKUs in the table
  const { data: allProductLocations = [] } = useQuery<ProductInBin[]>({
    queryKey: ["/api/locations"],
    queryFn: async () => {
      const res = await fetch("/api/locations");
      if (!res.ok) throw new Error("Failed to fetch product locations");
      return res.json();
    },
    enabled: canView,
  });

  // Map warehouse location ID to SKU for quick lookup
  const skuByLocationId = useMemo(() => {
    const map = new Map<number, string>();
    for (const pl of allProductLocations) {
      if (pl.warehouseLocationId && pl.sku) {
        const existing = map.get(pl.warehouseLocationId);
        if (existing) {
          map.set(pl.warehouseLocationId, existing + ", " + pl.sku);
        } else {
          map.set(pl.warehouseLocationId, pl.sku);
        }
      }
    }
    return map;
  }, [allProductLocations]);

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

  const assignProductMutation = useMutation({
    mutationFn: async ({ warehouseLocationId, catalogProductId, locationType, isPrimary }: { warehouseLocationId: number; catalogProductId: number; locationType: string; isPrimary: number }) => {
      const res = await fetch(`/api/warehouse/locations/${warehouseLocationId}/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catalogProductId, locationType, isPrimary }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to assign product");
      }
      return res.json();
    },
    onSuccess: () => {
      refetchProductsInBin();
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      setSelectedProductId(null);
      setProductSearchQuery("");
      toast({ title: "Product assigned to location" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const removeProductFromLocationMutation = useMutation({
    mutationFn: async (productLocationId: number) => {
      const res = await fetch(`/api/locations/${productLocationId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove product");
      return res.json();
    },
    onSuccess: () => {
      refetchProductsInBin();
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      toast({ title: "Product removed from location" });
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
      minQty: "",
      maxQty: "",
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
    if (newLocation.minQty) data.minQty = parseInt(newLocation.minQty);
    if (newLocation.maxQty) data.maxQty = parseInt(newLocation.maxQty);
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
      minQty: editingLocation.minQty || null,
      maxQty: editingLocation.maxQty || null,
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
    // Normalize line endings (Windows \r\n, old Mac \r, Unix \n)
    const normalized = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const lines = normalized.split('\n').filter(line => line.trim());
    if (lines.length < 2) return [];
    
    const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Simple CSV parsing - handles basic quoted values
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
    const template = "zone,aisle,bay,level,bin,name,location_type,is_pickable,pick_sequence,min_qty,max_qty,warehouse_id\nFWD,A,01,A,1,Forward Pick A1,bin,1,1,5,50,\nBULK,B,02,B,,Bulk B2,bulk_reserve,0,,,100,";
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
      <div className="p-8 text-center text-muted-foreground">
        You don't have permission to view warehouse locations.
      </div>
    );
  }

  // Filter locations by selected warehouse and search query
  const filteredLocations = useMemo(() => {
    let result = locations;
    
    // Filter by warehouse
    if (selectedWarehouseId !== "all") {
      result = result.filter(loc => loc.warehouseId === parseInt(selectedWarehouseId));
    }
    
    // Filter by search query
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

  // Helper to get warehouse name
  const getWarehouseName = (warehouseId: number | null) => {
    if (!warehouseId) return "-";
    const wh = warehouses.find(w => w.id === warehouseId);
    return wh ? wh.code : "-";
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6" />
            Bin Locations
          </h1>
          <p className="text-muted-foreground">
            Manage your warehouse bins and set primary SKU slotting
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <TabsList className="w-max min-w-full md:w-auto">
            <TabsTrigger value="locations" data-testid="tab-locations">
              <Box className="h-4 w-4 mr-2" />
              Locations ({filteredLocations.length})
            </TabsTrigger>
            <TabsTrigger value="zones" data-testid="tab-zones">
              <Layers className="h-4 w-4 mr-2" />
              Zones ({zones.length})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="locations" className="space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 w-full sm:w-auto">
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search bins..."
                  value={binSearchQuery}
                  onChange={(e) => setBinSearchQuery(e.target.value)}
                  className="pl-9"
                  data-testid="input-bin-search"
                />
              </div>
              <Select value={selectedWarehouseId} onValueChange={setSelectedWarehouseId}>
                <SelectTrigger className="w-full sm:w-48" data-testid="select-warehouse-filter">
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
              <div className="text-sm text-muted-foreground">
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
                    className="flex-1 sm:flex-none"
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
                    className="flex-1 sm:flex-none"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    <span className="hidden sm:inline">Delete Selected</span>
                    <span className="sm:hidden">Delete</span> ({selectedIds.size})
                  </Button>
                </>
              )}
              <Button variant="outline" onClick={handleExportLocations} data-testid="btn-export-csv" className="flex-1 sm:flex-none">
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Export CSV</span>
              </Button>
              {canCreate && (
                <>
                  <Button variant="outline" onClick={() => setIsImportOpen(true)} data-testid="btn-import-csv" className="flex-1 sm:flex-none">
                    <Upload className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Import CSV</span>
                  </Button>
                  <Button onClick={() => setIsCreateLocationOpen(true)} data-testid="btn-create-location" className="flex-1 sm:flex-none">
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
                  <CardContent className="p-4">
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
                          <div className="font-mono font-medium text-base">{loc.code}</div>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">{loc.locationType.replace('_', ' ')}</Badge>
                            {loc.zone && <Badge variant="secondary">{loc.zone}</Badge>}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {loc.name && <div>{loc.name}</div>}
                            <div>Warehouse: {getWarehouseName(loc.warehouseId)}</div>
                          </div>
                        </div>
                      </div>
                      {canEdit && (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingLocation(loc)}
                            data-testid={`btn-edit-location-mobile-${loc.id}`}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
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
                        {skuByLocationId.get(loc.id) || <span className="text-muted-foreground">-</span>}
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
                              title="Set Primary SKU"
                              data-testid={`btn-assign-products-${loc.id}`}
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
            <div className="text-sm text-muted-foreground">
              Zones organize your warehouse into logical areas
            </div>
            {canCreate && (
              <Button onClick={() => setIsCreateZoneOpen(true)} data-testid="btn-create-zone" className="w-full sm:w-auto">
                <Plus className="h-4 w-4 mr-2" />
                Add Zone
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {zonesLoading ? (
              <div className="col-span-full text-center py-8">Loading...</div>
            ) : zones.length === 0 ? (
              <Card className="col-span-full">
                <CardContent className="py-8 text-center text-muted-foreground">
                  <p>No zones defined yet.</p>
                  <p className="text-sm mt-2">Common zones: RCV (Receiving), BULK (Bulk Storage), FWD (Forward Pick), PACK, SHIP</p>
                </CardContent>
              </Card>
            ) : (
              zones.map((zone) => (
                <Card key={zone.id} data-testid={`zone-card-${zone.id}`}>
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-lg font-mono">{zone.code}</CardTitle>
                        <CardDescription>{zone.name}</CardDescription>
                      </div>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteZoneMutation.mutate(zone.id)}
                          data-testid={`btn-delete-zone-${zone.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex gap-2">
                      <Badge variant="outline">{zone.locationType.replace('_', ' ')}</Badge>
                      {zone.isPickable === 1 && <Badge variant="secondary">Pickable</Badge>}
                    </div>
                    {zone.description && (
                      <p className="text-sm text-muted-foreground mt-2">{zone.description}</p>
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Location</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted p-3 rounded-lg text-center">
              <span className="text-sm text-muted-foreground">Preview: </span>
              <span className="font-mono font-bold text-lg">{previewCode()}</span>
            </div>
            
            <div className="grid grid-cols-5 gap-2">
              <div>
                <Label>Zone</Label>
                <Input
                  placeholder="FWD"
                  value={newLocation.zone}
                  onChange={(e) => setNewLocation({ ...newLocation, zone: e.target.value })}
                  className="uppercase"
                  data-testid="input-location-zone"
                />
              </div>
              <div>
                <Label>Aisle</Label>
                <Input
                  placeholder="A"
                  value={newLocation.aisle}
                  onChange={(e) => setNewLocation({ ...newLocation, aisle: e.target.value })}
                  className="uppercase"
                  data-testid="input-location-aisle"
                />
              </div>
              <div>
                <Label>Bay</Label>
                <Input
                  placeholder="01"
                  value={newLocation.bay}
                  onChange={(e) => setNewLocation({ ...newLocation, bay: e.target.value })}
                  data-testid="input-location-bay"
                />
              </div>
              <div>
                <Label>Level</Label>
                <Input
                  placeholder="B"
                  value={newLocation.level}
                  onChange={(e) => setNewLocation({ ...newLocation, level: e.target.value })}
                  className="uppercase"
                  data-testid="input-location-level"
                />
              </div>
              <div>
                <Label>Bin</Label>
                <Input
                  placeholder="1"
                  value={newLocation.bin}
                  onChange={(e) => setNewLocation({ ...newLocation, bin: e.target.value })}
                  data-testid="input-location-bin"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Warehouse</Label>
                <Select
                  value={newLocation.warehouseId}
                  onValueChange={(v) => setNewLocation({ ...newLocation, warehouseId: v })}
                >
                  <SelectTrigger data-testid="select-location-warehouse">
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
                <Label>Location Type</Label>
                <Select
                  value={newLocation.locationType}
                  onValueChange={(v) => setNewLocation({ ...newLocation, locationType: v })}
                >
                  <SelectTrigger data-testid="select-location-type">
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

            <div>
              <Label>Friendly Name (optional)</Label>
              <Input
                placeholder="Main floor left"
                value={newLocation.name}
                onChange={(e) => setNewLocation({ ...newLocation, name: e.target.value })}
                data-testid="input-location-name"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label>Pick Sequence</Label>
                <Input
                  type="number"
                  placeholder="Auto"
                  value={newLocation.pickSequence}
                  onChange={(e) => setNewLocation({ ...newLocation, pickSequence: e.target.value })}
                  data-testid="input-location-sequence"
                />
              </div>
              <div>
                <Label>Min Qty</Label>
                <Input
                  type="number"
                  placeholder="0"
                  value={newLocation.minQty}
                  onChange={(e) => setNewLocation({ ...newLocation, minQty: e.target.value })}
                  data-testid="input-location-minqty"
                />
              </div>
              <div>
                <Label>Max Qty</Label>
                <Input
                  type="number"
                  placeholder="∞"
                  value={newLocation.maxQty}
                  onChange={(e) => setNewLocation({ ...newLocation, maxQty: e.target.value })}
                  data-testid="input-location-maxqty"
                />
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="create-is-pickable"
                checked={newLocation.isPickable === 1}
                onCheckedChange={(checked) => setNewLocation({ ...newLocation, isPickable: checked ? 1 : 0 })}
                data-testid="checkbox-location-pickable"
              />
              <Label htmlFor="create-is-pickable" className="text-sm font-normal cursor-pointer">
                Forward Pick Location (direct picker access)
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateLocationOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleCreateLocation}
              disabled={createLocationMutation.isPending}
              data-testid="btn-save-location"
            >
              Create Location
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Location Dialog */}
      <Dialog open={!!editingLocation} onOpenChange={(open) => !open && setEditingLocation(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Location</DialogTitle>
          </DialogHeader>
          {editingLocation && (
            <div className="space-y-4">
              <div className="bg-muted p-3 rounded-lg text-center">
                <span className="font-mono font-bold text-lg">{editingLocation.code}</span>
              </div>
              
              <div className="grid grid-cols-5 gap-2">
                <div>
                  <Label>Zone</Label>
                  <Input
                    value={editingLocation.zone || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, zone: e.target.value || null })}
                    className="uppercase"
                  />
                </div>
                <div>
                  <Label>Aisle</Label>
                  <Input
                    value={editingLocation.aisle || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, aisle: e.target.value || null })}
                    className="uppercase"
                  />
                </div>
                <div>
                  <Label>Bay</Label>
                  <Input
                    value={editingLocation.bay || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, bay: e.target.value || null })}
                  />
                </div>
                <div>
                  <Label>Level</Label>
                  <Input
                    value={editingLocation.level || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, level: e.target.value || null })}
                    className="uppercase"
                  />
                </div>
                <div>
                  <Label>Bin</Label>
                  <Input
                    value={editingLocation.bin || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, bin: e.target.value || null })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Warehouse</Label>
                  <Select
                    value={editingLocation.warehouseId?.toString() || "none"}
                    onValueChange={(v) => setEditingLocation({ ...editingLocation, warehouseId: v && v !== "none" ? parseInt(v) : null })}
                  >
                    <SelectTrigger data-testid="select-edit-warehouse">
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
                  <Label>Location Type</Label>
                  <Select
                    value={editingLocation.locationType}
                    onValueChange={(v) => setEditingLocation({ ...editingLocation, locationType: v })}
                  >
                    <SelectTrigger>
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

              <div>
                <Label>Friendly Name</Label>
                <Input
                  value={editingLocation.name || ""}
                  onChange={(e) => setEditingLocation({ ...editingLocation, name: e.target.value || null })}
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label>Pick Sequence</Label>
                  <Input
                    type="number"
                    value={editingLocation.pickSequence ?? ""}
                    onChange={(e) => setEditingLocation({ 
                      ...editingLocation, 
                      pickSequence: e.target.value ? parseInt(e.target.value) : null 
                    })}
                  />
                </div>
                <div>
                  <Label>Min Qty</Label>
                  <Input
                    type="number"
                    value={editingLocation.minQty ?? ""}
                    onChange={(e) => setEditingLocation({ 
                      ...editingLocation, 
                      minQty: e.target.value ? parseInt(e.target.value) : null 
                    })}
                  />
                </div>
                <div>
                  <Label>Max Qty</Label>
                  <Input
                    type="number"
                    value={editingLocation.maxQty ?? ""}
                    onChange={(e) => setEditingLocation({ 
                      ...editingLocation, 
                      maxQty: e.target.value ? parseInt(e.target.value) : null 
                    })}
                  />
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="edit-is-pickable"
                  checked={editingLocation.isPickable === 1}
                  onCheckedChange={(checked) => setEditingLocation({ 
                    ...editingLocation, 
                    isPickable: checked ? 1 : 0 
                  })}
                  data-testid="checkbox-edit-location-pickable"
                />
                <Label htmlFor="edit-is-pickable" className="text-sm font-normal cursor-pointer">
                  Forward Pick Location (direct picker access)
                </Label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingLocation(null)}>Cancel</Button>
            <Button 
              onClick={handleUpdateLocation}
              disabled={updateLocationMutation.isPending}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Zone Dialog */}
      <Dialog open={isCreateZoneOpen} onOpenChange={setIsCreateZoneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New Zone</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Zone Code</Label>
                <Input
                  placeholder="FWD"
                  value={newZone.code}
                  onChange={(e) => setNewZone({ ...newZone, code: e.target.value })}
                  className="uppercase"
                  data-testid="input-zone-code"
                />
                <p className="text-xs text-muted-foreground mt-1">Short code like RCV, BULK, FWD</p>
              </div>
              <div>
                <Label>Zone Name</Label>
                <Input
                  placeholder="Forward Pick Area"
                  value={newZone.name}
                  onChange={(e) => setNewZone({ ...newZone, name: e.target.value })}
                  data-testid="input-zone-name"
                />
              </div>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input
                placeholder="Main picking area for fast-moving items"
                value={newZone.description}
                onChange={(e) => setNewZone({ ...newZone, description: e.target.value })}
                data-testid="input-zone-description"
              />
            </div>
            <div>
              <Label>Default Location Type</Label>
              <Select
                value={newZone.locationType}
                onValueChange={(v) => setNewZone({ ...newZone, locationType: v })}
              >
                <SelectTrigger data-testid="select-zone-type">
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateZoneOpen(false)}>Cancel</Button>
            <Button 
              onClick={() => createZoneMutation.mutate(newZone)}
              disabled={!newZone.code || !newZone.name || createZoneMutation.isPending}
              data-testid="btn-save-zone"
            >
              Create Zone
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSV Import Dialog */}
      <Dialog open={isImportOpen} onOpenChange={setIsImportOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import Locations from CSV</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <p className="text-sm text-muted-foreground">
                Upload a CSV file with location data. Set a default warehouse or include warehouse_id in CSV.
              </p>
              <Button variant="outline" size="sm" onClick={downloadTemplate} data-testid="btn-download-template">
                <Download className="h-4 w-4 mr-2" />
                Download Template
              </Button>
            </div>

            <div>
              <Label>Default Warehouse (applies to rows without warehouse_id)</Label>
              <Select value={importWarehouseId || "none"} onValueChange={(v) => setImportWarehouseId(v === "none" ? "" : v)}>
                <SelectTrigger data-testid="select-import-warehouse">
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
                  <div className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-accent transition-colors">
                    <Upload className="h-4 w-4" />
                    <span>Choose CSV File</span>
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
                <span className="text-sm text-muted-foreground">or paste data below</span>
              </div>
              
              <div>
                <Label>CSV Data</Label>
                <Textarea
                  className="font-mono text-sm h-48"
                  placeholder="zone,aisle,bay,level,bin,name,location_type,is_pickable,pick_sequence
FWD,A,01,A,1,Forward Pick A1,bin,1,1
BULK,B,02,B,,Bulk B2,bulk_reserve,0,"
                  value={csvData}
                  onChange={(e) => setCsvData(e.target.value)}
                  data-testid="textarea-csv-data"
                />
              </div>
            </div>

            <div className="text-sm text-muted-foreground">
              <p><strong>Supported columns:</strong></p>
              <ul className="list-disc list-inside mt-1">
                <li><code>zone, aisle, bay, level, bin</code> - Location hierarchy (at least one required)</li>
                <li><code>name</code> - Friendly name (optional)</li>
                <li><code>location_type</code> - bin, pallet, carton_flow, bulk_reserve, receiving, putaway_staging, packing, shipping_lane, staging, returns, quarantine, crossdock, hazmat, cold_storage, secure (default: bin)</li>
                <li><code>is_pickable</code> - 1 for pickable, 0 for non-pickable (default: 1)</li>
                <li><code>pick_sequence</code> - Picking order number (optional)</li>
                <li><code>warehouse_id</code> - Warehouse ID (optional, overrides default above)</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsImportOpen(false); setCsvData(""); setImportWarehouseId(""); }}>Cancel</Button>
            <Button 
              onClick={handleImport}
              disabled={!csvData.trim() || bulkImportMutation.isPending}
              data-testid="btn-run-import"
            >
              <Upload className="h-4 w-4 mr-2" />
              {bulkImportMutation.isPending ? "Importing..." : "Import Locations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Reassign Dialog */}
      <Dialog open={isReassignOpen} onOpenChange={setIsReassignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move Products to New Location</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Move all products from the {selectedIds.size} selected location(s) to a new location.
              This will update the product-location mappings so you can delete the old locations.
            </p>
            <div>
              <Label>Target Location (Holding Bin)</Label>
              <Select value={targetLocationId} onValueChange={setTargetLocationId}>
                <SelectTrigger data-testid="select-target-location">
                  <SelectValue placeholder="Select destination location..." />
                </SelectTrigger>
                <SelectContent>
                  {locations
                    .filter(loc => !selectedIds.has(loc.id))
                    .sort((a, b) => {
                      // Sort staging locations first
                      if (a.locationType === 'staging' && b.locationType !== 'staging') return -1;
                      if (a.locationType !== 'staging' && b.locationType === 'staging') return 1;
                      return a.code.localeCompare(b.code);
                    })
                    .map(loc => (
                      <SelectItem key={loc.id} value={loc.id.toString()}>
                        {loc.code} {loc.locationType === 'staging' && '(Staging/Holding)'} - {loc.locationType}
                      </SelectItem>
                    ))
                  }
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Tip: Create a staging location to use as a holding bin for products awaiting reassignment.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsReassignOpen(false); setTargetLocationId(""); }}>
              Cancel
            </Button>
            <Button 
              onClick={() => bulkReassignMutation.mutate({ 
                sourceIds: Array.from(selectedIds), 
                targetId: parseInt(targetLocationId) 
              })}
              disabled={!targetLocationId || bulkReassignMutation.isPending}
              data-testid="btn-confirm-reassign"
            >
              <MoveRight className="h-4 w-4 mr-2" />
              {bulkReassignMutation.isPending ? "Moving..." : "Move Products"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set Primary SKU for Bin Dialog */}
      <Dialog open={isAssignProductsOpen} onOpenChange={(open) => {
        setIsAssignProductsOpen(open);
        if (!open) {
          setAssigningToLocation(null);
          setSelectedProductId(null);
          setProductSearchQuery("");
          setAssignLocationType("forward_pick");
          setAssignIsPrimary(true);
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Set Primary SKU for {assigningToLocation?.code}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Products currently in this bin */}
            <div>
              <Label className="text-sm font-medium">Products in this location ({productsInBin.length})</Label>
              {productsInBin.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No products assigned to this location yet.</p>
              ) : (
                <ScrollArea className="h-40 border rounded-md mt-2">
                  <div className="p-2 space-y-2">
                    {productsInBin.map((product) => (
                      <div key={product.id} className="flex items-center justify-between bg-muted/50 rounded px-3 py-2">
                        <div className="flex items-center gap-2">
                          {product.isPrimary === 1 && <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />}
                          <div>
                            <div className="font-medium text-sm">{product.name}</div>
                            <div className="text-xs text-muted-foreground flex gap-2">
                              {product.sku && <span>SKU: {product.sku}</span>}
                              <Badge variant="outline" className="text-xs">{product.locationType.replace('_', ' ')}</Badge>
                            </div>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeProductFromLocationMutation.mutate(product.id)}
                          disabled={removeProductFromLocationMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>

            {/* Add new product */}
            <div className="border-t pt-4">
              <Label className="text-sm font-medium">Add product to this location</Label>
              <div className="grid grid-cols-2 gap-4 mt-2">
                <div className="col-span-2">
                  <Popover open={productSearchOpen} onOpenChange={setProductSearchOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={productSearchOpen}
                        className="w-full justify-between"
                        data-testid="btn-select-product"
                      >
                        {selectedProductId
                          ? catalogProducts.find(p => p.id === selectedProductId)?.title?.slice(0, 40) || "Select product..."
                          : "Search and select product..."}
                        <Search className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0" align="start">
                      <Command>
                        <CommandInput 
                          placeholder="Search by name or SKU..." 
                          value={productSearchQuery}
                          onValueChange={setProductSearchQuery}
                          data-testid="input-product-search"
                        />
                        <CommandList>
                          <CommandEmpty>No products found.</CommandEmpty>
                          <CommandGroup>
                            {catalogProducts
                              .filter(p => 
                                p.title.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
                                (p.sku && p.sku.toLowerCase().includes(productSearchQuery.toLowerCase()))
                              )
                              .slice(0, 50)
                              .map(product => (
                                <CommandItem
                                  key={product.id}
                                  value={`${product.title} ${product.sku || ''}`}
                                  onSelect={() => {
                                    setSelectedProductId(product.id);
                                    setProductSearchOpen(false);
                                  }}
                                  className="flex items-center gap-2"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm truncate">{product.title}</div>
                                    <div className="text-xs text-muted-foreground">{product.sku || 'No SKU'}</div>
                                  </div>
                                </CommandItem>
                              ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                
                <div>
                  <Label className="text-xs">Location Type</Label>
                  <Select value={assignLocationType} onValueChange={setAssignLocationType}>
                    <SelectTrigger data-testid="select-assign-location-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forward_pick">Forward Pick</SelectItem>
                      <SelectItem value="bulk_storage">Bulk Storage</SelectItem>
                      <SelectItem value="overflow">Overflow</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                <div className="flex items-end gap-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="isPrimary"
                      checked={assignIsPrimary}
                      onCheckedChange={(checked) => setAssignIsPrimary(!!checked)}
                      data-testid="checkbox-is-primary"
                    />
                    <Label htmlFor="isPrimary" className="text-sm cursor-pointer">
                      Primary pick location
                    </Label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAssignProductsOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                if (assigningToLocation && selectedProductId) {
                  assignProductMutation.mutate({
                    warehouseLocationId: assigningToLocation.id,
                    catalogProductId: selectedProductId,
                    locationType: assignLocationType,
                    isPrimary: assignIsPrimary ? 1 : 0,
                  });
                }
              }}
              disabled={!selectedProductId || assignProductMutation.isPending}
              data-testid="btn-assign-product"
            >
              <Package className="h-4 w-4 mr-2" />
              {assignProductMutation.isPending ? "Setting..." : "Set Primary"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
