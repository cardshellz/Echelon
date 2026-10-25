import { shipmentListState } from "@/lib/shipment-list-navigation";
import { shipmentWarehouseOptionsSchema } from "@shared/procurement/shipment-create-source";
import { useShipmentCreation } from "@/hooks/use-shipment-creation";
import { ShipmentCreateRecovery } from "@/features/purchasing/ShipmentCreateRecovery";
import { shipmentCreateSchema, type ShipmentCreateInput } from "@shared/procurement/shipment-create-command";
import type { ShipmentCreateRecovery as ShipmentRecovery } from "@/lib/shipment-create-command";
import { shipmentWorkListPageSchema, SHIPMENT_LIST_PAGE_SIZE, type ShipmentWorkListItem, type ShipmentCostFilter } from "@shared/procurement/shipment-work-list";
import { landedCostHealthSchema, landedCostHealthHref, type LandedCostHealth } from "@shared/procurement/landed-cost-health";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { ShipmentPurchaseOrderLinks } from "@/features/purchasing/ShipmentPurchaseOrderLinks";
import { procurementChildHref } from "@/lib/procurement-navigation";
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
  AlertTriangle,
  CheckCircle2,
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

function formatCents(cents: number | bigint | null | undefined): string {
  const value = BigInt(cents ?? 0);
  const absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "-" : ""}$${(absolute / BigInt(100)).toLocaleString("en-US")}.${(absolute % BigInt(100)).toString().padStart(2, "0")}`;
}

type LandedCostPushResult = {
  updated: number;
  total: number;
  skipped?: Array<{
    lotId: number;
    productVariantId: number | null;
    reason: string;
    lineIds?: number[];
  }>;
};

type LandedCostFollowupFilter = ShipmentCostFilter;
type InboundShipment = ShipmentWorkListItem;

export default function InboundShipments() {
  const shipmentCreation = useShipmentCreation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const listSearch = useSearch();
  const listState = shipmentListState(listSearch);
  const { status: statusFilter, mode: modeFilter, costFilter: landedCostFilter, search: searchQuery, offset } = listState;
  function updateFilters(changes: Record<string, string | number>) {
    const params = new URLSearchParams(listSearch);
    for (const [key, value] of Object.entries(changes)) params.set(key, String(value));
    if (params.get("mode") === "all") params.delete("mode");
    navigate(`/shipments?${params}`, { replace: true });
  }
  const setOffset = (value: number) => updateFilters({ offset: value });
  const setStatusFilter = (value: string) => updateFilters({ status: value, offset: 0 });
  const setModeFilter = (value: string) => updateFilters({ mode: value, offset: 0 });
  const setLandedCostFilter = (value: LandedCostFollowupFilter) => updateFilters({ costFilter: value, offset: 0 });
  const setSearchQuery = (value: string) => updateFilters({ search: value, offset: 0 });
  const shipmentHref = (shipment: InboundShipment) => procurementChildHref("/shipments", listSearch,
    `/shipments/${shipment.id}?document=${encodeURIComponent(shipment.shipmentNumber)}`);

  // Create dialog
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newShipment, setNewShipment] = useState({
    shipmentNumber: "",
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
  const shipmentQuery = useQuery({
    queryKey: ["/api/inbound-shipments", statusFilter, modeFilter, searchQuery, landedCostFilter, offset],
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ status: statusFilter, costFilter: landedCostFilter,
        limit: String(SHIPMENT_LIST_PAGE_SIZE), offset: String(offset) });
      if (modeFilter !== "all") params.set("mode", modeFilter);
      if (searchQuery) params.set("search", searchQuery);
      const res = await fetch(`/api/inbound-shipments?${params}`, { credentials: "include", signal });
      if (!res.ok) throw new Error(`Shipments could not be loaded (HTTP ${res.status}).`);
      try { return shipmentWorkListPageSchema.parse(await res.json()); }
      catch { throw new Error("Shipment response is incomplete or invalid. Retry to verify the current work list."); }
    },
  });
  const shipmentData = shipmentQuery.isError ? undefined : shipmentQuery.data;

  const warehousesQuery = useQuery({
    queryKey: ["/api/warehouses", "shipment-create"], enabled: showCreateDialog, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/warehouses", { credentials: "include", signal });
      if (!res.ok) throw new Error("Warehouses could not be loaded.");
      try { return shipmentWarehouseOptionsSchema.parse(await res.json()); }
      catch { throw new Error("Warehouse options could not be verified."); }
    },
  });
  const warehouses = warehousesQuery.isError ? [] : warehousesQuery.data ?? [];

  const landedCostHealthQuery = useQuery<LandedCostHealth>({
    queryKey: ["/api/procurement/landed-cost-health"],
    queryFn: async () => {
      const res = await fetch("/api/procurement/landed-cost-health?limit=100", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch landed cost health");
      return landedCostHealthSchema.parse(await res.json());
    },
  });
  const landedCostHealth = landedCostHealthQuery.isError ? undefined : landedCostHealthQuery.data;

  const shipments = shipmentData?.shipments ?? [];
  const landedCostIssuesByShipment = new Map<number, LandedCostHealth["items"]>();
  for (const item of shipmentData?.costHealthItems ?? []) {
    const existing = landedCostIssuesByShipment.get(item.shipmentId) ?? [];
    existing.push(item);
    landedCostIssuesByShipment.set(item.shipmentId, existing);
  }

  // Stats
  const stats = {
    total: shipmentData?.total ?? 0,
    inTransit: shipments.filter(s => s.status === "in_transit").length,
    atPortCustoms: shipments.filter(s => ["at_port", "customs_clearance"].includes(s.status)).length,
    deliveredCosting: shipments.filter(s => ["delivered", "costing"].includes(s.status)).length,
    estimatedTotal: shipments
      .filter(s => !["closed", "cancelled"].includes(s.status))
      .reduce((sum, s) => sum + BigInt(s.estimatedTotalCostCents ?? 0), BigInt(0)),
    actualTotal: shipments
      .filter(s => !["closed", "cancelled"].includes(s.status))
      .reduce((sum, s) => sum + BigInt(s.actualTotalCostCents ?? 0), BigInt(0)),
  };

  type ShipmentCreateSubmission = { body: ShipmentCreateInput; recovery?: ShipmentRecovery; visit: ReturnType<typeof shipmentCreation.captureVisit> };
  const createMutation = useMutation({
    retry: false,
    networkMode: "always",
    mutationFn: (submission: ShipmentCreateSubmission) => {
      if (!submission.visit.isCurrent()) throw new Error("The shipment creation view changed. Review the saved request before sending.");
      return shipmentCreation.execute(submission.body, submission.recovery);
    },
    onSuccess: (shipment, submission) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      const purchaseOrderId = submission.body.purchaseOrder?.purchaseOrderId;
      if (purchaseOrderId) {
        void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}/shipments`] });
        void queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}/shippable-lines`] });
      }
      if (!submission.visit.isCurrent()) return;
      setShowCreateDialog(false);
      setNewShipment({ shipmentNumber: "", mode: "sea_fcl", carrierName: "", forwarderName: "", originPort: "", destinationPort: "", warehouseId: 0, eta: "", notes: "" });
      toast({ title: "Shipment confirmed", description: `${shipment.shipmentNumber} is ready to open.` });
      navigate(`/shipments/${shipment.id}`);
    },
    onError: (error: Error, submission) => {
      if (submission.visit.isCurrent()) toast({ title: "Shipment creation needs attention", description: error.message, variant: "destructive" });
    },
  });
  const recoverShipmentCreation = (recovery: ShipmentRecovery) => createMutation.mutate({ body: recovery.body, recovery, visit: shipmentCreation.captureVisit() });
  const submitShipmentCreation = () => {
    try {
      if (warehousesQuery.isPending || warehousesQuery.isError) throw new Error("Load the available warehouses before creating a shipment.");
      const data = newShipment;
      const body = shipmentCreateSchema.parse({ shipmentNumber: data.shipmentNumber || undefined, mode: data.mode, carrierName: data.carrierName || undefined,
        forwarderName: data.forwarderName || undefined, originPort: data.originPort || undefined,
        destinationPort: data.destinationPort || undefined, warehouseId: data.warehouseId || undefined,
        eta: data.eta || undefined, notes: data.notes || undefined });
      createMutation.mutate({ body, visit: shipmentCreation.captureVisit() });
    } catch (error) { toast({ title: "Review shipment details", description: error instanceof Error ? error.message : "Invalid shipment details", variant: "destructive" }); }
  };

  const pushCostsToLotsMutation = useMutation({
    mutationFn: async (shipmentId: number): Promise<LandedCostPushResult> => {
      const res = await fetch(`/api/inbound-shipments/${shipmentId}/push-costs-to-lots`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to push landed costs");
      }
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/procurement/landed-cost-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inbound-shipments"] });
      const skippedCount = result.skipped?.length ?? 0;
      toast({
        title: skippedCount > 0 ? "Landed cost push needs review" : "Landed costs pushed",
        description:
          skippedCount > 0
            ? `${result.updated} lot${result.updated === 1 ? "" : "s"} updated, ${skippedCount} skipped`
            : `${result.updated} lot${result.updated === 1 ? "" : "s"} updated`,
        variant: skippedCount > 0 ? "destructive" : "default",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function renderModeBadge(mode: string | null) {
    if (!mode) return <span className="text-muted-foreground">Not recorded</span>;
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

  function renderHealthType(type: string) {
    return type.replace(/_/g, " ");
  }

  // Status filter buttons
  const statusOptions = [
    { value: "active", label: "Not cancelled" },
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
  const landedCostFilterOptions: Array<{ value: LandedCostFollowupFilter; label: string }> = [
    { value: "all", label: "All costs" }, { value: "any", label: "Any Follow-Up" },
    { value: "critical", label: "Critical" }, { value: "warning", label: "Warnings" },
    { value: "allocation", label: "Allocation" }, { value: "needs_finalize", label: "Needs Finalize" },
    { value: "ready_to_push", label: "Ready To Push" }, { value: "stale_provisional", label: "Stale Provisional" },
  ];

  function renderLandedCostFollowupBadges(shipmentId: number) {
    const issues = landedCostIssuesByShipment.get(shipmentId) ?? [];
    if (issues.length === 0) return null;
    const primary = issues[0];
    return (
      <div className="flex flex-wrap gap-1">
        <Badge variant={primary.severity === "critical" ? "destructive" : "outline"} className="text-[10px]">
          {renderHealthType(primary.type)}
        </Badge>
        {issues.length > 1 && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            +{issues.length - 1}
          </Badge>
        )}
      </div>
    );
  }

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

      {shipmentQuery.isError && <div role="alert" className="rounded-md border border-destructive p-4 space-y-2">
        <p>{shipmentQuery.error.message}</p>
        <Button variant="outline" disabled={shipmentQuery.isFetching} onClick={() => void shipmentQuery.refetch()}>Retry shipments</Button>
      </div>}
      {shipmentQuery.isPending && <p role="status">Loading shipments…</p>}
      {shipmentQuery.isFetching && !shipmentQuery.isPending && !shipmentQuery.isError && <p role="status">Refreshing shipments…</p>}
      {/* The matching total is complete. Other summaries deliberately describe only this page. */}
      {shipmentData && <>
      <p className="text-sm text-muted-foreground">Shipment total matches all filters. Status counts and open-shipment costs below cover this page only.</p>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">{stats.total}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Matching Shipments</div>
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
            <div className="text-xs md:text-sm text-muted-foreground">Est. Cost · This Page</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold text-green-600">{formatCents(stats.actualTotal)}</div>
            <div className="text-xs md:text-sm text-muted-foreground">Actual Cost · This Page</div>
          </CardContent>
        </Card>
      </div>

      </>}

      {(landedCostHealthQuery.isPending || landedCostHealthQuery.isError) && (
        <Card role="region" aria-label="Landed Cost Health">
          <CardContent className="p-4 space-y-2">
            <h2 className="font-semibold">Landed Cost Health</h2>
            {landedCostHealthQuery.isError ? <>
              <p role="alert">Landed cost health is unavailable. Retry to verify current cost evidence.</p>
              <Button variant="outline" size="sm" disabled={landedCostHealthQuery.isFetching}
                onClick={() => void landedCostHealthQuery.refetch()}>Retry cost health</Button>
            </> : <p role="status">Loading landed cost health…</p>}
          </CardContent>
        </Card>
      )}

      {landedCostHealth && (
        <Card role="region" aria-label="Landed Cost Health" className={landedCostHealth.status === "critical" ? "border-red-300" : landedCostHealth.status === "warning" ? "border-amber-300" : "border-emerald-300"}>
          <CardContent className="p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {landedCostHealth.status === "healthy" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                ) : (
                  <AlertTriangle className={`h-4 w-4 ${landedCostHealth.status === "critical" ? "text-red-600" : "text-amber-600"}`} />
                )}
                <span className="font-semibold">Landed Cost Health</span>
                <Badge variant={landedCostHealth.status === "healthy" ? "outline" : "destructive"}>
                  {landedCostHealth.status}
                </Badge>
              </div>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>{landedCostHealth.scannedShipments} shipments checked</span>
                <span>{landedCostHealth.critical} critical</span>
                <span>{landedCostHealth.warning} warnings</span>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Allocation Blockers</div>
                <div className="font-mono">{landedCostHealth.counts.allocationBlockers}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Allocation Warnings</div>
                <div className="font-mono">{landedCostHealth.counts.allocationWarnings}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Needs Finalize</div>
                <div className="font-mono">{landedCostHealth.counts.pendingFinalization}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Ready To Push</div>
                <div className="font-mono">{landedCostHealth.counts.finalizedNotPushed}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Stale Provisional Lots</div>
                <div className="font-mono">{landedCostHealth.counts.staleProvisionalLots}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Posting Review</div>
                <div className="font-mono">{landedCostHealth.counts.postingReviewRequired}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Other Provisional Costs</div>
                <div className="font-mono">{landedCostHealth.counts.provisionalOtherCosts}</div>
              </div>
            </div>

            {landedCostHealth.items.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={landedCostFilter === "critical" ? "default" : "outline"} onClick={() => setLandedCostFilter("critical")}>
                  Critical
                </Button>
                <Button size="sm" variant={landedCostFilter === "warning" ? "default" : "outline"} onClick={() => setLandedCostFilter("warning")}>
                  Warnings
                </Button>
                <Button size="sm" variant={landedCostFilter === "ready_to_push" ? "default" : "outline"} onClick={() => setLandedCostFilter("ready_to_push")}>
                  Ready To Push
                </Button>
                <Button size="sm" variant={landedCostFilter === "all" ? "ghost" : "outline"} onClick={() => setLandedCostFilter("all")}>
                  Clear Filter
                </Button>
              </div>
            )}

            {landedCostHealth.items.length > 0 && (
              <div className="space-y-2">
                {landedCostHealth.items.slice(0, 5).map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <Badge variant={item.severity === "critical" ? "destructive" : "outline"}>{item.severity}</Badge>
                    <span className="font-mono">{item.shipmentNumber || `#${item.shipmentId}`}</span>
                    <span>{renderHealthType(item.type)}</span>
                    <span className="text-muted-foreground flex-1 min-w-[220px]">{item.detail}</span>
                    <div className="ml-auto flex gap-2">
                      {item.action === "push_costs_to_lots" && (
                        <Button
                          size="sm"
                          onClick={() => pushCostsToLotsMutation.mutate(item.shipmentId)}
                          disabled={pushCostsToLotsMutation.isPending}
                        >
                          {pushCostsToLotsMutation.isPending ? "Pushing..." : "Push Costs"}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(landedCostHealthHref(item))}
                      >
                        Review
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search shipment, PO, SKU, carrier or container..."
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
        {(
          <div className="flex gap-1 flex-wrap" aria-label="Shipment cost filters">
            {landedCostFilterOptions.map((opt) => (
              <Button
                key={opt.value}
                variant={landedCostFilter === opt.value ? "default" : "outline"}
                size="sm"
                onClick={() => setLandedCostFilter(opt.value)}
                className="h-8 text-xs"
              >
                {opt.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      {shipmentData && <section aria-label="Shipment results" className="space-y-3">
      <nav aria-label="Shipment pages" className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm">{shipments.length > 0
          ? `Showing ${offset + 1}–${offset + shipments.length} of ${shipmentData.total} matching shipments`
          : `${shipmentData.total} matching shipments${offset > 0 ? "; this page is now empty" : ""}`}</p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={offset === 0 || shipmentQuery.isFetching}
            onClick={() => setOffset(Math.max(0, offset - SHIPMENT_LIST_PAGE_SIZE))}>Previous shipments</Button>
          <Button variant="outline" disabled={!shipmentData.hasMore || shipmentQuery.isFetching}
            onClick={() => setOffset(offset + SHIPMENT_LIST_PAGE_SIZE)}>Next shipments</Button>
        </div>
      </nav>
      {/* Mobile Card View */}
      <div className="md:hidden space-y-3">
        {shipments.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-center text-muted-foreground">
              No inbound shipments match these filters.
            </CardContent>
          </Card>
        ) : (
          shipments.map(shipment => (
            <Card
              key={shipment.id}
              className="cursor-pointer active:bg-accent/50"
              onClick={() => navigate(shipmentHref(shipment))}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link href={shipmentHref(shipment)} onClick={event => event.stopPropagation()} className="font-mono font-medium text-sm text-primary hover:underline">{shipment.shipmentNumber}</Link>
                      <Badge
                        variant={STATUS_BADGES[shipment.status]?.variant || "secondary"}
                        className={`text-xs ${STATUS_BADGES[shipment.status]?.color || ""}`}
                      >
                        {STATUS_BADGES[shipment.status]?.label || shipment.status}
                      </Badge>
                      {renderModeBadge(shipment.mode)}
                      {renderLandedCostFollowupBadges(shipment.id)}
                    </div>
                    <div className="text-sm mt-1">{shipment.carrierName || "No carrier"}</div>
                    <div className="mt-1 text-sm" data-testid={`shipment-purchases-${shipment.id}`}>
                      <ShipmentPurchaseOrderLinks
                        purchaseOrders={shipment.purchaseOrders}
                        hrefFor={(id, poNumber) => procurementChildHref("/shipments", listSearch, `/purchase-orders/${id}?tab=shipments&poScope=${id}&document=${encodeURIComponent(poNumber)}`)}
                      />
                    </div>
                    <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                      <span>{renderRoute(shipment)}</span>
                      {shipment.containerNumber && <span>#{shipment.containerNumber}</span>}
                    </div>
                    <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                      {shipment.eta && <span>ETA {format(new Date(shipment.eta), "MMM d, yyyy")}</span>}
                      <span>Est. {formatCents(shipment.estimatedTotalCostCents)}</span>
                      <span>Act. {formatCents(shipment.actualTotalCostCents)}</span>
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
              <TableHead>Purchase orders</TableHead>
              <TableHead>Route</TableHead>
              <TableHead>ETA</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Landed Cost</TableHead>
              <TableHead className="text-right">Est. Cost</TableHead>
              <TableHead className="text-right">Actual Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shipments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                  No inbound shipments match these filters.
                </TableCell>
              </TableRow>
            ) : (
              shipments.map(shipment => (
                <TableRow
                  key={shipment.id}
                  className="cursor-pointer"
                  onClick={() => navigate(shipmentHref(shipment))}
                >
                  <TableCell className="font-mono font-medium"><Link href={shipmentHref(shipment)} onClick={event => event.stopPropagation()} className="text-primary hover:underline">{shipment.shipmentNumber}</Link></TableCell>
                  <TableCell>{renderModeBadge(shipment.mode)}</TableCell>
                  <TableCell>{shipment.carrierName || "—"}</TableCell>
                  <TableCell className="font-mono text-sm">{shipment.containerNumber || "—"}</TableCell>
                  <TableCell className="min-w-[10rem]" data-testid={`shipment-purchases-${shipment.id}`}>
                    <ShipmentPurchaseOrderLinks
                      purchaseOrders={shipment.purchaseOrders}
                      hrefFor={(id, poNumber) => procurementChildHref("/shipments", listSearch, `/purchase-orders/${id}?tab=shipments&poScope=${id}&document=${encodeURIComponent(poNumber)}`)}
                    />
                  </TableCell>
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
                  <TableCell>{renderLandedCostFollowupBadges(shipment.id) || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="text-right font-mono">{formatCents(shipment.estimatedTotalCostCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatCents(shipment.actualTotalCostCents)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      </section>}

      {/* Create Shipment Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto min-w-0 max-w-md">
          <DialogHeader>
            <DialogTitle>New Inbound Shipment</DialogTitle>
            <DialogDescription>Create a draft shipment. You can add PO lines after creation.</DialogDescription>
          </DialogHeader>
          <ShipmentCreateRecovery recovery={shipmentCreation.recovery} error={shipmentCreation.error} pending={createMutation.isPending} onRetry={recoverShipmentCreation} onRefresh={shipmentCreation.refresh} />
          <fieldset disabled={createMutation.isPending || !shipmentCreation.ready || !!shipmentCreation.recovery || !!shipmentCreation.error} className="space-y-4 min-w-0">
            {warehousesQuery.isPending && <p role="status">Loading available warehouses...</p>}
            {warehousesQuery.isError && <div role="alert">Warehouse options could not be loaded or verified. <Button type="button" variant="outline" onClick={() => void warehousesQuery.refetch()}>Retry warehouses</Button></div>}
            <div className="space-y-2">
              <Label htmlFor="create-shipment-number">Shipment number (optional)</Label>
              <Input id="create-shipment-number" value={newShipment.shipmentNumber} maxLength={30}
                onChange={event => setNewShipment(previous => ({ ...previous, shipmentNumber: event.target.value }))}
                placeholder="Generated automatically if blank" />
            </div>
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
                onClick={submitShipmentCreation}
                disabled={createMutation.isPending || warehousesQuery.isPending || warehousesQuery.isError}
              >
                {createMutation.isPending ? "Creating..." : "Create Draft"}
              </Button>
            </div>
          </fieldset>
        </DialogContent>
      </Dialog>
    </div>
  );
}
