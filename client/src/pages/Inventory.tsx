import React, { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import OperationsView from "./OperationsView";
import InlineTransferDialog from "@/components/operations/InlineTransferDialog";
import { useAuth } from "@/lib/auth";
import {
  Package,
  Search,
  Plus,
  Download,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  Boxes,
  MapPin,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  XCircle,
  ChevronRight,
  ChevronDown,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ArrowLeftRight,
  Building2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface VariantAvailability {
  variantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  available: number;
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  atpPieces: number;
}

interface InventoryItemSummary {
  productVariantId: number;
  baseSku: string;
  name: string;
  totalOnHandPieces: number;
  totalReservedPieces: number;
  totalAtpPieces: number;
  variants: VariantAvailability[];
}

interface Product {
  id: number;
  baseSku: string;
  name: string;
  description: string | null;
  baseUnit: string;
  costPerUnit: number | null;
  imageUrl: string | null;
  active: number;
  createdAt: string;
  updatedAt: string;
}

interface WarehouseLocation {
  id: number;
  code: string;
  name: string | null;
  locationType: string;
  zone: string;
  isPickable: number;
  parentLocationId: number | null;
  movementPolicy: string;
  capacityCubicMm: number | null;
  maxWeightG: number | null;
}

interface Warehouse {
  id: number;
  code: string;
  name: string;
  address: string | null;
  isActive: number;
}

interface ProductVariant {
  id: number;
  sku: string;
  productId: number;
  name: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  parentVariantId: number | null;
  barcode: string | null;
  active: number;
}

interface VariantLevel {
  variantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  baseSku: string | null;
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  available: number;
  locationCount: number;
  pickableQty: number;
}

interface VariantLocationLevel {
  id: number;
  variantQty: number;
  reservedQty: number;
  pickedQty: number;
  location: {
    id: number;
    code: string;
    name: string | null;
    locationType: string;
    isPickable: number;
    warehouseId: number | null;
  } | null;
}

function VariantLocationRows({ variantId, sku, warehouses, canEdit, onTransfer }: {
  variantId: number;
  sku: string;
  warehouses: Warehouse[];
  canEdit: boolean;
  onTransfer: (fromLocationId: number, fromLocationCode: string, variantId: number, sku: string) => void;
}) {
  const { data: locationLevels = [], isLoading, isError } = useQuery<VariantLocationLevel[]>({
    queryKey: [`/api/inventory/variants/${variantId}/locations`],
  });

  if (isLoading) {
    return (
      <TableRow className="bg-muted/20">
        <TableCell colSpan={canEdit ? 6 : 5} className="py-2 pl-8">
          <RefreshCw className="h-4 w-4 animate-spin inline mr-2" />
          Loading locations...
        </TableCell>
      </TableRow>
    );
  }

  if (isError) {
    return (
      <TableRow className="bg-red-50 dark:bg-red-900/10">
        <TableCell colSpan={canEdit ? 6 : 5} className="py-2 pl-8 text-red-600 text-sm">
          <AlertTriangle className="h-4 w-4 inline mr-2" />
          Failed to load location data
        </TableCell>
      </TableRow>
    );
  }

  if (locationLevels.length === 0) {
    return (
      <TableRow className="bg-muted/20">
        <TableCell colSpan={canEdit ? 6 : 5} className="py-2 pl-8 text-muted-foreground text-sm">
          No stock at any location
        </TableCell>
      </TableRow>
    );
  }

  return (
    <>
      {locationLevels.map((locLevel) => {
        const isPickable = locLevel.location?.isPickable === 1;
        const available = locLevel.variantQty - locLevel.reservedQty;
        const locType = locLevel.location?.locationType || "";
        return (
          <TableRow key={locLevel.id} className="bg-muted/20 text-sm">
            <TableCell colSpan={2} className="pl-8">
              <div className="flex items-center gap-2">
                <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="font-mono text-xs">{locLevel.location?.code || "Unknown"}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-sm ${
                  isPickable
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-muted text-muted-foreground"
                }`}>
                  {locType.replace("_", " ")}
                </span>
                {locLevel.location?.warehouseId && (
                  <span className="text-[10px] text-muted-foreground">
                    [{warehouses.find(w => w.id === locLevel.location?.warehouseId)?.code || ""}]
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{locLevel.variantQty}</TableCell>
            <TableCell className="text-right font-mono text-xs">{locLevel.reservedQty || 0}</TableCell>
            <TableCell className="text-right font-mono text-xs">{available}</TableCell>
            {canEdit && (
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTransfer(
                      locLevel.location?.id || 0,
                      locLevel.location?.code || "",
                      variantId,
                      sku
                    );
                  }}
                >
                  <ArrowLeftRight className="h-3 w-3 mr-1" />
                  Move
                </Button>
              </TableCell>
            )}
          </TableRow>
        );
      })}
    </>
  );
}

export default function Inventory() {
  const [, navigate] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [adjustDialogOpen, setAdjustDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItemSummary | null>(null);
  const [adjustmentQty, setAdjustmentQty] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [addItemDialogOpen, setAddItemDialogOpen] = useState(false);
  const [newItemForm, setNewItemForm] = useState({ baseSku: "", name: "", description: "" });
  const [csvUploadOpen, setCsvUploadOpen] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvResults, setCsvResults] = useState<{ row: number; sku: string; location: string; status: string; message: string }[] | null>(null);
  const [csvUploading, setCsvUploading] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFilters, setExportFilters] = useState({
    locationTypes: [] as string[],
    binTypes: [] as string[],
    zone: "",
  });
  const [exporting, setExporting] = useState(false);
  
  const locationTypeOptions = [
    { value: "forward_pick", label: "Forward Pick" },
    { value: "bulk_storage", label: "Bulk Storage" },
    { value: "overflow", label: "Overflow" },
    { value: "receiving", label: "Receiving" },
    { value: "staging", label: "Staging" },
  ];
  const binTypeOptions = [
    { value: "bin", label: "Bin" },
    { value: "pallet", label: "Pallet" },
    { value: "carton_flow", label: "Carton Flow" },
    { value: "bulk_reserve", label: "Bulk Reserve" },
    { value: "shelf", label: "Shelf" },
  ];
  
  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (exportFilters.locationTypes.length > 0) {
        params.set("locationType", exportFilters.locationTypes.join(","));
      }
      if (exportFilters.binTypes.length > 0) {
        params.set("binType", exportFilters.binTypes.join(","));
      }
      if (exportFilters.zone) {
        params.set("zone", exportFilters.zone);
      }
      
      const response = await fetch(`/api/inventory/export?${params.toString()}`);
      if (!response.ok) throw new Error("Export failed");
      
      const data = await response.json();
      
      // Convert to CSV
      const headers = ["SKU", "Variant Name", "Base SKU", "Item Name", "Location", "Zone", "Location Type", "Bin Type", "Pickable", "Variant Qty", "Reserved", "Picked", "Available"];
      const csvRows = [headers.join(",")];
      
      for (const row of data) {
        csvRows.push([
          `"${row.sku || ''}"`,
          `"${row.variantName || ''}"`,
          `"${row.baseSku || ''}"`,
          `"${row.itemName || ''}"`,
          `"${row.locationCode || ''}"`,
          `"${row.zone || ''}"`,
          `"${row.locationType || ''}"`,
          `"${row.binType || ''}"`,
          row.isPickable ? "Yes" : "No",
          row.variantQty,
          row.reservedQty,
          row.pickedQty,
          row.availableQty,
        ].join(","));
      }
      
      const csvContent = csvRows.join("\n");
      const blob = new Blob([csvContent], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inventory-export-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast({ title: "Export complete", description: `${data.length} records exported` });
      setExportDialogOpen(false);
    } catch (error) {
      toast({ title: "Export failed", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };
  const [activeTab, setActiveTab] = useState("physical");
  const [expandedVariants, setExpandedVariants] = useState<Set<number>>(new Set());
  const [expandedProducts, setExpandedProducts] = useState<Set<number>>(new Set());
  const [sortField, setSortField] = useState<string>("sku");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [productSortField, setProductSortField] = useState<string>("baseSku");
  const [productSortDirection, setProductSortDirection] = useState<"asc" | "desc">("asc");
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<number | null>(null);
  const [transferDialog, setTransferDialog] = useState<{
    open: boolean;
    fromLocationId?: number;
    fromLocationCode?: string;
    variantId?: number;
    sku?: string;
  }>({ open: false });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory", "edit");

  const { data: warehouses = [] } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
  });

  const { data: inventorySummary = [], isLoading: loadingInventory, refetch: refetchInventory } = useQuery<InventoryItemSummary[]>({
    queryKey: ["/api/inventory/summary", selectedWarehouseId],
    queryFn: async () => {
      const url = selectedWarehouseId 
        ? `/api/inventory/summary?warehouseId=${selectedWarehouseId}`
        : "/api/inventory/summary";
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch inventory summary");
      return response.json();
    },
  });

  const { data: locations = [], isLoading: loadingLocations } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/inventory/locations"],
  });

  const { data: variants = [] } = useQuery<ProductVariant[]>({
    queryKey: ["/api/product-variants"],
  });

  const { data: variantLevels = [], isLoading: loadingVariantLevels } = useQuery<VariantLevel[]>({
    queryKey: ["/api/inventory/levels", selectedWarehouseId],
    queryFn: async () => {
      const url = selectedWarehouseId
        ? `/api/inventory/levels?warehouseId=${selectedWarehouseId}`
        : "/api/inventory/levels";
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch inventory levels");
      return response.json();
    },
    enabled: activeTab === "physical",
  });

  const createItemMutation = useMutation({
    mutationFn: async (data: { baseSku: string; name: string; description?: string }) => {
      const response = await apiRequest("POST", "/api/products", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Item created successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/summary"] });
      setAddItemDialogOpen(false);
      setNewItemForm({ baseSku: "", name: "", description: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create item", description: error.message, variant: "destructive" });
    },
  });

  const adjustInventoryMutation = useMutation({
    mutationFn: async (data: { productVariantId: number; warehouseLocationId: number; qtyDelta: number; reason: string }) => {
      const response = await apiRequest("POST", "/api/inventory/adjust", data);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Inventory adjusted successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/summary"] });
      setAdjustDialogOpen(false);
      setSelectedItem(null);
      setAdjustmentQty("");
      setAdjustmentReason("");
    },
    onError: (error: Error) => {
      toast({ title: "Failed to adjust inventory", description: error.message, variant: "destructive" });
    },
  });

  const migrateLocationsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/inventory/migrate-locations", {});
      return response.json();
    },
    onSuccess: (data: { created: number; skipped: number; total: number }) => {
      toast({ 
        title: "Locations synced to WMS", 
        description: `Created ${data.created} locations, skipped ${data.skipped} (of ${data.total} total)` 
      });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/locations"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to sync locations", description: error.message, variant: "destructive" });
    },
  });

  const filteredItems = inventorySummary.filter(item => 
    (item.baseSku?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
    (item.name?.toLowerCase() || '').includes(searchQuery.toLowerCase())
  );

  const totalOnHand = inventorySummary.reduce((sum, item) => sum + Number(item.totalOnHandPieces || 0), 0);
  const totalReserved = inventorySummary.reduce((sum, item) => sum + Number(item.totalReservedPieces || 0), 0);
  const totalATP = inventorySummary.reduce((sum, item) => sum + Number(item.totalAtpPieces || 0), 0);
  const lowStockItems = inventorySummary.filter(item => Number(item.totalAtpPieces || 0) <= 0).length;

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const sortedVariantLevels = [...variantLevels]
    .filter(v =>
      (v.sku || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      (v.name || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case "sku": aVal = a.sku || ""; bVal = b.sku || ""; break;
        case "name": aVal = a.name || ""; bVal = b.name || ""; break;
        case "qty": aVal = a.variantQty; bVal = b.variantQty; break;
        case "reserved": aVal = a.reservedQty; bVal = b.reservedQty; break;
        case "available": aVal = a.available; bVal = b.available; break;
        default: aVal = a.sku || ""; bVal = b.sku || "";
      }
      if (typeof aVal === "string") {
        return sortDirection === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
    });

  const handleAdjustClick = (item: InventoryItemSummary) => {
    setSelectedItem(item);
    setAdjustDialogOpen(true);
  };

  const handleAdjustSubmit = () => {
    if (!selectedItem || !adjustmentQty || !adjustmentReason) return;
    
    const firstLocation = locations[0];
    if (!firstLocation) {
      toast({ title: "No warehouse location available", variant: "destructive" });
      return;
    }
    
    adjustInventoryMutation.mutate({
      productVariantId: selectedItem.productVariantId,
      warehouseLocationId: firstLocation.id,
      qtyDelta: parseInt(adjustmentQty),
      reason: adjustmentReason,
    });
  };

  const getStatusBadge = (atpBase: number) => {
    if (atpBase <= 0) {
      return <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">Out of Stock</Badge>;
    }
    if (atpBase < 100) {
      return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Low Stock</Badge>;
    }
    return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">In Stock</Badge>;
  };

  // Product-level status (fungible ATP in pieces)
  const getProductStatusBadge = (atpBase: number) => {
    if (atpBase <= 0) {
      return <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400">Out of Stock</Badge>;
    }
    if (atpBase < 500) {
      return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Low Stock</Badge>;
    }
    return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">In Stock</Badge>;
  };

  const handleProductSort = (field: string) => {
    if (productSortField === field) {
      setProductSortDirection(productSortDirection === "asc" ? "desc" : "asc");
    } else {
      setProductSortField(field);
      setProductSortDirection("asc");
    }
  };

  const sortedProducts = [...filteredItems].sort((a, b) => {
    let aVal: any, bVal: any;
    switch (productSortField) {
      case "baseSku": aVal = a.baseSku || ""; bVal = b.baseSku || ""; break;
      case "name": aVal = a.name || ""; bVal = b.name || ""; break;
      case "onHand": aVal = a.totalOnHandPieces; bVal = b.totalOnHandPieces; break;
      case "reserved": aVal = a.totalReservedPieces; bVal = b.totalReservedPieces; break;
      case "atp": aVal = a.totalAtpPieces; bVal = b.totalAtpPieces; break;
      case "variants": aVal = a.variants.length; bVal = b.variants.length; break;
      default: aVal = a.baseSku || ""; bVal = b.baseSku || "";
    }
    if (typeof aVal === "string") {
      return productSortDirection === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return productSortDirection === "asc" ? aVal - bVal : bVal - aVal;
  });

  const handleCsvUpload = async () => {
    if (!csvFile) return;
    
    setCsvUploading(true);
    setCsvResults(null);
    
    try {
      const formData = new FormData();
      formData.append("file", csvFile);
      
      const response = await fetch("/api/inventory/upload-csv", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || "Upload failed");
      }
      
      setCsvResults(data.results);
      toast({
        title: "CSV processed",
        description: `${data.summary.successCount} updated, ${data.summary.errorCount} errors`,
      });
      
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/summary"] });
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setCsvUploading(false);
    }
  };

  const handleDownloadTemplate = () => {
    window.location.href = "/api/inventory/csv-template";
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card p-4 md:p-6 pb-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-5 w-5 md:h-6 md:w-6 text-primary" />
              Inventory Management
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Manage stock levels, locations, and inventory adjustments.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetchInventory()}>
              <RefreshCw size={16} className="mr-1" /> <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => migrateLocationsMutation.mutate()}
              disabled={migrateLocationsMutation.isPending}
              data-testid="button-sync-locations"
            >
              <MapPin size={16} className="mr-1" /> 
              <span className="hidden sm:inline">{migrateLocationsMutation.isPending ? "Syncing..." : "Sync Locations"}</span>
              <span className="sm:hidden">{migrateLocationsMutation.isPending ? "..." : "Sync"}</span>
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setCsvUploadOpen(true)} data-testid="button-upload-csv">
              <Upload size={16} /> <span className="hidden sm:inline">Upload CSV</span>
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setExportDialogOpen(true)} data-testid="button-export">
              <Download size={16} /> <span className="hidden sm:inline">Export</span>
            </Button>
            <Button size="sm" className="gap-2" onClick={() => navigate("/receiving")} data-testid="button-receive-stock">
              <Plus size={16} /> <span className="hidden sm:inline">Receive Stock</span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-4">
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <Boxes size={12} /> Total SKUs
            </div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">{variants.length}</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <TrendingUp size={12} /> Total On Hand
            </div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">{totalOnHand.toLocaleString()}</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <AlertTriangle size={12} /> Low/Out of Stock
            </div>
            <div className="text-2xl font-bold font-mono text-amber-600 mt-1">{lowStockItems}</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <MapPin size={12} /> Locations
            </div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">{locations.length}</div>
          </div>
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mt-6">
          <div className="flex items-center gap-2 flex-1 max-w-2xl">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input 
                placeholder="Search by SKU or Name..." 
                className="pl-9 h-11 w-full"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <Select 
              value={selectedWarehouseId?.toString() || "all"} 
              onValueChange={(v) => setSelectedWarehouseId(v === "all" ? null : parseInt(v))}
            >
              <SelectTrigger className="w-[180px] h-11" data-testid="select-warehouse-filter">
                <Building2 className="h-4 w-4 mr-2 text-muted-foreground" />
                <SelectValue placeholder="All Warehouses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Warehouses</SelectItem>
                {warehouses.map((wh) => (
                  <SelectItem key={wh.id} value={wh.id.toString()}>
                    {wh.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          
        </div>
      </div>

      <div className="flex-1 p-4 md:p-6 overflow-hidden flex flex-col">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-4">
            <TabsTrigger
              value="physical"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2 text-sm"
            >
              <Package className="h-4 w-4 mr-2" />
              Physical Inventory
            </TabsTrigger>
            <TabsTrigger
              value="availability"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2 text-sm"
            >
              <TrendingUp className="h-4 w-4 mr-2" />
              Product Availability
            </TabsTrigger>
            <TabsTrigger
              value="operations"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-4 py-2 text-sm"
            >
              <Boxes className="h-4 w-4 mr-2" />
              Operations
            </TabsTrigger>
          </TabsList>

          {/* ====== TAB 1: Physical Inventory ====== */}
          <TabsContent value="physical" className="flex-1 flex flex-col mt-0">
            {loadingVariantLevels ? (
              <div className="flex-1 flex items-center justify-center">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Mobile card layout */}
                <div className="md:hidden space-y-3 flex-1 overflow-auto">
                  {sortedVariantLevels.map((level) => (
                    <div key={level.variantId} className="rounded-md border bg-card p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="font-mono font-medium text-primary text-sm">{level.sku}</div>
                          <div className="text-sm font-medium mt-1">{level.name}</div>
                        </div>
                        {level.locationCount > 0 && (
                          <span className="text-xs text-muted-foreground">{level.locationCount} bins</span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs mt-3">
                        <div className="bg-muted/30 p-2 rounded">
                          <div className="text-muted-foreground">Physical</div>
                          <div className="font-mono font-bold">{level.variantQty.toLocaleString()}</div>
                        </div>
                        <div className="bg-muted/30 p-2 rounded">
                          <div className="text-muted-foreground">Committed</div>
                          <div className="font-mono font-bold text-muted-foreground">{level.reservedQty.toLocaleString()}</div>
                        </div>
                        <div className="bg-muted/30 p-2 rounded">
                          <div className="text-muted-foreground">Available</div>
                          <div className="font-mono font-bold text-green-600">{level.available.toLocaleString()}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop table */}
                <div className="hidden md:block rounded-md border bg-card flex-1 overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/40 sticky top-0 z-10">
                      <TableRow>
                        <TableHead className="w-[180px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("sku")}>
                          <div className="flex items-center gap-1">
                            SKU
                            {sortField === "sku" ? (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleSort("name")}>
                          <div className="flex items-center gap-1">
                            Name
                            {sortField === "name" ? (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("qty")}>
                          <div className="flex items-center justify-end gap-1">
                            Physical
                            {sortField === "qty" ? (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("reserved")}>
                          <div className="flex items-center justify-end gap-1">
                            Committed
                            {sortField === "reserved" ? (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("available")}>
                          <div className="flex items-center justify-end gap-1">
                            Available
                            {sortField === "available" ? (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        {canEdit && <TableHead className="w-[80px]"></TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedVariantLevels.map((level) => (
                        <React.Fragment key={level.variantId}>
                          <TableRow
                            data-testid={`row-variant-${level.variantId}`}
                            className={level.locationCount > 0 ? "cursor-pointer hover:bg-muted/50" : ""}
                            onClick={() => {
                              if (level.locationCount > 0) {
                                const newExpanded = new Set(expandedVariants);
                                if (newExpanded.has(level.variantId)) {
                                  newExpanded.delete(level.variantId);
                                } else {
                                  newExpanded.add(level.variantId);
                                }
                                setExpandedVariants(newExpanded);
                              }
                            }}
                          >
                            <TableCell className="font-mono font-medium text-primary">
                              <div className="flex items-center gap-1">
                                {level.locationCount > 0 && (
                                  expandedVariants.has(level.variantId) ?
                                    <ChevronDown className="h-4 w-4 text-muted-foreground" /> :
                                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                )}
                                {level.sku}
                              </div>
                            </TableCell>
                            <TableCell className="truncate max-w-[200px]">{level.name}</TableCell>
                            <TableCell className="text-right font-mono font-bold">{level.variantQty.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{level.reservedQty.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono font-medium text-green-600">{level.available.toLocaleString()}</TableCell>
                            {canEdit && <TableCell></TableCell>}
                          </TableRow>
                          {expandedVariants.has(level.variantId) && (
                            <VariantLocationRows
                              variantId={level.variantId}
                              sku={level.sku}
                              warehouses={warehouses}
                              canEdit={canEdit}
                              onTransfer={(fromLocationId, fromLocationCode, variantId, sku) => {
                                setTransferDialog({
                                  open: true,
                                  fromLocationId,
                                  fromLocationCode,
                                  variantId,
                                  sku,
                                });
                              }}
                            />
                          )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {sortedVariantLevels.length > 0 && (
                  <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                    <div>Showing {sortedVariantLevels.length} of {variantLevels.length} variants</div>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* ====== TAB 2: Product Availability ====== */}
          <TabsContent value="availability" className="flex-1 flex flex-col mt-0">
            {loadingInventory ? (
              <div className="flex-1 flex items-center justify-center">
                <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Mobile card layout */}
                <div className="md:hidden space-y-3 flex-1 overflow-auto">
                  {sortedProducts.map((product) => (
                    <div key={product.baseSku} className="rounded-md border bg-card p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="font-mono font-medium text-primary text-sm">{product.baseSku}</div>
                          <div className="text-sm font-medium mt-1">{product.name}</div>
                        </div>
                        {getProductStatusBadge(product.totalAtpPieces)}
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs mt-3">
                        <div className="bg-muted/30 p-2 rounded">
                          <div className="text-muted-foreground">Total Pieces</div>
                          <div className="font-mono font-bold">{product.totalOnHandPieces.toLocaleString()}</div>
                        </div>
                        <div className="bg-muted/30 p-2 rounded">
                          <div className="text-muted-foreground">Available</div>
                          <div className="font-mono font-bold text-green-600">{product.totalAtpPieces.toLocaleString()}</div>
                        </div>
                        <div className="bg-muted/30 p-2 rounded">
                          <div className="text-muted-foreground">Variants</div>
                          <div className="font-mono font-bold">{product.variants.length}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Desktop table */}
                <div className="hidden md:block rounded-md border bg-card flex-1 overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/40 sticky top-0 z-10">
                      <TableRow>
                        <TableHead className="w-[180px] cursor-pointer hover:bg-muted/60" onClick={() => handleProductSort("baseSku")}>
                          <div className="flex items-center gap-1">
                            Product
                            {productSortField === "baseSku" ? (productSortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleProductSort("name")}>
                          <div className="flex items-center gap-1">
                            Name
                            {productSortField === "name" ? (productSortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[120px] cursor-pointer hover:bg-muted/60" onClick={() => handleProductSort("onHand")}>
                          <div className="flex items-center justify-end gap-1">
                            Total Pieces
                            {productSortField === "onHand" ? (productSortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleProductSort("reserved")}>
                          <div className="flex items-center justify-end gap-1">
                            Reserved
                            {productSortField === "reserved" ? (productSortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[120px] cursor-pointer hover:bg-muted/60" onClick={() => handleProductSort("atp")}>
                          <div className="flex items-center justify-end gap-1">
                            Available (ATP)
                            {productSortField === "atp" ? (productSortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="text-right w-[80px] cursor-pointer hover:bg-muted/60" onClick={() => handleProductSort("variants")}>
                          <div className="flex items-center justify-end gap-1">
                            Variants
                            {productSortField === "variants" ? (productSortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 text-muted-foreground" />}
                          </div>
                        </TableHead>
                        <TableHead className="w-[100px]">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedProducts.map((product) => (
                        <React.Fragment key={product.baseSku}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => {
                              const newExpanded = new Set(expandedProducts);
                              const key = product.productVariantId;
                              if (newExpanded.has(key)) {
                                newExpanded.delete(key);
                              } else {
                                newExpanded.add(key);
                              }
                              setExpandedProducts(newExpanded);
                            }}
                          >
                            <TableCell className="font-mono font-medium text-primary">
                              <div className="flex items-center gap-1">
                                {expandedProducts.has(product.productVariantId) ?
                                  <ChevronDown className="h-4 w-4 text-muted-foreground" /> :
                                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                                }
                                {product.baseSku}
                              </div>
                            </TableCell>
                            <TableCell className="truncate max-w-[200px]">{product.name}</TableCell>
                            <TableCell className="text-right font-mono font-bold">{product.totalOnHandPieces.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">{product.totalReservedPieces.toLocaleString()}</TableCell>
                            <TableCell className="text-right font-mono font-medium text-green-600">{product.totalAtpPieces.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{product.variants.length}</TableCell>
                            <TableCell>{getProductStatusBadge(product.totalAtpPieces)}</TableCell>
                          </TableRow>
                          {expandedProducts.has(product.productVariantId) && product.variants.map((v) => (
                            <TableRow key={v.variantId} className="bg-muted/20">
                              <TableCell className="font-mono text-sm pl-10 text-muted-foreground">{v.sku}</TableCell>
                              <TableCell className="text-sm text-muted-foreground">{v.name}</TableCell>
                              <TableCell className="text-right font-mono text-sm text-muted-foreground">{v.unitsPerVariant} /pkg</TableCell>
                              <TableCell className="text-right font-mono text-sm" colSpan={1}></TableCell>
                              <TableCell className="text-right font-mono text-sm font-medium">{v.available.toLocaleString()} sellable</TableCell>
                              <TableCell className="text-right font-mono text-sm text-muted-foreground">{v.variantQty.toLocaleString()} physical</TableCell>
                              <TableCell></TableCell>
                            </TableRow>
                          ))}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                {sortedProducts.length > 0 && (
                  <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                    <div>Showing {sortedProducts.length} of {inventorySummary.length} products</div>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          {/* ====== TAB 3: Operations ====== */}
          <TabsContent value="operations" className="flex-1 flex flex-col mt-0 overflow-auto">
            <OperationsView warehouseId={selectedWarehouseId} searchQuery={searchQuery} />
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={adjustDialogOpen} onOpenChange={setAdjustDialogOpen}>
        <DialogContent className="w-[95vw] max-w-md mx-auto max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Adjust Inventory</DialogTitle>
            <DialogDescription className="text-sm">
              Adjust the base unit count for {selectedItem?.baseSku}. Use positive numbers to add stock, negative to remove.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label className="text-sm">Current On Hand: {selectedItem?.totalOnHandPieces.toLocaleString()} pieces</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qty" className="text-sm">Adjustment Quantity (+ or -)</Label>
              <Input
                id="qty"
                type="number"
                placeholder="e.g., 100 or -50"
                value={adjustmentQty}
                onChange={(e) => setAdjustmentQty(e.target.value)}
                className="w-full h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason" className="text-sm">Reason for Adjustment</Label>
              <Textarea
                id="reason"
                placeholder="e.g., Cycle count correction, damaged goods, etc."
                value={adjustmentReason}
                onChange={(e) => setAdjustmentReason(e.target.value)}
                className="w-full min-h-[100px]"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setAdjustDialogOpen(false)} className="w-full sm:w-auto min-h-[44px]">Cancel</Button>
            <Button 
              onClick={handleAdjustSubmit}
              disabled={!adjustmentQty || !adjustmentReason || adjustInventoryMutation.isPending}
              className="w-full sm:w-auto min-h-[44px]"
            >
              {adjustInventoryMutation.isPending ? "Adjusting..." : "Apply Adjustment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addItemDialogOpen} onOpenChange={setAddItemDialogOpen}>
        <DialogContent className="w-[95vw] max-w-md mx-auto max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Add Inventory Item</DialogTitle>
            <DialogDescription className="text-sm">
              Create a new base inventory item. You'll add variants and stock levels separately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="baseSku" className="text-sm">Base SKU</Label>
              <Input
                id="baseSku"
                placeholder="e.g., EG-STD-SLV"
                value={newItemForm.baseSku}
                onChange={(e) => setNewItemForm({ ...newItemForm, baseSku: e.target.value })}
                className="w-full h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name" className="text-sm">Name</Label>
              <Input
                id="name"
                placeholder="e.g., Easy Glide Standard Sleeve"
                value={newItemForm.name}
                onChange={(e) => setNewItemForm({ ...newItemForm, name: e.target.value })}
                className="w-full h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description" className="text-sm">Description (optional)</Label>
              <Textarea
                id="description"
                placeholder="Product description..."
                value={newItemForm.description}
                onChange={(e) => setNewItemForm({ ...newItemForm, description: e.target.value })}
                className="w-full min-h-[100px]"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setAddItemDialogOpen(false)} className="w-full sm:w-auto min-h-[44px]">Cancel</Button>
            <Button 
              onClick={() => createItemMutation.mutate(newItemForm)}
              disabled={!newItemForm.baseSku || !newItemForm.name || createItemMutation.isPending}
              className="w-full sm:w-auto min-h-[44px]"
            >
              {createItemMutation.isPending ? "Creating..." : "Create Item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={csvUploadOpen} onOpenChange={(open) => {
        setCsvUploadOpen(open);
        if (!open) {
          setCsvFile(null);
          setCsvResults(null);
        }
      }}>
        <DialogContent className="w-[95vw] max-w-md mx-auto max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Upload Inventory CSV
            </DialogTitle>
            <DialogDescription className="text-sm">
              Upload a CSV file to update inventory levels in bulk. The CSV should have columns: location_code, sku, quantity
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDownloadTemplate} className="min-h-[44px]">
                <Download size={14} className="mr-1" /> Download Template
              </Button>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="csvFile" className="text-sm">Select CSV File</Label>
              <Input
                id="csvFile"
                type="file"
                accept=".csv"
                className="w-full h-11"
                onChange={(e) => {
                  setCsvFile(e.target.files?.[0] || null);
                  setCsvResults(null);
                }}
              />
              {csvFile && (
                <p className="text-xs text-muted-foreground">
                  Selected: {csvFile.name} ({(csvFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>

            {csvResults && (
              <div className="space-y-2">
                <Label className="text-sm">Results</Label>
                {/* Mobile card layout for CSV results */}
                <div className="md:hidden space-y-2 max-h-48 overflow-auto">
                  {csvResults.map((result, idx) => (
                    <div key={idx} className={`p-3 rounded-md border ${result.status === "error" ? "bg-red-50 border-red-200" : "bg-green-50 border-green-200"}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono text-xs">Row {result.row}</span>
                        {result.status === "success" ? (
                          <CheckCircle className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-red-600" />
                        )}
                      </div>
                      <div className="text-xs font-mono mb-1">{result.sku} @ {result.location}</div>
                      <div className="text-xs text-muted-foreground">{result.message}</div>
                    </div>
                  ))}
                </div>
                {/* Desktop table layout for CSV results */}
                <div className="hidden md:block rounded-md border max-h-60 overflow-x-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-muted">
                      <TableRow>
                        <TableHead className="w-16">Row</TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Message</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {csvResults.map((result, idx) => (
                        <TableRow key={idx} className={result.status === "error" ? "bg-red-50" : "bg-green-50"}>
                          <TableCell className="font-mono text-xs">{result.row}</TableCell>
                          <TableCell className="font-mono text-xs">{result.sku}</TableCell>
                          <TableCell className="font-mono text-xs">{result.location}</TableCell>
                          <TableCell>
                            {result.status === "success" ? (
                              <CheckCircle className="h-4 w-4 text-green-600" />
                            ) : (
                              <XCircle className="h-4 w-4 text-red-600" />
                            )}
                          </TableCell>
                          <TableCell className="text-xs">{result.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setCsvUploadOpen(false)} className="w-full sm:w-auto min-h-[44px]">
              {csvResults ? "Close" : "Cancel"}
            </Button>
            {!csvResults && (
              <Button 
                onClick={handleCsvUpload}
                disabled={!csvFile || csvUploading}
                className="w-full sm:w-auto min-h-[44px]"
              >
                {csvUploading ? "Uploading..." : "Upload & Process"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InlineTransferDialog
        open={transferDialog.open}
        onOpenChange={(open) => setTransferDialog({ ...transferDialog, open })}
        defaultFromLocationId={transferDialog.fromLocationId}
        defaultFromLocationCode={transferDialog.fromLocationCode}
        defaultVariantId={transferDialog.variantId}
        defaultSku={transferDialog.sku}
      />

      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="w-[95vw] max-w-md mx-auto max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Export Inventory</DialogTitle>
            <DialogDescription className="text-sm">
              Export inventory data to CSV. Filter by location type, storage type, or zone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-sm">Location Purpose (optional filter)</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {locationTypeOptions.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={exportFilters.locationTypes.includes(type.value)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setExportFilters({ ...exportFilters, locationTypes: [...exportFilters.locationTypes, type.value] });
                        } else {
                          setExportFilters({ ...exportFilters, locationTypes: exportFilters.locationTypes.filter(t => t !== type.value) });
                        }
                      }}
                      className="h-5 w-5"
                    />
                    <span className="text-sm">{type.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-sm">Storage Type (optional filter)</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {binTypeOptions.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={exportFilters.binTypes.includes(type.value)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setExportFilters({ ...exportFilters, binTypes: [...exportFilters.binTypes, type.value] });
                        } else {
                          setExportFilters({ ...exportFilters, binTypes: exportFilters.binTypes.filter(t => t !== type.value) });
                        }
                      }}
                      className="h-5 w-5"
                    />
                    <span className="text-sm">{type.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label className="text-sm">Zone (optional)</Label>
              <Input
                value={exportFilters.zone}
                onChange={(e) => setExportFilters({ ...exportFilters, zone: e.target.value })}
                placeholder="e.g., A, B, BULK"
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            <p className="text-xs text-muted-foreground">Leave filters empty to export all inventory with stock.</p>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setExportDialogOpen(false)} className="w-full sm:w-auto min-h-[44px]">Cancel</Button>
            <Button onClick={handleExport} disabled={exporting} className="w-full sm:w-auto min-h-[44px]">
              {exporting ? "Exporting..." : "Export CSV"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
