import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  ShoppingCart,
  Plus,
  Search,
  ChevronsUpDown,
  Check,
  FileText,
  DollarSign,
  Clock,
  Package,
  AlertCircle,
} from "lucide-react";

// Status badge config
const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_approval: { variant: "outline", label: "Pending Approval", color: "text-amber-600 border-amber-300" },
  approved: { variant: "default", label: "Approved" },
  sent: { variant: "default", label: "Sent", color: "bg-blue-500" },
  acknowledged: { variant: "default", label: "Acknowledged", color: "bg-indigo-500" },
  partially_received: { variant: "outline", label: "Partial Receipt", color: "text-orange-600 border-orange-300" },
  received: { variant: "default", label: "Received", color: "bg-green-600" },
  closed: { variant: "secondary", label: "Closed" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

function formatCents(cents: number | null | undefined): string {
  if (!cents) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Vendor = { id: number; name: string; code: string };
type PurchaseOrder = {
  id: number;
  poNumber: string;
  vendorId: number;
  status: string;
  poType: string;
  priority: string;
  lineCount: number;
  totalCents: number | null;
  expectedDeliveryDate: string | null;
  createdAt: string;
  vendor?: Vendor;
};

export default function PurchaseOrders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [vendorFilter, setVendorFilter] = useState<number | null>(null);

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");
  const [newPO, setNewPO] = useState({
    vendorId: 0,
    poType: "standard",
    priority: "normal",
    expectedDeliveryDate: "",
    vendorNotes: "",
    internalNotes: "",
  });

  // Queries
  const { data: poData } = useQuery<{ purchaseOrders: PurchaseOrder[]; total: number }>({
    queryKey: ["/api/purchase-orders", statusFilter, searchQuery, vendorFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (searchQuery) params.set("search", searchQuery);
      if (vendorFilter) params.set("vendorId", String(vendorFilter));
      params.set("limit", "100");
      const res = await fetch(`/api/purchase-orders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch POs");
      return res.json();
    },
  });

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
  });

  const purchaseOrders = poData?.purchaseOrders ?? [];

  // Stats
  const stats = {
    total: poData?.total ?? 0,
    openValue: purchaseOrders
      .filter(po => !["closed", "cancelled"].includes(po.status))
      .reduce((sum, po) => sum + (Number(po.totalCents) || 0), 0),
    pendingApproval: purchaseOrders.filter(po => po.status === "pending_approval").length,
    awaitingReceipt: purchaseOrders.filter(po => ["sent", "acknowledged"].includes(po.status)).length,
  };

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async (data: typeof newPO) => {
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: data.vendorId,
          poType: data.poType,
          priority: data.priority,
          expectedDeliveryDate: data.expectedDeliveryDate || undefined,
          vendorNotes: data.vendorNotes || undefined,
          internalNotes: data.internalNotes || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create PO");
      }
      return res.json();
    },
    onSuccess: (po) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setShowCreateDialog(false);
      setNewPO({ vendorId: 0, poType: "standard", priority: "normal", expectedDeliveryDate: "", vendorNotes: "", internalNotes: "" });
      toast({ title: "Purchase order created", description: `${po.poNumber} created as draft` });
      navigate(`/purchase-orders/${po.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const selectedVendor = vendors.find(v => v.id === newPO.vendorId);
  const filteredVendors = vendors.filter(v =>
    !vendorSearch || v.name.toLowerCase().includes(vendorSearch.toLowerCase()) || v.code.toLowerCase().includes(vendorSearch.toLowerCase())
  ).slice(0, 50);

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 md:h-6 md:w-6" />
            Purchase Orders
          </h1>
          <p className="text-sm text-muted-foreground">
            Create and manage purchase orders
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="min-h-[44px] w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          New Purchase Order
        </Button>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Total POs</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">{formatCents(stats.openValue)}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Open Value</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-amber-600">{stats.pendingApproval}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Pending Approval</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-blue-600">{stats.awaitingReceipt}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Awaiting Receipt</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search PO#, reference..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9 h-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44 h-10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="pending_approval">Pending Approval</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="acknowledged">Acknowledged</SelectItem>
            <SelectItem value="partially_received">Partial Receipt</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-3">
        {purchaseOrders.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              No purchase orders found.
            </CardContent>
          </Card>
        ) : (
          purchaseOrders.map(po => (
            <Card
              key={po.id}
              className="cursor-pointer active:bg-accent/50"
              onClick={() => navigate(`/purchase-orders/${po.id}`)}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-medium text-sm">{po.poNumber}</span>
                      <Badge
                        variant={STATUS_BADGES[po.status]?.variant || "secondary"}
                        className={`text-xs ${STATUS_BADGES[po.status]?.color || ""}`}
                      >
                        {STATUS_BADGES[po.status]?.label || po.status}
                      </Badge>
                      {po.priority === "rush" && <Badge variant="destructive" className="text-xs">Rush</Badge>}
                      {po.priority === "high" && <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">High</Badge>}
                    </div>
                    <div className="text-sm mt-1">{po.vendor?.name || `Vendor #${po.vendorId}`}</div>
                    <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                      <span>{po.lineCount || 0} lines</span>
                      <span>{formatCents(po.totalCents)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {format(new Date(po.createdAt), "MMM d, yyyy")}
                      {po.expectedDeliveryDate && ` • ETA ${format(new Date(po.expectedDeliveryDate), "MMM d")}`}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Desktop Table */}
      <Card className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>PO #</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Lines</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Expected</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {purchaseOrders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No purchase orders found. Click "New Purchase Order" to create one.
                </TableCell>
              </TableRow>
            ) : (
              purchaseOrders.map(po => (
                <TableRow
                  key={po.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/purchase-orders/${po.id}`)}
                >
                  <TableCell className="font-mono font-medium">
                    <div className="flex items-center gap-2">
                      {po.poNumber}
                      {po.priority === "rush" && <Badge variant="destructive" className="text-xs">Rush</Badge>}
                      {po.priority === "high" && <Badge variant="outline" className="text-xs text-orange-600 border-orange-300">High</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{po.vendor?.name || `Vendor #${po.vendorId}`}</TableCell>
                  <TableCell className="capitalize">{po.poType}</TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_BADGES[po.status]?.variant || "secondary"}
                      className={STATUS_BADGES[po.status]?.color || ""}
                    >
                      {STATUS_BADGES[po.status]?.label || po.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{po.lineCount || 0}</TableCell>
                  <TableCell className="text-right font-mono">{formatCents(po.totalCents)}</TableCell>
                  <TableCell>
                    {po.expectedDeliveryDate ? format(new Date(po.expectedDeliveryDate), "MMM d, yyyy") : "-"}
                  </TableCell>
                  <TableCell className="text-sm">{format(new Date(po.createdAt), "MMM d, yyyy")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Create PO Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Purchase Order</DialogTitle>
            <DialogDescription>Create a draft PO. You can add lines after creation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Vendor typeahead */}
            <div className="space-y-2">
              <Label>Vendor *</Label>
              <Popover open={vendorOpen} onOpenChange={setVendorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between h-10 font-normal"
                  >
                    {selectedVendor ? `${selectedVendor.code} — ${selectedVendor.name}` : "Select vendor..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search vendors..."
                      value={vendorSearch}
                      onValueChange={setVendorSearch}
                    />
                    <CommandList>
                      <CommandEmpty>No vendors found.</CommandEmpty>
                      <CommandGroup>
                        {filteredVendors.map(v => (
                          <CommandItem
                            key={v.id}
                            value={String(v.id)}
                            onSelect={() => {
                              setNewPO(prev => ({ ...prev, vendorId: v.id }));
                              setVendorOpen(false);
                              setVendorSearch("");
                            }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${newPO.vendorId === v.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="font-mono text-xs mr-2">{v.code}</span>
                            {v.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={newPO.poType} onValueChange={v => setNewPO(prev => ({ ...prev, poType: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="blanket">Blanket</SelectItem>
                    <SelectItem value="dropship">Dropship</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={newPO.priority} onValueChange={v => setNewPO(prev => ({ ...prev, priority: v }))}>
                  <SelectTrigger className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="rush">Rush</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Expected Delivery</Label>
              <Input
                type="date"
                value={newPO.expectedDeliveryDate}
                onChange={e => setNewPO(prev => ({ ...prev, expectedDeliveryDate: e.target.value }))}
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label>Vendor Notes</Label>
              <Textarea
                value={newPO.vendorNotes}
                onChange={e => setNewPO(prev => ({ ...prev, vendorNotes: e.target.value }))}
                placeholder="Notes printed on PO..."
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label>Internal Notes</Label>
              <Textarea
                value={newPO.internalNotes}
                onChange={e => setNewPO(prev => ({ ...prev, internalNotes: e.target.value }))}
                placeholder="Warehouse-only notes..."
                rows={2}
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate(newPO)}
                disabled={!newPO.vendorId || createMutation.isPending}
              >
                {createMutation.isPending ? "Creating..." : "Create Draft"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
