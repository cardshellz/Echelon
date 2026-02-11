import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Edit, Building2, MapPin, Check, X } from "lucide-react";
import { Switch } from "@/components/ui/switch";

interface Warehouse {
  id: number;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  timezone: string | null;
  isActive: number;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
}

export default function Warehouses() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingWarehouse, setEditingWarehouse] = useState<Warehouse | null>(null);
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    address: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
    timezone: "America/New_York",
    isActive: 1,
    isDefault: 0,
  });

  const canView = hasPermission("inventory", "view");
  const canEdit = hasPermission("inventory", "edit");
  const canCreate = hasPermission("inventory", "create");

  const { data: warehouses = [], isLoading } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
    enabled: canView,
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await fetch("/api/warehouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create warehouse");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouses"] });
      setIsCreateOpen(false);
      resetForm();
      toast({ title: "Warehouse created successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<typeof formData> }) => {
      const res = await fetch(`/api/warehouses/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update warehouse");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouses"] });
      setEditingWarehouse(null);
      resetForm();
      toast({ title: "Warehouse updated successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/warehouses/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete warehouse");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/warehouses"] });
      toast({ title: "Warehouse deleted successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setFormData({
      code: "",
      name: "",
      address: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
      timezone: "America/New_York",
      isActive: 1,
      isDefault: 0,
    });
  };

  const handleEdit = (warehouse: Warehouse) => {
    setEditingWarehouse(warehouse);
    setFormData({
      code: warehouse.code,
      name: warehouse.name,
      address: warehouse.address || "",
      city: warehouse.city || "",
      state: warehouse.state || "",
      postalCode: warehouse.postalCode || "",
      country: warehouse.country || "US",
      timezone: warehouse.timezone || "America/New_York",
      isActive: warehouse.isActive,
      isDefault: warehouse.isDefault,
    });
  };

  const handleSubmit = () => {
    if (!formData.code || !formData.name) {
      toast({ title: "Error", description: "Code and name are required", variant: "destructive" });
      return;
    }
    if (editingWarehouse) {
      updateMutation.mutate({ id: editingWarehouse.id, data: formData });
    } else {
      createMutation.mutate(formData as any);
    }
  };

  const handleDelete = (id: number, name: string) => {
    if (confirm(`Delete warehouse "${name}"? This will also delete all locations within it.`)) {
      deleteMutation.mutate(id);
    }
  };

  if (!canView) {
    return (
      <div className="p-2 md:p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">You don't have permission to view warehouses.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6 md:h-8 md:w-8" />
            Warehouses
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your physical warehouse locations</p>
        </div>
        {canCreate && (
          <Button onClick={() => setIsCreateOpen(true)} className="min-h-[44px]" data-testid="btn-add-warehouse">
            <Plus className="h-4 w-4 mr-2" />
            Add Warehouse
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        <Card>
          <CardHeader className="pb-2 p-3 md:p-6">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Total Warehouses</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            <div className="text-xl md:text-2xl font-bold">{warehouses.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 p-3 md:p-6">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Active</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            <div className="text-xl md:text-2xl font-bold text-green-600">
              {warehouses.filter(w => w.isActive === 1).length}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2 p-3 md:p-6">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Default Warehouse</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 md:p-6 md:pt-0">
            <div className="text-base md:text-lg font-medium">
              {warehouses.find(w => w.isDefault === 1)?.name || "None set"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-lg md:text-xl">Warehouse List</CardTitle>
          <CardDescription className="text-xs md:text-sm">All physical warehouse sites in your network</CardDescription>
        </CardHeader>
        <CardContent className="p-2 md:p-6">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : warehouses.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Building2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No warehouses configured yet.</p>
              <p className="text-sm">Add your first warehouse to get started.</p>
            </div>
          ) : (
            <>
              {/* Mobile Card View */}
              <div className="md:hidden space-y-3">
                {warehouses.map((warehouse) => (
                  <Card key={warehouse.id} data-testid={`warehouse-card-${warehouse.id}`}>
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-sm">{warehouse.code}</span>
                            {warehouse.isDefault === 1 && (
                              <Badge variant="outline" className="text-xs">Default</Badge>
                            )}
                          </div>
                          <p className="font-medium text-sm">{warehouse.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {[warehouse.city, warehouse.state].filter(Boolean).join(", ") || "No location"}
                          </p>
                          <div className="pt-1">
                            {warehouse.isActive === 1 ? (
                              <Badge variant="default" className="bg-green-100 text-green-800 text-xs">Active</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs">Inactive</Badge>
                            )}
                          </div>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="min-h-[44px] min-w-[44px]"
                              onClick={() => handleEdit(warehouse)}
                              data-testid={`btn-edit-warehouse-mobile-${warehouse.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="min-h-[44px] min-w-[44px]"
                              onClick={() => handleDelete(warehouse.id, warehouse.name)}
                              data-testid={`btn-delete-warehouse-mobile-${warehouse.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Desktop Table View */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Default</TableHead>
                      {canEdit && <TableHead className="w-24">Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {warehouses.map((warehouse) => (
                      <TableRow key={warehouse.id} data-testid={`warehouse-row-${warehouse.id}`}>
                        <TableCell className="font-mono font-medium">{warehouse.code}</TableCell>
                        <TableCell>{warehouse.name}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {[warehouse.city, warehouse.state].filter(Boolean).join(", ") || "-"}
                        </TableCell>
                        <TableCell>
                          {warehouse.isActive === 1 ? (
                            <Badge variant="default" className="bg-green-100 text-green-800">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {warehouse.isDefault === 1 ? (
                            <Check className="h-4 w-4 text-green-600" />
                          ) : (
                            <X className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        {canEdit && (
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit(warehouse)}
                                data-testid={`btn-edit-warehouse-${warehouse.id}`}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(warehouse.id, warehouse.name)}
                                data-testid={`btn-delete-warehouse-${warehouse.id}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={isCreateOpen || !!editingWarehouse} onOpenChange={(open) => {
        if (!open) {
          setIsCreateOpen(false);
          setEditingWarehouse(null);
          resetForm();
        }
      }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>
              {editingWarehouse ? "Edit Warehouse" : "Add New Warehouse"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
              <div className="space-y-1">
                <Label htmlFor="code" className="text-xs md:text-sm">Code *</Label>
                <Input
                  id="code"
                  placeholder="EAST"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-warehouse-code"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="name" className="text-xs md:text-sm">Name *</Label>
                <Input
                  id="name"
                  placeholder="East Coast Distribution"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-warehouse-name"
                />
              </div>
            </div>

            <details className="group" open>
              <summary className="text-xs md:text-sm font-medium cursor-pointer list-none flex items-center gap-2 py-2">
                <span className="text-muted-foreground group-open:rotate-90 transition-transform">▶</span>
                Address Details
              </summary>
              <div className="space-y-3 pt-2">
                <div className="space-y-1">
                  <Label htmlFor="address" className="text-xs md:text-sm">Address</Label>
                  <Input
                    id="address"
                    placeholder="123 Warehouse Blvd"
                    value={formData.address}
                    onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                    className="h-11"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    data-testid="input-warehouse-address"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 md:gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="city" className="text-xs md:text-sm">City</Label>
                    <Input
                      id="city"
                      placeholder="Newark"
                      value={formData.city}
                      onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                      className="h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-warehouse-city"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="state" className="text-xs md:text-sm">State</Label>
                    <Input
                      id="state"
                      placeholder="NJ"
                      value={formData.state}
                      onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                      className="h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-warehouse-state"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="postalCode" className="text-xs md:text-sm">Postal</Label>
                    <Input
                      id="postalCode"
                      placeholder="07102"
                      value={formData.postalCode}
                      onChange={(e) => setFormData({ ...formData, postalCode: e.target.value })}
                      className="h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-warehouse-postal"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 md:gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="country" className="text-xs md:text-sm">Country</Label>
                    <Input
                      id="country"
                      placeholder="US"
                      value={formData.country}
                      onChange={(e) => setFormData({ ...formData, country: e.target.value })}
                      className="h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-warehouse-country"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="timezone" className="text-xs md:text-sm">Timezone</Label>
                    <Input
                      id="timezone"
                      placeholder="America/New_York"
                      value={formData.timezone}
                      onChange={(e) => setFormData({ ...formData, timezone: e.target.value })}
                      className="h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-warehouse-timezone"
                    />
                  </div>
                </div>
              </div>
            </details>

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2">
              <div className="flex items-center gap-2 min-h-[44px]">
                <Switch
                  id="isActive"
                  checked={formData.isActive === 1}
                  onCheckedChange={(checked) => setFormData({ ...formData, isActive: checked ? 1 : 0 })}
                  data-testid="switch-warehouse-active"
                />
                <Label htmlFor="isActive" className="text-sm">Active</Label>
              </div>
              <div className="flex items-center gap-2 min-h-[44px]">
                <Switch
                  id="isDefault"
                  checked={formData.isDefault === 1}
                  onCheckedChange={(checked) => setFormData({ ...formData, isDefault: checked ? 1 : 0 })}
                  data-testid="switch-warehouse-default"
                />
                <Label htmlFor="isDefault" className="text-sm">Default Warehouse</Label>
              </div>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button 
              variant="outline" 
              className="min-h-[44px] w-full sm:w-auto"
              onClick={() => {
                setIsCreateOpen(false);
                setEditingWarehouse(null);
                resetForm();
              }} 
              data-testid="btn-cancel-warehouse"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="btn-save-warehouse"
            >
              {editingWarehouse ? "Update" : "Create"} Warehouse
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
