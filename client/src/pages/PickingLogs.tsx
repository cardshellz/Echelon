import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { 
  Search, 
  Filter, 
  Clock, 
  User,
  Package,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Pause,
  Play,
  ArrowRight,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  FileText
} from "lucide-react";
import { format, subDays } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";

interface PickingLog {
  id: number;
  timestamp: string;
  actionType: string;
  pickerId: string | null;
  pickerName: string | null;
  pickerRole: string | null;
  orderId: number | null;
  orderNumber: string | null;
  orderItemId: number | null;
  sku: string | null;
  itemName: string | null;
  locationCode: string | null;
  qtyRequested: number | null;
  qtyBefore: number | null;
  qtyAfter: number | null;
  qtyDelta: number | null;
  reason: string | null;
  notes: string | null;
  deviceType: string | null;
  sessionId: string | null;
  pickMethod: string | null;
  orderStatusBefore: string | null;
  orderStatusAfter: string | null;
  itemStatusBefore: string | null;
  itemStatusAfter: string | null;
  metadata: Record<string, unknown> | null;
}

interface OrderTimelineResponse {
  order: {
    id: number;
    orderNumber: string;
    shopifyCreatedAt: string | null;
    completedAt: string | null;
  };
  logs: PickingLog[];
  metrics: {
    claimedAt: string | null;
    completedAt: string | null;
    claimToCompleteMs: number | null;
    totalItemsPicked: number;
    shortedItems: number;
    queueWaitMs: number | null;
    c2pMs: number | null;
  };
}

const actionTypeConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  order_claimed: { label: "Order Claimed", icon: User, color: "bg-blue-500" },
  order_released: { label: "Order Released", icon: ArrowRight, color: "bg-orange-500" },
  order_completed: { label: "Order Completed", icon: CheckCircle2, color: "bg-green-500" },
  item_picked: { label: "Picked (Complete)", icon: Package, color: "bg-green-600" },
  item_shorted: { label: "Item Shorted", icon: XCircle, color: "bg-red-500" },
  item_quantity_adjusted: { label: "Picked (+1)", icon: Package, color: "bg-emerald-500" },
  order_held: { label: "Order Held", icon: Pause, color: "bg-purple-500" },
  order_unhold: { label: "Order Unhold", icon: Play, color: "bg-purple-400" },
  order_exception: { label: "Exception", icon: AlertTriangle, color: "bg-red-600" },
  exception_resolved: { label: "Exception Resolved", icon: CheckCircle2, color: "bg-emerald-500" },
};

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

export default function PickingLogs() {
  const [startDate, setStartDate] = useState(format(subDays(new Date(), 7), "yyyy-MM-dd"));
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [actionType, setActionType] = useState<string>("all");
  const [orderNumber, setOrderNumber] = useState("");
  const [sku, setSku] = useState("");
  const [page, setPage] = useState(0);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const pageSize = 50;

  const { data, isLoading, refetch } = useQuery<{ logs: PickingLog[]; count: number }>({
    queryKey: ["picking-logs", startDate, endDate, actionType, orderNumber, sku, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("startDate", new Date(startDate).toISOString());
      params.set("endDate", new Date(endDate + "T23:59:59").toISOString());
      if (actionType !== "all") params.set("actionType", actionType);
      if (orderNumber) params.set("orderNumber", orderNumber);
      if (sku) params.set("sku", sku);
      params.set("limit", String(pageSize));
      params.set("offset", String(page * pageSize));
      
      const res = await fetch(`/api/picking/logs?${params}`);
      if (!res.ok) throw new Error("Failed to fetch logs");
      return res.json();
    },
  });

  const { data: timeline, isLoading: timelineLoading } = useQuery<OrderTimelineResponse>({
    queryKey: ["order-timeline", selectedOrderId],
    queryFn: async () => {
      const res = await fetch(`/api/picking/orders/${selectedOrderId}/timeline`);
      if (!res.ok) throw new Error("Failed to fetch timeline");
      return res.json();
    },
    enabled: !!selectedOrderId,
  });

  const totalPages = data ? Math.ceil(data.count / pageSize) : 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="page-title">Picking Logs</h1>
          <p className="text-muted-foreground">Audit trail of all picking operations</p>
        </div>
        <Button onClick={() => refetch()} variant="outline" data-testid="button-refresh">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Start Date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setPage(0); }}
                data-testid="input-start-date"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">End Date</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setPage(0); }}
                data-testid="input-end-date"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Action Type</label>
              <Select value={actionType} onValueChange={(v) => { setActionType(v); setPage(0); }}>
                <SelectTrigger data-testid="select-action-type">
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Actions</SelectItem>
                  {Object.entries(actionTypeConfig).map(([key, { label }]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Order #</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search order..."
                  value={orderNumber}
                  onChange={(e) => { setOrderNumber(e.target.value); setPage(0); }}
                  className="pl-9"
                  data-testid="input-order-number"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">SKU</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search SKU..."
                  value={sku}
                  onChange={(e) => { setSku(e.target.value); setPage(0); }}
                  className="pl-9"
                  data-testid="input-sku"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Logs ({data?.count || 0} records)
            </CardTitle>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  data-testid="button-prev-page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  data-testid="button-next-page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : data?.logs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No logs found matching your filters
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 px-3">Timestamp</th>
                    <th className="text-left py-2 px-3">Action</th>
                    <th className="text-left py-2 px-3">Method</th>
                    <th className="text-left py-2 px-3">Picker</th>
                    <th className="text-left py-2 px-3">Order</th>
                    <th className="text-left py-2 px-3">SKU</th>
                    <th className="text-left py-2 px-3">Qty</th>
                    <th className="text-left py-2 px-3">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.logs.map((log) => {
                    const config = actionTypeConfig[log.actionType] || {
                      label: log.actionType,
                      icon: FileText,
                      color: "bg-gray-500",
                    };
                    const Icon = config.icon;
                    
                    return (
                      <tr 
                        key={log.id} 
                        className="border-b hover:bg-muted/50 cursor-pointer"
                        onClick={() => log.orderId && setSelectedOrderId(log.orderId)}
                        data-testid={`row-log-${log.id}`}
                      >
                        <td className="py-2 px-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            {format(new Date(log.timestamp), "MMM d, HH:mm:ss")}
                          </div>
                        </td>
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <div className={cn("p-1 rounded", config.color)}>
                              <Icon className="h-3 w-3 text-white" />
                            </div>
                            <span className="font-medium">{config.label}</span>
                          </div>
                        </td>
                        <td className="py-2 px-3">
                          {log.pickMethod ? (
                            <Badge 
                              variant="outline" 
                              className={cn(
                                "text-xs",
                                log.pickMethod === "scan" && "bg-green-50 text-green-700 border-green-200",
                                log.pickMethod === "pick_all" && "bg-amber-50 text-amber-700 border-amber-200",
                                log.pickMethod === "short" && "bg-red-50 text-red-700 border-red-200",
                                log.pickMethod === "button" && "bg-blue-50 text-blue-700 border-blue-200",
                                log.pickMethod === "manual" && "bg-gray-50 text-gray-700 border-gray-200"
                              )}
                            >
                              {log.pickMethod === "pick_all" ? "Pick All" : 
                               log.pickMethod === "short" ? "Short" :
                               log.pickMethod === "scan" ? "Scan" : 
                               log.pickMethod}
                            </Badge>
                          ) : "—"}
                        </td>
                        <td className="py-2 px-3">
                          {log.pickerName || log.pickerId || "—"}
                        </td>
                        <td className="py-2 px-3">
                          {log.orderNumber ? (
                            <Badge variant="outline" className="font-mono">
                              {log.orderNumber}
                            </Badge>
                          ) : "—"}
                        </td>
                        <td className="py-2 px-3">
                          {log.sku ? (
                            <span className="font-mono text-xs">{log.sku}</span>
                          ) : "—"}
                        </td>
                        <td className="py-2 px-3">
                          {log.qtyDelta !== null ? (
                            <span className={cn(
                              "font-mono",
                              log.qtyDelta > 0 ? "text-green-600" : log.qtyDelta < 0 ? "text-red-600" : ""
                            )}>
                              {log.qtyDelta > 0 ? "+" : ""}{log.qtyDelta}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="py-2 px-3">
                          {log.reason && (
                            <span className="text-muted-foreground text-xs truncate max-w-[200px] block">
                              {log.reason}
                            </span>
                          )}
                          {log.locationCode && !log.reason && (
                            <span className="text-muted-foreground text-xs">
                              @ {log.locationCode}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedOrderId} onOpenChange={() => setSelectedOrderId(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Order Timeline: {timeline?.order.orderNumber || "Loading..."}
            </DialogTitle>
          </DialogHeader>
          
          {timelineLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : timeline && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-muted/50 p-3 rounded-lg">
                  <div className="text-xs text-muted-foreground">Queue Wait</div>
                  <div className="text-lg font-semibold">{formatDuration(timeline.metrics.queueWaitMs)}</div>
                </div>
                <div className="bg-muted/50 p-3 rounded-lg">
                  <div className="text-xs text-muted-foreground">Pick Time</div>
                  <div className="text-lg font-semibold">{formatDuration(timeline.metrics.claimToCompleteMs)}</div>
                </div>
                <div className="bg-muted/50 p-3 rounded-lg">
                  <div className="text-xs text-muted-foreground">C2P Time</div>
                  <div className="text-lg font-semibold">{formatDuration(timeline.metrics.c2pMs)}</div>
                </div>
                <div className="bg-muted/50 p-3 rounded-lg">
                  <div className="text-xs text-muted-foreground">Items Picked</div>
                  <div className="text-lg font-semibold">
                    {timeline.metrics.totalItemsPicked}
                    {timeline.metrics.shortedItems > 0 && (
                      <span className="text-red-500 text-sm ml-1">
                        ({timeline.metrics.shortedItems} short)
                      </span>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="space-y-3">
                <h4 className="font-medium">Event Timeline</h4>
                <div className="relative">
                  <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-border" />
                  <div className="space-y-4">
                    {timeline.logs.map((log, i) => {
                      const config = actionTypeConfig[log.actionType] || {
                        label: log.actionType,
                        icon: FileText,
                        color: "bg-gray-500",
                      };
                      const Icon = config.icon;
                      
                      return (
                        <div key={log.id} className="relative flex gap-4 items-start">
                          <div className={cn("z-10 p-1.5 rounded-full shrink-0", config.color)}>
                            <Icon className="h-3 w-3 text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{config.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {format(new Date(log.timestamp), "HH:mm:ss")}
                              </span>
                            </div>
                            {log.pickerName && (
                              <div className="text-sm text-muted-foreground">
                                by {log.pickerName}
                              </div>
                            )}
                            {log.sku && (
                              <div className="text-sm">
                                <span className="font-mono">{log.sku}</span>
                                {log.qtyDelta !== null && (
                                  <span className={cn(
                                    "ml-2 font-mono",
                                    log.qtyDelta > 0 ? "text-green-600" : "text-red-600"
                                  )}>
                                    ({log.qtyDelta > 0 ? "+" : ""}{log.qtyDelta})
                                  </span>
                                )}
                                {log.locationCode && (
                                  <span className="text-muted-foreground ml-2">
                                    @ {log.locationCode}
                                  </span>
                                )}
                              </div>
                            )}
                            {log.reason && (
                              <div className="text-sm text-muted-foreground mt-1">
                                {log.reason}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
