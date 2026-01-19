import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import {
  Search,
  Filter,
  Download,
  X,
  ChevronRight,
  Clock,
  Package,
  User,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Truck,
  XCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Order, OrderItem, PickingLog } from "@shared/schema";

type OrderWithItems = Order & { items: OrderItem[]; pickerName?: string };

interface OrderDetail {
  order: Order;
  items: OrderItem[];
  pickingLogs: PickingLog[];
  picker?: { id: string; displayName: string | null };
}

const DATE_PRESETS = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7days" },
  { label: "Last 30 days", value: "30days" },
  { label: "All time", value: "all" },
];

const STATUS_OPTIONS = [
  { label: "All", value: "" },
  { label: "Completed", value: "completed" },
  { label: "Shipped", value: "shipped" },
  { label: "Exception", value: "exception" },
  { label: "Cancelled", value: "cancelled" },
];

const PRIORITY_OPTIONS = [
  { label: "All", value: "" },
  { label: "Rush", value: "rush" },
  { label: "High", value: "high" },
  { label: "Normal", value: "normal" },
];

function getStatusColor(status: string) {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-800 border-green-200";
    case "shipped":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "exception":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "cancelled":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-gray-100 text-gray-800 border-gray-200";
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "shipped":
      return <Truck className="h-3.5 w-3.5" />;
    case "exception":
      return <AlertTriangle className="h-3.5 w-3.5" />;
    case "cancelled":
      return <XCircle className="h-3.5 w-3.5" />;
    default:
      return null;
  }
}

function getPriorityColor(priority: string) {
  switch (priority) {
    case "rush":
      return "bg-red-100 text-red-800";
    case "high":
      return "bg-orange-100 text-orange-800";
    default:
      return "bg-gray-100 text-gray-600";
  }
}

function getActionLabel(actionType: string): string {
  switch (actionType) {
    case "order_claimed":
      return "Order Claimed";
    case "order_released":
      return "Order Released";
    case "order_completed":
      return "Order Completed";
    case "item_picked":
      return "Item Picked";
    case "item_shorted":
      return "Item Shorted";
    case "item_quantity_adjusted":
      return "Qty Adjusted";
    case "order_held":
      return "Order Held";
    case "order_unhold":
      return "Hold Released";
    case "order_exception":
      return "Exception Created";
    case "exception_resolved":
      return "Exception Resolved";
    default:
      return actionType;
  }
}

function getPickMethodLabel(method: string | null): string {
  switch (method) {
    case "scan":
      return "Scanned";
    case "manual":
      return "Manual (+1)";
    case "pick_all":
      return "Pick All";
    case "short":
      return "Shorted";
    default:
      return method || "";
  }
}

export default function OrderHistory() {
  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState("7days");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [pickerId, setPickerId] = useState("");
  const [sku, setSku] = useState("");
  const [page, setPage] = useState(0);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const pageSize = 25;

  const getDateRange = () => {
    const now = new Date();
    switch (datePreset) {
      case "today":
        return { startDate: startOfDay(now), endDate: endOfDay(now) };
      case "7days":
        return { startDate: startOfDay(subDays(now, 7)), endDate: endOfDay(now) };
      case "30days":
        return { startDate: startOfDay(subDays(now, 30)), endDate: endOfDay(now) };
      default:
        return {};
    }
  };

  const buildQueryParams = () => {
    const params = new URLSearchParams();
    const { startDate, endDate } = getDateRange();
    
    if (search) params.set("orderNumber", search);
    if (status && status !== "all") params.set("status", status);
    if (priority && priority !== "all") params.set("priority", priority);
    if (pickerId && pickerId !== "all") params.set("pickerId", pickerId);
    if (sku) params.set("sku", sku);
    if (startDate) params.set("startDate", startDate.toISOString());
    if (endDate) params.set("endDate", endDate.toISOString());
    params.set("limit", pageSize.toString());
    params.set("offset", (page * pageSize).toString());
    
    return params.toString();
  };

  const { data, isLoading, refetch } = useQuery<{ orders: OrderWithItems[]; total: number }>({
    queryKey: ["orderHistory", search, datePreset, status, priority, pickerId, sku, page],
    queryFn: async () => {
      const res = await fetch(`/api/orders/history?${buildQueryParams()}`);
      if (!res.ok) throw new Error("Failed to fetch order history");
      return res.json();
    },
  });

  const { data: pickers } = useQuery<{ id: string; displayName: string | null; username: string }[]>({
    queryKey: ["pickers"],
    queryFn: async () => {
      const res = await fetch("/api/users");
      if (!res.ok) return [];
      const users = await res.json();
      return users.filter((u: any) => u.role === "picker" || u.role === "lead");
    },
  });

  const { data: orderDetail, isLoading: detailLoading } = useQuery<OrderDetail>({
    queryKey: ["orderDetail", selectedOrderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${selectedOrderId}/detail`);
      if (!res.ok) throw new Error("Failed to fetch order detail");
      return res.json();
    },
    enabled: !!selectedOrderId,
  });

  const handleExport = () => {
    const params = new URLSearchParams();
    const { startDate, endDate } = getDateRange();
    
    if (search) params.set("orderNumber", search);
    if (status && status !== "all") params.set("status", status);
    if (priority && priority !== "all") params.set("priority", priority);
    if (pickerId && pickerId !== "all") params.set("pickerId", pickerId);
    if (sku) params.set("sku", sku);
    if (startDate) params.set("startDate", startDate.toISOString());
    if (endDate) params.set("endDate", endDate.toISOString());
    
    window.location.href = `/api/orders/history/export?${params.toString()}`;
  };

  const clearFilters = () => {
    setSearch("");
    setDatePreset("7days");
    setStatus("");
    setPriority("");
    setPickerId("");
    setSku("");
    setPage(0);
  };

  const hasActiveFilters = search || status || priority || pickerId || sku || datePreset !== "7days";
  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between p-4">
          <div>
            <h1 className="text-2xl font-bold">Order History</h1>
            <p className="text-sm text-muted-foreground">
              Search and view completed orders
            </p>
          </div>
          <Button variant="outline" onClick={handleExport} data-testid="button-export">
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>

        <div className="px-4 pb-4 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search order #, customer name..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
              data-testid="input-search"
            />
          </div>
          <div className="flex gap-2">
            <Select value={datePreset} onValueChange={(v) => { setDatePreset(v); setPage(0); }}>
              <SelectTrigger className="w-[140px]" data-testid="select-date-preset">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" data-testid="button-filters">
                  <Filter className="h-4 w-4 mr-2" />
                  Filters
                  {hasActiveFilters && (
                    <Badge variant="secondary" className="ml-2 h-5 px-1.5">
                      {[search, status, priority, pickerId, sku].filter(Boolean).length + (datePreset !== "7days" ? 1 : 0)}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Filters</SheetTitle>
                </SheetHeader>
                <div className="mt-6 space-y-6">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Status</label>
                    <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
                      <SelectTrigger data-testid="select-status">
                        <SelectValue placeholder="All statuses" />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value || "all"}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm font-medium mb-2 block">Priority</label>
                    <Select value={priority} onValueChange={(v) => { setPriority(v); setPage(0); }}>
                      <SelectTrigger data-testid="select-priority">
                        <SelectValue placeholder="All priorities" />
                      </SelectTrigger>
                      <SelectContent>
                        {PRIORITY_OPTIONS.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value || "all"}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm font-medium mb-2 block">Picker</label>
                    <Select value={pickerId} onValueChange={(v) => { setPickerId(v); setPage(0); }}>
                      <SelectTrigger data-testid="select-picker">
                        <SelectValue placeholder="All pickers" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All pickers</SelectItem>
                        {pickers?.map((picker) => (
                          <SelectItem key={picker.id} value={picker.id}>
                            {picker.displayName || picker.username}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm font-medium mb-2 block">Contains SKU</label>
                    <Input
                      placeholder="Enter SKU..."
                      value={sku}
                      onChange={(e) => { setSku(e.target.value); setPage(0); }}
                      data-testid="input-sku"
                    />
                  </div>

                  <div className="flex gap-2 pt-4">
                    <Button variant="outline" onClick={clearFilters} className="flex-1" data-testid="button-clear-filters">
                      Clear All
                    </Button>
                    <Button onClick={() => setFilterOpen(false)} className="flex-1" data-testid="button-apply-filters">
                      Apply
                    </Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="px-4 pb-3 flex flex-wrap gap-2">
            {search && (
              <Badge variant="secondary" className="gap-1">
                Order: {search}
                <X className="h-3 w-3 cursor-pointer" onClick={() => setSearch("")} />
              </Badge>
            )}
            {status && (
              <Badge variant="secondary" className="gap-1">
                Status: {status}
                <X className="h-3 w-3 cursor-pointer" onClick={() => setStatus("")} />
              </Badge>
            )}
            {priority && (
              <Badge variant="secondary" className="gap-1">
                Priority: {priority}
                <X className="h-3 w-3 cursor-pointer" onClick={() => setPriority("")} />
              </Badge>
            )}
            {pickerId && (
              <Badge variant="secondary" className="gap-1">
                Picker: {pickers?.find(p => p.id === pickerId)?.displayName || pickerId}
                <X className="h-3 w-3 cursor-pointer" onClick={() => setPickerId("")} />
              </Badge>
            )}
            {sku && (
              <Badge variant="secondary" className="gap-1">
                SKU: {sku}
                <X className="h-3 w-3 cursor-pointer" onClick={() => setSku("")} />
              </Badge>
            )}
            {datePreset !== "7days" && (
              <Badge variant="secondary" className="gap-1">
                Date: {DATE_PRESETS.find(p => p.value === datePreset)?.label}
                <X className="h-3 w-3 cursor-pointer" onClick={() => setDatePreset("7days")} />
              </Badge>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <Package className="h-12 w-12 mb-4 opacity-50" />
              <p>No orders found</p>
              <p className="text-sm">Try adjusting your filters</p>
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Picker</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.orders.map((order) => (
                    <TableRow
                      key={order.id}
                      className={`cursor-pointer hover:bg-muted/50 ${selectedOrderId === order.id ? 'bg-muted' : ''}`}
                      onClick={() => setSelectedOrderId(order.id)}
                      data-testid={`row-order-${order.id}`}
                    >
                      <TableCell className="font-medium">
                        #{order.orderNumber}
                        {order.priority !== "normal" && (
                          <Badge variant="outline" className={`ml-2 text-xs ${getPriorityColor(order.priority)}`}>
                            {order.priority}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{order.customerName}</TableCell>
                      <TableCell>
                        <span className="text-muted-foreground">
                          {order.pickedCount}/{order.itemCount}
                        </span>
                      </TableCell>
                      <TableCell>{order.pickerName || "—"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`gap-1 ${getStatusColor(order.status)}`}>
                          {getStatusIcon(order.status)}
                          {order.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {order.completedAt ? format(new Date(order.completedAt), "MMM d, h:mm a") : "—"}
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {totalPages > 1 && (
                <div className="flex items-center justify-between p-4 border-t">
                  <p className="text-sm text-muted-foreground">
                    Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, data?.total || 0)} of {data?.total || 0}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => Math.max(0, p - 1))}
                      disabled={page === 0}
                      data-testid="button-prev-page"
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage(p => p + 1)}
                      disabled={page >= totalPages - 1}
                      data-testid="button-next-page"
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {selectedOrderId && (
          <div className="w-[400px] border-l bg-muted/30 overflow-auto hidden lg:block">
            <OrderDetailPanel
              detail={orderDetail}
              loading={detailLoading}
              onClose={() => setSelectedOrderId(null)}
            />
          </div>
        )}
      </div>

      {selectedOrderId && (
        <Sheet open={!!selectedOrderId} onOpenChange={() => setSelectedOrderId(null)}>
          <SheetContent className="w-full sm:max-w-lg lg:hidden p-0">
            <OrderDetailPanel
              detail={orderDetail}
              loading={detailLoading}
              onClose={() => setSelectedOrderId(null)}
            />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function OrderDetailPanel({
  detail,
  loading,
  onClose,
}: {
  detail?: OrderDetail;
  loading: boolean;
  onClose: () => void;
}) {
  const [itemsOpen, setItemsOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        Select an order to view details
      </div>
    );
  }

  const { order, items, pickingLogs, picker } = detail;

  const cycleTime = order.completedAt && order.startedAt
    ? Math.round((new Date(order.completedAt).getTime() - new Date(order.startedAt).getTime()) / 60000)
    : null;

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold">#{order.orderNumber}</h2>
            <p className="text-sm text-muted-foreground">{order.customerName}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="lg:hidden" data-testid="button-close-detail">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Order Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant="outline" className={`gap-1 ${getStatusColor(order.status)}`}>
                {getStatusIcon(order.status)}
                {order.status}
              </Badge>
            </div>
            {order.priority !== "normal" && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Priority</span>
                <Badge variant="outline" className={getPriorityColor(order.priority)}>
                  {order.priority}
                </Badge>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Picker</span>
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" />
                {picker?.displayName || "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Shopify #</span>
              <span className="font-mono text-xs">{order.shopifyOrderId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{order.createdAt ? format(new Date(order.createdAt), "MMM d, h:mm a") : "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Completed</span>
              <span>{order.completedAt ? format(new Date(order.completedAt), "MMM d, h:mm a") : "—"}</span>
            </div>
            {cycleTime !== null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pick Time</span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  {cycleTime} min
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Shipment</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground italic">Shipment tracking coming soon</p>
          </CardContent>
        </Card>

        <Collapsible open={itemsOpen} onOpenChange={setItemsOpen}>
          <Card>
            <CollapsibleTrigger className="w-full">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Line Items ({items.length})
                </CardTitle>
                {itemsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className="space-y-3">
                {items.map((item) => (
                  <div key={item.id} className="border rounded-lg p-3 text-sm">
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-medium">{item.sku}</span>
                      <Badge variant={item.status === "completed" ? "default" : item.status === "short" ? "destructive" : "secondary"}>
                        {item.pickedQuantity}/{item.quantity}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs line-clamp-1">{item.name}</p>
                    <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                      <span>Location: {item.location}</span>
                      {item.shortReason && (
                        <span className="text-amber-600">Short: {item.shortReason}</span>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>

        <Collapsible open={timelineOpen} onOpenChange={setTimelineOpen}>
          <Card>
            <CollapsibleTrigger className="w-full">
              <CardHeader className="pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Pick Timeline ({pickingLogs.length})
                </CardTitle>
                {timelineOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </CardHeader>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent>
                <div className="space-y-3">
                  {pickingLogs.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic">No picking activity recorded</p>
                  ) : (
                    pickingLogs.map((log) => (
                      <div key={log.id} className="flex gap-3 text-sm">
                        <div className="text-xs text-muted-foreground w-16 shrink-0">
                          {log.timestamp ? format(new Date(log.timestamp), "h:mm a") : ""}
                        </div>
                        <div className="flex-1">
                          <div className="font-medium">{getActionLabel(log.actionType)}</div>
                          {log.sku && (
                            <div className="text-xs text-muted-foreground">
                              {log.sku}
                              {log.qtyDelta !== null && log.qtyDelta !== undefined && (
                                <span className="ml-1">
                                  ({log.qtyDelta > 0 ? '+' : ''}{log.qtyDelta})
                                </span>
                              )}
                              {log.pickMethod && (
                                <Badge variant="outline" className="ml-2 text-xs">
                                  {getPickMethodLabel(log.pickMethod)}
                                </Badge>
                              )}
                            </div>
                          )}
                          {log.reason && (
                            <div className="text-xs text-amber-600">{log.reason}</div>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>
    </ScrollArea>
  );
}
