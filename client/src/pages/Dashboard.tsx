import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowRight,
  Package,
  ShoppingCart,
  Truck,
  DollarSign,
  Activity,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  X,
  Warehouse,
  FileText,
  Clock,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Calendar,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { DateRangePicker, type DateRangeValue } from "@/components/DateRangePicker";

interface SyncHealth {
  lastSuccessfulSync: string | null;
  lastSyncAttempt: string | null;
  lastSyncError: string | null;
  consecutiveErrors: number;
  minutesSinceLastSync: number | null;
  status: "healthy" | "stale" | "error";
  latestShopifyOrder: string | null;
  latestSyncedOrder: string | null;
  syncGapMinutes: number | null;
  unsynced24h: number;
  needsAlert: boolean;
  alertMessage: string | null;
}

interface DashboardData {
  generatedAt: string;
  orderPipeline: {
    total: number;
    byStatus: Record<string, number>;
    stuckOrders: number;
    avgAgeHours: number;
    oldestUnshippedHours: number;
  };
  shipmentHealth: {
    total: number;
    byStatus: Record<string, number>;
    unpushed: number;
    requiresReview: number;
    onHold: number;
    shippedInRange: number;
  };
  inventoryHealth: {
    totalSkus: number;
    totalOnHand: number;
    totalReserved: number;
    totalAvailable: number;
    lowStockSkus: number;
    outOfStockSkus: number;
    overstockSkus: number;
    negativeInventory: number;
  };
  procurementPipeline: {
    openPoCount: number;
    openPoValue: number;
    draftPoCount: number;
    overduePoCount: number;
    inTransitShipments: number;
    expectedReceiptsNext30Days: number;
  };
  financialKpis: {
    inventoryValueCents: number;
    openPoValueCents: number;
    pendingApCents: number;
    revenueCents: number;
    orderCount: number;
    avgOrderValueCents: number;
  };
  webhookHealth: {
    pendingRetries: number;
    deadLetters: number;
    failedInbox: number;
    staleRetries: number;
  };
  forwardDemand: {
    activeEvents: number;
    plannedEvents: number;
    totalForwardDemandPieces: number;
    productsWithForwardDemand: number;
  };
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function StatusBadge({ value, thresholds }: { value: number; thresholds: { warn: number; critical: number } }) {
  if (value >= thresholds.critical) {
    return <Badge variant="destructive">{value}</Badge>;
  }
  if (value >= thresholds.warn) {
    return <Badge variant="outline" className="border-yellow-500 text-yellow-600">{value}</Badge>;
  }
  return <Badge variant="secondary">{value}</Badge>;
}

function KpiCard({ title, value, subtitle, icon: Icon, onClick, alert }: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ElementType;
  onClick?: () => void;
  alert?: boolean;
}) {
  return (
    <Card className={`cursor-pointer hover:shadow-md transition-shadow ${alert ? "border-red-200 bg-red-50/30" : ""}`}
          onClick={onClick}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className={`text-2xl font-bold ${alert ? "text-red-600" : ""}`}>{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <Icon className={`h-8 w-8 ${alert ? "text-red-400" : "text-muted-foreground/30"}`} />
        </div>
      </CardContent>
    </Card>
  );
}

function PipelineBar({ data }: { data: Record<string, number> }) {
  const total = Object.values(data).reduce((s, v) => s + v, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">No active orders</p>;

  const colors: Record<string, string> = {
    ready: "bg-blue-400",
    in_progress: "bg-blue-500",
    picking: "bg-indigo-400",
    picked: "bg-indigo-500",
    packing: "bg-violet-400",
    packed: "bg-violet-500",
    completed: "bg-green-400",
    ready_to_ship: "bg-emerald-400",
    partially_shipped: "bg-teal-400",
    on_hold: "bg-yellow-400",
    exception: "bg-red-400",
    awaiting_3pl: "bg-orange-400",
  };

  return (
    <div>
      <div className="flex h-4 rounded-full overflow-hidden mb-2">
        {Object.entries(data).map(([status, count]) => (
          <div
            key={status}
            className={`${colors[status] || "bg-gray-300"}`}
            style={{ width: `${(count / total) * 100}%` }}
            title={`${status}: ${count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(data)
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([status, count]) => (
            <span key={status} className="text-xs text-muted-foreground">
              <span className={`inline-block w-2 h-2 rounded-full mr-1 ${colors[status] || "bg-gray-300"}`} />
              {status.replace(/_/g, " ")}: {count}
            </span>
          ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [alertDismissed, setAlertDismissed] = React.useState(false);
  const [dateRange, setDateRange] = React.useState<DateRangeValue>({
    from: new Date(),
    to: new Date(),
  });

  const fromStr = format(dateRange.from, "yyyy-MM-dd");
  const toStr = format(dateRange.to, "yyyy-MM-dd");

  const { data: syncHealth } = useQuery<SyncHealth>({
    queryKey: ["/api/sync/health"],
    refetchInterval: 60000,
  });

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/enterprise/dashboard", fromStr, toStr],
    queryFn: async () => {
      const res = await fetch(`/api/enterprise/dashboard?from=${fromStr}&to=${toStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load dashboard");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const triggerSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sync/recover-orders", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to recover orders");
      return res.json();
    },
    onSuccess: (data: any) => {
      const stages = data?.stages ?? [];
      const parts: string[] = [];
      const errors: string[] = [];
      for (const s of stages) {
        if (s.error) { errors.push(`${s.name}: ${s.error}`); continue; }
        if (!s.data) continue;
        if (s.name === "shopify_reconcile" && s.data.reconciled > 0) parts.push(`${s.data.reconciled} from Shopify`);
        if (s.name === "shopify_to_oms" && s.data.bridged > 0) parts.push(`${s.data.bridged} to OMS`);
        if (s.name === "oms_to_wms" && s.data.synced > 0) parts.push(`${s.data.synced} to WMS`);
      }
      const description = parts.length > 0 ? parts.join(" • ") : "No missing orders found.";
      if (errors.length > 0) {
        toast({ title: "Sync completed with warnings", description: `${description} — errors: ${errors.join("; ")}`, variant: "destructive" });
      } else {
        toast({ title: "Sync complete", description });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/sync/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/enterprise/dashboard"] });
    },
    onError: (error) => {
      toast({ title: "Sync failed", description: String(error), variant: "destructive" });
    },
  });

  const showSyncAlert = syncHealth?.needsAlert && !alertDismissed;

  const orderPipeline = data?.orderPipeline;
  const shipmentHealth = data?.shipmentHealth;
  const inventoryHealth = data?.inventoryHealth;
  const procurementPipeline = data?.procurementPipeline;
  const financialKpis = data?.financialKpis;
  const webhookHealth = data?.webhookHealth;
  const forwardDemand = data?.forwardDemand;

  const hasIssues = data && (
    (orderPipeline?.stuckOrders ?? 0) > 0 ||
    (shipmentHealth?.unpushed ?? 0) > 0 ||
    (shipmentHealth?.requiresReview ?? 0) > 0 ||
    (inventoryHealth?.negativeInventory ?? 0) > 0 ||
    (webhookHealth?.deadLetters ?? 0) > 0 ||
    (procurementPipeline?.overduePoCount ?? 0) > 0
  );

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6 max-w-[1600px] mx-auto">
      {/* Sync Alert Banner */}
      {showSyncAlert && (
        <Alert variant="destructive" className="border-red-500 bg-red-50 dark:bg-red-950/20">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="flex items-center justify-between">
            <span>Order Sync Alert</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => triggerSyncMutation.mutate()}
                disabled={triggerSyncMutation.isPending}
                className="h-7"
                data-testid="button-sync-now"
              >
                {triggerSyncMutation.isPending ? (
                  <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3 mr-1" />
                )}
                Sync Now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAlertDismissed(true)}
                className="h-7 w-7 p-0"
                data-testid="button-dismiss-sync-alert"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </AlertTitle>
          <AlertDescription>
            {syncHealth?.alertMessage || "Orders may not be syncing properly."}
            {syncHealth?.unsynced24h > 0 && (
              <span className="ml-2 font-medium">
                ({syncHealth.unsynced24h} orders pending)
              </span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            {data
              ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}`
              : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasIssues && (
            <Badge variant="destructive" className="text-sm px-3 py-1">
              <AlertTriangle className="h-4 w-4 mr-1" />
              Issues Detected
            </Badge>
          )}
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      {/* Top KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-4">
        <KpiCard
          title="Orders"
          value={isLoading ? "—" : formatNumber(financialKpis?.orderCount ?? 0)}
          subtitle={financialKpis?.avgOrderValueCents ? `avg ${formatCents(financialKpis.avgOrderValueCents)}` : undefined}
          icon={ShoppingCart}
          onClick={() => navigate("/orders")}
        />
        <KpiCard
          title="Revenue"
          value={isLoading ? "—" : formatCents(financialKpis?.revenueCents ?? 0)}
          icon={DollarSign}
        />
        <KpiCard
          title="Shipped"
          value={isLoading ? "—" : formatNumber(shipmentHealth?.shippedInRange ?? 0)}
          icon={Truck}
          onClick={() => navigate("/orders")}
        />
        <KpiCard
          title="Low Stock SKUs"
          value={isLoading ? "—" : (inventoryHealth?.lowStockSkus ?? 0)}
          icon={AlertCircle}
          alert={(inventoryHealth?.lowStockSkus ?? 0) > 0}
          onClick={() => navigate("/inventory")}
        />
        <KpiCard
          title="Inventory Value"
          value={isLoading ? "—" : formatCents(financialKpis?.inventoryValueCents ?? 0)}
          icon={Warehouse}
          onClick={() => navigate("/inventory/costs")}
        />
        <KpiCard
          title="Open PO Value"
          value={isLoading ? "—" : formatCents(financialKpis?.openPoValueCents ?? 0)}
          subtitle={procurementPipeline ? `${procurementPipeline.openPoCount} open POs` : undefined}
          icon={FileText}
          onClick={() => navigate("/purchase-orders")}
        />
      </div>

      {/* Tabbed Sections */}
      <Tabs defaultValue="operations" className="space-y-4">
        <TabsList>
          <TabsTrigger value="operations">Operations</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="procurement">Procurement</TabsTrigger>
          <TabsTrigger value="system">System Health</TabsTrigger>
        </TabsList>

        {/* Operations Tab */}
        <TabsContent value="operations" className="space-y-4">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">Order Pipeline</CardTitle>
                    <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>
                      View All <ArrowRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                  <CardDescription>{orderPipeline?.total ?? 0} active orders</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <PipelineBar data={orderPipeline?.byStatus ?? {}} />
                  <div className="grid grid-cols-3 gap-4 pt-2">
                    <div>
                      <p className="text-xs text-muted-foreground">Stuck ({">"}48h)</p>
                      <p className="text-lg font-semibold">
                        <StatusBadge value={orderPipeline?.stuckOrders ?? 0} thresholds={{ warn: 1, critical: 5 }} />
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Avg Age</p>
                      <p className="text-lg font-semibold">{orderPipeline?.avgAgeHours ?? 0}h</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Oldest</p>
                      <p className="text-lg font-semibold">{orderPipeline?.oldestUnshippedHours ?? 0}h</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">Shipment Health</CardTitle>
                    <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>
                      View All <ArrowRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                  <CardDescription>{shipmentHealth?.total ?? 0} total shipments</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Unpushed</span>
                        <StatusBadge value={shipmentHealth?.unpushed ?? 0} thresholds={{ warn: 1, critical: 5 }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Requires Review</span>
                        <StatusBadge value={shipmentHealth?.requiresReview ?? 0} thresholds={{ warn: 1, critical: 3 }} />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">On Hold</span>
                        <StatusBadge value={shipmentHealth?.onHold ?? 0} thresholds={{ warn: 1, critical: 5 }} />
                      </div>
                    </div>
                    <div className="space-y-3">
                      {Object.entries(shipmentHealth?.byStatus ?? {})
                        .filter(([, count]) => count > 0)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([status, count]) => (
                          <div key={status} className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">{status.replace(/_/g, " ")}</span>
                            <span className="text-sm font-medium">{count}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* Inventory Tab */}
        <TabsContent value="inventory" className="space-y-4">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <>
              <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
                <KpiCard
                  title="Total SKUs"
                  value={formatNumber(inventoryHealth?.totalSkus ?? 0)}
                  icon={Package}
                  onClick={() => navigate("/inventory")}
                />
                <KpiCard
                  title="On Hand"
                  value={formatNumber(inventoryHealth?.totalOnHand ?? 0)}
                  subtitle={`${formatNumber(inventoryHealth?.totalReserved ?? 0)} reserved`}
                  icon={Warehouse}
                />
                <KpiCard
                  title="Available"
                  value={formatNumber(inventoryHealth?.totalAvailable ?? 0)}
                  icon={CheckCircle2}
                />
                <KpiCard
                  title="Negative Inventory"
                  value={inventoryHealth?.negativeInventory ?? 0}
                  icon={XCircle}
                  alert={(inventoryHealth?.negativeInventory ?? 0) > 0}
                  onClick={() => navigate("/inventory")}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3">
                      <AlertTriangle className={`h-8 w-8 ${(inventoryHealth?.outOfStockSkus ?? 0) > 0 ? "text-red-500" : "text-muted-foreground/30"}`} />
                      <div>
                        <p className="text-2xl font-bold">{inventoryHealth?.outOfStockSkus ?? 0}</p>
                        <p className="text-sm text-muted-foreground">Out of Stock SKUs</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3">
                      <AlertCircle className={`h-8 w-8 ${(inventoryHealth?.lowStockSkus ?? 0) > 0 ? "text-yellow-500" : "text-muted-foreground/30"}`} />
                      <div>
                        <p className="text-2xl font-bold">{inventoryHealth?.lowStockSkus ?? 0}</p>
                        <p className="text-sm text-muted-foreground">Low Stock SKUs ({"<"}5)</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center gap-3">
                      <TrendingUp className="h-8 w-8 text-muted-foreground/30" />
                      <div>
                        <p className="text-2xl font-bold">{inventoryHealth?.overstockSkus ?? 0}</p>
                        <p className="text-sm text-muted-foreground">Overstock SKUs ({">"}100)</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </TabsContent>

        {/* Procurement Tab */}
        <TabsContent value="procurement" className="space-y-4">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <>
              <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
                <KpiCard
                  title="Open POs"
                  value={procurementPipeline?.openPoCount ?? 0}
                  subtitle={formatCents(procurementPipeline?.openPoValue ?? 0)}
                  icon={FileText}
                  onClick={() => navigate("/purchase-orders")}
                />
                <KpiCard
                  title="Draft POs"
                  value={procurementPipeline?.draftPoCount ?? 0}
                  icon={FileText}
                  onClick={() => navigate("/purchase-orders")}
                />
                <KpiCard
                  title="Overdue POs"
                  value={procurementPipeline?.overduePoCount ?? 0}
                  icon={Clock}
                  alert={(procurementPipeline?.overduePoCount ?? 0) > 0}
                  onClick={() => navigate("/purchase-orders")}
                />
                <KpiCard
                  title="In Transit"
                  value={procurementPipeline?.inTransitShipments ?? 0}
                  icon={Truck}
                  onClick={() => navigate("/shipments")}
                />
                <KpiCard
                  title="Expected (30d)"
                  value={procurementPipeline?.expectedReceiptsNext30Days ?? 0}
                  subtitle="receipts expected"
                  icon={Calendar}
                />
                <KpiCard
                  title="Forward Demand"
                  value={`${(forwardDemand?.activeEvents ?? 0) + (forwardDemand?.plannedEvents ?? 0)} events`}
                  subtitle={`${formatNumber(forwardDemand?.totalForwardDemandPieces ?? 0)} pcs across ${forwardDemand?.productsWithForwardDemand ?? 0} products`}
                  icon={TrendingUp}
                  onClick={() => navigate("/demand-planner")}
                />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Quick Actions</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => navigate("/reorder-analysis")}>Reorder Analysis</Button>
                    <Button variant="outline" size="sm" onClick={() => navigate("/purchasing")}>Purchasing Dashboard</Button>
                    <Button variant="outline" size="sm" onClick={() => navigate("/demand-planner")}>Demand Planner</Button>
                    <Button variant="outline" size="sm" onClick={() => navigate("/receiving")}>Receiving</Button>
                    <Button variant="outline" size="sm" onClick={() => navigate("/suppliers")}>Suppliers</Button>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* System Health Tab */}
        <TabsContent value="system" className="space-y-4">
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : (
            <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <Activity className={`h-8 w-8 ${(webhookHealth?.pendingRetries ?? 0) > 10 ? "text-yellow-500" : "text-green-500"}`} />
                    <div>
                      <p className="text-2xl font-bold">{webhookHealth?.pendingRetries ?? 0}</p>
                      <p className="text-sm text-muted-foreground">Pending Retries</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <XCircle className={`h-8 w-8 ${(webhookHealth?.deadLetters ?? 0) > 0 ? "text-red-500" : "text-green-500"}`} />
                    <div>
                      <p className="text-2xl font-bold">{webhookHealth?.deadLetters ?? 0}</p>
                      <p className="text-sm text-muted-foreground">Dead Letters</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <AlertCircle className={`h-8 w-8 ${(webhookHealth?.failedInbox ?? 0) > 0 ? "text-red-500" : "text-green-500"}`} />
                    <div>
                      <p className="text-2xl font-bold">{webhookHealth?.failedInbox ?? 0}</p>
                      <p className="text-sm text-muted-foreground">Failed Inbox</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <Clock className={`h-8 w-8 ${(webhookHealth?.staleRetries ?? 0) > 0 ? "text-yellow-500" : "text-green-500"}`} />
                    <div>
                      <p className="text-2xl font-bold">{webhookHealth?.staleRetries ?? 0}</p>
                      <p className="text-sm text-muted-foreground">Stale Retries</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
