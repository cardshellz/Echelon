import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { 
  Package, Plus, Trash2, Lock, RefreshCw, AlertTriangle, Store
} from "lucide-react";

interface Channel {
  id: number;
  name: string;
  provider: string;
  status: string;
}

interface InventoryItem {
  id: number;
  baseSku: string;
  name: string;
  active: number;
}

interface ChannelReservation {
  id: number;
  channelId: number;
  inventoryItemId: number;
  reserveBaseQty: number;
  minStockBase: number | null;
  maxStockBase: number | null;
  notes: string | null;
  channel?: Channel;
  inventoryItem?: InventoryItem;
}

export default function Reserves() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedChannelFilter, setSelectedChannelFilter] = useState<string>("all");
  const [newReservation, setNewReservation] = useState({
    channelId: "",
    inventoryItemId: "",
    reserveBaseQty: 0,
    minStockBase: 0,
    maxStockBase: 0,
    notes: "",
  });

  const canView = hasPermission("channels", "view");
  const canEdit = hasPermission("channels", "edit");

  const { data: channels = [] } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
    queryFn: async () => {
      const res = await fetch("/api/channels", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch channels");
      return res.json();
    },
    enabled: canView,
  });

  const { data: inventoryItems = [] } = useQuery<InventoryItem[]>({
    queryKey: ["/api/inventory/items"],
    queryFn: async () => {
      const res = await fetch("/api/inventory/items", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch inventory");
      return res.json();
    },
    enabled: canView,
  });

  const { data: reservations = [], isLoading } = useQuery<ChannelReservation[]>({
    queryKey: ["/api/channel-reservations", selectedChannelFilter],
    queryFn: async () => {
      const url = selectedChannelFilter !== "all" 
        ? `/api/channel-reservations?channelId=${selectedChannelFilter}`
        : "/api/channel-reservations";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch reservations");
      return res.json();
    },
    enabled: canView,
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof newReservation) => {
      const res = await fetch("/api/channel-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelId: parseInt(data.channelId),
          inventoryItemId: parseInt(data.inventoryItemId),
          reserveBaseQty: data.reserveBaseQty,
          minStockBase: data.minStockBase || null,
          maxStockBase: data.maxStockBase || null,
          notes: data.notes || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to create reservation");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-reservations"] });
      setIsCreateOpen(false);
      setNewReservation({
        channelId: "",
        inventoryItemId: "",
        reserveBaseQty: 0,
        minStockBase: 0,
        maxStockBase: 0,
        notes: "",
      });
      toast({ title: "Reserve created successfully" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/channel-reservations/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete reservation");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-reservations"] });
      toast({ title: "Reserve deleted" });
    },
  });

  const getTotalReserved = () => {
    return reservations.reduce((sum, r) => sum + r.reserveBaseQty, 0);
  };

  if (!canView) {
    return (
      <div className="flex items-center justify-center h-96" data-testid="page-reserves-no-access">
        <Card className="p-6 text-center">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold">Access Denied</h2>
          <p className="text-muted-foreground mt-2">You don't have permission to view reserves.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="page-reserves">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Package className="h-8 w-8 text-primary" />
            Channel Reserves
          </h1>
          <p className="text-muted-foreground">Allocate inventory to specific sales channels</p>
        </div>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <Select value={selectedChannelFilter} onValueChange={setSelectedChannelFilter}>
            <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-channel-filter">
              <SelectValue placeholder="Filter by channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Channels</SelectItem>
              {channels.map(ch => (
                <SelectItem key={ch.id} value={ch.id.toString()}>
                  {ch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canEdit && (
            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-create-reserve" className="w-full sm:w-auto">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Reserve
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Channel Reserve</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Channel</Label>
                    <Select
                      value={newReservation.channelId}
                      onValueChange={(value) => setNewReservation(prev => ({ ...prev, channelId: value }))}
                    >
                      <SelectTrigger data-testid="select-reserve-channel">
                        <SelectValue placeholder="Select channel" />
                      </SelectTrigger>
                      <SelectContent>
                        {channels.map(ch => (
                          <SelectItem key={ch.id} value={ch.id.toString()}>
                            {ch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Inventory Item (SKU)</Label>
                    <Select
                      value={newReservation.inventoryItemId}
                      onValueChange={(value) => setNewReservation(prev => ({ ...prev, inventoryItemId: value }))}
                    >
                      <SelectTrigger data-testid="select-reserve-item">
                        <SelectValue placeholder="Select item" />
                      </SelectTrigger>
                      <SelectContent>
                        {inventoryItems.filter(i => i.active === 1).map(item => (
                          <SelectItem key={item.id} value={item.id.toString()}>
                            {item.baseSku} - {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-2">
                      <Label>Reserve Qty</Label>
                      <Input
                        type="number"
                        value={newReservation.reserveBaseQty}
                        onChange={(e) => setNewReservation(prev => ({ ...prev, reserveBaseQty: parseInt(e.target.value) || 0 }))}
                        data-testid="input-reserve-qty"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Min Stock</Label>
                      <Input
                        type="number"
                        value={newReservation.minStockBase}
                        onChange={(e) => setNewReservation(prev => ({ ...prev, minStockBase: parseInt(e.target.value) || 0 }))}
                        data-testid="input-min-stock"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Max Stock</Label>
                      <Input
                        type="number"
                        value={newReservation.maxStockBase}
                        onChange={(e) => setNewReservation(prev => ({ ...prev, maxStockBase: parseInt(e.target.value) || 0 }))}
                        data-testid="input-max-stock"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Notes</Label>
                    <Textarea
                      value={newReservation.notes}
                      onChange={(e) => setNewReservation(prev => ({ ...prev, notes: e.target.value }))}
                      placeholder="Optional notes about this reserve"
                      data-testid="input-reserve-notes"
                    />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => createMutation.mutate(newReservation)}
                    disabled={!newReservation.channelId || !newReservation.inventoryItemId || createMutation.isPending}
                    data-testid="button-submit-reserve"
                  >
                    Create Reserve
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Channels</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{channels.filter(c => c.status === 'active').length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Reserves</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{reservations.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Reserved Units</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{getTotalReserved().toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-5 w-5" />
            Reserve Allocations
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : reservations.length === 0 ? (
            <div className="text-center py-12">
              <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No reserves configured yet.</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create reserves to allocate specific inventory quantities to sales channels.
              </p>
            </div>
          ) : (
            <>
              {/* Mobile card layout */}
              <div className="md:hidden space-y-3">
                {reservations.map(reserve => (
                  <div 
                    key={reserve.id} 
                    className="border rounded-lg p-4 space-y-3"
                    data-testid={`reserve-card-${reserve.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">
                        {reserve.channel?.name || `Channel ${reserve.channelId}`}
                      </Badge>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            if (confirm('Delete this reserve?')) {
                              deleteMutation.mutate(reserve.id);
                            }
                          }}
                          data-testid={`button-delete-reserve-mobile-${reserve.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="font-mono text-sm">{reserve.inventoryItem?.baseSku || '-'}</p>
                      <p className="text-sm text-muted-foreground">{reserve.inventoryItem?.name || '-'}</p>
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t">
                      <span className="text-sm text-muted-foreground">Reserved Qty</span>
                      <span className="font-medium">{reserve.reserveBaseQty.toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table layout */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="text-right">Reserved</TableHead>
                      <TableHead className="text-right">Min Stock</TableHead>
                      <TableHead className="text-right">Max Stock</TableHead>
                      <TableHead>Notes</TableHead>
                      {canEdit && <TableHead className="w-[80px]"></TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reservations.map(reserve => {
                      const isLowStock = false; // TODO: Add inventory level check
                      
                      return (
                        <TableRow key={reserve.id} data-testid={`reserve-row-${reserve.id}`}>
                          <TableCell>
                            <Badge variant="outline">
                              {reserve.channel?.name || `Channel ${reserve.channelId}`}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-sm">
                            {reserve.inventoryItem?.baseSku || '-'}
                          </TableCell>
                          <TableCell>
                            {reserve.inventoryItem?.name || '-'}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {reserve.reserveBaseQty.toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              {isLowStock && (
                                <AlertTriangle className="h-4 w-4 text-amber-500" />
                              )}
                              {reserve.minStockBase?.toLocaleString() || '-'}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            {reserve.maxStockBase?.toLocaleString() || '-'}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
                            {reserve.notes || '-'}
                          </TableCell>
                          {canEdit && (
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                  if (confirm('Delete this reserve?')) {
                                    deleteMutation.mutate(reserve.id);
                                  }
                                }}
                                data-testid={`button-delete-reserve-${reserve.id}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
