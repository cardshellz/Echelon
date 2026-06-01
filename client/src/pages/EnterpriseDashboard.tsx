import React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Package, ShoppingCart, Truck, DollarSign, AlertTriangle,
  TrendingUp, Warehouse, FileText, Calendar, ArrowRight,
  Clock, Activity, AlertCircle, CheckCircle2, XCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLocation } from "wouter";

interface EnterpriseDashboardData {
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
    shippedToday: number;
    shippedThisWeek: number;
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
    revenueToday: number;
    ordersToday: number;
    ordersThisWeek: number;
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

export default function EnterpriseDashboard() {
  const [, navigate] = useLocation();
  const { data, isLoading, error } = useQuery<EnterpriseDashboardData>({
    queryKey: ["/api/enterprise/dashboard"],
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Enterprise Operations</h1>
        <p className="text-muted-foreground">Loading dashboard...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Enterprise Operations</h1>
        <p className="text-red-500">Failed to load dashboard data</p>
      </div>
    );
  }

  const {
    orderPipeline, shipmentHealth, inventoryHealth,
    procurementPipeline, financialKpis, webhookHealth, forwardDemand,
  } = data;

  const hasIssues = orderPipeline.stuckOrders > 0
    || shipmentHealth.unpushed > 0
    || shipmentHealth.requiresReview > 0
    || inventoryHealth.negativeInventory > 0
    || webhookHealth.deadLetters > 0
    || procurementPipeline.overduePoCount > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Enterprise Operations</h1>
          <p className="text-sm text-muted-foreground">
            Full system visibility — updated {new Date(data.generatedAt).toLocaleTimeString()}
          </p>
        </div>
        {hasIssues && (
          <Badge variant="destructive" className="text-sm px-3 py-1">
            <AlertTriangle className="h-4 w-4 mr-1" />
            Issues Detected
          </Badge>
        )}
      </div>

      {/* Financial KPIs */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          title="Orders Today"
          value={formatNumber(financialKpis.ordersToday)}
          subtitle={`${formatNumber(financialKpis.ordersThisWeek)} this week`}
          icon={ShoppingCart}
          onClick={() => navigate("/orders")}
        />
        <KpiCard
          title="Revenue Today"
          value={formatCents(financialKpis.revenueToday)}
          icon={DollarSign}
        />
        <KpiCard
          title="Shipped Today"
          value={formatNumber(shipmentHealth.shippedToday)}
          subtitle={`${formatNumber(shipmentHealth.shippedThisWeek)} this week`}
          icon={Truck}
          onClick={() => navigate("/orders")}
        />
        <KpiCard
          title="Inventory Value"
          value={formatCents(financialKpis.inventoryValueCents)}
          icon={Warehouse}
          onClick={() => navigate("/inventory/costs")}
        />
        <KpiCard
          title="Open PO Value"
          value={formatCents(financialKpis.openPoValueCents)}
          subtitle={`${procurementPipeline.openPoCount} open POs`}
          icon={FileText}
          onClick={() => navigate("/purchase-orders")}
        />
        <KpiCard
          title="Pending AP"
          value={formatCents(financialKpis.pendingApCents)}
          icon={DollarSign}
          onClick={() => navigate("/ap")}
        />
      </div>

      <Tabs defaultValue="operations" className="space-y-4">
        <TabsList>
          <TabsTrigger value="operations">Operations</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="procurement">Procurement</TabsTrigger>
          <TabsTrigger value="system">System Health</TabsTrigger>
        </TabsList>

        {/* Operations Tab */}
        <TabsContent value="operations" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Order Pipeline */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Order Pipeline</CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>
                    View All <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
                <CardDescription>{orderPipeline.total} active orders</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <PipelineBar data={orderPipeline.byStatus} />
                <div className="grid grid-cols-3 gap-4 pt-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Stuck ({">"}48h)</p>
                    <p className="text-lg font-semibold">
                      <StatusBadge value={orderPipeline.stuckOrders} thresholds={{ warn: 1, critical: 5 }} />
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Avg Age</p>
                    <p className="text-lg font-semibold">{orderPipeline.avgAgeHours}h</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Oldest</p>
                    <p className="text-lg font-semibold">{orderPipeline.oldestUnshippedHours}h</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Shipment Health */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">Shipment Health</CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>
                    View All <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
                <CardDescription>{shipmentHealth.total} total shipments</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Unpushed</span>
                      <StatusBadge value={shipmentHealth.unpushed} thresholds={{ warn: 1, critical: 5 }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Requires Review</span>
                      <StatusBadge value={shipmentHealth.requiresReview} thresholds={{ warn: 1, critical: 3 }} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">On Hold</span>
                      <StatusBadge value={shipmentHealth.onHold} thresholds={{ warn: 1, critical: 5 }} />
                    </div>
                  </div>
                  <div className="space-y-3">
                    {Object.entries(shipmentHealth.byStatus)
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
        </TabsContent>

        {/* Inventory Tab */}
        <TabsContent value="inventory" className="space-y-4">
          <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
            <KpiCard
              title="Total SKUs"
              value={formatNumber(inventoryHealth.totalSkus)}
              icon={Package}
              onClick={() => navigate("/inventory")}
            />
            <KpiCard
              title="On Hand"
              value={formatNumber(inventoryHealth.totalOnHand)}
              subtitle={`${formatNumber(inventoryHealth.totalReserved)} reserved`}
              icon={Warehouse}
            />
            <KpiCard
              title="Available"
              value={formatNumber(inventoryHealth.totalAvailable)}
              icon={CheckCircle2}
            />
            <KpiCard
              title="Negative Inventory"
              value={inventoryHealth.negativeInventory}
              icon={XCircle}
              alert={inventoryHealth.negativeInventory > 0}
              onClick={() => navigate("/operations")}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <AlertTriangle className={`h-8 w-8 ${inventoryHealth.outOfStockSkus > 0 ? "text-red-500" : "text-muted-foreground/30"}`} />
                  <div>
                    <p className="text-2xl font-bold">{inventoryHealth.outOfStockSkus}</p>
                    <p className="text-sm text-muted-foreground">Out of Stock SKUs</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <AlertCircle className={`h-8 w-8 ${inventoryHealth.lowStockSkus > 0 ? "text-yellow-500" : "text-muted-foreground/30"}`} />
                  <div>
                    <p className="text-2xl font-bold">{inventoryHealth.lowStockSkus}</p>
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
                    <p className="text-2xl font-bold">{inventoryHealth.overstockSkus}</p>
                    <p className="text-sm text-muted-foreground">Overstock SKUs ({">"}100)</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Procurement Tab */}
        <TabsContent value="procurement" className="space-y-4">
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
            <KpiCard
              title="Open POs"
              value={procurementPipeline.openPoCount}
              subtitle={formatCents(procurementPipeline.openPoValue)}
              icon={FileText}
              onClick={() => navigate("/purchase-orders")}
            />
            <KpiCard
              title="Draft POs"
              value={procurementPipeline.draftPoCount}
              icon={FileText}
              onClick={() => navigate("/purchase-orders")}
            />
            <KpiCard
              title="Overdue POs"
              value={procurementPipeline.overduePoCount}
              icon={Clock}
              alert={procurementPipeline.overduePoCount > 0}
              onClick={() => navigate("/purchase-orders")}
            />
            <KpiCard
              title="In Transit"
              value={procurementPipeline.inTransitShipments}
              icon={Truck}
              onClick={() => navigate("/shipments")}
            />
            <KpiCard
              title="Expected (30d)"
              value={procurementPipeline.expectedReceiptsNext30Days}
              subtitle="receipts expected"
              icon={Calendar}
            />
            <KpiCard
              title="Forward Demand"
              value={`${forwardDemand.activeEvents + forwardDemand.plannedEvents} events`}
              subtitle={`${formatNumber(forwardDemand.totalForwardDemandPieces)} pcs across ${forwardDemand.productsWithForwardDemand} products`}
              icon={TrendingUp}
              onClick={() => navigate("/demand-planner")}
            />
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Quick Actions</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => navigate("/reorder-analysis")}>
                  Reorder Analysis
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate("/purchasing")}>
                  Purchasing Dashboard
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate("/demand-planner")}>
                  Demand Planner
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate("/receiving")}>
                  Receiving
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate("/suppliers")}>
                  Suppliers
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* System Health Tab */}
        <TabsContent value="system" className="space-y-4">
          <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <Activity className={`h-8 w-8 ${webhookHealth.pendingRetries > 10 ? "text-yellow-500" : "text-green-500"}`} />
                  <div>
                    <p className="text-2xl font-bold">{webhookHealth.pendingRetries}</p>
                    <p className="text-sm text-muted-foreground">Pending Retries</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <XCircle className={`h-8 w-8 ${webhookHealth.deadLetters > 0 ? "text-red-500" : "text-green-500"}`} />
                  <div>
                    <p className="text-2xl font-bold">{webhookHealth.deadLetters}</p>
                    <p className="text-sm text-muted-foreground">Dead Letters</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <AlertCircle className={`h-8 w-8 ${webhookHealth.failedInbox > 0 ? "text-red-500" : "text-green-500"}`} />
                  <div>
                    <p className="text-2xl font-bold">{webhookHealth.failedInbox}</p>
                    <p className="text-sm text-muted-foreground">Failed Inbox</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center gap-3">
                  <Clock className={`h-8 w-8 ${webhookHealth.staleRetries > 0 ? "text-yellow-500" : "text-green-500"}`} />
                  <div>
                    <p className="text-2xl font-bold">{webhookHealth.staleRetries}</p>
                    <p className="text-sm text-muted-foreground">Stale Retries</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
