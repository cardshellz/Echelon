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
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  Ship,
  Plane,
  Truck,
  Plus,
  Search,
  Package,
  DollarSign,
  Anchor,
} from "lucide-react";

// Status badge config
const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  booked: { variant: "default", label: "Booked", color: "bg-blue-500" },
  in_transit: { variant: "default", label: "In Transit", color: "bg-purple-500" },
  at_port: { variant: "outline", label: "At Port", color: "text-yellow-600 border-yellow-300" },
  customs_clearance: { variant: "outline", label: "Customs", color: "text-orange-600 border-orange-300" },
  delivered: { variant: "default", label: "Delivered", color: "bg-teal-500" },
  costing: { variant: "outline", label: "Costing", color: "text-amber-600 border-amber-300" },
  closed: { variant: "default", label: "Closed", color: "bg-green-600" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

// Mode config with icons and labels
const MODE_CONFIG: Record<string, { label: string; icon: typeof Ship }> = {
  sea_fcl: { label: "Sea FCL", icon: Ship },
  sea_lcl: { label: "Sea LCL", icon: Ship },
  air: { label: "Air", icon: Plane },
  ground: { label: "Ground", icon: Truck },
  ltl: { label: "LTL", icon: Truck },
  ftl: { label: "FTL", icon: Truck },
  parcel: { label: "Parcel", icon: Package },
  courier: { label: "Courier", icon: Truck },
};

function formatCents(cents: number | null | undefined): string {
  if (!cents) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type Warehouse = { id: number; code: string; name: string };
type InboundShipment = {
  id: number;
  shipmentNumber: string;
  mode: string;
  status: string;
  carrierName: string | null;
  forwarderName: string | null;
  containerNumber: string | null;
  originPort: string | null;
  destinationPort: string | null;
  originCountry: string | null;
  destinationCountry: string | null;
  warehouseId: number | null;
  eta: string | null;
  estimatedCostCents: number | null;
  actualCostCents: number | null;
  lineCount: number;
  notes: string | null;
  createdAt: string;
};

export default function InboundShipments() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newShipment, setNewShipment] = useState({
    mode: "sea_fcl",
    carrierName: "",
    forwarderName: "",
    originPort: "",
    destinationPort: "",
    warehouseId: 0,
    eta: "",
    notes: "",
  });

  // Queries
  const { data: shipmentData } = useQuery<{ shipments: InboundShipment[]; total: number }>({
    queryKey: ["/api/inbound-shipments", statusFilter, modeFilter, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (modeFilter !== "all") params.set("mode", modeFilter);
      if (searchQuery) params.set("search", searchQuery);
      params.set("limit", "100");
      const res = await fetch(`/api/inbound-shipments?${params}`);
      if (!res.ok) throw new Error("Failed to fetch shipments");
      return res.json();
    },
  });

  const { data: warehouses = [] } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
    queryFn: async () => {
      const res = await fetch("/api/warehouses", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warehouses");
      return res.json();
    },
  });

  const shipments = shipmentData?.shipments ?? [];

  // Stats
  const stats = {
    total: shipmentData?.total ?? 0,
    inTransit: shipments.filter(s => s.status === "in_transit").length,
    atPortCustoms: shipments.filter(s => ["at_port", "customs_clearance"].includes(s.status)).length,
    deliveredCosting: shipments.filter(s => ["delivered", "costing"].includes(s.status)).length,
    estimatedTotal: shipments
      .filter(s => !["closed", "cancelled"].includes(s.status))
      .reduce((sum, s) => sum + (Number(s.estimatedCostCents) || 0), 0),
    actualTotal: shipments
      .filter(s => !["closed", "cancelled"].includes(s.status))
      .reduce((sum, s) => sum + (Number(s.actualCostCents) || 0), 0),
  };

  // Create mutation
  const createMutation = useMutation({
    mutationFn: async (data: typeof newShipment) => {
      const res = await fetch("/api/inbound-shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: data.mode,
          carrierName: data.carrierName || undefined,
          forwarderName: data.forwarderName || undefined,
          originPort: data.originPort || undefined,
          destinationPort: data.destinationPort || undefined,
          warehouseId: data.warehouseId || undefined,
          eta: data.eta || undefined,
          notes: data.notes || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create shipment");
      }
      return res.json();
    },
    onSuccess: (shipment) => {
      queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      setShowCreateDialog(false);
      setNewShipment({ mode: "sea_fcl", carrierName: "", forwarderName: "", originPort: "", destinationPort: "", warehouseId: 0, eta: "", notes: "" });
      toast({ title: "Shipment created", description: `${shipment.shipmentNumber} created as draft` });
      navigate(`/shipments/${shipment.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function renderModeBadge(mode: string) {
    const config = MODE_CONFIG[mode];
    if (!config) return <Badge variant="secondary">{mode}</Badge>;
    const Icon = config.icon;
    return (
      <Badge variant="outline" className="gap-1">
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
    );
  }

  function renderRoute(shipment: InboundShipment) {
    const origin = shipment.originPort || shipment.originCountry;
    const dest = shipment.destinationPort || shipment.destinationCountry;
    if (!origin && !dest) return "—";
    if (!origin) return dest;
    if (!dest) return origin;
    return `${origin} → ${dest}`;
  }

  // Status filter buttons
  const statusOptions = [
    { value: "all", label: "All" },
    { value: "draft", label: "Draft" },
    { value: "booked", label: "Booked" },
    { value: "in_transit", label: "In Transit" },
    { value: "at_port", label: "At Port" },
    { value: "customs_clearance", label: "Customs" },
    { value: "delivered", label: "Delivered" },
    { value: "costing", label: "Costing" },
    { value: "closed", label: "Closed" },
    { value: "cancelled", label: "Cancelled" },
  ];

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Anchor className="h-5 w-5 md:h-6 md:w-6" />
            Inbound Shipments
          </h1>
          <p className="text-sm text-muted-foreground">
            Track and manage inbound freight shipments
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="min-h-[44px] w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          New Shipment
        </Button>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Total Shipments</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-purple-600">{stats.inTransit}</div>
            <div className="text-xs md:text-sm text-muted-foreground">In Transit</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-orange-600">{stats.atPortCustoms}</div>
            <div className="text-xs md:text-sm text-muted-foreground">At Port / Customs</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-teal-600">{stats.deliveredCosting}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Delivered / Costing</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-blue-600">{formatCents(stats.estimatedTotal)}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Est. Total</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">{formatCents(stats.actualTotal)}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Actual Total</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search shipment #, carrier, container #..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-9 h-10"
            />
          </div>
          <Select value={modeFilter} onValueChange={setModeFilter}>
            <SelectTrigger className="w-full sm:w-44 h-10">
              <SelectValue placeholder="Mode" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Modes</SelectItem>
              <SelectItem value="sea_fcl">Sea FCL</SelectItem>
              <SelectItem value="sea_lcl">Sea LCL</SelectItem>
              <SelectItem value="air">Air</SelectItem>
              <SelectItem value="ground">Ground</SelectItem>
              <SelectItem value="ltl">LTL</SelectItem>
              <SelectItem value="ftl">FTL</SelectItem>
              <SelectItem value="parcel">Parcel</SelectItem>
              <SelectItem value="courier">Courier</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* Status filter buttons */}
        <div className="flex gap-1 flex-wrap">
          {statusOptions.map(opt => (
            <Button
              key={opt.value}
              variant={statusFilter === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => setStatusFilter(opt.value)}
              className="h-8 text-xs"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden space-y-3">
        {shipments.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              No inbound shipments found.
            </CardContent>
          </Card>
        ) : (
          shipments.map(shipment => (
            <Card
              key={shipment.id}
              className="cursor-pointer active:bg-accent/50"
              onClick={() => navigate(`/shipments/${shipment.id}`)}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-medium text-sm">{shipment.shipmentNumber}</span>
                      <Badge
                        variant={STATUS_BADGES[shipment.status]?.variant || "secondary"}
                        className={`text-xs ${STATUS_BADGES[shipment.status]?.color || ""}`}
                      >
                        {STATUS_BADGES[shipment.status]?.label || shipment.status}
                      </Badge>
                      {renderModeBadge(shipment.mode)}
                    </div>
                    <div className="text-sm mt-1">{shipment.carrierName || "No carrier"}</div>
                    <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                      <span>{renderRoute(shipment)}</span>
                      {shipment.containerNumber && <span>#{shipment.containerNumber}</span>}
                    </div>
                    <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                      {shipment.eta && <span>ETA {format(new Date(shipment.eta), "MMM d, yyyy")}</span>}
                      <span>Est. {formatCents(shipment.estimatedCostCents)}</span>
                      <span>Act. {formatCents(shipment.actualCostCents)}</span>
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
              <TableHead>Shipment #</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Container #</TableHead>
              <TableHead className="text-right">POs</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>ETA</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Est. Cost</TableHead>
              <TableHead className="text-right">Actual Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shipments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  No inbound shipments found. Click "New Shipment" to create one.
                </TableCell>
              </TableRow>
            ) : (
              shipments.map(shipment => (
                <TableRow
                  key={shipment.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/shipments/${shipment.id}`)}
                >
                  <TableCell className="font-mono font-medium">{shipment.shipmentNumber}</TableCell>
                  <TableCell>{renderModeBadge(shipment.mode)}</TableCell>
                  <TableCell>{shipment.carrierName || "—"}</TableCell>
                  <TableCell className="font-mono text-sm">{shipment.containerNumber || "—"}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-sm">{renderRoute(shipment)}</TableCell>
                  <TableCell>
                    {shipment.eta ? format(new Date(shipment.eta), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={STATUS_BADGES[shipment.status]?.variant || "secondary"}
                      className={STATUS_BADGES[shipment.status]?.color || ""}
                    >
                      {STATUS_BADGES[shipment.status]?.label || shipment.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatCents(shipment.estimatedCostCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatCents(shipment.actualCostCents)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Create Shipment Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Inbound Shipment</DialogTitle>
            <DialogDescription>Create a draft shipment. You can add PO lines after creation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Mode *</Label>
              <Select value={newShipment.mode} onValueChange={v => setNewShipment(prev => ({ ...prev, mode: v }))}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sea_fcl">Sea FCL</SelectItem>
                  <SelectItem value="sea_lcl">Sea LCL</SelectItem>
                  <SelectItem value="air">Air</SelectItem>
                  <SelectItem value="ground">Ground</SelectItem>
                  <SelectItem value="ltl">LTL</SelectItem>
                  <SelectItem value="ftl">FTL</SelectItem>
                  <SelectItem value="parcel">Parcel</SelectItem>
                  <SelectItem value="courier">Courier</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Carrier Name</Label>
                <Input
                  value={newShipment.carrierName}
                  onChange={e => setNewShipment(prev => ({ ...prev, carrierName: e.target.value }))}
                  placeholder="e.g. Maersk"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Forwarder Name</Label>
                <Input
                  value={newShipment.forwarderName}
                  onChange={e => setNewShipment(prev => ({ ...prev, forwarderName: e.target.value }))}
                  placeholder="e.g. Flexport"
                  className="h-10"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Origin Port</Label>
                <Input
                  value={newShipment.originPort}
                  onChange={e => setNewShipment(prev => ({ ...prev, originPort: e.target.value }))}
                  placeholder="e.g. Shanghai"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Destination Port</Label>
                <Input
                  value={newShipment.destinationPort}
                  onChange={e => setNewShipment(prev => ({ ...prev, destinationPort: e.target.value }))}
                  placeholder="e.g. Los Angeles"
                  className="h-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Warehouse</Label>
              <Select
                value={newShipment.warehouseId ? String(newShipment.warehouseId) : ""}
                onValueChange={v => setNewShipment(prev => ({ ...prev, warehouseId: Number(v) }))}
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Select warehouse..." />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map(wh => (
                    <SelectItem key={wh.id} value={String(wh.id)}>
                      {wh.code} — {wh.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>ETA</Label>
              <Input
                type="date"
                value={newShipment.eta}
                onChange={e => setNewShipment(prev => ({ ...prev, eta: e.target.value }))}
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={newShipment.notes}
                onChange={e => setNewShipment(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Shipment notes..."
                rows={3}
              />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate(newShipment)}
                disabled={createMutation.isPending}
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
