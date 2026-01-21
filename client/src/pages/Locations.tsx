import React, { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { locationsApi } from "@/lib/api";
import type { ProductLocation, InsertProductLocation } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { 
  MapPin, 
  Search, 
  Edit2, 
  Check, 
  X, 
  Plus,
  Upload,
  Download,
  Trash2,
  Package,
  FileText,
  Loader2,
  RefreshCw,
  AlertCircle
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface WarehouseLocation {
  id: number;
  code: string;
  zone: string | null;
  locationType: string;
}

export default function Locations() {
  const queryClient = useQueryClient();
  
  // Fetch locations
  const { data: locations = [], isLoading } = useQuery({
    queryKey: ["locations"],
    queryFn: locationsApi.getAll,
  });

  // Fetch warehouse locations for dropdown
  const { data: warehouseLocations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
  });

  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLocation, setEditLocation] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importResult, setImportResult] = useState<{ updated: number; notFound: number; errors: string[] } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [newSku, setNewSku] = useState("");
  const [newName, setNewName] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Group warehouse locations by zone for easier selection
  const locationsByZone = warehouseLocations.reduce((acc, loc) => {
    const zone = loc.zone || "Other";
    if (!acc[zone]) acc[zone] = [];
    acc[zone].push(loc);
    return acc;
  }, {} as Record<string, WarehouseLocation[]>);
  
  // Mutations
  const createMutation = useMutation({
    mutationFn: locationsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      setAddDialogOpen(false);
      setNewSku("");
      setNewName("");
      setNewLocation("");
    },
  });
  
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: { location: string; zone: string } }) => 
      locationsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      setEditingId(null);
      setEditLocation("");
    },
  });
  
  const deleteMutation = useMutation({
    mutationFn: locationsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
    },
  });
  
  // Filter locations
  const filteredLocations = locations.filter(loc => 
    loc.sku.toLowerCase().includes(searchQuery.toLowerCase()) ||
    loc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    loc.location.toLowerCase().includes(searchQuery.toLowerCase())
  );
  
  // Group by zone
  const zones = [...new Set(locations.map(l => l.zone))].sort();
  
  // Start editing
  const handleStartEdit = (id: number, currentLocation: string) => {
    setEditingId(id);
    setEditLocation(currentLocation);
  };
  
  // Save edit
  const handleSaveEdit = (id: number) => {
    const selectedWarehouseLoc = warehouseLocations.find(l => l.code === editLocation);
    const zone = selectedWarehouseLoc?.zone || editLocation.split("-")[0]?.toUpperCase() || "A";
    updateMutation.mutate({ 
      id, 
      data: { 
        location: editLocation.toUpperCase(), 
        zone,
        warehouseLocationId: selectedWarehouseLoc?.id 
      } as any
    });
  };
  
  // Cancel edit
  const handleCancelEdit = () => {
    setEditingId(null);
    setEditLocation("");
  };
  
  // Add new
  const handleAdd = () => {
    if (!newSku || !newLocation) return;
    
    // Find the selected warehouse location to get zone and id
    const selectedWarehouseLoc = warehouseLocations.find(l => l.code === newLocation);
    const zone = selectedWarehouseLoc?.zone || newLocation.split("-")[0]?.toUpperCase() || "A";
    
    createMutation.mutate({
      sku: newSku.toUpperCase(),
      name: newName || newSku.toUpperCase(),
      location: newLocation.toUpperCase(),
      zone,
      warehouseLocationId: selectedWarehouseLoc?.id,
    } as any);
  };
  
  // Delete
  const handleDelete = (id: number) => {
    if (confirm("Are you sure you want to delete this location?")) {
      deleteMutation.mutate(id);
    }
  };
  
  // Export CSV
  const handleExport = () => {
    window.location.href = "/api/locations/export/csv";
  };
  
  // Import CSV
  const handleImportClick = () => {
    fileInputRef.current?.click();
  };
  
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsImporting(true);
    setImportResult(null);
    setImportDialogOpen(true);
    
    try {
      const csvData = await file.text();
      const response = await fetch("/api/locations/import/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvData }),
      });
      
      const result = await response.json();
      
      if (response.ok) {
        setImportResult(result);
        queryClient.invalidateQueries({ queryKey: ["locations"] });
      } else {
        setImportResult({ updated: 0, notFound: 0, errors: [result.error || "Import failed"] });
      }
    } catch (error) {
      setImportResult({ updated: 0, notFound: 0, errors: ["Failed to import CSV file"] });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };
  
  const handleShopifySync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/shopify/sync", { method: "POST" });
      const result = await response.json();
      if (response.ok) {
        queryClient.invalidateQueries({ queryKey: ["locations"] });
        alert(`Synced ${result.total} products from Shopify (${result.created} new, ${result.updated} updated)`);
      } else {
        alert(result.error || "Shopify sync failed");
      }
    } catch (error) {
      alert("Failed to sync with Shopify");
    } finally {
      setIsSyncing(false);
    }
  };
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading locations...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-muted/20">
      {/* Header */}
      <div className="p-4 md:p-6 border-b bg-card">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <MapPin className="h-6 w-6 text-primary" />
              Product Locations
            </h1>
            <p className="text-muted-foreground text-sm">
              Map SKUs to bin locations for picking
            </p>
          </div>
          
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              accept=".csv"
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-csv-file"
            />
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleShopifySync}
              disabled={isSyncing}
              data-testid="button-shopify-sync"
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", isSyncing && "animate-spin")} />
              {isSyncing ? "Syncing..." : "Sync Shopify"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleImportClick} data-testid="button-import-csv">
              <Upload className="h-4 w-4 mr-2" />
              Import CSV
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} data-testid="button-export-csv">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
            <Button onClick={() => setAddDialogOpen(true)} data-testid="button-add-location">
              <Plus className="h-4 w-4 mr-2" />
              Add Product
            </Button>
          </div>
        </div>
        
        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search by SKU, name, or location..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search-locations"
          />
        </div>
        
        {/* Zone Summary */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {zones.map(zone => (
            <Badge 
              key={zone} 
              variant="secondary" 
              className="px-3 py-1"
            >
              Zone {zone}: {locations.filter(l => l.zone === zone).length} products
            </Badge>
          ))}
        </div>
      </div>
      
      {/* Table */}
      <ScrollArea className="flex-1">
        <div className="p-4 md:p-6">
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[140px]">SKU</TableHead>
                  <TableHead>Product Name</TableHead>
                  <TableHead className="w-[140px]">Location</TableHead>
                  <TableHead className="w-[100px]">Zone</TableHead>
                  <TableHead className="w-[120px]">Updated</TableHead>
                  <TableHead className="w-[100px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLocations.map((loc) => (
                  <TableRow key={loc.id} data-testid={`row-location-${loc.sku}`}>
                    <TableCell className="font-mono font-medium">{loc.sku}</TableCell>
                    <TableCell className="text-muted-foreground">{loc.name}</TableCell>
                    <TableCell>
                      {editingId === loc.id ? (
                        <Select value={editLocation} onValueChange={setEditLocation}>
                          <SelectTrigger className="h-8 w-36 font-mono">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">
                            {Object.entries(locationsByZone).sort().map(([zone, locs]) => (
                              <React.Fragment key={zone}>
                                <div className="px-2 py-1 text-xs font-semibold text-muted-foreground bg-muted">
                                  {zone}
                                </div>
                                {locs.sort((a, b) => a.code.localeCompare(b.code)).map((wloc) => (
                                  <SelectItem key={wloc.id} value={wloc.code} className="font-mono text-sm">
                                    {wloc.code}
                                  </SelectItem>
                                ))}
                              </React.Fragment>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline" className="font-mono bg-primary/5">
                          <MapPin className="h-3 w-3 mr-1" />
                          {loc.location}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{loc.zone}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {formatDistanceToNow(new Date(loc.updatedAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="text-right">
                      {editingId === loc.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            className="h-8 w-8 text-emerald-600"
                            onClick={() => handleSaveEdit(loc.id)}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            className="h-8 w-8"
                            onClick={handleCancelEdit}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1">
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            className="h-8 w-8"
                            onClick={() => handleStartEdit(loc.id, loc.location)}
                            data-testid={`button-edit-${loc.sku}`}
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button 
                            size="icon" 
                            variant="ghost" 
                            className="h-8 w-8 text-destructive hover:text-destructive"
                            onClick={() => handleDelete(loc.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                
                {filteredLocations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      No products found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
          
          {/* Quick Tips */}
          <Card className="mt-6 bg-muted/30">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Location Format Guide</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground space-y-1">
              <p><strong>A-01-02-B</strong> = Zone A, Aisle 01, Rack 02, Bin B</p>
              <p>Zone is auto-detected from the first character of the location.</p>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
      
      {/* Add Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Product Location</DialogTitle>
            <DialogDescription>
              Map a SKU to its bin location
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="sku">SKU *</Label>
              <Input 
                id="sku"
                placeholder="e.g. NK-292-BLK"
                value={newSku}
                onChange={(e) => setNewSku(e.target.value)}
                className="uppercase"
                data-testid="input-new-sku"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Product Name</Label>
              <Input 
                id="name"
                placeholder="e.g. Nike Air Max 90 Black"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                data-testid="input-new-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="location">Bin Location *</Label>
              {warehouseLocations.length === 0 ? (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No warehouse locations exist. <a href="/warehouse/locations" className="underline">Create locations first</a>.
                  </AlertDescription>
                </Alert>
              ) : (
                <Select value={newLocation} onValueChange={setNewLocation} data-testid="select-new-location">
                  <SelectTrigger className="font-mono">
                    <SelectValue placeholder="Select a bin location" />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {Object.entries(locationsByZone).sort().map(([zone, locs]) => (
                      <React.Fragment key={zone}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted">
                          Zone: {zone}
                        </div>
                        {locs.sort((a, b) => a.code.localeCompare(b.code)).map((loc) => (
                          <SelectItem key={loc.id} value={loc.code} className="font-mono">
                            {loc.code}
                          </SelectItem>
                        ))}
                      </React.Fragment>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!newSku || !newLocation || warehouseLocations.length === 0}>
              Add Location
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Import Result Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              CSV Import
            </DialogTitle>
          </DialogHeader>
          
          {isImporting ? (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
              <p className="text-muted-foreground">Processing CSV file...</p>
            </div>
          ) : importResult ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-emerald-50 dark:bg-emerald-900/20 p-4 rounded-lg text-center">
                  <div className="text-2xl font-bold text-emerald-600">{importResult.updated}</div>
                  <div className="text-sm text-muted-foreground">Locations Updated</div>
                </div>
                <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-lg text-center">
                  <div className="text-2xl font-bold text-amber-600">{importResult.notFound}</div>
                  <div className="text-sm text-muted-foreground">SKUs Not Found</div>
                </div>
              </div>
              
              {importResult.errors.length > 0 && (
                <div className="bg-muted/50 p-3 rounded-lg max-h-32 overflow-auto">
                  <p className="text-xs font-medium mb-1">Issues:</p>
                  {importResult.errors.map((err, i) => (
                    <p key={i} className="text-xs text-muted-foreground">{err}</p>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          
          <DialogFooter>
            <Button onClick={() => setImportDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
