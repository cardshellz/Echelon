import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
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
  ChevronLeft,
  ChevronRight,
  ReceiptText,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { DateRangePicker, type DateRangeValue } from "@/components/DateRangePicker";

// ─── Types ────────────────────────────────────────────────────────

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

interface FinanceMetric {
  value: number;
  priorValue: number;
  deltaPct: number | null;
}

interface FinanceWaterfall {
  grossSalesCents: FinanceMetric;
  discountCents: FinanceMetric;
  netSalesCents: FinanceMetric;
  shippingCents: FinanceMetric;
  taxCents: FinanceMetric;
  totalCollectedCents: FinanceMetric;
  refundCents: FinanceMetric;
  netRevenueCents: FinanceMetric;
  cogsCents: FinanceMetric;
  grossMarginCents: FinanceMetric;
  grossMarginPct: FinanceMetric;
  orderCount: FinanceMetric;
  avgOrderValueCents: FinanceMetric;
  refundedOrderCount: FinanceMetric;
  cancelledOrderCount: FinanceMetric;
}

interface ChannelBreakdown {
  channelId: number;
  channelName: string;
  provider: string;
  orderCount: number;
  grossSalesCents: number;
  discountCents: number;
  netSalesCents: number;
  shippingCents: number;
  taxCents: number;
  refundCents: number;
  netRevenueCents: number;
  cogsCents: number;
  grossMarginPct: number | null;
  avgOrderValueCents: number;
}

interface FinanceSummary {
  waterfall: FinanceWaterfall;
  channels: ChannelBreakdown[];
  dateRange: { from: string; to: string };
  priorRange: { from: string; to: string };
}

interface FinanceOrderRow {
  id: number;
  externalOrderNumber: string | null;
  channelName: string;
  provider: string;
  orderedAt: string;
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  refundAmountCents: number;
  financialStatus: string;
  status: string;
  customerName: string | null;
  cogsCents: number;
}

interface FinanceOrderList {
  orders: FinanceOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface OrderLineDetail {
  id: number;
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  quantity: number;
  paidPriceCents: number;
  totalPriceCents: number;
  totalDiscountCents: number;
  planDiscountCents: number;
  couponDiscountCents: number;
  taxable: boolean;
}

interface OrderAdjustmentDetail {
  id: number;
  adjustmentType: string;
  quantity: number;
  restockPolicy: string;
  reason: string | null;
  externalLineItemId: string;
  createdAt: string;
}

interface OrderEventDetail {
  eventType: string;
  details: any;
  createdAt: string;
}

interface OrderCostDetail {
  sku: string | null;
  qty: number;
  unitCostCents: number;
  totalCostCents: number;
}

interface FinanceOrderDetail {
  id: number;
  externalOrderNumber: string | null;
  externalOrderId: string;
  channelName: string;
  provider: string;
  status: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  customerName: string | null;
  customerEmail: string | null;
  orderedAt: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  refundAmountCents: number;
  currency: string;
  riskLevel: string | null;
  riskScore: number | null;
  riskRecommendation: string | null;
  lines: OrderLineDetail[];
  adjustments: OrderAdjustmentDetail[];
  costs: OrderCostDetail[];
  events: OrderEventDetail[];
  cogsTotalCents: number;
  netRevenueCents: number;
  grossMarginPct: number | null;
}

// ─── Formatters ───────────────────────────────────────────────────

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCentsCompact(cents: number): string {
  const abs = Math.abs(cents);
  if (abs >= 100_000_00) return `$${(cents / 100_00).toFixed(0)}k`;
  if (abs >= 10_000_00) return `$${(cents / 100_00).toFixed(1)}k`;
  return formatCents(cents);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatPct(n: number | null): string {
  if (n === null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

// ─── Shared Components ────────────────────────────────────────────

function StatusBadge({ value, thresholds }: { value: number; thresholds: { warn: number; critical: number } }) {
  if (value >= thresholds.critical) return <Badge variant="destructive">{value}</Badge>;
  if (value >= thresholds.warn) return <Badge variant="outline" className="border-yellow-500 text-yellow-600">{value}</Badge>;
  return <Badge variant="secondary">{value}</Badge>;
}

function DeltaIndicator({ metric, invert }: { metric: FinanceMetric; invert?: boolean }) {
  if (metric.deltaPct === null) return <span className="text-xs text-muted-foreground">—</span>;
  const isUp = metric.deltaPct > 0;
  const isGood = invert ? !isUp : isUp;
  const color = Math.abs(metric.deltaPct) < 1 ? "text-muted-foreground" : isGood ? "text-green-600" : "text-red-600";
  const Icon = isUp ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {formatPct(metric.deltaPct)}
    </span>
  );
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

function FinanceKpiCard({ title, metric: m, format: fmt, icon: Icon, onClick, invert }: {
  title: string;
  metric: FinanceMetric;
  format: (v: number) => string;
  icon: React.ElementType;
  onClick?: () => void;
  invert?: boolean;
}) {
  return (
    <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={onClick}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{fmt(m.value)}</p>
            <div className="flex items-center gap-2 mt-1">
              <DeltaIndicator metric={m} invert={invert} />
              <span className="text-xs text-muted-foreground">vs prior</span>
            </div>
          </div>
          <Icon className="h-8 w-8 text-muted-foreground/30" />
        </div>
      </CardContent>
    </Card>
  );
}

function PipelineBar({ data }: { data: Record<string, number> }) {
  const total = Object.values(data).reduce((s, v) => s + v, 0);
  if (total === 0) return <p className="text-sm text-muted-foreground">No active orders</p>;
  const colors: Record<string, string> = {
    ready: "bg-blue-400", in_progress: "bg-blue-500", picking: "bg-indigo-400",
    picked: "bg-indigo-500", packing: "bg-violet-400", packed: "bg-violet-500",
    completed: "bg-green-400", ready_to_ship: "bg-emerald-400",
    partially_shipped: "bg-teal-400", on_hold: "bg-yellow-400",
    exception: "bg-red-400", awaiting_3pl: "bg-orange-400",
  };
  return (
    <div>
      <div className="flex h-4 rounded-full overflow-hidden mb-2">
        {Object.entries(data).map(([status, count]) => (
          <div key={status} className={colors[status] || "bg-gray-300"} style={{ width: `${(count / total) * 100}%` }} title={`${status}: ${count}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(data).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([status, count]) => (
          <span key={status} className="text-xs text-muted-foreground">
            <span className={`inline-block w-2 h-2 rounded-full mr-1 ${colors[status] || "bg-gray-300"}`} />
            {status.replace(/_/g, " ")}: {count}
          </span>
        ))}
      </div>
    </div>
  );
}

function FinancialStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    paid: "bg-green-100 text-green-700",
    refunded: "bg-red-100 text-red-700",
    partially_refunded: "bg-orange-100 text-orange-700",
    pending: "bg-yellow-100 text-yellow-700",
    voided: "bg-gray-100 text-gray-700",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${variants[status] || "bg-gray-100 text-gray-600"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ─── Revenue Waterfall Component ──────────────────────────────────

function RevenueWaterfall({ waterfall, onRowClick }: {
  waterfall: FinanceWaterfall;
  onRowClick?: (key: string) => void;
}) {
  const rows: {
    key: string;
    label: string;
    metric: FinanceMetric;
    prefix: string;
    bold?: boolean;
    separator?: boolean;
    invert?: boolean;
    pctOfGross?: number | null;
  }[] = [
    { key: "grossSales", label: "Gross Sales", metric: waterfall.grossSalesCents, prefix: "" },
    { key: "discounts", label: "Discounts", metric: waterfall.discountCents, prefix: "−", invert: true,
      pctOfGross: waterfall.grossSalesCents.value > 0
        ? Math.round((waterfall.discountCents.value / waterfall.grossSalesCents.value) * 1000) / 10
        : null },
    { key: "netSales", label: "Net Sales", metric: waterfall.netSalesCents, prefix: "=", bold: true, separator: true },
    { key: "shipping", label: "Shipping Collected", metric: waterfall.shippingCents, prefix: "+" },
    { key: "tax", label: "Tax Collected", metric: waterfall.taxCents, prefix: "+" },
    { key: "totalCollected", label: "Total Collected", metric: waterfall.totalCollectedCents, prefix: "=", bold: true, separator: true },
    { key: "refunds", label: "Refunds", metric: waterfall.refundCents, prefix: "−", invert: true,
      pctOfGross: waterfall.totalCollectedCents.value > 0
        ? Math.round((waterfall.refundCents.value / waterfall.totalCollectedCents.value) * 1000) / 10
        : null },
    { key: "netRevenue", label: "Net Revenue", metric: waterfall.netRevenueCents, prefix: "=", bold: true, separator: true },
    { key: "cogs", label: "COGS", metric: waterfall.cogsCents, prefix: "−", invert: true },
    { key: "grossMargin", label: "Gross Margin", metric: waterfall.grossMarginCents, prefix: "=", bold: true, separator: true },
  ];

  return (
    <div className="space-y-0">
      {rows.map((row) => (
        <div key={row.key}>
          {row.separator && <div className="border-t border-dashed my-1" />}
          <div
            className={`flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50 cursor-pointer text-sm ${row.bold ? "font-semibold" : ""}`}
            onClick={() => onRowClick?.(row.key)}
          >
            <div className="flex items-center gap-2">
              <span className="w-4 text-muted-foreground text-xs text-center">{row.prefix}</span>
              <span>{row.label}</span>
              {row.pctOfGross !== null && row.pctOfGross !== undefined && (
                <span className="text-xs text-muted-foreground">({row.pctOfGross}%)</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <DeltaIndicator metric={row.metric} invert={row.invert} />
              <span className="w-28 text-right tabular-nums">
                {row.key === "grossMargin"
                  ? `${formatCents(row.metric.value)} (${waterfall.grossMarginPct.value}%)`
                  : formatCents(row.metric.value)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Channel Table Component ──────────────────────────────────────

function ChannelTable({ channels, onChannelClick }: {
  channels: ChannelBreakdown[];
  onChannelClick: (channelId: number) => void;
}) {
  if (channels.length === 0) {
    return <p className="text-sm text-muted-foreground p-4">No channel data for this period.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Channel</TableHead>
          <TableHead className="text-right">Orders</TableHead>
          <TableHead className="text-right">Net Sales</TableHead>
          <TableHead className="text-right">Disc %</TableHead>
          <TableHead className="text-right">Refunds</TableHead>
          <TableHead className="text-right">Net Revenue</TableHead>
          <TableHead className="text-right">Margin</TableHead>
          <TableHead className="text-right">AOV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {channels.map((ch) => (
          <TableRow
            key={ch.channelId}
            className="cursor-pointer hover:bg-muted/50"
            onClick={() => onChannelClick(ch.channelId)}
          >
            <TableCell>
              <div className="flex items-center gap-2">
                <span className="font-medium">{ch.channelName}</span>
                <span className="text-xs text-muted-foreground">{ch.provider}</span>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(ch.orderCount)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCentsCompact(ch.netSalesCents)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {ch.grossSalesCents > 0 ? `${((ch.discountCents / ch.grossSalesCents) * 100).toFixed(1)}%` : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatCentsCompact(ch.refundCents)}</TableCell>
            <TableCell className="text-right tabular-nums font-medium">{formatCentsCompact(ch.netRevenueCents)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {ch.grossMarginPct !== null ? `${ch.grossMarginPct}%` : "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatCents(ch.avgOrderValueCents)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─── Order List Sheet ─────────────────────────────────────────────

function OrderListSheet({ open, onOpenChange, fromStr, toStr, channelId, title }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  fromStr: string;
  toStr: string;
  channelId?: number;
  title: string;
}) {
  const [page, setPage] = React.useState(1);
  const [selectedOrderId, setSelectedOrderId] = React.useState<number | null>(null);

  React.useEffect(() => { setPage(1); }, [fromStr, toStr, channelId]);

  const channelParam = channelId ? `&channelId=${channelId}` : "";
  const { data, isLoading } = useQuery<FinanceOrderList>({
    queryKey: ["/api/finance/orders", fromStr, toStr, channelId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/finance/orders?from=${fromStr}&to=${toStr}&page=${page}&pageSize=50${channelParam}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <>
      <Sheet open={open && !selectedOrderId} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{title}</SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {isLoading ? (
              <p className="text-muted-foreground">Loading orders...</p>
            ) : !data || data.orders.length === 0 ? (
              <p className="text-muted-foreground">No orders found.</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-3">{formatNumber(data.total)} orders total</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Refund</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.orders.map((o) => (
                      <TableRow
                        key={o.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setSelectedOrderId(o.id)}
                      >
                        <TableCell className="font-medium">{o.externalOrderNumber || `#${o.id}`}</TableCell>
                        <TableCell>
                          <span className="text-xs">{o.channelName}</span>
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {format(new Date(o.orderedAt), "MM/dd HH:mm")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatCents(o.totalCents)}</TableCell>
                        <TableCell><FinancialStatusBadge status={o.financialStatus} /></TableCell>
                        <TableCell className="text-right tabular-nums">
                          {o.refundAmountCents > 0 ? formatCents(o.refundAmountCents) : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      <ChevronLeft className="h-4 w-4 mr-1" /> Prev
                    </Button>
                    <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
                    <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                      Next <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <OrderDetailSheet
        orderId={selectedOrderId}
        open={!!selectedOrderId}
        onOpenChange={(v) => { if (!v) setSelectedOrderId(null); }}
        onBack={() => setSelectedOrderId(null)}
      />
    </>
  );
}

// ─── Order Detail Sheet ───────────────────────────────────────────

function OrderDetailSheet({ orderId, open, onOpenChange, onBack }: {
  orderId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onBack: () => void;
}) {
  const { data, isLoading } = useQuery<FinanceOrderDetail>({
    queryKey: ["/api/finance/orders", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/finance/orders/${orderId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open && !!orderId,
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <SheetTitle>
              {data ? `Order ${data.externalOrderNumber || `#${data.id}`}` : "Order Detail"}
            </SheetTitle>
          </div>
        </SheetHeader>
        {isLoading ? (
          <p className="text-muted-foreground mt-4">Loading...</p>
        ) : !data ? (
          <p className="text-muted-foreground mt-4">Order not found.</p>
        ) : (
          <div className="mt-4 space-y-6">
            {/* Header info */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Channel</p>
                <p className="font-medium">{data.channelName} ({data.provider})</p>
              </div>
              <div>
                <p className="text-muted-foreground">Ordered</p>
                <p className="font-medium">{format(new Date(data.orderedAt), "MMM d, yyyy HH:mm")}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Status</p>
                <FinancialStatusBadge status={data.financialStatus} />
              </div>
              <div>
                <p className="text-muted-foreground">Customer</p>
                <p className="font-medium">{data.customerName || "—"}</p>
              </div>
              {data.riskLevel && (
                <div>
                  <p className="text-muted-foreground">Risk</p>
                  <p className="font-medium">
                    {data.riskLevel}
                    {data.riskScore !== null && ` (${data.riskScore})`}
                    {data.riskRecommendation && ` — ${data.riskRecommendation}`}
                  </p>
                </div>
              )}
            </div>

            {/* Line items */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Line Items</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Discount</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm">{line.title || "Unknown"}</p>
                          {line.variantTitle && <p className="text-xs text-muted-foreground">{line.variantTitle}</p>}
                          {line.sku && <p className="text-xs text-muted-foreground">{line.sku}</p>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{line.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCents(line.paidPriceCents)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.totalDiscountCents > 0 ? formatCents(line.totalDiscountCents) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCents(line.totalPriceCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Financial summary */}
            <div>
              <h3 className="text-sm font-semibold mb-2">Financial Summary</h3>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{formatCents(data.subtotalCents)}</span></div>
                {data.discountCents > 0 && (
                  <div className="flex justify-between text-muted-foreground"><span>Discounts</span><span className="tabular-nums">−{formatCents(data.discountCents)}</span></div>
                )}
                {data.shippingCents > 0 && (
                  <div className="flex justify-between text-muted-foreground"><span>Shipping</span><span className="tabular-nums">{formatCents(data.shippingCents)}</span></div>
                )}
                {data.taxCents > 0 && (
                  <div className="flex justify-between text-muted-foreground"><span>Tax</span><span className="tabular-nums">{formatCents(data.taxCents)}</span></div>
                )}
                <div className="flex justify-between font-semibold border-t pt-1"><span>Total</span><span className="tabular-nums">{formatCents(data.totalCents)}</span></div>
                {data.refundAmountCents > 0 && (
                  <div className="flex justify-between text-red-600"><span>Refunded</span><span className="tabular-nums">−{formatCents(data.refundAmountCents)}</span></div>
                )}
                {data.cogsTotalCents > 0 && (
                  <>
                    <div className="flex justify-between text-muted-foreground"><span>COGS</span><span className="tabular-nums">−{formatCents(data.cogsTotalCents)}</span></div>
                    <div className="flex justify-between font-semibold border-t pt-1">
                      <span>Gross Margin</span>
                      <span className="tabular-nums">
                        {formatCents(data.netRevenueCents - data.cogsTotalCents)}
                        {data.grossMarginPct !== null && ` (${data.grossMarginPct}%)`}
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* COGS breakdown */}
            {data.costs.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Cost Basis</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Unit Cost</TableHead>
                      <TableHead className="text-right">Total Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.costs.map((c, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{c.sku || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.qty}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCents(c.unitCostCents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCents(c.totalCostCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Adjustments */}
            {data.adjustments.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Adjustments</h3>
                <div className="space-y-2">
                  {data.adjustments.map((adj) => (
                    <div key={adj.id} className="flex items-start gap-2 text-sm border rounded p-2">
                      <Badge variant="outline" className="text-xs">{adj.adjustmentType}</Badge>
                      <div>
                        <p>qty {adj.quantity} &middot; restock: {adj.restockPolicy}</p>
                        {adj.reason && <p className="text-xs text-muted-foreground">{adj.reason}</p>}
                        <p className="text-xs text-muted-foreground">{format(new Date(adj.createdAt), "MMM d HH:mm")}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Event timeline */}
            {data.events.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold mb-2">Timeline</h3>
                <div className="space-y-1">
                  {data.events.map((evt, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm py-1">
                      <span className="text-xs text-muted-foreground tabular-nums w-28">
                        {format(new Date(evt.createdAt), "MM/dd HH:mm")}
                      </span>
                      <Badge variant="secondary" className="text-xs">{evt.eventType.replace(/_/g, " ")}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [alertDismissed, setAlertDismissed] = React.useState(false);
  const [dateRange, setDateRange] = React.useState<DateRangeValue>(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 29);
    return { from, to };
  });

  // Drill-down state
  const [orderListOpen, setOrderListOpen] = React.useState(false);
  const [drillChannelId, setDrillChannelId] = React.useState<number | undefined>();
  const [drillTitle, setDrillTitle] = React.useState("Orders");

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

  const { data: finance, isLoading: financeLoading } = useQuery<FinanceSummary>({
    queryKey: ["/api/finance/summary", fromStr, toStr],
    queryFn: async () => {
      const res = await fetch(`/api/finance/summary?from=${fromStr}&to=${toStr}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load finance summary");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const triggerSyncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sync/recover-orders", { method: "POST", credentials: "include" });
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
      queryClient.invalidateQueries({ queryKey: ["/api/finance/summary"] });
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
  const wf = finance?.waterfall;

  const hasIssues = data && (
    (orderPipeline?.stuckOrders ?? 0) > 0 ||
    (shipmentHealth?.unpushed ?? 0) > 0 ||
    (shipmentHealth?.requiresReview ?? 0) > 0 ||
    (inventoryHealth?.negativeInventory ?? 0) > 0 ||
    (webhookHealth?.deadLetters ?? 0) > 0 ||
    (procurementPipeline?.overduePoCount ?? 0) > 0
  );

  function openOrderDrill(channelId?: number, title?: string) {
    setDrillChannelId(channelId);
    setDrillTitle(title || "Orders");
    setOrderListOpen(true);
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6 max-w-[1600px] mx-auto">
      {/* Sync Alert Banner */}
      {showSyncAlert && (
        <Alert variant="destructive" className="border-red-500 bg-red-50 dark:bg-red-950/20">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle className="flex items-center justify-between">
            <span>Order Sync Alert</span>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => triggerSyncMutation.mutate()} disabled={triggerSyncMutation.isPending} className="h-7" data-testid="button-sync-now">
                {triggerSyncMutation.isPending ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Sync Now
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAlertDismissed(true)} className="h-7 w-7 p-0" data-testid="button-dismiss-sync-alert">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </AlertTitle>
          <AlertDescription>
            {syncHealth?.alertMessage || "Orders may not be syncing properly."}
            {syncHealth?.unsynced24h > 0 && <span className="ml-2 font-medium">({syncHealth.unsynced24h} orders pending)</span>}
          </AlertDescription>
        </Alert>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-xs md:text-sm text-muted-foreground mt-1">
            {data ? `Updated ${new Date(data.generatedAt).toLocaleTimeString()}` : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasIssues && (
            <Badge variant="destructive" className="text-sm px-3 py-1">
              <AlertTriangle className="h-4 w-4 mr-1" /> Issues Detected
            </Badge>
          )}
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      {/* Top Finance KPI Cards */}
      {wf ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-4">
          <FinanceKpiCard title="Orders" metric={wf.orderCount} format={formatNumber} icon={ShoppingCart} onClick={() => openOrderDrill()} />
          <FinanceKpiCard title="Net Revenue" metric={wf.netRevenueCents} format={formatCents} icon={DollarSign} onClick={() => openOrderDrill()} />
          <FinanceKpiCard title="Refunds" metric={wf.refundCents} format={formatCents} icon={ReceiptText} invert onClick={() => openOrderDrill()} />
          <FinanceKpiCard title="Avg Order" metric={wf.avgOrderValueCents} format={formatCents} icon={TrendingUp} />
          <KpiCard
            title="Shipped"
            value={isLoading ? "—" : formatNumber(shipmentHealth?.shippedInRange ?? 0)}
            icon={Truck}
            onClick={() => navigate("/orders")}
          />
          <KpiCard
            title="Inventory Value"
            value={isLoading ? "—" : formatCents(financialKpis?.inventoryValueCents ?? 0)}
            icon={Warehouse}
            onClick={() => navigate("/inventory/costs")}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-2 md:gap-4">
          <KpiCard title="Orders" value={isLoading ? "—" : formatNumber(financialKpis?.orderCount ?? 0)} icon={ShoppingCart} onClick={() => navigate("/orders")} />
          <KpiCard title="Revenue" value={isLoading ? "—" : formatCents(financialKpis?.revenueCents ?? 0)} icon={DollarSign} />
          <KpiCard title="Shipped" value={isLoading ? "—" : formatNumber(shipmentHealth?.shippedInRange ?? 0)} icon={Truck} onClick={() => navigate("/orders")} />
          <KpiCard title="Low Stock" value={isLoading ? "—" : (inventoryHealth?.lowStockSkus ?? 0)} icon={AlertCircle} alert={(inventoryHealth?.lowStockSkus ?? 0) > 0} onClick={() => navigate("/inventory")} />
          <KpiCard title="Inventory Value" value={isLoading ? "—" : formatCents(financialKpis?.inventoryValueCents ?? 0)} icon={Warehouse} onClick={() => navigate("/inventory/costs")} />
          <KpiCard title="Open PO Value" value={isLoading ? "—" : formatCents(financialKpis?.openPoValueCents ?? 0)} icon={FileText} onClick={() => navigate("/purchase-orders")} />
        </div>
      )}

      {/* Tabbed Sections */}
      <Tabs defaultValue="finance" className="space-y-4">
        <TabsList>
          <TabsTrigger value="finance">Finance</TabsTrigger>
          <TabsTrigger value="operations">Operations</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="procurement">Procurement</TabsTrigger>
          <TabsTrigger value="system">System Health</TabsTrigger>
        </TabsList>

        {/* Finance Tab */}
        <TabsContent value="finance" className="space-y-4">
          {financeLoading ? (
            <p className="text-muted-foreground">Loading financial data...</p>
          ) : !finance ? (
            <p className="text-muted-foreground">Unable to load financial data.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Revenue Waterfall</CardTitle>
                  <CardDescription>Full financial breakdown for selected period</CardDescription>
                </CardHeader>
                <CardContent>
                  <RevenueWaterfall
                    waterfall={finance.waterfall}
                    onRowClick={(key) => {
                      if (key === "refunds") openOrderDrill(undefined, "Refunded Orders");
                      else openOrderDrill(undefined, "All Orders");
                    }}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">By Channel</CardTitle>
                  <CardDescription>Revenue breakdown across sales channels</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <ChannelTable
                    channels={finance.channels}
                    onChannelClick={(chId) => {
                      const ch = finance.channels.find((c) => c.channelId === chId);
                      openOrderDrill(chId, ch ? `${ch.channelName} Orders` : "Channel Orders");
                    }}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

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
                    <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>View All <ArrowRight className="h-4 w-4 ml-1" /></Button>
                  </div>
                  <CardDescription>{orderPipeline?.total ?? 0} active orders</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <PipelineBar data={orderPipeline?.byStatus ?? {}} />
                  <div className="grid grid-cols-3 gap-4 pt-2">
                    <div>
                      <p className="text-xs text-muted-foreground">Stuck ({">"}48h)</p>
                      <p className="text-lg font-semibold"><StatusBadge value={orderPipeline?.stuckOrders ?? 0} thresholds={{ warn: 1, critical: 5 }} /></p>
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
                    <Button variant="ghost" size="sm" onClick={() => navigate("/orders")}>View All <ArrowRight className="h-4 w-4 ml-1" /></Button>
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
                      {Object.entries(shipmentHealth?.byStatus ?? {}).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([status, count]) => (
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
                <KpiCard title="Total SKUs" value={formatNumber(inventoryHealth?.totalSkus ?? 0)} icon={Package} onClick={() => navigate("/inventory")} />
                <KpiCard title="On Hand" value={formatNumber(inventoryHealth?.totalOnHand ?? 0)} subtitle={`${formatNumber(inventoryHealth?.totalReserved ?? 0)} reserved`} icon={Warehouse} />
                <KpiCard title="Available" value={formatNumber(inventoryHealth?.totalAvailable ?? 0)} icon={CheckCircle2} />
                <KpiCard title="Negative Inventory" value={inventoryHealth?.negativeInventory ?? 0} icon={XCircle} alert={(inventoryHealth?.negativeInventory ?? 0) > 0} onClick={() => navigate("/inventory")} />
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
                <KpiCard title="Open POs" value={procurementPipeline?.openPoCount ?? 0} subtitle={formatCents(procurementPipeline?.openPoValue ?? 0)} icon={FileText} onClick={() => navigate("/purchase-orders")} />
                <KpiCard title="Draft POs" value={procurementPipeline?.draftPoCount ?? 0} icon={FileText} onClick={() => navigate("/purchase-orders")} />
                <KpiCard title="Overdue POs" value={procurementPipeline?.overduePoCount ?? 0} icon={Clock} alert={(procurementPipeline?.overduePoCount ?? 0) > 0} onClick={() => navigate("/purchase-orders")} />
                <KpiCard title="In Transit" value={procurementPipeline?.inTransitShipments ?? 0} icon={Truck} onClick={() => navigate("/shipments")} />
                <KpiCard title="Expected (30d)" value={procurementPipeline?.expectedReceiptsNext30Days ?? 0} subtitle="receipts expected" icon={Calendar} />
                <KpiCard
                  title="Forward Demand"
                  value={`${(forwardDemand?.activeEvents ?? 0) + (forwardDemand?.plannedEvents ?? 0)} events`}
                  subtitle={`${formatNumber(forwardDemand?.totalForwardDemandPieces ?? 0)} pcs across ${forwardDemand?.productsWithForwardDemand ?? 0} products`}
                  icon={TrendingUp}
                  onClick={() => navigate("/demand-planner")}
                />
              </div>
              <Card>
                <CardHeader><CardTitle className="text-lg">Quick Actions</CardTitle></CardHeader>
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

      {/* Order drill-down sheet */}
      <OrderListSheet
        open={orderListOpen}
        onOpenChange={setOrderListOpen}
        fromStr={fromStr}
        toStr={toStr}
        channelId={drillChannelId}
        title={drillTitle}
      />
    </div>
  );
}
