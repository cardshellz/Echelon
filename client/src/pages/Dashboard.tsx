import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  ArrowUpRight, 
  ArrowDownRight, 
  Package, 
  ShoppingCart, 
  Truck, 
  DollarSign, 
  Activity,
  AlertCircle,
  RefreshCw,
  AlertTriangle,
  X
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

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


export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [alertDismissed, setAlertDismissed] = React.useState(false);

  const { data: syncHealth } = useQuery<SyncHealth>({
    queryKey: ["/api/sync/health"],
    refetchInterval: 60000, // Check every minute
  });

  const triggerSyncMutation = useMutation({
    mutationFn: async () => {
      // Two-step sync to close both gaps the alert banner can surface:
      //   1. Pull missing Shopify orders into shopify_orders + OMS (reconcile-orders)
      //   2. Backfill any OMS orders that didn't make it to WMS (backfill-oms-to-wms)
      // The banner's "orders waiting to sync" count is the OMS→WMS gap.
      const reconcileRes = await fetch("/api/shopify/reconcile-orders", {
        method: "POST",
        credentials: "include",
      });
      const reconcileData = reconcileRes.ok ? await reconcileRes.json() : {};

      const backfillRes = await fetch("/api/sync/backfill-oms-to-wms", {
        method: "POST",
        credentials: "include",
      });
      const backfillData = backfillRes.ok ? await backfillRes.json() : {};

      if (!reconcileRes.ok && !backfillRes.ok) {
        throw new Error("Sync failed");
      }
      return {
        reconciled: reconcileData?.reconciled ?? 0,
        checked: reconcileData?.checked ?? 0,
        bridged: backfillData?.synced ?? 0,
      };
    },
    onSuccess: (data: { reconciled: number; checked: number; bridged: number }) => {
      const parts: string[] = [];
      if (data.reconciled > 0) parts.push(`${data.reconciled} order(s) pulled from Shopify`);
      if (data.bridged > 0) parts.push(`${data.bridged} OMS order(s) bridged to WMS`);
      const description =
        parts.length > 0
          ? parts.join(", ") + "."
          : `No missing orders found (checked ${data.checked} in Shopify).`;
      toast({ title: "Sync complete", description });
      queryClient.invalidateQueries({ queryKey: ["/api/sync/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
    },
    onError: (error) => {
      toast({ title: "Sync failed", description: String(error), variant: "destructive" });
    },
  });

  const showSyncAlert = syncHealth?.needsAlert && !alertDismissed;

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

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">Warehouse activity and performance metrics for today.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="h-11 min-h-[44px] text-sm">Download Report</Button>
          <Button className="h-11 min-h-[44px] text-sm bg-primary hover:bg-primary/90">Create Order</Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-4">
        <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4 pb-1 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Total Revenue</CardTitle>
            <DollarSign className="h-3 w-3 md:h-4 md:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 md:p-4 pt-0">
            <div className="text-lg md:text-2xl font-bold">$45,231.89</div>
            <p className="text-[10px] md:text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-emerald-600 flex items-center mr-1 font-medium">
                <ArrowUpRight className="h-2.5 w-2.5 md:h-3 md:w-3 mr-0.5" /> +20.1%
              </span>
              <span className="hidden sm:inline">from last month</span>
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-chart-2 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4 pb-1 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Orders Shipped</CardTitle>
            <Truck className="h-3 w-3 md:h-4 md:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 md:p-4 pt-0">
            <div className="text-lg md:text-2xl font-bold">+2350</div>
            <p className="text-[10px] md:text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-emerald-600 flex items-center mr-1 font-medium">
                <ArrowUpRight className="h-2.5 w-2.5 md:h-3 md:w-3 mr-0.5" /> +15.2%
              </span>
              <span className="hidden sm:inline">fulfillment rate</span>
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-chart-3 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4 pb-1 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Pending Orders</CardTitle>
            <ShoppingCart className="h-3 w-3 md:h-4 md:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 md:p-4 pt-0">
            <div className="text-lg md:text-2xl font-bold">122</div>
            <p className="text-[10px] md:text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-rose-600 flex items-center mr-1 font-medium">
                <ArrowDownRight className="h-2.5 w-2.5 md:h-3 md:w-3 mr-0.5" /> -4.1%
              </span>
              <span className="hidden sm:inline">backlog reduced</span>
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-chart-4 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4 pb-1 md:pb-2">
            <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground">Low Stock SKUs</CardTitle>
            <Activity className="h-3 w-3 md:h-4 md:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 md:p-4 pt-0">
            <div className="text-lg md:text-2xl font-bold">12</div>
            <p className="text-[10px] md:text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-amber-600 flex items-center mr-1 font-medium">
                <AlertCircle className="h-2.5 w-2.5 md:h-3 md:w-3 mr-0.5" /> Action needed
              </span>
              <span className="hidden sm:inline">reorder soon</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-7 gap-4 md:gap-6">
        {/* Main Chart */}
        <Card className="lg:col-span-4 shadow-sm">
          <CardHeader className="p-3 md:p-6">
            <CardTitle className="text-base md:text-lg">Order Fulfillment</CardTitle>
            <CardDescription className="text-xs md:text-sm">Daily order processing vs shipping volume</CardDescription>
          </CardHeader>
          <CardContent className="p-2 md:p-6 pt-0">
            <div className="h-[200px] md:h-[300px] w-full flex flex-col items-center justify-center text-muted-foreground">
              <Truck className="h-8 w-8 mb-2 opacity-20" />
              <p className="text-xs md:text-sm" data-testid="text-chart-empty">No fulfillment data available yet</p>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity / Inventory */}
        <Card className="lg:col-span-3 shadow-sm flex flex-col">
          <CardHeader className="p-3 md:p-6">
            <CardTitle className="text-base md:text-lg">Critical Inventory</CardTitle>
            <CardDescription className="text-xs md:text-sm">Items requiring immediate attention</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 p-2 md:p-6 pt-0">
            <Tabs defaultValue="low_stock" className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-3 md:mb-4 h-9 md:h-10">
                <TabsTrigger value="low_stock" className="text-xs md:text-sm min-h-[36px]">Low Stock</TabsTrigger>
                <TabsTrigger value="moving_fast" className="text-xs md:text-sm min-h-[36px]">Fast Moving</TabsTrigger>
              </TabsList>
              <TabsContent value="low_stock" className="mt-0">
                <div className="flex flex-col items-center justify-center h-36 md:h-48 text-muted-foreground text-xs md:text-sm">
                  <Package className="h-6 w-6 md:h-8 md:w-8 mb-2 opacity-20" />
                  <span data-testid="text-low-stock-empty">No low stock alerts</span>
                </div>
              </TabsContent>
              <TabsContent value="moving_fast" className="mt-0">
                <div className="flex flex-col items-center justify-center h-36 md:h-48 text-muted-foreground text-xs md:text-sm">
                  <Activity className="h-6 w-6 md:h-8 md:w-8 mb-2 opacity-20" />
                  No fast moving alerts
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
