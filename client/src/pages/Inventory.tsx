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
  MapPin
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

export default function Inventory() {
  const [activeTab, setActiveTab] = useState("items");
  const [searchQuery, setSearchQuery] = useState("");
  const [adjustDialogOpen, setAdjustDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItemSummary | null>(null);
  const [adjustmentQty, setAdjustmentQty] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [addItemDialogOpen, setAddItemDialogOpen] = useState(false);
  const [newItemForm, setNewItemForm] = useState({ baseSku: "", name: "", description: "" });
  
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

  const filteredItems = inventorySummary.filter(item => 
    item.baseSku.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalOnHand = inventorySummary.reduce((sum, item) => sum + item.totalOnHandBase, 0);
  const totalReserved = inventorySummary.reduce((sum, item) => sum + item.totalReservedBase, 0);
  const totalATP = inventorySummary.reduce((sum, item) => sum + item.totalAtpBase, 0);
  const lowStockItems = inventorySummary.filter(item => item.totalAtpBase <= 0).length;

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

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card p-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" />
              Inventory Management
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Manage stock levels, locations, and inventory adjustments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetchInventory()}>
              <RefreshCw size={16} className="mr-1" /> Refresh
            </Button>
            <Button variant="outline" className="gap-2">
              <Download size={16} /> Export
            </Button>
            <Button className="gap-2" onClick={() => setAddItemDialogOpen(true)}>
              <Plus size={16} /> Add Item
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-4">
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <Boxes size={12} /> Total SKUs
            </div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">{inventorySummary.length}</div>
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

        <div className="flex items-center justify-between gap-4 mt-6">
          <div className="flex items-center gap-2 flex-1 max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input 
                placeholder="Search by SKU or Name..." 
                className="pl-9 h-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Button variant="outline" size="sm" className="h-9 gap-2">
              <Filter size={16} /> Filters
            </Button>
          </div>
          
          <div className="flex items-center bg-muted/50 p-1 rounded-md">
            <Button 
              variant={activeTab === "items" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs"
              onClick={() => setActiveTab("items")}
            >
              All Items
            </Button>
            <Button 
              variant={activeTab === "variants" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs"
              onClick={() => setActiveTab("variants")}
            >
              Variants
            </Button>
            <Button 
              variant={activeTab === "locations" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs"
              onClick={() => setActiveTab("locations")}
            >
              Locations
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-hidden flex flex-col">
        {loadingInventory || loadingLocations ? (
          <div className="flex-1 flex items-center justify-center">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === "items" ? (
          <>
            {filteredItems.length === 0 ? (
              <div className="flex-1 bg-card rounded-md border flex flex-col items-center justify-center text-center p-12">
                <div className="bg-primary/10 p-4 rounded-full mb-4">
                  <Package className="h-10 w-10 text-primary" />
                </div>
                <h2 className="text-2xl font-bold mb-2">No Inventory Items Yet</h2>
                <p className="text-muted-foreground max-w-md mb-8">
                  Start by adding your first inventory item. Items are tracked at the base unit level with sellable variants.
                </p>
                <Button onClick={() => setAddItemDialogOpen(true)}>
                  <Plus size={16} className="mr-2" /> Add First Item
                </Button>
              </div>
            ) : (
              <div className="rounded-md border bg-card flex-1 overflow-auto">
                <Table>
                  <TableHeader className="bg-muted/40 sticky top-0 z-10">
                    <TableRow>
                      <TableHead className="w-[180px]">Base SKU</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead className="text-right w-[120px]">On Hand</TableHead>
                      <TableHead className="text-right w-[120px]">Reserved</TableHead>
                      <TableHead className="text-right w-[120px]">ATP</TableHead>
                      <TableHead className="w-[120px]">Status</TableHead>
                      <TableHead className="w-[120px]">Variants</TableHead>
                      <TableHead className="w-[50px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredItems.map((item) => (
                      <TableRow key={item.inventoryItemId} className="hover:bg-muted/5">
                        <TableCell className="font-mono font-medium text-primary">
                          {item.baseSku}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{item.name}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">{item.totalOnHandBase.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono text-muted-foreground">{item.totalReservedBase.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono font-bold">
                          {item.totalAtpBase.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          {getStatusBadge(item.totalAtpBase)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {item.variants.slice(0, 3).map((v, i) => (
                              <Badge key={i} variant="outline" className="text-[10px]">
                                {v.sku.split("-").pop()} ({v.available})
                              </Badge>
                            ))}
                            {item.variants.length > 3 && (
                              <Badge variant="outline" className="text-[10px]">+{item.variants.length - 3}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem className="gap-2" onClick={() => handleAdjustClick(item)}>
                                <Edit size={14} /> Adjust Stock
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="gap-2">
                                <History size={14} /> View History
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        ) : activeTab === "variants" ? (
          <div className="rounded-md border bg-card flex-1 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/40 sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-[200px]">SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right w-[120px]">Units Per</TableHead>
                  <TableHead className="w-[100px]">Level</TableHead>
                  <TableHead className="w-[150px]">Barcode</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {variants.map((variant) => (
                  <TableRow key={variant.id}>
                    <TableCell className="font-mono font-medium text-primary">{variant.sku}</TableCell>
                    <TableCell>{variant.name}</TableCell>
                    <TableCell className="text-right font-mono">{variant.unitsPerVariant}</TableCell>
                    <TableCell>
                      <Badge variant="outline">Level {variant.hierarchyLevel}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {variant.barcode || "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-md border bg-card flex-1 overflow-auto">
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
        )}
        
        {activeTab === "items" && filteredItems.length > 0 && (
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <div>Showing {filteredItems.length} of {inventorySummary.length} items</div>
          </div>
        )}
      </div>

      <Dialog open={adjustDialogOpen} onOpenChange={setAdjustDialogOpen}>
        <DialogContent>
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
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason">Reason for Adjustment</Label>
              <Textarea
                id="reason"
                placeholder="e.g., Cycle count correction, damaged goods, etc."
                value={adjustmentReason}
                onChange={(e) => setAdjustmentReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={handleAdjustSubmit}
              disabled={!adjustmentQty || !adjustmentReason || adjustInventoryMutation.isPending}
            >
              {adjustInventoryMutation.isPending ? "Adjusting..." : "Apply Adjustment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={addItemDialogOpen} onOpenChange={setAddItemDialogOpen}>
        <DialogContent>
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
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="e.g., Easy Glide Standard Sleeve"
                value={newItemForm.name}
                onChange={(e) => setNewItemForm({ ...newItemForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                placeholder="Product description..."
                value={newItemForm.description}
                onChange={(e) => setNewItemForm({ ...newItemForm, description: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddItemDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={() => createItemMutation.mutate(newItemForm)}
              disabled={!newItemForm.baseSku || !newItemForm.name || createItemMutation.isPending}
            >
              {createItemMutation.isPending ? "Creating..." : "Create Item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
