import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ShoppingCart,
  Clock,
  TrendingDown,
  PackageX,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ReorderItem {
  variantId: number;
  sku: string;
  variantName: string;
  productName: string;
  unitsPerVariant: number;
  totalOnHand: number;
  totalReserved: number;
  available: number;
  avgDailyUsage: number;
  daysOfSupply: number;
  leadTimeDays: number;
  safetyStockQty: number;
  reorderPoint: number;
  suggestedOrderQty: number;
  status: string;
  lastReceivedAt: string | null;
}

interface ReorderAnalysis {
  items: ReorderItem[];
  summary: {
    totalSkus: number;
    belowReorderPoint: number;
    orderSoon: number;
    noMovement: number;
    totalOnHand: number;
  };
  lookbackDays: number;
}

interface PurchasingViewProps {
  searchQuery: string;
}

const STATUS_CONFIG: Record<string, { label: string; className: string; priority: number }> = {
  stockout: { label: "Stockout", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", priority: 0 },
  order_now: { label: "Order Now", className: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400", priority: 1 },
  order_soon: { label: "Order Soon", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400", priority: 2 },
  ok: { label: "OK", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400", priority: 3 },
  no_movement: { label: "No Movement", className: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400", priority: 4 },
};

export default function PurchasingView({ searchQuery }: PurchasingViewProps) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [lookbackDays, setLookbackDays] = useState("90");
  const [sortField, setSortField] = useState("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const { data, isLoading } = useQuery<ReorderAnalysis>({
    queryKey: ["/api/purchasing/reorder-analysis", lookbackDays],
    queryFn: async () => {
      const res = await fetch(`/api/purchasing/reorder-analysis?lookbackDays=${lookbackDays}`);
      if (!res.ok) throw new Error("Failed to fetch reorder analysis");
      return res.json();
    },
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const filtered = (data?.items ?? [])
    .filter((item) => {
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          item.sku.toLowerCase().includes(q) ||
          item.variantName.toLowerCase().includes(q) ||
          item.productName.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case "sku": aVal = a.sku; bVal = b.sku; break;
        case "name": aVal = a.variantName; bVal = b.variantName; break;
        case "onHand": aVal = a.totalOnHand; bVal = b.totalOnHand; break;
        case "usage": aVal = a.avgDailyUsage; bVal = b.avgDailyUsage; break;
        case "dos": aVal = a.daysOfSupply; bVal = b.daysOfSupply; break;
        case "reorderPt": aVal = a.reorderPoint; bVal = b.reorderPoint; break;
        case "orderQty": aVal = a.suggestedOrderQty; bVal = b.suggestedOrderQty; break;
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
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-muted-foreground" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  const formatDos = (dos: number) => {
    if (dos >= 9999) return "∞";
    return `${dos}d`;
  };

  const dosColor = (item: ReorderItem) => {
    if (item.status === "stockout") return "text-red-600 font-bold";
    if (item.status === "order_now") return "text-orange-600 font-bold";
    if (item.status === "order_soon") return "text-amber-600";
    return "";
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 gap-4">
      {/* Summary cards */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 shrink-0">
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <ShoppingCart size={12} /> Total SKUs
            </div>
            <div className="text-2xl font-bold font-mono mt-1">{data.summary.totalSkus}</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border border-red-200 dark:border-red-800/40">
            <div className="text-xs text-red-600 font-medium uppercase tracking-wider flex items-center gap-1">
              <AlertTriangle size={12} /> Need Ordering
            </div>
            <div className="text-2xl font-bold font-mono text-red-600 mt-1">{data.summary.belowReorderPoint}</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border border-amber-200 dark:border-amber-800/40">
            <div className="text-xs text-amber-600 font-medium uppercase tracking-wider flex items-center gap-1">
              <Clock size={12} /> Order Soon
            </div>
            <div className="text-2xl font-bold font-mono text-amber-600 mt-1">{data.summary.orderSoon}</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider flex items-center gap-1">
              <PackageX size={12} /> No Movement
            </div>
            <div className="text-2xl font-bold font-mono text-muted-foreground mt-1">{data.summary.noMovement}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 shrink-0">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px] h-9 text-sm">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="stockout">Stockout</SelectItem>
            <SelectItem value="order_now">Order Now</SelectItem>
            <SelectItem value="order_soon">Order Soon</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="no_movement">No Movement</SelectItem>
          </SelectContent>
        </Select>
        <Select value={lookbackDays} onValueChange={setLookbackDays}>
          <SelectTrigger className="w-[160px] h-9 text-sm">
            <TrendingDown className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">30-day velocity</SelectItem>
            <SelectItem value="60">60-day velocity</SelectItem>
            <SelectItem value="90">90-day velocity</SelectItem>
            <SelectItem value="180">180-day velocity</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading reorder analysis...</div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Mobile cards */}
          <div className="md:hidden flex-1 overflow-auto space-y-3">
            {filtered.map((item) => {
              const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.ok;
              return (
                <div key={item.variantId} className="rounded-md border bg-card p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="font-mono font-medium text-primary text-sm">{item.sku}</div>
                      <div className="text-sm text-muted-foreground mt-0.5">{item.variantName}</div>
                    </div>
                    <Badge variant="outline" className={`text-xs ${cfg.className}`}>{cfg.label}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mt-3">
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">On Hand</div>
                      <div className="font-mono font-bold">{item.totalOnHand.toLocaleString()}</div>
                    </div>
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">Days Supply</div>
                      <div className={`font-mono font-bold ${dosColor(item)}`}>{formatDos(item.daysOfSupply)}</div>
                    </div>
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">Daily Use</div>
                      <div className="font-mono font-bold">{item.avgDailyUsage}</div>
                    </div>
                  </div>
                  {item.suggestedOrderQty > 0 && (
                    <div className="mt-2 text-xs bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800/30 rounded p-2">
                      Suggested order: <span className="font-mono font-bold">{item.suggestedOrderQty.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block rounded-md border bg-card flex-1 overflow-auto">
            <Table>
              <TableHeader className="bg-muted/40 sticky top-0 z-10">
                <TableRow>
                  <TableHead className="w-[140px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("sku")}>
                    <div className="flex items-center gap-1">SKU <SortIcon field="sku" /></div>
                  </TableHead>
                  <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleSort("name")}>
                    <div className="flex items-center gap-1">Name <SortIcon field="name" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[90px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("onHand")}>
                    <div className="flex items-center justify-end gap-1">On Hand <SortIcon field="onHand" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[90px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("usage")}>
                    <div className="flex items-center justify-end gap-1">Daily Use <SortIcon field="usage" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("dos")}>
                    <div className="flex items-center justify-end gap-1">Days Supply <SortIcon field="dos" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("reorderPt")}>
                    <div className="flex items-center justify-end gap-1">Reorder Pt <SortIcon field="reorderPt" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("orderQty")}>
                    <div className="flex items-center justify-end gap-1">Order Qty <SortIcon field="orderQty" /></div>
                  </TableHead>
                  <TableHead className="w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("status")}>
                    <div className="flex items-center gap-1">Status <SortIcon field="status" /></div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((item) => {
                  const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.ok;
                  return (
                    <TableRow key={item.variantId}>
                      <TableCell className="font-mono font-medium text-primary">{item.sku}</TableCell>
                      <TableCell className="truncate max-w-[200px]">{item.variantName}</TableCell>
                      <TableCell className="text-right font-mono font-bold">{item.totalOnHand.toLocaleString()}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {item.avgDailyUsage > 0 ? item.avgDailyUsage : "—"}
                      </TableCell>
                      <TableCell className={`text-right font-mono ${dosColor(item)}`}>
                        {formatDos(item.daysOfSupply)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {item.reorderPoint > 0 ? item.reorderPoint.toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {item.suggestedOrderQty > 0 ? (
                          <span className="font-bold text-orange-600">{item.suggestedOrderQty.toLocaleString()}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${cfg.className}`}>{cfg.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No items match the current filters
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {filtered.length > 0 && (
            <div className="text-xs text-muted-foreground shrink-0 pt-2">
              Showing {filtered.length} of {data?.items.length ?? 0} SKUs
              {" · "}Velocity based on trailing {data?.lookbackDays ?? 90} days
              {" · "}Default lead time: 120 days
            </div>
          )}
        </div>
      )}
    </div>
  );
}
