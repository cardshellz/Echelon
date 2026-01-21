import { useState } from "react";
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
import { Plus, Trash2, Edit, MapPin, Layers, Box, ArrowRight } from "lucide-react";

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
}

const LOCATION_TYPES = [
  { value: "forward_pick", label: "Forward Pick" },
  { value: "bulk_storage", label: "Bulk Storage" },
  { value: "receiving", label: "Receiving" },
  { value: "packing", label: "Packing" },
  { value: "shipping", label: "Shipping" },
  { value: "staging", label: "Staging" },
  { value: "pallet", label: "Pallet" },
];

const DEFAULT_ZONES = [
  { code: "RCV", name: "Receiving Dock", locationType: "receiving" },
  { code: "BULK", name: "Bulk Storage", locationType: "bulk_storage" },
  { code: "FWD", name: "Forward Pick", locationType: "forward_pick" },
  { code: "PACK", name: "Packing Station", locationType: "packing" },
  { code: "SHIP", name: "Shipping Lane", locationType: "shipping" },
];

export default function WarehouseLocations() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("locations");
  const [isCreateLocationOpen, setIsCreateLocationOpen] = useState(false);
  const [isCreateZoneOpen, setIsCreateZoneOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<WarehouseLocation | null>(null);
  const [newLocation, setNewLocation] = useState({
    zone: "",
    aisle: "",
    bay: "",
    level: "",
    bin: "",
    name: "",
    locationType: "forward_pick",
    isPickable: 1,
    pickSequence: "",
    minQty: "",
    maxQty: "",
  });
  const [newZone, setNewZone] = useState({
    code: "",
    name: "",
    description: "",
    locationType: "forward_pick",
    isPickable: 1,
  });

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
      setNewZone({ code: "", name: "", description: "", locationType: "forward_pick", isPickable: 1 });
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
      locationType: "forward_pick",
      isPickable: 1,
      pickSequence: "",
      minQty: "",
      maxQty: "",
    });
  };

  const handleCreateLocation = () => {
    const data: any = {
      locationType: newLocation.locationType,
      isPickable: newLocation.isPickable,
    };
    if (newLocation.zone) data.zone = newLocation.zone.toUpperCase();
    if (newLocation.aisle) data.aisle = newLocation.aisle.toUpperCase();
    if (newLocation.bay) data.bay = newLocation.bay;
    if (newLocation.level) data.level = newLocation.level.toUpperCase();
    if (newLocation.bin) data.bin = newLocation.bin;
    if (newLocation.name) data.name = newLocation.name;
    if (newLocation.pickSequence) data.pickSequence = parseInt(newLocation.pickSequence);
    if (newLocation.minQty) data.minQty = parseInt(newLocation.minQty);
    if (newLocation.maxQty) data.maxQty = parseInt(newLocation.maxQty);
    
    createLocationMutation.mutate(data);
  };

  const handleUpdateLocation = () => {
    if (!editingLocation) return;
    const data: any = {
      locationType: editingLocation.locationType,
      isPickable: editingLocation.isPickable,
    };
    if (editingLocation.zone) data.zone = editingLocation.zone.toUpperCase();
    if (editingLocation.aisle) data.aisle = editingLocation.aisle.toUpperCase();
    if (editingLocation.bay) data.bay = editingLocation.bay;
    if (editingLocation.level) data.level = editingLocation.level?.toUpperCase();
    if (editingLocation.bin) data.bin = editingLocation.bin;
    if (editingLocation.name) data.name = editingLocation.name;
    if (editingLocation.pickSequence) data.pickSequence = editingLocation.pickSequence;
    if (editingLocation.minQty) data.minQty = editingLocation.minQty;
    if (editingLocation.maxQty) data.maxQty = editingLocation.maxQty;
    
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

  if (!canView) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        You don't have permission to view warehouse locations.
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MapPin className="h-6 w-6" />
            Warehouse Locations
          </h1>
          <p className="text-muted-foreground">
            Manage your warehouse zones and bin locations
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="locations" data-testid="tab-locations">
            <Box className="h-4 w-4 mr-2" />
            Locations ({locations.length})
          </TabsTrigger>
          <TabsTrigger value="zones" data-testid="tab-zones">
            <Layers className="h-4 w-4 mr-2" />
            Zones ({zones.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="locations" className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              Location code format: <code className="bg-muted px-1 rounded">ZONE-AISLE-BAY-LEVEL-BIN</code>
            </div>
            {canCreate && (
              <Button onClick={() => setIsCreateLocationOpen(true)} data-testid="btn-create-location">
                <Plus className="h-4 w-4 mr-2" />
                Add Location
              </Button>
            )}
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location Code</TableHead>
                  <TableHead>Zone</TableHead>
                  <TableHead>Aisle</TableHead>
                  <TableHead>Bay</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Bin</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Pick Seq</TableHead>
                  {canEdit && <TableHead className="w-[100px]"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {locationsLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8">Loading...</TableCell>
                  </TableRow>
                ) : locations.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                      No locations defined yet. Add your first location to get started.
                    </TableCell>
                  </TableRow>
                ) : (
                  locations.map((loc) => (
                    <TableRow key={loc.id} data-testid={`location-row-${loc.id}`}>
                      <TableCell className="font-mono font-medium">{loc.code}</TableCell>
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
          <div className="flex justify-between items-center">
            <div className="text-sm text-muted-foreground">
              Zones organize your warehouse into logical areas
            </div>
            {canCreate && (
              <Button onClick={() => setIsCreateZoneOpen(true)} data-testid="btn-create-zone">
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
                <Label>Friendly Name (optional)</Label>
                <Input
                  placeholder="Main floor left"
                  value={newLocation.name}
                  onChange={(e) => setNewLocation({ ...newLocation, name: e.target.value })}
                  data-testid="input-location-name"
                />
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
                  <Label>Friendly Name</Label>
                  <Input
                    value={editingLocation.name || ""}
                    onChange={(e) => setEditingLocation({ ...editingLocation, name: e.target.value || null })}
                  />
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
    </div>
  );
}
