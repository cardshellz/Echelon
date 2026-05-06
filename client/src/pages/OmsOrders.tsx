import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShoppingCart,
  Package,
  Truck,
  Clock,
  Search,
  ChevronLeft,
  ChevronRight,
  Store,
  Globe,
  X,
  CheckCircle2,
  AlertCircle,
  Timer,
  Filter,
  Ship,
  ExternalLink,
  RotateCcw,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OmsOrderLine {
  id: number;
  sku: string | null;
  title: string | null;
  variantTitle: string | null;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  fulfillmentStatus: string | null;
  externalLineItemId: string | null;
}

interface OmsOrderEvent {
  id: number;
  eventType: string;
  details: any;
  createdAt: string;
}

interface OmsOrder {
  id: number;
  channelId: number;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  customerName: string | null;
  customerEmail: string | null;
  shipToName: string | null;
  shipToAddress1: string | null;
  shipToAddress2: string | null;
  shipToCity: string | null;
  shipToState: string | null;
  shipToZip: string | null;
  shipToCountry: string | null;
  totalCents: number;
  currency: string;
  warehouseId: number | null;
  trackingNumber: string | null;
  trackingCarrier: string | null;
  shipstationOrderId: number | null;
  shipstationOrderKey: string | null;
  orderedAt: string;
  createdAt: string;
  lines: OmsOrderLine[];
  events?: OmsOrderEvent[];
  channelName?: string;
}

interface OmsStats {
  total: number;
  byStatus: Record<string, number>;
  byChannel: Record<string, number>;
  todayCount: number;
}

interface OmsOpsIssue {
  code: string;
  severity: "critical" | "warning" | "info";
  count: number;
  message: string;
  sample: any[];
}

interface OmsOpsHealth {
  generatedAt: string;
  status: "healthy" | "degraded" | "critical";
  counts: {
    critical: number;
    warning: number;
    info: number;
  };
  issues: OmsOpsIssue[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusColor(status: string): string {
  switch (status) {
    case "pending": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300";
    case "confirmed": return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "processing": return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
    case "shipped": return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
    case "delivered": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
    case "cancelled": return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
    default: return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300";
  }
}

function channelIcon(name: string | undefined) {
  if (!name) return <Store className="h-4 w-4" />;
  const lower = (name || "").toLowerCase();
  if (lower.includes("ebay")) return <Globe className="h-4 w-4 text-blue-500" />;
  if (lower.includes("shopify")) return <ShoppingCart className="h-4 w-4 text-green-500" />;
  return <Store className="h-4 w-4" />;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OmsOrders() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [shipDialog, setShipDialog] = useState<{ orderId: number } | null>(null);
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrier, setCarrier] = useState("USPS");

  const limit = 50;

  // Fetch stats
  const { data: stats } = useQuery<OmsStats>({
    queryKey: ["/api/oms/orders/stats"],
    queryFn: async () => {
      const res = await fetch("/api/oms/orders/stats");
      if (!res.ok) throw new Error("Failed to fetch stats");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const { data: opsHealth } = useQuery<OmsOpsHealth>({
    queryKey: ["/api/oms/ops/health"],
    queryFn: async () => {
      const res = await fetch("/api/oms/ops/health");
      if (!res.ok) throw new Error("Failed to fetch OMS health");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Fetch orders
  const { data: ordersData, isLoading } = useQuery<{ orders: OmsOrder[]; total: number }>({
    queryKey: ["/api/oms/orders", page, search, statusFilter, channelFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (channelFilter !== "all") params.set("channelId", channelFilter);
      const res = await fetch(`/api/oms/orders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch orders");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  // Fetch selected order detail
  const { data: selectedOrder } = useQuery<OmsOrder>({
    queryKey: ["/api/oms/orders", selectedOrderId],
    queryFn: async () => {
      const res = await fetch(`/api/oms/orders/${selectedOrderId}`);
      if (!res.ok) throw new Error("Failed to fetch order");
      return res.json();
    },
    enabled: !!selectedOrderId,
  });

  // Mutations
  const assignWarehouseMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await fetch(`/api/oms/orders/${orderId}/assign-warehouse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouseId: 1 }),
      });
      if (!res.ok) throw new Error("Failed to assign warehouse");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Warehouse assigned" });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
    },
  });

  const pushToShipStationMutation = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await fetch(`/api/oms/orders/${orderId}/push-to-shipstation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to push to ShipStation");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Pushed to ShipStation", description: `SS Order #${data.shipstationOrderId}` });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
    },
    onError: (err: Error) => {
      toast({ title: "ShipStation push failed", description: err.message, variant: "destructive" });
    },
  });

  const markShippedMutation = useMutation({
    mutationFn: async ({ orderId, trackingNumber, carrier }: any) => {
      const res = await fetch(`/api/oms/orders/${orderId}/mark-shipped`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackingNumber, carrier }),
      });
      if (!res.ok) throw new Error("Failed to mark shipped");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Order marked as shipped" });
      setShipDialog(null);
      setTrackingNumber("");
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
    },
  });

  const replayWebhookMutation = useMutation({
    mutationFn: async (inboxId: number) => {
      const res = await fetch(`/api/oms/ops/webhook-inbox/${inboxId}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to queue replay" }));
        throw new Error(err.error || "Failed to queue replay");
      }
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: "Webhook replay queued",
        description: `${result.topic} retry #${result.retryQueueId}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/ops/health"] });
    },
    onError: (err: Error) => {
      toast({ title: "Replay failed", description: err.message, variant: "destructive" });
    },
  });

  const remediateFlowMutation = useMutation({
    mutationFn: async ({ code, row }: { code: string; row: any }) => {
      const res = await fetch("/api/oms/ops/reconciliation/remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          omsOrderId: row.oms_order_id,
          wmsOrderId: row.wms_order_id,
          shipmentId: row.shipment_id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to remediate issue" }));
        throw new Error(err.error || "Failed to remediate issue");
      }
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: result.changed ? "Remediation applied" : "No change needed",
        description: result.action,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/ops/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
    },
    onError: (err: Error) => {
      toast({ title: "Remediation failed", description: err.message, variant: "destructive" });
    },
  });

  const orders = ordersData?.orders || [];
  const total = ordersData?.total || 0;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Orders (OMS)</h1>
          <p className="text-muted-foreground text-sm">Unified order view across all channels</p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Today</span>
            </div>
            <p className="text-2xl font-bold mt-1">{stats?.todayCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-yellow-500" />
              <span className="text-sm text-muted-foreground">Pending</span>
            </div>
            <p className="text-2xl font-bold mt-1">{stats?.byStatus?.pending ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-blue-500" />
              <span className="text-sm text-muted-foreground">Confirmed</span>
            </div>
            <p className="text-2xl font-bold mt-1">{(stats?.byStatus?.confirmed ?? 0) + (stats?.byStatus?.processing ?? 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2">
              <Truck className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Shipped</span>
            </div>
            <p className="text-2xl font-bold mt-1">{stats?.byStatus?.shipped ?? 0}</p>
          </CardContent>
        </Card>
      </div>

      {opsHealth && (
        <Card className={opsHealth.status === "critical" ? "border-red-300" : opsHealth.status === "degraded" ? "border-amber-300" : "border-emerald-300"}>
          <CardHeader className="pb-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertCircle className={opsHealth.status === "healthy" ? "h-4 w-4 text-emerald-600" : opsHealth.status === "degraded" ? "h-4 w-4 text-amber-600" : "h-4 w-4 text-red-600"} />
                OMS/WMS Flow Health
              </CardTitle>
              <div className="flex gap-2">
                <Badge variant={opsHealth.status === "healthy" ? "outline" : "destructive"}>
                  {opsHealth.status}
                </Badge>
                <Badge variant="outline">
                  {opsHealth.counts.critical} critical
                </Badge>
                <Badge variant="outline">
                  {opsHealth.counts.warning} warnings
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {opsHealth.issues.length === 0 ? (
              <div className="text-sm text-muted-foreground">No stuck webhook, WMS, or shipping handoff issues detected.</div>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {opsHealth.issues.map((issue) => (
                  <div key={issue.code} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{issue.message}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{issue.code}</div>
                      </div>
                      <Badge variant={issue.severity === "critical" ? "destructive" : "outline"}>
                        {issue.count}
                      </Badge>
                    </div>
                    {issue.sample.length > 0 && issue.code.startsWith("WEBHOOK_INBOX_") ? (
                      <div className="mt-3 space-y-2">
                        {issue.sample.slice(0, 3).map((row: any) => (
                          <div key={row.id} className="flex items-center justify-between gap-3 rounded bg-muted p-2 text-xs">
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                #{row.id} {row.provider}/{row.topic}
                              </div>
                              <div className="truncate text-muted-foreground">
                                {row.status || "processing"} | attempts {row.attempts ?? 0} | {row.source_domain || "unknown shop"}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 shrink-0 gap-1 px-2"
                              disabled={replayWebhookMutation.isPending}
                              onClick={() => replayWebhookMutation.mutate(Number(row.id))}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Replay
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : issue.sample.length > 0 && (
                      issue.code === "OMS_FINAL_WMS_ACTIVE" ||
                      issue.code === "WMS_FINAL_OMS_OPEN" ||
                      issue.code === "SHIPMENT_SHIPPED_OMS_OPEN" ||
                      issue.code === "WMS_SHIPPED_TRACKING_NOT_CONFIRMED_PUSHED"
                    ) ? (
                      <div className="mt-3 space-y-2">
                        {issue.sample.slice(0, 3).map((row: any) => (
                          <div
                            key={`${issue.code}-${row.oms_order_id || row.wms_order_id || row.shipment_id}`}
                            className="flex items-center justify-between gap-3 rounded bg-muted p-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">
                                {row.external_order_number || row.order_number || `OMS #${row.oms_order_id}`}
                              </div>
                              <div className="truncate text-muted-foreground">
                                OMS {row.oms_order_id || "-"} | WMS {row.wms_order_id || row.order_id || "-"} | Ship {row.shipment_id || "-"}
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 shrink-0 gap-1 px-2"
                              disabled={remediateFlowMutation.isPending}
                              onClick={() => remediateFlowMutation.mutate({ code: issue.code, row })}
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              Fix
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : issue.sample.length > 0 && (
                      <pre className="mt-3 max-h-28 overflow-auto rounded bg-muted p-2 text-xs">
                        {JSON.stringify(issue.sample.slice(0, 3), null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order #, customer, SKU..."
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="shipped">Shipped</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={channelFilter} onValueChange={(v) => { setChannelFilter(v); setPage(1); }}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Channel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Channels</SelectItem>
            <SelectItem value="36">Shopify US</SelectItem>
            <SelectItem value="37">Shopify CA</SelectItem>
            <SelectItem value="67">eBay</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Orders Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Order #</TableHead>
                <TableHead className="w-[80px]">Channel</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="w-[60px] text-center">Items</TableHead>
                <TableHead className="w-[100px] text-right">Total</TableHead>
                <TableHead className="w-[100px]">Status</TableHead>
                <TableHead className="w-[80px]">SS</TableHead>
                <TableHead className="w-[80px]">Warehouse</TableHead>
                <TableHead className="w-[140px]">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    No orders found
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <TableRow
                    key={order.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelectedOrderId(order.id)}
                  >
                    <TableCell className="font-mono text-sm">
                      {order.externalOrderNumber || order.externalOrderId}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {channelIcon(order.channelName)}
                        <span className="text-xs text-muted-foreground">{order.channelName || `Ch ${order.channelId}`}</span>
                      </div>
                    </TableCell>
                    <TableCell className="truncate max-w-[200px]">
                      {order.customerName || "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      {order.lines?.reduce((s, l) => s + l.quantity, 0) || 0}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatCents(order.totalCents, order.currency)}
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(order.status)}`}>
                        {order.status}
                      </span>
                    </TableCell>
                    <TableCell>
                      {order.shipstationOrderId ? (
                        <Badge variant="outline" className="text-xs gap-1 text-blue-600 border-blue-300">
                          <Ship className="h-3 w-3" />
                          SS
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {order.warehouseId ? `WH-${order.warehouseId}` : "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(order.orderedAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((page - 1) * limit) + 1}–{Math.min(page * limit, total)} of {total}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">Page {page} of {totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Order Detail Dialog */}
      <Dialog open={!!selectedOrderId} onOpenChange={(open) => { if (!open) setSelectedOrderId(null); }}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {selectedOrder && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {channelIcon(selectedOrder.channelName)}
                  Order {selectedOrder.externalOrderNumber || selectedOrder.externalOrderId}
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(selectedOrder.status)}`}>
                    {selectedOrder.status}
                  </span>
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                {/* Customer & Shipping */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <h4 className="font-semibold text-sm mb-1">Customer</h4>
                    <p className="text-sm">{selectedOrder.customerName || "—"}</p>
                    <p className="text-sm text-muted-foreground">{selectedOrder.customerEmail || ""}</p>
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm mb-1">Ship To</h4>
                    <p className="text-sm">{selectedOrder.shipToName || "—"}</p>
                    <p className="text-sm text-muted-foreground">
                      {[selectedOrder.shipToAddress1, selectedOrder.shipToCity, selectedOrder.shipToState, selectedOrder.shipToZip]
                        .filter(Boolean).join(", ")}
                    </p>
                    <p className="text-sm text-muted-foreground">{selectedOrder.shipToCountry}</p>
                  </div>
                </div>

                <Separator />

                {/* Line Items */}
                <div>
                  <h4 className="font-semibold text-sm mb-2">Line Items</h4>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead className="text-center">Qty</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedOrder.lines?.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell className="font-mono text-xs">{line.sku || "—"}</TableCell>
                          <TableCell className="text-sm truncate max-w-[200px]">{line.title || "—"}</TableCell>
                          <TableCell className="text-center">{line.quantity}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatCents(line.totalCents)}
                          </TableCell>
                          <TableCell>
                            <span className={`text-xs ${line.fulfillmentStatus === "fulfilled" ? "text-green-600" : "text-muted-foreground"}`}>
                              {line.fulfillmentStatus || "unfulfilled"}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <div className="flex justify-end mt-2">
                    <span className="font-semibold">{formatCents(selectedOrder.totalCents, selectedOrder.currency)}</span>
                  </div>
                </div>

                <Separator />

                {/* Event Timeline */}
                {selectedOrder.events && selectedOrder.events.length > 0 && (
                  <div>
                    <h4 className="font-semibold text-sm mb-2">Timeline</h4>
                    <div className="space-y-2">
                      {selectedOrder.events.map((event) => (
                        <div key={event.id} className="flex items-start gap-2 text-sm">
                          <div className="mt-0.5">
                            {event.eventType === "created" && <CheckCircle2 className="h-4 w-4 text-blue-500" />}
                            {event.eventType === "inventory_reserved" && <Package className="h-4 w-4 text-purple-500" />}
                            {event.eventType === "assigned_warehouse" && <Store className="h-4 w-4 text-orange-500" />}
                            {event.eventType === "shipped" && <Truck className="h-4 w-4 text-green-500" />}
                            {event.eventType === "tracking_pushed" && <Globe className="h-4 w-4 text-green-600" />}
                            {(event.eventType === "pushed_to_shipstation" || event.eventType === "shipped_via_shipstation") && <Ship className="h-4 w-4 text-blue-500" />}
                            {!["created", "inventory_reserved", "assigned_warehouse", "shipped", "tracking_pushed", "pushed_to_shipstation", "shipped_via_shipstation"].includes(event.eventType) && (
                              <Timer className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                          <div>
                            <span className="font-medium capitalize">{event.eventType.replace(/_/g, " ")}</span>
                            <span className="text-muted-foreground ml-2">{formatDate(event.createdAt)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tracking */}
                {selectedOrder.trackingNumber && (
                  <>
                    <Separator />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">Tracking</h4>
                      <p className="text-sm font-mono">
                        {selectedOrder.trackingCarrier}: {selectedOrder.trackingNumber}
                      </p>
                    </div>
                  </>
                )}

                {/* ShipStation Info */}
                {selectedOrder.shipstationOrderId && (
                  <>
                    <Separator />
                    <div>
                      <h4 className="font-semibold text-sm mb-1">ShipStation</h4>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs gap-1 text-blue-600 border-blue-300">
                          <Ship className="h-3 w-3" />
                          SS Order #{selectedOrder.shipstationOrderId}
                        </Badge>
                        <a
                          href={`https://ss.shipstation.com/#/orders/all?orderNumber=${selectedOrder.shipstationOrderKey || ""}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:underline inline-flex items-center gap-1"
                        >
                          Open in ShipStation <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </div>
                  </>
                )}

                <Separator />

                {/* Actions */}
                <div className="flex gap-2 flex-wrap">
                  {!selectedOrder.warehouseId && selectedOrder.status !== "cancelled" && selectedOrder.status !== "shipped" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => assignWarehouseMutation.mutate(selectedOrder.id)}
                      disabled={assignWarehouseMutation.isPending}
                    >
                      Assign Warehouse
                    </Button>
                  )}
                  {!selectedOrder.shipstationOrderId && selectedOrder.status !== "cancelled" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      onClick={() => pushToShipStationMutation.mutate(selectedOrder.id)}
                      disabled={pushToShipStationMutation.isPending}
                    >
                      <Ship className="h-3.5 w-3.5" />
                      {pushToShipStationMutation.isPending ? "Pushing..." : "Push to ShipStation"}
                    </Button>
                  )}
                  {selectedOrder.status !== "shipped" && selectedOrder.status !== "cancelled" && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setShipDialog({ orderId: selectedOrder.id });
                        setSelectedOrderId(null);
                      }}
                    >
                      Mark Shipped
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Ship Dialog */}
      <Dialog open={!!shipDialog} onOpenChange={(open) => { if (!open) setShipDialog(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark Order Shipped</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Carrier</Label>
              <Select value={carrier} onValueChange={setCarrier}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USPS">USPS</SelectItem>
                  <SelectItem value="UPS">UPS</SelectItem>
                  <SelectItem value="FEDEX">FedEx</SelectItem>
                  <SelectItem value="DHL">DHL</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Tracking Number</Label>
              <Input
                value={trackingNumber}
                onChange={(e) => setTrackingNumber(e.target.value)}
                placeholder="Enter tracking number"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShipDialog(null)}>Cancel</Button>
              <Button
                onClick={() => {
                  if (shipDialog) {
                    markShippedMutation.mutate({
                      orderId: shipDialog.orderId,
                      trackingNumber,
                      carrier,
                    });
                  }
                }}
                disabled={!trackingNumber || markShippedMutation.isPending}
              >
                {markShippedMutation.isPending ? "Shipping..." : "Confirm Ship"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
