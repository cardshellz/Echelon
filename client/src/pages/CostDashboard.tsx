import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DollarSign,
  Package,
  AlertTriangle,
  Search,
  ChevronDown,
  ChevronRight,
  Plus,
  Upload,
  Pencil,
  Trash2,
  TrendingUp,
  Layers,
  ArrowUpDown,
  RefreshCw,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// ─── Helpers ────────────────────────────────────────────────────────

function formatCostCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "$0.00";
  const val = Number(cents);
  if (val < 1) {
    return `$${val.toFixed(4)}`;
  }
  return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function formatDollars(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDollarsCents(cents: number | null | undefined): string {
  if (!cents && cents !== 0) return "$0.00";
  return `$${Number(cents).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return d;
  }
}

function formatPct(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

// ─── Main Component ─────────────────────────────────────────────────

export default function CostDashboard() {
  const [activeTab, setActiveTab] = useState("valuation");
  const { toast } = useToast();

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Inventory Cost Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          FIFO cost tracking, valuation, and COGS analysis
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5 lg:w-auto lg:inline-grid">
          <TabsTrigger value="valuation" className="text-xs sm:text-sm">
            <DollarSign className="h-4 w-4 mr-1.5 hidden sm:block" />
            Valuation
          </TabsTrigger>
          <TabsTrigger value="explorer" className="text-xs sm:text-sm">
            <Layers className="h-4 w-4 mr-1.5 hidden sm:block" />
            Explorer
          </TabsTrigger>
          <TabsTrigger value="order-cogs" className="text-xs sm:text-sm">
            <TrendingUp className="h-4 w-4 mr-1.5 hidden sm:block" />
            Order COGS
          </TabsTrigger>
          <TabsTrigger value="manual" className="text-xs sm:text-sm">
            <Plus className="h-4 w-4 mr-1.5 hidden sm:block" />
            Manual Entry
          </TabsTrigger>
          <TabsTrigger value="adjustments" className="text-xs sm:text-sm">
            <ArrowUpDown className="h-4 w-4 mr-1.5 hidden sm:block" />
            Adjustments
          </TabsTrigger>
        </TabsList>

        <TabsContent value="valuation" className="mt-4">
          <ValuationSection />
        </TabsContent>

        <TabsContent value="explorer" className="mt-4">
          <CostExplorer />
        </TabsContent>

        <TabsContent value="order-cogs" className="mt-4">
          <OrderCOGSSection />
        </TabsContent>

        <TabsContent value="manual" className="mt-4">
          <ManualEntrySection />
        </TabsContent>

        <TabsContent value="adjustments" className="mt-4">
          <AdjustmentsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1: VALUATION SUMMARY
// ═══════════════════════════════════════════════════════════════════════

function ValuationSection() {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/cogs/valuation"],
  });

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const valuation = data || {};
  const byProduct: any[] = valuation.byProduct || [];

  return (
    <div className="space-y-6">
      {/* Big Numbers Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-lg">
                <DollarSign className="h-5 w-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Inventory Value</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {formatDollarsCents(valuation.totalValueCents)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg">
                <Package className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Pieces</p>
                <p className="text-2xl font-bold">
                  {(valuation.totalQty || 0).toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-lg">
                <Layers className="h-5 w-5 text-purple-600 dark:text-purple-400" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Products</p>
                <p className="text-2xl font-bold">{byProduct.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {valuation.landedPendingLots > 0 && (
          <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Landed Cost Pending</p>
                  <p className="text-lg font-bold text-amber-600">
                    {valuation.landedPendingLots} lots · {formatDollarsCents(valuation.landedPendingValueCents)}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Product Breakdown Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Product Valuation</CardTitle>
          <CardDescription>Value by product, sorted by total value</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto -mx-6 px-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Avg Cost/Piece</TableHead>
                  <TableHead className="text-right">Total Value</TableHead>
                  <TableHead className="text-right">Lots</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byProduct.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                      No cost data yet. Add manual cost entries or receive inventory with PO costs.
                    </TableCell>
                  </TableRow>
                )}
                {byProduct.map((p: any) => (
                  <TableRow key={p.productId}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div>
                          <p className="font-medium text-sm">{p.productName}</p>
                          <p className="text-xs text-muted-foreground">{p.baseSku}</p>
                        </div>
                        {p.hasLandedPending && (
                          <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Pending
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {p.totalQty.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatCostCents(p.avgCostPerPiece)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-medium">
                      {formatDollarsCents(p.totalValueCents)}
                    </TableCell>
                    <TableCell className="text-right text-sm">{p.activeLots}</TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2: COST EXPLORER
// ═══════════════════════════════════════════════════════════════════════

function CostExplorer() {
  const [search, setSearch] = useState("");
  const [onlyPending, setOnlyPending] = useState(false);
  const [expandedLots, setExpandedLots] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/cogs/lots", { search: debouncedSearch, onlyPending, limit: pageSize, offset: page * pageSize }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (onlyPending) params.set("onlyPending", "true");
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      const res = await fetch(`/api/cogs/lots?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const lots: any[] = data?.lots || [];
  const total = data?.total || 0;

  // Group lots by product
  const grouped = useMemo(() => {
    const map = new Map<number, { product: any; lots: any[] }>();
    for (const lot of lots) {
      const pid = lot.product_id;
      if (!map.has(pid)) {
        map.set(pid, {
          product: { id: pid, name: lot.product_name, baseSku: lot.base_sku },
          lots: [],
        });
      }
      map.get(pid)!.lots.push(lot);
    }
    return Array.from(map.values());
  }, [lots]);

  const toggleExpand = (productId: number) => {
    setExpandedLots(prev => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by SKU, product name, or lot number..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="pl-9"
          />
        </div>
        <Button
          variant={onlyPending ? "default" : "outline"}
          size="sm"
          onClick={() => { setOnlyPending(!onlyPending); setPage(0); }}
          className="whitespace-nowrap"
        >
          <AlertTriangle className="h-4 w-4 mr-1.5" />
          Landed Pending Only
        </Button>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : grouped.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No lots found{search ? ` matching "${search}"` : ""}.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {grouped.map(({ product, lots: productLots }) => {
            const isExpanded = expandedLots.has(product.id);
            const totalQty = productLots.reduce((s: number, l: any) => s + Number(l.qty_on_hand || 0), 0);
            const totalValue = productLots.reduce(
              (s: number, l: any) => s + Number(l.qty_on_hand || 0) * Number(l.total_unit_cost_cents || l.unit_cost_cents || 0),
              0,
            );
            const hasLandedPending = productLots.some(
              (l: any) => Number(l.landed_cost_cents || 0) === 0 && l.inbound_shipment_id,
            );

            return (
              <Card key={product.id}>
                <button
                  onClick={() => toggleExpand(product.id)}
                  className="w-full text-left p-4 hover:bg-muted/50 transition-colors rounded-t-lg"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 min-w-0">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{product.name}</p>
                        <p className="text-xs text-muted-foreground">{product.baseSku}</p>
                      </div>
                      {hasLandedPending && (
                        <Badge variant="outline" className="text-amber-600 border-amber-300 text-xs shrink-0">
                          ⚠️ Landed Pending
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-6 text-sm shrink-0 ml-4">
                      <div className="text-right">
                        <p className="font-mono">{totalQty.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">pieces</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono font-medium">{formatDollarsCents(totalValue)}</p>
                        <p className="text-xs text-muted-foreground">value</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono">{productLots.length}</p>
                        <p className="text-xs text-muted-foreground">lots</p>
                      </div>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 pb-4">
                    <div className="overflow-x-auto -mx-4 px-4">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="text-xs">Lot</TableHead>
                            <TableHead className="text-xs">SKU</TableHead>
                            <TableHead className="text-xs">Received</TableHead>
                            <TableHead className="text-xs text-right">PO Cost</TableHead>
                            <TableHead className="text-xs text-right">Landed</TableHead>
                            <TableHead className="text-xs text-right">Total/pc</TableHead>
                            <TableHead className="text-xs text-right">Qty Recv</TableHead>
                            <TableHead className="text-xs text-right">Remaining</TableHead>
                            <TableHead className="text-xs">Source</TableHead>
                            <TableHead className="text-xs text-right">Age</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {productLots.map((lot: any) => {
                            const landedPending =
                              Number(lot.landed_cost_cents || 0) === 0 && lot.inbound_shipment_id;
                            return (
                              <TableRow key={lot.id} className={landedPending ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}>
                                <TableCell className="font-mono text-xs">
                                  {lot.lot_number}
                                  {lot.batch_number && (
                                    <span className="text-muted-foreground ml-1">({lot.batch_number})</span>
                                  )}
                                </TableCell>
                                <TableCell className="font-mono text-xs">{lot.sku}</TableCell>
                                <TableCell className="text-xs">{formatDate(lot.received_at)}</TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {formatCostCents(lot.po_unit_cost_cents)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {Number(lot.landed_cost_cents || 0) > 0
                                    ? formatCostCents(lot.landed_cost_cents)
                                    : landedPending
                                      ? <span className="text-amber-600">⚠️ $0</span>
                                      : "$0"
                                  }
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs font-medium">
                                  {formatCostCents(lot.total_unit_cost_cents || lot.unit_cost_cents)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {Number(lot.qty_received || 0).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {Number(lot.qty_on_hand || 0).toLocaleString()}
                                </TableCell>
                                <TableCell className="text-xs">
                                  <SourceBadge lot={lot} />
                                </TableCell>
                                <TableCell className="text-right text-xs text-muted-foreground">
                                  {Math.round(Number(lot.age_days || 0))}d
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}

          {/* Pagination */}
          {total > pageSize && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-sm text-muted-foreground">
                Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * pageSize >= total}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceBadge({ lot }: { lot: any }) {
  const source = lot.cost_source || "manual";
  if (source === "po" && lot.po_number) {
    return <Badge variant="outline" className="text-xs">PO {lot.po_number}</Badge>;
  }
  if (source === "po_landed" && lot.shipment_number) {
    return <Badge variant="outline" className="text-xs text-green-600 border-green-300">✓ {lot.shipment_number}</Badge>;
  }
  if (source === "manual") {
    return <Badge variant="secondary" className="text-xs">Manual</Badge>;
  }
  return <Badge variant="outline" className="text-xs">{source}</Badge>;
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3: ORDER COGS
// ═══════════════════════════════════════════════════════════════════════

function OrderCOGSSection() {
  const [orderNumber, setOrderNumber] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());

  const { data: cogsData, isLoading, error } = useQuery<any>({
    queryKey: ["/api/cogs/order", { orderNumber: searchTerm }],
    queryFn: async () => {
      if (!searchTerm) return null;
      const res = await fetch(`/api/cogs/order?orderNumber=${encodeURIComponent(searchTerm)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!searchTerm,
  });

  const handleSearch = () => {
    const cleaned = orderNumber.trim().replace(/^#/, "");
    if (cleaned) setSearchTerm(cleaned);
  };

  const toggleItem = (itemId: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Order COGS Lookup</CardTitle>
          <CardDescription>Search by order number to see cost of goods sold breakdown</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Enter order number (e.g., 1234 or #CS-1234)"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="pl-9"
              />
            </div>
            <Button onClick={handleSearch} disabled={!orderNumber.trim()}>
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading && <LoadingSpinner />}

      {searchTerm && !isLoading && !cogsData && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No order found for "{searchTerm}". Try a different order number.
          </CardContent>
        </Card>
      )}

      {cogsData && (
        <div className="space-y-4">
          {/* Order Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Order Total</p>
                <p className="text-xl font-bold">{formatDollarsCents(cogsData.totalRevenueCents)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">COGS</p>
                <p className="text-xl font-bold text-red-600">{formatDollarsCents(cogsData.totalCogsCents)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Gross Margin</p>
                <p className="text-xl font-bold text-green-600">{formatDollarsCents(cogsData.grossMarginCents)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Margin %</p>
                <p className="text-xl font-bold">{formatPct(cogsData.marginPercent)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Line Items */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Order #{cogsData.orderNumber} — Line Items
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {cogsData.lineItems.map((item: any) => (
                  <div key={item.orderItemId} className="border rounded-lg">
                    <button
                      onClick={() => toggleItem(item.orderItemId)}
                      className="w-full text-left p-3 hover:bg-muted/50 transition-colors flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {expandedItems.has(item.orderItemId) ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{item.productName || item.sku}</p>
                          <p className="text-xs text-muted-foreground">{item.sku} × {item.qty}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-sm shrink-0">
                        <div className="text-right">
                          <p className="font-mono text-xs">COGS: {formatDollarsCents(item.cogsCents)}</p>
                        </div>
                        <div className="text-right">
                          <p className={`font-mono text-xs font-medium ${item.marginCents >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {formatPct(item.marginPercent)}
                          </p>
                        </div>
                      </div>
                    </button>

                    {expandedItems.has(item.orderItemId) && item.lotBreakdown.length > 0 && (
                      <div className="border-t px-3 pb-3">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="text-xs">Lot</TableHead>
                              <TableHead className="text-xs text-right">Qty</TableHead>
                              <TableHead className="text-xs text-right">Unit Cost</TableHead>
                              <TableHead className="text-xs text-right">Total</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {item.lotBreakdown.map((lb: any, i: number) => (
                              <TableRow key={i}>
                                <TableCell className="font-mono text-xs">{lb.lotNumber}</TableCell>
                                <TableCell className="text-right font-mono text-xs">{lb.qty}</TableCell>
                                <TableCell className="text-right font-mono text-xs">{formatCostCents(lb.unitCostCents)}</TableCell>
                                <TableCell className="text-right font-mono text-xs">{formatDollarsCents(lb.totalCostCents)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                ))}

                {cogsData.lineItems.length === 0 && (
                  <p className="text-center text-muted-foreground py-6 text-sm">
                    No COGS data recorded for this order yet.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 4: MANUAL COST ENTRY
// ═══════════════════════════════════════════════════════════════════════

function ManualEntrySection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showBulkDialog, setShowBulkDialog] = useState(false);
  const [editingLot, setEditingLot] = useState<any>(null);

  // Form state
  const [variantId, setVariantId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [landedCost, setLandedCost] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [notes, setNotes] = useState("");

  // Data queries
  const { data: variants } = useQuery<any[]>({
    queryKey: ["/api/inventory/variants"],
  });
  const { data: manualLots, isLoading: lotsLoading } = useQuery<any[]>({
    queryKey: ["/api/cogs/manual-lots"],
  });
  const { data: locations } = useQuery<any[]>({
    queryKey: ["/api/inventory/locations"],
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/cogs/manual-entry", {
        productVariantId: parseInt(variantId),
        warehouseLocationId: parseInt(locationId),
        qty: parseInt(qty),
        unitCostCents: parseFloat(unitCost),
        landedCostCents: landedCost ? parseFloat(landedCost) : undefined,
        batchNumber: batchNumber || undefined,
        receivedAt: receivedAt || undefined,
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/manual-lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/valuation"] });
      toast({ title: "Cost lot created", description: "Manual cost entry saved successfully" });
      // Reset form
      setVariantId("");
      setQty("");
      setUnitCost("");
      setLandedCost("");
      setBatchNumber("");
      setReceivedAt("");
      setNotes("");
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (lotId: number) => {
      const res = await apiRequest("DELETE", `/api/cogs/manual-lots/${lotId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/manual-lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/valuation"] });
      toast({ title: "Deleted", description: "Manual lot removed" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      {/* Entry Form */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Manual Cost Entry</CardTitle>
              <CardDescription>
                Create cost lots for existing inventory without PO linkage.
                All costs in cents per piece.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setShowBulkDialog(true)}>
              <Upload className="h-4 w-4 mr-1.5" />
              Bulk Import
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <Label>Product Variant</Label>
              <Select value={variantId} onValueChange={setVariantId}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Select variant..." />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {(variants || []).map((v: any) => (
                    <SelectItem key={v.id} value={String(v.id)}>
                      {v.sku} — {v.name || v.variantName || "Default"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Location</Label>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Select location..." />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {(locations || []).map((l: any) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.code} — {l.name || l.zone || ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Quantity (pieces)</Label>
              <Input
                type="number"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                placeholder="10000"
                className="mt-1.5"
                min={1}
              />
            </div>

            <div>
              <Label>Unit Cost (cents per piece)</Label>
              <Input
                type="number"
                step="0.0001"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                placeholder="0.0120"
                className="mt-1.5"
                min={0}
              />
            </div>

            <div>
              <Label>Landed Cost (cents per piece, optional)</Label>
              <Input
                type="number"
                step="0.0001"
                value={landedCost}
                onChange={(e) => setLandedCost(e.target.value)}
                placeholder="0.0050"
                className="mt-1.5"
                min={0}
              />
            </div>

            <div>
              <Label>Received Date</Label>
              <Input
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label>Batch Number (optional)</Label>
              <Input
                value={batchNumber}
                onChange={(e) => setBatchNumber(e.target.value)}
                placeholder="BATCH-001"
                className="mt-1.5"
              />
            </div>

            <div>
              <Label>Notes (optional)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Initial inventory load"
                className="mt-1.5"
              />
            </div>
          </div>

          <div className="mt-4">
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!variantId || !locationId || !qty || !unitCost || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <RefreshCw className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-1.5" />
              )}
              Create Cost Lot
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Existing Manual Lots */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Manual Cost Lots</CardTitle>
          <CardDescription>Manually entered cost lots. Can be edited or deleted if unconsumed.</CardDescription>
        </CardHeader>
        <CardContent>
          {lotsLoading ? (
            <LoadingSpinner />
          ) : (
            <div className="overflow-x-auto -mx-6 px-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Lot</TableHead>
                    <TableHead className="text-xs">SKU</TableHead>
                    <TableHead className="text-xs">Product</TableHead>
                    <TableHead className="text-xs">Batch</TableHead>
                    <TableHead className="text-xs text-right">Qty</TableHead>
                    <TableHead className="text-xs text-right">Cost/pc</TableHead>
                    <TableHead className="text-xs text-right">Consumed</TableHead>
                    <TableHead className="text-xs">Created</TableHead>
                    <TableHead className="text-xs"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!manualLots || manualLots.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        No manual cost lots. Use the form above to create one.
                      </TableCell>
                    </TableRow>
                  )}
                  {(manualLots || []).map((lot: any) => (
                    <TableRow key={lot.id}>
                      <TableCell className="font-mono text-xs">{lot.lot_number}</TableCell>
                      <TableCell className="font-mono text-xs">{lot.sku}</TableCell>
                      <TableCell className="text-xs">{lot.product_name}</TableCell>
                      <TableCell className="text-xs">{lot.batch_number || "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {Number(lot.qty_on_hand || 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatCostCents(lot.total_unit_cost_cents || lot.po_unit_cost_cents)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {Number(lot.qty_consumed || 0).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">{formatDate(lot.created_at)}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => setEditingLot(lot)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            disabled={Number(lot.qty_consumed || 0) > 0}
                            onClick={() => {
                              if (confirm("Delete this manual cost lot?")) {
                                deleteMutation.mutate(lot.id);
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bulk Import Dialog */}
      <BulkImportDialog open={showBulkDialog} onOpenChange={setShowBulkDialog} />

      {/* Edit Dialog */}
      {editingLot && (
        <EditManualLotDialog lot={editingLot} onClose={() => setEditingLot(null)} />
      )}
    </div>
  );
}

// ─── Bulk Import Dialog ──────────────────────────────────────────────

function BulkImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pasteData, setPasteData] = useState("");

  const importMutation = useMutation({
    mutationFn: async () => {
      // Parse TSV/CSV paste: SKU\tQty\tUnitCost\tBatch
      const lines = pasteData.trim().split("\n").filter(l => l.trim());
      const entries = lines.map(line => {
        const parts = line.split(/[\t,]/).map(s => s.trim());
        return {
          sku: parts[0],
          qty: parseInt(parts[1]),
          unitCostCents: parseFloat(parts[2]),
          batchNumber: parts[3] || undefined,
        };
      }).filter(e => e.sku && !isNaN(e.qty) && !isNaN(e.unitCostCents));

      if (entries.length === 0) throw new Error("No valid entries found");

      const res = await apiRequest("POST", "/api/cogs/bulk-import", { entries });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/manual-lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/valuation"] });
      toast({
        title: "Import complete",
        description: `${data.imported} imported, ${data.errors?.length || 0} errors`,
      });
      if (data.errors?.length) {
        console.warn("Import errors:", data.errors);
      }
      onOpenChange(false);
      setPasteData("");
    },
    onError: (err: any) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk Cost Import</DialogTitle>
          <DialogDescription>
            Paste from a spreadsheet. Format: SKU, Qty, Unit Cost (cents), Batch (optional).
            One row per line, tab or comma separated.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={10}
          placeholder={"CS-PS-STD-100\t10000\t0.012\tBATCH-001\nCS-TL-35PT-25\t5000\t0.10\tBATCH-001"}
          value={pasteData}
          onChange={(e) => setPasteData(e.target.value)}
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => importMutation.mutate()}
            disabled={!pasteData.trim() || importMutation.isPending}
          >
            {importMutation.isPending ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit Manual Lot Dialog ──────────────────────────────────────────

function EditManualLotDialog({ lot, onClose }: { lot: any; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [unitCost, setUnitCost] = useState(String(lot.total_unit_cost_cents || lot.po_unit_cost_cents || 0));
  const [batchNumber, setBatchNumber] = useState(lot.batch_number || "");
  const [notes, setNotes] = useState(lot.notes || "");

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/cogs/manual-lots/${lot.id}`, {
        unitCostCents: parseFloat(unitCost),
        batchNumber: batchNumber || undefined,
        notes: notes || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/manual-lots"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cogs/valuation"] });
      toast({ title: "Updated", description: "Manual lot updated" });
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Manual Lot {lot.lot_number}</DialogTitle>
          <DialogDescription>{lot.sku} — {lot.product_name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Unit Cost (cents per piece)</Label>
            <Input
              type="number"
              step="0.0001"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>Batch Number</Label>
            <Input
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1.5" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SECTION 5: COST ADJUSTMENTS
// ═══════════════════════════════════════════════════════════════════════

function AdjustmentsSection() {
  const { data: adjustments, isLoading } = useQuery<any[]>({
    queryKey: ["/api/cogs/adjustments"],
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Cost Adjustments</CardTitle>
          <CardDescription>
            When shipment costs are finalized, lot costs are updated. This log tracks all cost changes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSpinner />
          ) : (
            <div className="overflow-x-auto -mx-6 px-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Date</TableHead>
                    <TableHead className="text-xs">Lot</TableHead>
                    <TableHead className="text-xs">SKU</TableHead>
                    <TableHead className="text-xs text-right">Old Cost</TableHead>
                    <TableHead className="text-xs text-right">New Cost</TableHead>
                    <TableHead className="text-xs text-right">Delta</TableHead>
                    <TableHead className="text-xs">Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(!adjustments || adjustments.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-12">
                        No cost adjustments yet. Adjustments appear when shipment costs are finalized
                        and landed costs are pushed to inventory lots.
                      </TableCell>
                    </TableRow>
                  )}
                  {(adjustments || []).map((adj: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{formatDate(adj.adjustedAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{adj.lotNumber}</TableCell>
                      <TableCell className="font-mono text-xs">{adj.sku}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatCostCents(adj.oldCostCents)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-medium">
                        {formatCostCents(adj.newCostCents)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        <span className={adj.deltaCents > 0 ? "text-red-600" : "text-green-600"}>
                          {adj.deltaCents > 0 ? "+" : ""}{formatCostCents(adj.deltaCents)}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-xs">
                          {(adj.reason || "").replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </div>
  );
}

// Simple debounce hook
function useDebounce(value: string, delay: number): string {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
