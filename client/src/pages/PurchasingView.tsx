import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Box,
  BrainCircuit,
  CheckCircle2,
  DollarSign,
  PackageSearch,
  ShoppingCart,
  TrendingDown
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DashboardKPIs {
  criticalRestocks: number;
  upcomingRestocks: number;
  idleCapitalCents: number;
  inboundPipelineValueCents: number;
  totalOpenLines: number;
  lastComputedAt: string;
}

interface ReorderItem {
  productId: number;
  productVariantId?: number;
  sku: string;
  productName: string;
  totalOnHand: number;
  totalReserved: number;
  available: number;
  periodUsage: number;
  avgDailyUsage: number;
  daysOfSupply: number;
  leadTimeDays: number;
  safetyStockDays: number;
  reorderPoint: number;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomUnits: number;
  orderUomLabel: string;
  onOrderPieces: number;
  openPoCount: number;
  status: string;
}

interface ReorderAnalysis {
  items: ReorderItem[];
  lookbackDays: number;
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: any; priority: number }> = {
  stockout: { label: "Stockout Imminent", bg: "bg-red-500/10", text: "text-red-500", icon: AlertTriangle, priority: 0 },
  order_now: { label: "Critical Restock", bg: "bg-orange-500/10", text: "text-orange-500", icon: AlertTriangle, priority: 1 },
  order_soon: { label: "Burn Rate High", bg: "bg-amber-500/10", text: "text-amber-500", icon: Activity, priority: 2 },
  on_order: { label: "Inbound Pipeline", bg: "bg-blue-500/10", text: "text-blue-500", icon: PackageSearch, priority: 2.5 },
  ok: { label: "Healthy", bg: "bg-green-500/10", text: "text-green-500", icon: CheckCircle2, priority: 3 },
  no_movement: { label: "Stagnant", bg: "bg-zinc-500/10", text: "text-zinc-500", icon: Box, priority: 4 },
};

export default function PurchasingView() {
  const [sortField, setSortField] = useState("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: kpis, isLoading: isLoadingKpis } = useQuery<DashboardKPIs>({
    queryKey: ["/api/purchasing/kpis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/kpis");
      if (!res.ok) throw new Error("Failed to fetch KPIs");
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30s
  });

  const { data: analysis, isLoading: isLoadingAnalysis } = useQuery<ReorderAnalysis>({
    queryKey: ["/api/purchasing/reorder-analysis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/reorder-analysis");
      if (!res.ok) throw new Error("Failed to fetch reorder analysis");
      return res.json();
    },
  });

  const autoDraftMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/purchasing/auto-draft-run", {
         method: "POST", 
         headers: { "Content-Type": "application/json" } 
      });
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      toast({
        title: "Autonomous Procurement Synced",
        description: `Successfully analyzed burn rates and updated ${data.count} Vendor POs for ${data.itemsDrafted} critical items.`,
      });
    },
    onError: () => {
      toast({
        title: "System Error",
        description: "The AI agent was unable to execute the PO drafting protocol.",
        variant: "destructive"
      });
    }
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const filtered = (analysis?.items ?? []).sort((a, b) => {
    let aVal: any, bVal: any;
    switch (sortField) {
      case "sku": aVal = a.sku; bVal = b.sku; break;
      case "onHand": aVal = a.totalOnHand; bVal = b.totalOnHand; break;
      case "onOrder": aVal = a.onOrderPieces; bVal = b.onOrderPieces; break;
      case "health": aVal = a.available / (a.reorderPoint || 1); bVal = b.available / (b.reorderPoint || 1); break;
      case "status":
        aVal = STATUS_CONFIG[a.status]?.priority ?? 99;
        bVal = STATUS_CONFIG[b.status]?.priority ?? 99;
        break;
      default: aVal = a.sku; bVal = b.sku;
    }
    if (typeof aVal === "string") {
      return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === "asc" ? aVal - bVal : bVal - aVal;
  });

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-muted-foreground ml-1" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
  };

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      {/* HEADER */}
      <div className="border-b bg-white dark:bg-zinc-900 sticky top-0 z-10 px-6 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 flex items-center gap-3">
              <BrainCircuit className="h-6 w-6 text-primary" />
              Supply Chain Command Center
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Autonomous Inventory Health & Procurement Engine
            </p>
          </div>

          <Button 
            size="lg" 
            className="gap-2 shadow-lg hover:shadow-xl transition-all"
            onClick={() => autoDraftMutation.mutate()}
            disabled={autoDraftMutation.isPending}
          >
            {autoDraftMutation.isPending ? (
              <TrendingDown className="h-4 w-4 animate-bounce" />
            ) : (
              <ShoppingCart className="h-4 w-4" />
            )}
            Run Draft Protocol
          </Button>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-auto">
        {/* KPI CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Critical Restocks</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : kpis?.criticalRestocks || 0}
              </div>
              <p className="text-xs text-zinc-500 mt-1">SKUs below Reorder Point</p>
            </CardContent>
          </Card>
          
          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Upcoming Restocks</CardTitle>
              <Activity className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : kpis?.upcomingRestocks || 0}
              </div>
              <p className="text-xs text-zinc-500 mt-1">Approaching 14-day threshold</p>
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Inbound Pipeline</CardTitle>
              <PackageSearch className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : formatCurrency(kpis?.inboundPipelineValueCents || 0)}
              </div>
              <p className="text-xs text-zinc-500 mt-1">{kpis?.totalOpenLines || 0} Active PO Lines Transit</p>
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Capital Efficiency</CardTitle>
              <DollarSign className="h-4 w-4 text-zinc-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : formatCurrency(kpis?.idleCapitalCents || 0)}
              </div>
              <p className="text-xs text-zinc-500 mt-1">Capital in stagnant inventory {'(>180d)'}</p>
            </CardContent>
          </Card>
        </div>

        {/* DATA TABLE */}
        <Card className="dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
          <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
            <CardTitle className="text-lg">Inventory Burn Telemetry</CardTitle>
            <CardDescription>Live health monitoring of catalog velocity against system reorder parameters.</CardDescription>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[80px]" />
                  <TableHead className="cursor-pointer font-semibold" onClick={() => handleSort("sku")}>
                    <div className="flex items-center">SKU <SortIcon field="sku" /></div>
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="w-[200px] cursor-pointer font-semibold" onClick={() => handleSort("health")}>
                    <div className="flex items-center">Health Indicator <SortIcon field="health" /></div>
                  </TableHead>
                  <TableHead className="text-right cursor-pointer font-semibold" onClick={() => handleSort("onHand")}>
                    <div className="flex justify-end items-center">Available <SortIcon field="onHand" /></div>
                  </TableHead>
                  <TableHead className="text-right">Reorder Pt</TableHead>
                  <TableHead className="text-right">Supply</TableHead>
                  <TableHead className="text-right cursor-pointer font-semibold" onClick={() => handleSort("status")}>
                    <div className="flex justify-end items-center">Status <SortIcon field="status" /></div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingAnalysis ? (
                   <TableRow>
                     <TableCell colSpan={8} className="text-center py-12 text-zinc-500">Loading telemetry data...</TableCell>
                   </TableRow>
                ) : filtered.length === 0 ? (
                   <TableRow>
                     <TableCell colSpan={8} className="text-center py-12 text-zinc-500">No data matching current criteria.</TableCell>
                   </TableRow>
                ) : (
                  filtered.map((item) => {
                    const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.ok;
                    const StatusIcon = cfg.icon;
                    // Health Calculation: Available / Reorder Point
                    const healthPct = item.reorderPoint > 0 
                                      ? Math.min(100, Math.max(0, (item.available / item.reorderPoint) * 100)) 
                                      : 100;
                    
                    let progressColor = "bg-green-500";
                    if (healthPct < 25) progressColor = "bg-red-500";
                    else if (healthPct < 75) progressColor = "bg-amber-500";

                    return (
                      <TableRow key={item.productId} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <TableCell>
                           {/* Intentionally left blank or for manual selection if needed */}
                        </TableCell>
                        <TableCell className="font-mono font-medium">{item.sku}</TableCell>
                        <TableCell className="max-w-[200px] truncate text-sm" title={item.productName}>
                          {item.productName}
                          {item.onOrderPieces > 0 && <div className="text-xs text-blue-500 mt-1">+{item.onOrderPieces} Inbound</div>}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1.5">
                            <div className="flex justify-between text-xs font-medium">
                              <span>Health</span>
                              <span>{Math.round(healthPct)}%</span>
                            </div>
                            <Progress value={healthPct} className={`h-1.5 [&>div]:${progressColor}`} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">{item.available.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono text-zinc-500">{item.reorderPoint.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-xs">
                          {item.daysOfSupply >= 9999 ? "∞" : `${item.daysOfSupply}d`}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className={`${cfg.bg} ${cfg.text} border-transparent gap-1 font-medium`}>
                            <StatusIcon className="h-3 w-3" />
                            {cfg.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
