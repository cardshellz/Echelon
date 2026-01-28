import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Package, 
  Search, 
  Filter, 
  Plus, 
  MoreHorizontal, 
  Download,
  Edit,
  History,
  RefreshCw,
  AlertTriangle,
  TrendingUp,
  Boxes,
  MapPin,
  Upload,
  FileSpreadsheet,
  CheckCircle,
  XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface VariantAvailability {
  variantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  available: number;
  onHandBase: number;
  reservedBase: number;
  atpBase: number;
  variantQty: number;
}

interface InventoryItemSummary {
  inventoryItemId: number;
  baseSku: string;
  name: string;
  totalOnHandBase: number;
  totalReservedBase: number;
  totalAtpBase: number;
  variants: VariantAvailability[];
}

interface InventoryItem {
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
  minQty: number | null;
  maxQty: number | null;
}

interface UomVariant {
  id: number;
  sku: string;
  inventoryItemId: number;
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
  onHandBase: number;
  reservedBase: number;
  pickedBase: number;
  available: number;
  totalPieces: number;
  locationCount: number;
}

export default function Inventory() {
  const [activeTab, setActiveTab] = useState("levels");
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
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: inventorySummary = [], isLoading: loadingInventory, refetch: refetchInventory } = useQuery<InventoryItemSummary[]>({
    queryKey: ["/api/inventory/summary"],
  });

  const { data: locations = [], isLoading: loadingLocations } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/inventory/locations"],
  });

  const { data: variants = [] } = useQuery<UomVariant[]>({
    queryKey: ["/api/inventory/variants"],
  });

  const { data: variantLevels = [], isLoading: loadingVariantLevels } = useQuery<VariantLevel[]>({
    queryKey: ["/api/inventory/levels"],
  });

  const createItemMutation = useMutation({
    mutationFn: async (data: { baseSku: string; name: string; description?: string }) => {
      const response = await apiRequest("POST", "/api/inventory/items", data);
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
    mutationFn: async (data: { inventoryItemId: number; warehouseLocationId: number; baseUnitsDelta: number; reason: string }) => {
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

  const totalOnHand = inventorySummary.reduce((sum, item) => sum + Number(item.totalOnHandBase || 0), 0);
  const totalReserved = inventorySummary.reduce((sum, item) => sum + Number(item.totalReservedBase || 0), 0);
  const totalATP = inventorySummary.reduce((sum, item) => sum + Number(item.totalAtpBase || 0), 0);
  const lowStockItems = inventorySummary.filter(item => Number(item.totalAtpBase || 0) <= 0).length;

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
      inventoryItemId: selectedItem.inventoryItemId,
      warehouseLocationId: firstLocation.id,
      baseUnitsDelta: parseInt(adjustmentQty),
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
            <Button variant="outline" size="sm" className="gap-2">
              <Download size={16} /> <span className="hidden sm:inline">Export</span>
            </Button>
            <Button size="sm" className="gap-2" onClick={() => setAddItemDialogOpen(true)}>
              <Plus size={16} /> <span className="hidden sm:inline">Add Item</span>
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
          <div className="flex items-center gap-2 flex-1 max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input 
                placeholder="Search by SKU or Name..." 
                className="pl-9 h-9 w-full"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm" className="h-9 gap-2">
              <Filter size={16} /> <span className="hidden sm:inline">Filters</span>
            </Button>
          </div>
          
          <div className="flex items-center bg-muted/50 p-1 rounded-md overflow-x-auto">
            <Button 
              variant={activeTab === "levels" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs whitespace-nowrap"
              onClick={() => setActiveTab("levels")}
            >
              Stock Levels
            </Button>
            <Button 
              variant={activeTab === "locations" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs whitespace-nowrap"
              onClick={() => setActiveTab("locations")}
            >
              Locations
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 md:p-6 overflow-hidden flex flex-col">
        {loadingInventory || loadingLocations ? (
          <div className="flex-1 flex items-center justify-center">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === "levels" ? (
          loadingVariantLevels ? (
            <div className="flex-1 flex items-center justify-center">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
          <>
            {/* Mobile card layout for variant levels */}
            <div className="md:hidden space-y-3 flex-1 overflow-auto">
              {variantLevels.filter(v => 
                (v.sku || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                (v.name || '').toLowerCase().includes(searchQuery.toLowerCase())
              ).map((level) => (
                <div key={level.variantId} className="rounded-md border bg-card p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="font-mono font-medium text-primary text-sm">{level.sku}</div>
                      <div className="text-sm font-medium mt-1">{level.name}</div>
                    </div>
                    {getStatusBadge(level.available)}
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mt-3">
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">Qty</div>
                      <div className="font-mono font-bold">{level.variantQty.toLocaleString()}</div>
                    </div>
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">Pieces</div>
                      <div className="font-mono font-bold">{level.totalPieces.toLocaleString()}</div>
                    </div>
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">Locations</div>
                      <div className="font-mono font-bold">{level.locationCount}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table layout for variant levels */}
            <div className="hidden md:block rounded-md border bg-card flex-1 overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/40 sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="w-[180px]">SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right w-[100px]">Qty</TableHead>
                    <TableHead className="text-right w-[100px]">Units/Pkg</TableHead>
                    <TableHead className="text-right w-[100px]">Pieces</TableHead>
                    <TableHead className="text-right w-[100px]">Reserved</TableHead>
                    <TableHead className="text-right w-[100px]">Available</TableHead>
                    <TableHead className="text-right w-[80px]">Locations</TableHead>
                    <TableHead className="w-[100px]">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {variantLevels.filter(v => 
                    (v.sku || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                    (v.name || '').toLowerCase().includes(searchQuery.toLowerCase())
                  ).map((level) => (
                    <TableRow key={level.variantId} data-testid={`row-variant-${level.variantId}`}>
                      <TableCell className="font-mono font-medium text-primary">{level.sku}</TableCell>
                      <TableCell className="truncate max-w-[200px]">{level.name}</TableCell>
                      <TableCell className="text-right font-mono font-bold">{level.variantQty.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{level.unitsPerVariant}</TableCell>
                      <TableCell className="text-right font-mono">{level.totalPieces.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{level.reservedBase.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono">{level.available.toLocaleString()}</TableCell>
                      <TableCell className="text-right">{level.locationCount}</TableCell>
                      <TableCell>{getStatusBadge(level.available)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
          )
        ) : (
          <>
            {/* Mobile card layout for locations */}
            <div className="md:hidden space-y-3 flex-1 overflow-auto">
              {locations.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No warehouse locations defined yet
                </div>
              ) : (
                locations.map((loc) => (
                  <div key={loc.id} className="rounded-md border bg-card p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="font-mono font-medium">{loc.code}</div>
                      {loc.isPickable ? (
                        <Badge className="bg-emerald-100 text-emerald-700">Pickable</Badge>
                      ) : (
                        <Badge variant="secondary">Not Pickable</Badge>
                      )}
                    </div>
                    <div className="text-sm mb-2">{loc.name || "-"}</div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Badge variant="outline">{loc.locationType}</Badge>
                      <span className="text-muted-foreground">Zone: <span className="font-mono">{loc.zone}</span></span>
                      <span className="text-muted-foreground">Policy: {loc.movementPolicy}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop table layout for locations */}
            <div className="hidden md:block rounded-md border bg-card flex-1 overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/40 sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="w-[150px]">Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-[120px]">Type</TableHead>
                    <TableHead className="w-[80px]">Zone</TableHead>
                    <TableHead className="w-[100px]">Pickable</TableHead>
                    <TableHead className="w-[120px]">Policy</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locations.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                        No warehouse locations defined yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    locations.map((loc) => (
                      <TableRow key={loc.id}>
                        <TableCell className="font-mono font-medium">{loc.code}</TableCell>
                        <TableCell>{loc.name || "-"}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{loc.locationType}</Badge>
                        </TableCell>
                        <TableCell className="font-mono">{loc.zone}</TableCell>
                        <TableCell>
                          {loc.isPickable ? (
                            <Badge className="bg-emerald-100 text-emerald-700">Yes</Badge>
                          ) : (
                            <Badge variant="secondary">No</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{loc.movementPolicy}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        
        {activeTab === "levels" && variantLevels.length > 0 && (
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <div>Showing {variantLevels.filter(v => 
              (v.sku || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
              (v.name || '').toLowerCase().includes(searchQuery.toLowerCase())
            ).length} of {variantLevels.length} variants</div>
          </div>
        )}
      </div>

      <Dialog open={adjustDialogOpen} onOpenChange={setAdjustDialogOpen}>
        <DialogContent className="w-[95vw] max-w-lg mx-auto">
          <DialogHeader>
            <DialogTitle>Adjust Inventory</DialogTitle>
            <DialogDescription>
              Adjust the base unit count for {selectedItem?.baseSku}. Use positive numbers to add stock, negative to remove.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Current On Hand: {selectedItem?.totalOnHandBase.toLocaleString()} base units</Label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="qty">Adjustment Quantity (+ or -)</Label>
              <Input
                id="qty"
                type="number"
                placeholder="e.g., 100 or -50"
                value={adjustmentQty}
                onChange={(e) => setAdjustmentQty(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason">Reason for Adjustment</Label>
              <Textarea
                id="reason"
                placeholder="e.g., Cycle count correction, damaged goods, etc."
                value={adjustmentReason}
                onChange={(e) => setAdjustmentReason(e.target.value)}
                className="w-full min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setAdjustDialogOpen(false)} className="w-full sm:w-auto">Cancel</Button>
            <Button 
              onClick={handleAdjustSubmit}
              disabled={!adjustmentQty || !adjustmentReason || adjustInventoryMutation.isPending}
              className="w-full sm:w-auto"
            >
              {adjustInventoryMutation.isPending ? "Adjusting..." : "Apply Adjustment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addItemDialogOpen} onOpenChange={setAddItemDialogOpen}>
        <DialogContent className="w-[95vw] max-w-lg mx-auto">
          <DialogHeader>
            <DialogTitle>Add Inventory Item</DialogTitle>
            <DialogDescription>
              Create a new base inventory item. You'll add variants and stock levels separately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="baseSku">Base SKU</Label>
              <Input
                id="baseSku"
                placeholder="e.g., EG-STD-SLV"
                value={newItemForm.baseSku}
                onChange={(e) => setNewItemForm({ ...newItemForm, baseSku: e.target.value })}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g., Easy Glide Standard Sleeve"
                value={newItemForm.name}
                onChange={(e) => setNewItemForm({ ...newItemForm, name: e.target.value })}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                placeholder="Product description..."
                value={newItemForm.description}
                onChange={(e) => setNewItemForm({ ...newItemForm, description: e.target.value })}
                className="w-full min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setAddItemDialogOpen(false)} className="w-full sm:w-auto">Cancel</Button>
            <Button 
              onClick={() => createItemMutation.mutate(newItemForm)}
              disabled={!newItemForm.baseSku || !newItemForm.name || createItemMutation.isPending}
              className="w-full sm:w-auto"
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
        <DialogContent className="w-[95vw] max-w-2xl mx-auto max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5" />
              Upload Inventory CSV
            </DialogTitle>
            <DialogDescription className="text-sm">
              Upload a CSV file to update inventory levels in bulk. The CSV should have columns: location_code, sku, quantity
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 flex-1 overflow-auto">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
                <Download size={14} className="mr-1" /> Download Template
              </Button>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="csvFile">Select CSV File</Label>
              <Input
                id="csvFile"
                type="file"
                accept=".csv"
                className="w-full"
                onChange={(e) => {
                  setCsvFile(e.target.files?.[0] || null);
                  setCsvResults(null);
                }}
              />
              {csvFile && (
                <p className="text-sm text-muted-foreground">
                  Selected: {csvFile.name} ({(csvFile.size / 1024).toFixed(1)} KB)
                </p>
              )}
            </div>

            {csvResults && (
              <div className="space-y-2">
                <Label>Results</Label>
                {/* Mobile card layout for CSV results */}
                <div className="md:hidden space-y-2 max-h-60 overflow-auto">
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
            <Button variant="outline" onClick={() => setCsvUploadOpen(false)} className="w-full sm:w-auto">
              {csvResults ? "Close" : "Cancel"}
            </Button>
            {!csvResults && (
              <Button 
                onClick={handleCsvUpload}
                disabled={!csvFile || csvUploading}
                className="w-full sm:w-auto"
              >
                {csvUploading ? "Uploading..." : "Upload & Process"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
