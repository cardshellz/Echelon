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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  BarChart,
  Bar
} from "recharts";

// Mock Data
const data = [
  { name: "Mon", orders: 400, shipped: 240 },
  { name: "Tue", orders: 300, shipped: 139 },
  { name: "Wed", orders: 200, shipped: 980 },
  { name: "Thu", orders: 278, shipped: 390 },
  { name: "Fri", orders: 189, shipped: 480 },
  { name: "Sat", orders: 239, shipped: 380 },
  { name: "Sun", orders: 349, shipped: 430 },
];

const inventoryData = [
  { sku: "NK-292-BLK", name: "Nike Air Max 90", location: "A-01-02", qty: 45, status: "In Stock" },
  { sku: "AD-550-WHT", name: "Adidas Ultraboost", location: "B-12-04", qty: 12, status: "Low Stock" },
  { sku: "PM-102-GRY", name: "Puma RS-X", location: "A-04-01", qty: 0, status: "Out of Stock" },
  { sku: "NB-990-NVY", name: "New Balance 990", location: "C-09-02", qty: 89, status: "In Stock" },
  { sku: "AS-200-BLU", name: "Asics Gel-Lyte", location: "B-03-05", qty: 3, status: "Low Stock" },
];

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
      const res = await fetch("/api/sync/trigger", { 
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to trigger sync");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Sync triggered", description: "Order sync has been initiated" });
      queryClient.invalidateQueries({ queryKey: ["/api/sync/health"] });
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
            <div className="h-[200px] md:h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                  <defs>
                    <linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorShipped" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis 
                    dataKey="name" 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(value) => `${value}`} 
                  />
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <Tooltip 
                    contentStyle={{ borderRadius: '6px', borderColor: 'hsl(var(--border))' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="orders" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorOrders)" 
                  />
                  <Area 
                    type="monotone" 
                    dataKey="shipped" 
                    stroke="hsl(var(--chart-2))" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorShipped)" 
                  />
                </AreaChart>
              </ResponsiveContainer>
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
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs md:text-sm py-2">SKU</TableHead>
                      <TableHead className="text-xs md:text-sm py-2">Qty</TableHead>
                      <TableHead className="text-xs md:text-sm py-2 text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventoryData.map((item) => (
                      <TableRow key={item.sku}>
                        <TableCell className="font-mono-sku text-[10px] md:text-xs font-medium py-2">{item.sku}</TableCell>
                        <TableCell className="text-xs md:text-sm py-2">{item.qty}</TableCell>
                        <TableCell className="text-right py-2">
                          <Badge 
                            variant="secondary" 
                            className={`text-[10px] md:text-xs ${
                              item.status === "Out of Stock" ? "bg-rose-100 text-rose-700 hover:bg-rose-100 dark:bg-rose-900/30 dark:text-rose-400" :
                              item.status === "Low Stock" ? "bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400" :
                              "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400"
                            }`}
                          >
                            {item.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
