import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, subDays, startOfDay, endOfDay } from "date-fns";
import {
  Search, Filter, Download, X, ChevronRight, Package,
  Calendar, CheckCircle2, AlertTriangle, Truck, XCircle
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { OmsOrder, OmsOrderLine } from "@shared/schema";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

type OrderWithItems = OmsOrder & { items: OmsOrderLine[]; channelProvider?: string | null };

function getChannelBadgeStyle(provider: string | null | undefined): { className: string; label: string } {
  switch (provider?.toLowerCase()) {
    case "shopify": return { className: "bg-green-100 text-green-700 border-green-300", label: "Shopify" };
    case "amazon": return { className: "bg-orange-100 text-orange-700 border-orange-300", label: "Amazon" };
    case "ebay": return { className: "bg-blue-100 text-blue-700 border-blue-300", label: "eBay" };
    case "etsy": return { className: "bg-orange-50 text-orange-600 border-orange-200", label: "Etsy" };
    default: return { className: "bg-gray-100 text-gray-600 border-gray-300", label: provider || "Unknown" };
  }
}

const CHANNEL_OPTIONS = [
  { label: "All Channels", value: "" },
  { label: "Shopify", value: "shopify" },
  { label: "Amazon", value: "amazon" },
  { label: "eBay", value: "ebay" },
];

const DATE_PRESETS = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7days" },
  { label: "Last 30 days", value: "30days" },
  { label: "All time", value: "all" },
];

const STATUS_OPTIONS = [
  { label: "All", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Processing", value: "processing" },
  { label: "Shipped", value: "shipped" },
  { label: "Delivered", value: "delivered" },
  { label: "Cancelled", value: "cancelled" },
];

function getStatusColor(status: string) {
  switch (status?.toLowerCase()) {
    case "pending": return "bg-sky-100 text-sky-800 border-sky-200";
    case "confirmed": return "bg-purple-100 text-purple-800 border-purple-200";
    case "processing": return "bg-amber-100 text-amber-800 border-amber-200";
    case "shipped": case "delivered": return "bg-green-100 text-green-800 border-green-200";
    case "cancelled": return "bg-red-100 text-red-800 border-red-200";
    default: return "bg-gray-100 text-gray-800 border-gray-200";
  }
}

interface OrderDetail { order: OmsOrder; items: OmsOrderLine[]; events: any[]; }

export default function OrderHistory() {
  const [search, setSearch] = useState("");
  const [datePreset, setDatePreset] = useState("7days");
  const [status, setStatus] = useState("");
  const [sku, setSku] = useState("");
  const [channel, setChannel] = useState("");
  const [page, setPage] = useState(0);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const isMobile = useIsMobile();
  const pageSize = 25;

  const getDateRange = () => {
    const now = new Date();
    switch (datePreset) {
      case "today": return { startDate: startOfDay(now), endDate: endOfDay(now) };
      case "7days": return { startDate: startOfDay(subDays(now, 7)), endDate: endOfDay(now) };
      case "30days": return { startDate: startOfDay(subDays(now, 30)), endDate: endOfDay(now) };
      default: return {};
    }
  };

  const buildQueryParams = () => {
    const params = new URLSearchParams();
    const { startDate, endDate } = getDateRange();
    if (search) params.set("search", search);
    if (status && status !== "all") params.set("status", status);
    if (sku) params.set("sku", sku);
    if (channel && channel !== "all") params.set("channel", channel);
    if (startDate) params.set("startDate", startDate.toISOString());
    if (endDate) params.set("endDate", endDate.toISOString());
    params.set("limit", pageSize.toString());
    params.set("offset", (page * pageSize).toString());
    return params.toString();
  };

  const { data, isLoading } = useQuery<{ orders: OrderWithItems[]; total: number }>({
    queryKey: ["orderHistory", search, datePreset, status, sku, channel, page],
    queryFn: async () => {
      const res = await fetch(`/api/orders/history?${buildQueryParams()}`);
      if (!res.ok) throw new Error("Failed to fetch order history");
      return res.json();
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
    if (search) params.set("search", search);
    if (status && status !== "all") params.set("status", status);
    if (sku) params.set("sku", sku);
    if (channel && channel !== "all") params.set("channel", channel);
    if (startDate) params.set("startDate", startDate.toISOString());
    if (endDate) params.set("endDate", endDate.toISOString());
    window.location.href = `/api/orders/history/export?${params.toString()}`;
  };

  const clearFilters = () => { setSearch(""); setDatePreset("7days"); setStatus(""); setSku(""); setChannel(""); setPage(0); };
  const hasActiveFilters = search || status || sku || channel || datePreset !== "7days";
  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-2 md:p-6">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Order History</h1>
            <p className="text-xs md:text-sm text-muted-foreground">Search and view all orders</p>
          </div>
          <Button variant="outline" onClick={handleExport} className="min-h-[44px]">
            <Download className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">Export CSV</span>
            <span className="sm:hidden">Export</span>
          </Button>
        </div>

        <div className="px-2 md:px-6 pb-4 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search order #, customer name..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} className="pl-9 h-11" autoComplete="off" />
          </div>
          <div className="flex gap-2">
            <Select value={datePreset} onValueChange={(v) => { setDatePreset(v); setPage(0); }}>
              <SelectTrigger className="w-[140px] h-11"><Calendar className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
              <SelectContent>{DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
            </Select>

            <Sheet open={filterOpen} onOpenChange={setFilterOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" className="min-h-[44px]">
                  <Filter className="h-4 w-4 mr-2" />
                  Filters
                  {hasActiveFilters && <Badge variant="secondary" className="ml-2 h-5 px-1.5">{[search, status, sku].filter(Boolean).length + (datePreset !== "7days" ? 1 : 0)}</Badge>}
                </Button>
              </SheetTrigger>
              <SheetContent className="max-h-[90vh] overflow-y-auto">
                <SheetHeader><SheetTitle>Filters</SheetTitle></SheetHeader>
                <div className="mt-6 space-y-6">
                  <div>
                    <label className="text-sm font-medium mb-2 block">Status</label>
                    <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
                      <SelectTrigger className="h-11"><SelectValue placeholder="All statuses" /></SelectTrigger>
                      <SelectContent>{STATUS_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value || "all"}>{opt.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block">Contains SKU</label>
                    <Input placeholder="Enter SKU..." value={sku} onChange={(e) => { setSku(e.target.value); setPage(0); }} className="h-11" />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block">Channel</label>
                    <Select value={channel} onValueChange={(v) => { setChannel(v); setPage(0); }}>
                      <SelectTrigger className="h-11"><SelectValue placeholder="All channels" /></SelectTrigger>
                      <SelectContent>{CHANNEL_OPTIONS.map(opt => <SelectItem key={opt.value} value={opt.value || "all"}>{opt.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2 pt-4">
                    <Button variant="outline" onClick={clearFilters} className="flex-1 min-h-[44px]">Clear All</Button>
                    <Button onClick={() => setFilterOpen(false)} className="flex-1 min-h-[44px]">Apply</Button>
                  </div>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="p-4 space-y-3">{[...Array(10)].map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
          ) : data?.orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground"><Package className="h-12 w-12 mb-4 opacity-50" /><p>No orders found</p></div>
          ) : (
            <>
              {/* Mobile card layout */}
              <div className="md:hidden p-2 space-y-3">
                {data?.orders.map((order) => {
                  const itemCount = order.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
                  return (
                  <Card key={order.id} className={cn("cursor-pointer transition-colors hover:bg-muted/50", selectedOrderId === order.id && "bg-muted")} onClick={() => setSelectedOrderId(order.id)}>
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <div className="font-medium text-sm flex items-center gap-2">#{order.externalOrderNumber}</div>
                          <p className="text-sm text-muted-foreground">{order.customerName}</p>
                        </div>
                        <Badge variant="outline" className={`gap-1 ${getStatusColor(order.status)}`}>{order.status}</Badge>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" />{order.orderedAt ? format(new Date(order.orderedAt), "MMM d") : "—"}</span>
                          <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" />{itemCount}</span>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </CardContent>
                  </Card>
                )})}
              </div>

              {/* Desktop table layout */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Order #</TableHead>
                      <TableHead>Channel</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Items</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Order Date</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data?.orders.map((order) => {
                      const itemCount = order.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
                      return (
                      <TableRow key={order.id} className={`cursor-pointer hover:bg-muted/50 ${selectedOrderId === order.id ? 'bg-muted' : ''}`} onClick={() => setSelectedOrderId(order.id)}>
                        <TableCell className="font-medium">#{order.externalOrderNumber}</TableCell>
                        <TableCell>
                          {order.channelProvider ? (
                            <Badge variant="outline" className={cn("text-xs", getChannelBadgeStyle(order.channelProvider).className)}>
                              {getChannelBadgeStyle(order.channelProvider).label}
                            </Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell>{order.customerName}</TableCell>
                        <TableCell><span className="text-muted-foreground">{itemCount}</span></TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`gap-1 ${getStatusColor(order.status)}`}>{order.status}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{order.orderedAt ? format(new Date(order.orderedAt), "MMM d, h:mm a") : "—"}</TableCell>
                        <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                      </TableRow>
                    )})}
                  </TableBody>
                </Table>
              </div>

              {totalPages > 1 && (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-2 p-2 md:p-4 border-t">
                  <p className="text-xs md:text-sm text-muted-foreground">Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, data?.total || 0)} of {data?.total || 0}</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="min-h-[44px]">Previous</Button>
                    <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages - 1} className="min-h-[44px]">Next</Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        
        {selectedOrderId && (
          <div className="w-[400px] border-l bg-muted/30 overflow-auto hidden lg:block">
            <OrderDetailPanel detail={orderDetail} loading={detailLoading} onClose={() => setSelectedOrderId(null)} />
          </div>
        )}
      </div>
      
      {selectedOrderId && isMobile && (
        <Sheet open={!!selectedOrderId} onOpenChange={() => setSelectedOrderId(null)}>
          <SheetContent className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-0">
            <OrderDetailPanel detail={orderDetail} loading={detailLoading} onClose={() => setSelectedOrderId(null)} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function OrderDetailPanel({ detail, loading, onClose }: { detail?: OrderDetail; loading: boolean; onClose: () => void; }) {
  if (loading) return <div className="p-4 space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-24 w-full" /></div>;
  if (!detail) return <div className="p-4 text-center text-muted-foreground">Select an order</div>;

  const { order, items } = detail;

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold">#{order.externalOrderNumber}</h2>
            <p className="text-sm text-muted-foreground">{order.customerName}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="lg:hidden"><X className="h-4 w-4" /></Button>
        </div>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Order Info</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Status</span><Badge variant="outline" className={`gap-1 ${getStatusColor(order.status)}`}>{order.status}</Badge></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Financial Status</span><span className="font-medium">{order.financialStatus}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Fulfillment Status</span><span className="font-medium">{order.fulfillmentStatus}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Total</span><span className="font-medium">${(order.totalCents / 100).toFixed(2)}</span></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Items ({items.length})</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {items.map((item, idx) => (
              <div key={idx} className="text-sm border-b pb-2 last:border-0 last:pb-0">
                <p className="font-medium">{item.title}</p>
                <div className="flex justify-between text-muted-foreground mt-1 text-xs">
                  <span>SKU: {item.sku}</span>
                  <span>Qty: {item.quantity}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </ScrollArea>
  );
}
