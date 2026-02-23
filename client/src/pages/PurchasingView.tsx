import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  TrendingDown,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ShoppingCart,
  Search,
  BarChart3,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
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
  productId: number;
  productVariantId?: number;
  sku: string;
  productName: string;
  variantCount: number;
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
  onOrderQty: number;
  onOrderPieces: number;
  openPoCount: number;
  earliestExpectedDate: string | null;
  status: string;
  lastReceivedAt: string | null;
}

interface ReorderAnalysis {
  items: ReorderItem[];
  summary: {
    totalProducts: number;
    belowReorderPoint: number;
    orderSoon: number;
    noMovement: number;
    totalOnHand: number;
  };
  lookbackDays: number;
}

const STATUS_CONFIG: Record<string, { label: string; className: string; priority: number }> = {
  stockout: { label: "Stockout", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", priority: 0 },
  order_now: { label: "Order Now", className: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400", priority: 1 },
  order_soon: { label: "Order Soon", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400", priority: 2 },
  on_order: { label: "On Order", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400", priority: 2.5 },
  ok: { label: "OK", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400", priority: 3 },
  no_movement: { label: "No Movement", className: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400", priority: 4 },
};

const LOOKBACK_OPTIONS = [
  { value: "7", label: "7d" },
  { value: "14", label: "14d" },
  { value: "30", label: "30d" },
  { value: "60", label: "60d" },
  { value: "90", label: "90d" },
  { value: "180", label: "180d" },
];

export default function PurchasingView() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortField, setSortField] = useState("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data, isLoading } = useQuery<ReorderAnalysis>({
    queryKey: ["/api/purchasing/reorder-analysis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/reorder-analysis");
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
      if (statusFilter === "need_ordering") {
        if (item.status !== "order_now" && item.status !== "stockout") return false;
      } else if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          item.sku.toLowerCase().includes(q) ||
          item.productName.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case "sku": aVal = a.sku; bVal = b.sku; break;
        case "name": aVal = a.productName; bVal = b.productName; break;
        case "onHand": aVal = a.totalOnHand; bVal = b.totalOnHand; break;
        case "onOrder": aVal = a.onOrderPieces; bVal = b.onOrderPieces; break;
        case "usage": aVal = a.periodUsage; bVal = b.periodUsage; break;
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

  // Selection helpers
  const toggleSelect = (productId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };
  const toggleSelectAll = () => {
    const selectableIds = filtered.filter(i => i.suggestedOrderQty > 0).map(i => i.productId);
    const allSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIds));
    }
  };
  const selectableCount = filtered.filter(i => i.suggestedOrderQty > 0).length;
  const allSelected = selectableCount > 0 && filtered.filter(i => i.suggestedOrderQty > 0).every(i => selectedIds.has(i.productId));

  // Create PO from selected reorder items
  const createPoMutation = useMutation({
    mutationFn: async (items: Array<{ productId: number; productVariantId: number; suggestedQty: number }>) => {
      const res = await fetch("/api/purchasing/create-po-from-reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || "Failed to create PO");
      }
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setSelectedIds(new Set());
      const poCount = result.purchaseOrders?.length || 1;
      toast({
        title: `${poCount} PO${poCount > 1 ? "s" : ""} created`,
        description: poCount === 1
          ? `${result.purchaseOrders?.[0]?.poNumber} created as draft`
          : `${poCount} POs created, grouped by vendor`,
      });
      if (poCount === 1 && result.purchaseOrders?.[0]?.id) {
        navigate(`/purchase-orders/${result.purchaseOrders[0].id}`);
      } else {
        navigate("/purchase-orders");
      }
    },
    onError: (err: Error) => {
      toast({ title: "Failed to create PO", description: err.message, variant: "destructive" });
    },
  });

  const handleCreatePO = () => {
    const items = filtered
      .filter(i => selectedIds.has(i.productId) && i.suggestedOrderQty > 0)
      .map(i => ({
        productId: i.productId,
        productVariantId: i.productVariantId || i.productId, // fallback
        suggestedQty: i.suggestedOrderQty,
      }));
    if (items.length === 0) return;
    createPoMutation.mutate(items);
  };

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
    <div className="flex flex-col h-full">
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 p-2 md:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-lg md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-5 w-5 md:h-6 md:w-6" />
              Reorder Analysis
            </h1>
            <p className="text-xs md:text-sm text-muted-foreground mt-1">
              Identify products that need reordering based on velocity and stock levels
            </p>
          </div>
          <div className="relative md:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <Input
              placeholder="Search SKU or product..."
              className="pl-9 h-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-3 p-2 md:p-6">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 shrink-0">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px] h-9 text-sm">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="need_ordering">Need Ordering</SelectItem>
            <SelectItem value="stockout">Stockout</SelectItem>
            <SelectItem value="order_now">Order Now</SelectItem>
            <SelectItem value="order_soon">Order Soon</SelectItem>
            <SelectItem value="on_order">On Order</SelectItem>
            <SelectItem value="ok">OK</SelectItem>
            <SelectItem value="no_movement">No Movement</SelectItem>
          </SelectContent>
        </Select>
        {data && (
          <div className="flex items-center gap-1.5">
            <TrendingDown className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={String(data.lookbackDays)}
              onValueChange={async (val) => {
                try {
                  await fetch("/api/purchasing/velocity-lookback", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ days: parseInt(val) }),
                  });
                  queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
                } catch (e) {
                  console.error("Failed to update velocity lookback", e);
                }
              }}
            >
              <SelectTrigger className="w-[130px] h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOOKBACK_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label} velocity window
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Loading reorder analysis...</div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Mobile cards */}
          <div className="md:hidden flex-1 overflow-auto space-y-3">
            {filtered.map((item) => {
              const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.ok;
              const canSelect = item.suggestedOrderQty > 0;
              return (
                <div key={item.productId} className="rounded-md border bg-card p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-start gap-2">
                      {canSelect && (
                        <Checkbox
                          checked={selectedIds.has(item.productId)}
                          onCheckedChange={() => toggleSelect(item.productId)}
                          className="mt-0.5"
                        />
                      )}
                      <div>
                        <div className="font-mono font-medium text-primary text-sm">{item.sku}</div>
                        <div className="text-sm text-muted-foreground mt-0.5">{item.productName}</div>
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-xs ${cfg.className}`}>{cfg.label}</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mt-3">
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">On Hand</div>
                      <div className="font-mono font-bold">
                        {item.orderUomUnits > 1
                          ? <>{Math.floor(item.totalOnHand / item.orderUomUnits).toLocaleString()} {item.orderUomLabel.toLowerCase()}{Math.floor(item.totalOnHand / item.orderUomUnits) !== 1 ? "s" : ""}</>
                          : item.totalOnHand.toLocaleString()}
                      </div>
                      {item.orderUomUnits > 1 && <div className="text-[10px] text-muted-foreground font-mono">{item.totalOnHand.toLocaleString()} pcs</div>}
                    </div>
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">Days Supply</div>
                      <div className={`font-mono font-bold ${dosColor(item)}`}>{formatDos(item.daysOfSupply)}</div>
                    </div>
                    <div className="bg-muted/30 p-2 rounded">
                      <div className="text-muted-foreground">{data?.lookbackDays ?? ""}d Usage</div>
                      <div className="font-mono font-bold">
                        {item.periodUsage > 0
                          ? item.orderUomUnits > 1
                            ? <>{Math.floor(item.periodUsage / item.orderUomUnits).toLocaleString()} {item.orderUomLabel.toLowerCase()}{Math.floor(item.periodUsage / item.orderUomUnits) !== 1 ? "s" : ""}</>
                            : item.periodUsage.toLocaleString()
                          : "—"}
                      </div>
                      {item.periodUsage > 0 && item.orderUomUnits > 1 && <div className="text-[10px] text-muted-foreground font-mono">{item.periodUsage.toLocaleString()} pcs</div>}
                    </div>
                  </div>
                  {item.onOrderPieces > 0 && (
                    <div className="mt-2 text-xs bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800/30 rounded p-2 text-blue-800 dark:text-blue-400">
                      On order: <span className="font-mono font-bold">{item.onOrderPieces.toLocaleString()}</span> pcs from {item.openPoCount} PO{item.openPoCount !== 1 ? "s" : ""}
                    </div>
                  )}
                  {item.suggestedOrderQty > 0 && (
                    <div className="mt-2 text-xs bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800/30 rounded p-2">
                      Suggested order: <span className="font-mono font-bold">{item.suggestedOrderQty.toLocaleString()}</span> {item.orderUomUnits > 1 ? item.orderUomLabel.toLowerCase() + (item.suggestedOrderQty !== 1 ? "s" : "") : "pcs"}
                      {item.orderUomUnits > 1 && <span className="text-muted-foreground"> ({item.suggestedOrderPieces.toLocaleString()} pcs)</span>}
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
                  <TableHead className="w-[40px]">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead className="w-[160px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("sku")}>
                    <div className="flex items-center gap-1">SKU <SortIcon field="sku" /></div>
                  </TableHead>
                  <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleSort("name")}>
                    <div className="flex items-center gap-1">Product <SortIcon field="name" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[110px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("onHand")}>
                    <div className="flex items-center justify-end gap-1">On Hand <SortIcon field="onHand" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[90px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("onOrder")}>
                    <div className="flex items-center justify-end gap-1">On Order <SortIcon field="onOrder" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("usage")}>
                    <div className="flex items-center justify-end gap-1">{data?.lookbackDays ?? ""}d Usage <SortIcon field="usage" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[100px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("dos")}>
                    <div className="flex items-center justify-end gap-1">Days Supply <SortIcon field="dos" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[110px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("reorderPt")}>
                    <div className="flex items-center justify-end gap-1">Reorder Pt <SortIcon field="reorderPt" /></div>
                  </TableHead>
                  <TableHead className="text-right w-[110px] cursor-pointer hover:bg-muted/60" onClick={() => handleSort("orderQty")}>
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
                  const canSelect = item.suggestedOrderQty > 0;
                  return (
                    <TableRow key={item.productId} className={selectedIds.has(item.productId) ? "bg-primary/5" : ""}>
                      <TableCell>
                        {canSelect ? (
                          <Checkbox
                            checked={selectedIds.has(item.productId)}
                            onCheckedChange={() => toggleSelect(item.productId)}
                          />
                        ) : <span className="w-4" />}
                      </TableCell>
                      <TableCell className="font-mono font-medium text-primary">{item.sku}</TableCell>
                      <TableCell className="truncate max-w-[200px]">{item.productName}</TableCell>
                      <TableCell className="text-right font-mono font-bold">
                        {item.orderUomUnits > 1 ? (
                          <div>
                            <span>{Math.floor(item.totalOnHand / item.orderUomUnits).toLocaleString()} {item.orderUomLabel.toLowerCase()}{Math.floor(item.totalOnHand / item.orderUomUnits) !== 1 ? "s" : ""}</span>
                            <div className="text-[10px] text-muted-foreground font-normal">{item.totalOnHand.toLocaleString()} pcs</div>
                          </div>
                        ) : (
                          <span>{item.totalOnHand.toLocaleString()}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {item.onOrderPieces > 0 ? (
                          <div>
                            <span className="text-blue-600 font-medium">
                              {item.onOrderQty > 0 && item.orderUomUnits > 1
                                ? <>{item.onOrderQty.toLocaleString()} {item.orderUomLabel.toLowerCase()}{item.onOrderQty !== 1 ? "s" : ""}</>
                                : <>{item.onOrderPieces.toLocaleString()}</>}
                            </span>
                            {item.orderUomUnits > 1 && (
                              <div className="text-[10px] text-muted-foreground">{item.onOrderPieces.toLocaleString()} pcs</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {item.periodUsage > 0 ? (
                          item.orderUomUnits > 1 ? (
                            <div>
                              <span>{Math.floor(item.periodUsage / item.orderUomUnits).toLocaleString()} {item.orderUomLabel.toLowerCase()}{Math.floor(item.periodUsage / item.orderUomUnits) !== 1 ? "s" : ""}</span>
                              <div className="text-[10px]">{item.periodUsage.toLocaleString()} pcs</div>
                            </div>
                          ) : (
                            <span>{item.periodUsage.toLocaleString()}</span>
                          )
                        ) : "—"}
                      </TableCell>
                      <TableCell className={`text-right font-mono ${dosColor(item)}`}>
                        {formatDos(item.daysOfSupply)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">
                        {item.reorderPoint > 0 ? (
                          item.orderUomUnits > 1 ? (
                            <div>
                              <span>{Math.ceil(item.reorderPoint / item.orderUomUnits).toLocaleString()} {item.orderUomLabel.toLowerCase()}{Math.ceil(item.reorderPoint / item.orderUomUnits) !== 1 ? "s" : ""}</span>
                              <div className="text-[10px]">{item.reorderPoint.toLocaleString()} pcs</div>
                            </div>
                          ) : (
                            <span>{item.reorderPoint.toLocaleString()}</span>
                          )
                        ) : "—"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {item.suggestedOrderQty > 0 ? (
                          <div>
                            <span className="font-bold text-orange-600">{item.suggestedOrderQty.toLocaleString()} {item.orderUomUnits > 1 ? item.orderUomLabel.toLowerCase() : "pcs"}{item.suggestedOrderQty !== 1 && item.orderUomUnits > 1 ? "s" : ""}</span>
                            {item.orderUomUnits > 1 && (
                              <div className="text-[10px] text-muted-foreground">{item.suggestedOrderPieces.toLocaleString()} pcs</div>
                            )}
                          </div>
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
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      No items match the current filters
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {filtered.length > 0 && (
            <div className="text-xs text-muted-foreground shrink-0 pt-2">
              Showing {filtered.length} of {data?.items.length ?? 0} products
              {" · "}Quantities shown in ordering UOM where available
            </div>
          )}
        </div>
      )}

      {/* Floating action bar when items selected */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 min-w-[280px]">
          <span className="text-sm font-medium">{selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""} selected</span>
          <div className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            className="h-8"
            onClick={() => setSelectedIds(new Set())}
          >
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
          <Button
            size="sm"
            className="h-8 bg-white text-primary hover:bg-white/90"
            onClick={handleCreatePO}
            disabled={createPoMutation.isPending}
          >
            <ShoppingCart className="h-3 w-3 mr-1" />
            {createPoMutation.isPending ? "Creating..." : "Create PO"}
          </Button>
        </div>
      )}
      </div>
    </div>
  );
}
