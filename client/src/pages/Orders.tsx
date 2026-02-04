import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  ShoppingCart, 
  Search, 
  Filter, 
  Clock,
  AlertCircle,
  CheckCircle2,
  Zap,
  ChevronDown,
  Layers,
  Package,
  Plus,
  Store,
  RefreshCw,
  Merge,
  MapPin,
  User2,
  Check
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useSettings, PickingMode } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

interface Channel {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
}

interface OrderItem {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  pickedQuantity: number;
  status: string;
}

interface Order {
  id: number;
  orderNumber: string;
  customerName: string;
  customerEmail: string | null;
  source: string;
  channelId: number | null;
  channel: Channel | null;
  warehouseStatus: string;
  priority: string;
  itemCount: number;
  pickedCount: number;
  totalAmount: string | null;
  onHold: number;
  createdAt: string;
  orderPlacedAt: string | null;
  items: OrderItem[];
  combinedGroupId: number | null;
  combinedRole: string | null;
}

interface OrdersResponse {
  orders: Order[];
  total: number;
  limit: number;
  offset: number;
}

interface CombinableOrder {
  id: number;
  orderNumber: string;
  itemCount: number;
  unitCount: number;
  totalAmount: string | null;
  source: string;
  createdAt: string;
}

interface CombinableGroup {
  addressHash: string;
  customerName: string;
  customerEmail: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
  orders: CombinableOrder[];
  totalOrders: number;
  totalItems: number;
  totalUnits: number;
}

const sourceIcons: Record<string, string> = {
  shopify: "https://upload.wikimedia.org/wikipedia/commons/0/0e/Shopify_logo_2018.svg",
  ebay: "https://upload.wikimedia.org/wikipedia/commons/1/1b/EBay_logo.svg",
  amazon: "https://upload.wikimedia.org/wikipedia/commons/a/a9/Amazon_logo.svg",
  etsy: "https://upload.wikimedia.org/wikipedia/commons/8/89/Etsy_logo.svg",
};

const statusColors: Record<string, string> = {
  ready: "bg-blue-50 text-blue-700 border-blue-200",
  in_progress: "bg-amber-50 text-amber-700 border-amber-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  exception: "bg-red-50 text-red-700 border-red-200",
  shipped: "bg-purple-50 text-purple-700 border-purple-200",
};

const priorityColors: Record<string, string> = {
  rush: "bg-red-500 text-white",
  high: "bg-orange-500 text-white",
  normal: "",
};

export default function Orders() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { 
    pickingMode, 
    setPickingMode, 
    autoRelease, 
    setAutoRelease, 
    releaseDelay, 
    setReleaseDelay 
  } = useSettings();

  const [searchTerm, setSearchTerm] = useState("");
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCombineOpen, setIsCombineOpen] = useState(false);
  const [selectedCombineGroup, setSelectedCombineGroup] = useState<CombinableGroup | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const [newOrder, setNewOrder] = useState({
    orderNumber: "",
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    priority: "normal",
    totalAmount: "",
    shippingAddress: "",
    shippingCity: "",
    shippingState: "",
    shippingPostalCode: "",
    shippingCountry: "US",
    notes: "",
    items: [{ sku: "", name: "", quantity: 1 }],
  });

  const { data: ordersData, isLoading: ordersLoading, refetch: refetchOrders } = useQuery<OrdersResponse>({
    queryKey: ["/api/oms/orders", channelFilter, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (channelFilter !== "all") params.append("channelId", channelFilter);
      if (statusFilter === "active") {
        params.append("status", "ready");
        params.append("status", "in_progress");
      } else if (statusFilter !== "all") {
        params.append("status", statusFilter);
      }
      params.append("limit", "100");
      const res = await fetch(`/api/oms/orders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch orders");
      return res.json();
    },
  });

  const { data: channels } = useQuery<Channel[]>({
    queryKey: ["/api/channels"],
  });

  const { data: combinableGroups = [], isError: combinableError } = useQuery<CombinableGroup[]>({
    queryKey: ["/api/orders/combinable"],
    queryFn: async () => {
      const res = await fetch("/api/orders/combinable");
      if (!res.ok) throw new Error("Failed to fetch combinable orders");
      return res.json();
    },
    refetchInterval: 30000,
    retry: 1,
  });

  const combineOrdersMutation = useMutation({
    mutationFn: async (orderIds: number[]) => {
      const res = await fetch("/api/orders/combine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to combine orders");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders/combinable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
      setIsCombineOpen(false);
      setSelectedCombineGroup(null);
      setSelectedOrderIds([]);
      toast({ title: "Orders combined", description: "The selected orders have been grouped for combined picking and shipping." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createOrderMutation = useMutation({
    mutationFn: async (orderData: any) => {
      const res = await fetch("/api/oms/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderData),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create order");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
      setIsCreateOpen(false);
      setNewOrder({
        orderNumber: "",
        customerName: "",
        customerEmail: "",
        customerPhone: "",
        priority: "normal",
        totalAmount: "",
        shippingAddress: "",
        shippingCity: "",
        shippingState: "",
        shippingPostalCode: "",
        shippingCountry: "US",
        notes: "",
        items: [{ sku: "", name: "", quantity: 1 }],
      });
      toast({ title: "Order created", description: "Manual order has been created successfully." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleCreateOrder = () => {
    if (!newOrder.orderNumber.trim() || !newOrder.customerName.trim()) {
      toast({ title: "Error", description: "Order number and customer name are required", variant: "destructive" });
      return;
    }
    const validItems = newOrder.items.filter(i => i.sku.trim() && i.name.trim() && i.quantity > 0);
    if (validItems.length === 0) {
      toast({ title: "Error", description: "At least one valid item is required", variant: "destructive" });
      return;
    }
    createOrderMutation.mutate({
      ...newOrder,
      source: "manual",
      items: validItems,
    });
  };

  const addOrderItem = () => {
    setNewOrder(prev => ({
      ...prev,
      items: [...prev.items, { sku: "", name: "", quantity: 1 }],
    }));
  };

  const updateOrderItem = (index: number, field: string, value: string | number) => {
    setNewOrder(prev => ({
      ...prev,
      items: prev.items.map((item, i) => i === index ? { ...item, [field]: value } : item),
    }));
  };

  const removeOrderItem = (index: number) => {
    if (newOrder.items.length > 1) {
      setNewOrder(prev => ({
        ...prev,
        items: prev.items.filter((_, i) => i !== index),
      }));
    }
  };

  const orders = ordersData?.orders || [];
  const filteredOrders = orders.filter(order => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      order.orderNumber.toLowerCase().includes(search) ||
      order.customerName.toLowerCase().includes(search) ||
      (order.customerEmail?.toLowerCase().includes(search))
    );
  });

  // Group combined orders into single display entries
  interface DisplayOrder extends Order {
    isCombinedGroup?: boolean;
    combinedOrders?: { id: number; orderNumber: string; itemCount: number; status: string }[];
    totalItemCount?: number;
    totalPickedCount?: number;
  }

  const groupedOrders: DisplayOrder[] = (() => {
    const result: DisplayOrder[] = [];
    const processedGroupIds = new Set<number>();
    
    for (const order of filteredOrders) {
      // Skip child orders - they'll be merged into the parent
      if (order.combinedGroupId && order.combinedRole === "child") {
        continue;
      }
      
      // If this is a parent of a combined group, merge all children
      if (order.combinedGroupId && order.combinedRole === "parent") {
        if (processedGroupIds.has(order.combinedGroupId)) continue;
        processedGroupIds.add(order.combinedGroupId);
        
        // Find all orders in this combined group
        const groupOrders = filteredOrders.filter(o => o.combinedGroupId === order.combinedGroupId);
        
        // Calculate combined totals
        const totalItemCount = groupOrders.reduce((sum, o) => sum + o.itemCount, 0);
        const totalPickedCount = groupOrders.reduce((sum, o) => sum + o.pickedCount, 0);
        const combinedOrdersList = groupOrders.map(o => ({
          id: o.id,
          orderNumber: o.orderNumber,
          itemCount: o.itemCount,
          status: o.status,
        }));
        
        // Create combined entry using parent's data
        result.push({
          ...order,
          isCombinedGroup: true,
          combinedOrders: combinedOrdersList,
          totalItemCount,
          totalPickedCount,
          itemCount: totalItemCount,
          pickedCount: totalPickedCount,
        });
      } else {
        // Regular uncombined order
        result.push(order);
      }
    }
    
    return result;
  })();

  const activeCount = orders.filter(o => o.status === "ready" || o.status === "in_progress").length;
  const exceptionCount = orders.filter(o => o.status === "exception").length;
  const completedCount = orders.filter(o => o.status === "completed" || o.status === "shipped").length;

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <div className="p-4 md:p-6 border-b bg-card">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-page-title">
              <ShoppingCart className="h-5 w-5 md:h-6 md:w-6 text-primary" />
              Order Management
            </h1>
            <p className="text-muted-foreground mt-1 text-sm hidden sm:block">
              Process, allocate, and fulfill customer orders across all channels.
            </p>
          </div>
          <div className="flex items-center gap-2 md:gap-3 flex-wrap">
            <div className="flex items-center rounded-lg border bg-muted/50 p-1" data-testid="picking-mode-toggle">
              <Button
                variant={pickingMode === "batch" ? "default" : "ghost"}
                size="sm"
                onClick={() => setPickingMode("batch")}
                className={cn("gap-1 md:gap-2 px-2 md:px-3", pickingMode === "batch" && "bg-primary shadow-sm")}
                data-testid="button-batch-mode"
              >
                <Layers className="h-4 w-4" />
                <span className="hidden sm:inline">Batch</span>
              </Button>
              <Button
                variant={pickingMode === "single" ? "default" : "ghost"}
                size="sm"
                onClick={() => setPickingMode("single")}
                className={cn("gap-1 md:gap-2 px-2 md:px-3", pickingMode === "single" && "bg-primary shadow-sm")}
                data-testid="button-single-mode"
              >
                <Package className="h-4 w-4" />
                <span className="hidden sm:inline">Single</span>
              </Button>
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button 
                  variant={autoRelease ? "default" : "outline"} 
                  size="sm"
                  className={cn("gap-1 md:gap-2", autoRelease ? "bg-emerald-600 hover:bg-emerald-700" : "")}
                  data-testid="button-auto-release-settings"
                >
                  <Zap className="h-4 w-4" />
                  <span className="hidden sm:inline">Auto-Release</span> {autoRelease ? "ON" : "OFF"}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label htmlFor="auto-release" className="text-base font-medium">Auto-Release to Pick</Label>
                      <p className="text-xs text-muted-foreground">
                        Automatically send orders to picking queue
                      </p>
                    </div>
                    <Switch 
                      id="auto-release" 
                      checked={autoRelease} 
                      onCheckedChange={setAutoRelease}
                      data-testid="switch-auto-release"
                    />
                  </div>
                  
                  {autoRelease && (
                    <div className="border-t pt-4 space-y-3">
                      <Label className="text-sm font-medium">Release Timing</Label>
                      <Select value={releaseDelay} onValueChange={setReleaseDelay}>
                        <SelectTrigger data-testid="select-release-timing">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="immediate">Immediate</SelectItem>
                          <SelectItem value="5min">5 minute batches</SelectItem>
                          <SelectItem value="15min">15 minute batches</SelectItem>
                          <SelectItem value="hourly">Hourly batches</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            
            {!combinableError && combinableGroups.length > 0 && (
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => setIsCombineOpen(true)} 
                data-testid="button-combine-orders" 
                className="gap-2 border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-700"
              >
                <Merge className="h-4 w-4" />
                <span className="hidden sm:inline">Combine</span>
                <Badge variant="secondary" className="bg-amber-200 text-amber-800">
                  {combinableGroups.length}
                </Badge>
              </Button>
            )}
            <Button size="sm" onClick={() => setIsCreateOpen(true)} data-testid="button-create-order" className="hidden sm:flex">
              <Plus className="h-4 w-4 mr-2" />
              Create Order
            </Button>
            <Button size="icon" onClick={() => setIsCreateOpen(true)} data-testid="button-create-order-mobile" className="sm:hidden h-9 w-9">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-full">
            <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent whitespace-nowrap">
              <TabsTrigger 
                value="active" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 md:px-4 py-2 text-sm"
                data-testid="tab-active"
              >
                Active ({activeCount})
              </TabsTrigger>
              <TabsTrigger 
                value="exception" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 md:px-4 py-2 text-sm text-amber-600"
                data-testid="tab-exceptions"
              >
                Exceptions ({exceptionCount})
              </TabsTrigger>
              <TabsTrigger 
                value="completed" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 md:px-4 py-2 text-sm"
                data-testid="tab-completed"
              >
                Completed ({completedCount})
              </TabsTrigger>
              <TabsTrigger 
                value="all" 
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 md:px-4 py-2 text-sm"
                data-testid="tab-all"
              >
                All
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="p-2 md:p-6 grid gap-4 md:gap-6 grid-cols-1 md:grid-cols-3">
        <div className="md:col-span-2 space-y-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input 
                placeholder="Search orders..." 
                className="pl-9 bg-card h-11" 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-search-orders"
              />
            </div>
            <div className="flex items-center gap-2">
              <Select value={channelFilter} onValueChange={setChannelFilter}>
                <SelectTrigger className="w-full sm:w-[180px] h-11" data-testid="select-channel-filter">
                  <Store className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="All Channels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Channels</SelectItem>
                  {channels?.map((ch) => (
                    <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={() => refetchOrders()} className="min-h-[44px] min-w-[44px]" data-testid="button-refresh-orders">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {ordersLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : filteredOrders.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <ShoppingCart className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">No orders found</p>
                <p className="text-sm">Orders from your connected channels will appear here.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {groupedOrders.map((order) => (
                <Card 
                  key={order.isCombinedGroup ? `combined-${order.combinedGroupId}` : order.id} 
                  className={cn(
                    "hover:border-primary/50 transition-colors cursor-pointer group",
                    order.isCombinedGroup && "border-l-4 border-l-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20"
                  )}
                  data-testid={`card-order-${order.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4">
                        <div className={cn(
                          "p-2 rounded-md group-hover:bg-primary/20 transition-colors flex items-center justify-center w-10 h-10",
                          order.isCombinedGroup ? "bg-indigo-100" : "bg-primary/10"
                        )}>
                          {order.isCombinedGroup ? (
                            <Merge className="h-5 w-5 text-indigo-600" />
                          ) : order.source && sourceIcons[order.source] ? (
                            <img 
                              src={sourceIcons[order.source]} 
                              className="w-5 h-5 object-contain" 
                              title={`${order.source} order`} 
                            />
                          ) : (
                            <ShoppingCart className="h-5 w-5 text-primary" />
                          )}
                        </div>
                        <div>
                          {order.isCombinedGroup && order.combinedOrders ? (
                            <>
                              <div className="font-semibold flex items-center gap-2 flex-wrap">
                                <Badge className="bg-indigo-600 text-white text-xs">
                                  {order.combinedOrders.length} Orders Combined
                                </Badge>
                                {order.priority !== "normal" && (
                                  <Badge className={cn("text-xs", priorityColors[order.priority])}>
                                    {order.priority.toUpperCase()}
                                  </Badge>
                                )}
                                <Badge variant="outline" className={cn("text-xs", statusColors[order.warehouseStatus] || "")}>
                                  {order.warehouseStatus.replace("_", " ")}
                                </Badge>
                              </div>
                              <div className="text-sm text-muted-foreground mt-1 space-y-0.5">
                                {order.combinedOrders.map((co) => (
                                  <div key={co.id} className="flex items-center gap-2">
                                    <span className="font-medium text-foreground">{co.orderNumber}</span>
                                    <span className="text-muted-foreground">({co.itemCount} items)</span>
                                  </div>
                                ))}
                              </div>
                              <div className="text-sm text-muted-foreground mt-1">
                                {order.customerName} • {order.itemCount} total items
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="font-semibold flex items-center gap-2 flex-wrap">
                                {order.orderNumber}
                                {order.totalAmount && (
                                  <span className="text-muted-foreground font-normal">${order.totalAmount}</span>
                                )}
                                {order.source === "manual" && (
                                  <Badge variant="outline" className="text-xs">Manual</Badge>
                                )}
                                {order.priority !== "normal" && (
                                  <Badge className={cn("text-xs", priorityColors[order.priority])}>
                                    {order.priority.toUpperCase()}
                                  </Badge>
                                )}
                                <Badge variant="outline" className={cn("text-xs", statusColors[order.warehouseStatus] || "")}>
                                  {order.warehouseStatus.replace("_", " ")}
                                </Badge>
                                {order.onHold === 1 && (
                                  <Badge variant="destructive" className="text-xs">ON HOLD</Badge>
                                )}
                              </div>
                              <div className="text-sm text-muted-foreground mt-1">
                                {order.customerName} • {order.itemCount} items
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {(() => {
                            const date = order.orderPlacedAt ? new Date(order.orderPlacedAt) : new Date(order.createdAt);
                            const now = new Date();
                            const diffMs = now.getTime() - date.getTime();
                            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                            const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                            if (diffHours >= 24) {
                              const days = Math.floor(diffHours / 24);
                              const hours = diffHours % 24;
                              return `${days}d ${hours}h`;
                            }
                            return `${diffHours}h ${diffMins}m`;
                          })()}
                        </div>
                      </div>
                    </div>
                    
                    {order.warehouseStatus !== "completed" && order.warehouseStatus !== "shipped" && order.itemCount > 0 && (
                      <div className="mt-4 flex items-center gap-3">
                        <div className="flex-1">
                          <div className="flex justify-between text-xs mb-1.5 text-muted-foreground">
                            <span>Pick Progress</span>
                            <span>{order.pickedCount}/{order.itemCount}</span>
                          </div>
                          <Progress value={(order.pickedCount / order.itemCount) * 100} className="h-1.5" />
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="hidden md:block space-y-6">
          <Card className="bg-primary text-primary-foreground border-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Order Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-primary-foreground/80 text-sm">Active Orders</span>
                  <span className="font-bold">{activeCount}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-primary-foreground/80 text-sm">Completed Today</span>
                  <span className="font-bold">{completedCount}</span>
                </div>
                <div className="pt-2 border-t border-primary-foreground/20 mt-2">
                  <div className="flex justify-between items-center text-amber-200">
                    <span className="text-sm flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Exceptions</span>
                    <span className="font-bold">{exceptionCount}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Channels</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {channels?.slice(0, 5).map((ch) => (
                <div key={ch.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    {sourceIcons[ch.provider] && (
                      <img src={sourceIcons[ch.provider]} className="w-4 h-4 object-contain" />
                    )}
                    <span>{ch.name}</span>
                  </div>
                  <Badge variant={ch.status === "active" ? "default" : "outline"} className="text-xs">
                    {ch.status}
                  </Badge>
                </div>
              ))}
              {(!channels || channels.length === 0) && (
                <p className="text-sm text-muted-foreground">No channels configured</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-md sm:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>Create Manual Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="orderNumber" className="text-sm">Order Number *</Label>
                <Input
                  id="orderNumber"
                  value={newOrder.orderNumber}
                  onChange={(e) => setNewOrder({ ...newOrder, orderNumber: e.target.value })}
                  placeholder="ORD-001"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-order-number"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priority" className="text-sm">Priority</Label>
                <Select 
                  value={newOrder.priority} 
                  onValueChange={(v) => setNewOrder({ ...newOrder, priority: v })}
                >
                  <SelectTrigger className="h-11" data-testid="select-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="rush">Rush</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="customerName" className="text-sm">Customer Name *</Label>
                <Input
                  id="customerName"
                  value={newOrder.customerName}
                  onChange={(e) => setNewOrder({ ...newOrder, customerName: e.target.value })}
                  placeholder="John Doe"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-customer-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="customerEmail" className="text-sm">Email</Label>
                <Input
                  id="customerEmail"
                  type="email"
                  value={newOrder.customerEmail}
                  onChange={(e) => setNewOrder({ ...newOrder, customerEmail: e.target.value })}
                  placeholder="john@example.com"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-customer-email"
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="customerPhone" className="text-sm">Phone</Label>
                <Input
                  id="customerPhone"
                  value={newOrder.customerPhone}
                  onChange={(e) => setNewOrder({ ...newOrder, customerPhone: e.target.value })}
                  placeholder="(555) 123-4567"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-customer-phone"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="totalAmount" className="text-sm">Total Amount</Label>
                <Input
                  id="totalAmount"
                  value={newOrder.totalAmount}
                  onChange={(e) => setNewOrder({ ...newOrder, totalAmount: e.target.value })}
                  placeholder="$99.99"
                  className="h-11"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-total-amount"
                />
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-3">
                <Label className="text-sm font-medium">Order Items *</Label>
                <Button type="button" variant="outline" size="sm" onClick={addOrderItem} className="min-h-[44px]" data-testid="button-add-item">
                  <Plus className="h-4 w-4 mr-1" /> Add Item
                </Button>
              </div>
              <div className="space-y-3">
                {newOrder.items.map((item, index) => (
                  <div key={index} className="grid gap-2 md:grid-cols-4 items-end">
                    <div className="space-y-1">
                      <Label className="text-xs">SKU</Label>
                      <Input
                        value={item.sku}
                        onChange={(e) => updateOrderItem(index, "sku", e.target.value)}
                        placeholder="SKU-001"
                        className="h-11"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-testid={`input-item-sku-${index}`}
                      />
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <Label className="text-xs">Name</Label>
                      <Input
                        value={item.name}
                        onChange={(e) => updateOrderItem(index, "name", e.target.value)}
                        placeholder="Product Name"
                        className="h-11"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-testid={`input-item-name-${index}`}
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="space-y-1 flex-1">
                        <Label className="text-xs">Qty</Label>
                        <Input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={(e) => updateOrderItem(index, "quantity", parseInt(e.target.value) || 1)}
                          className="h-11"
                          data-testid={`input-item-qty-${index}`}
                        />
                      </div>
                      {newOrder.items.length > 1 && (
                        <Button 
                          type="button" 
                          variant="ghost" 
                          size="icon" 
                          className="mt-5 min-h-[44px]"
                          onClick={() => removeOrderItem(index)}
                          data-testid={`button-remove-item-${index}`}
                        >
                          ×
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes" className="text-sm">Notes</Label>
              <Textarea
                id="notes"
                value={newOrder.notes}
                onChange={(e) => setNewOrder({ ...newOrder, notes: e.target.value })}
                placeholder="Special instructions or notes..."
                rows={2}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-notes"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setIsCreateOpen(false)} className="min-h-[44px]" data-testid="button-cancel-order">Cancel</Button>
            <Button onClick={handleCreateOrder} disabled={createOrderMutation.isPending} className="min-h-[44px]" data-testid="button-submit-order">
              {createOrderMutation.isPending ? "Creating..." : "Create Order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Combine Orders Dialog */}
      <Dialog open={isCombineOpen} onOpenChange={setIsCombineOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Merge className="h-5 w-5 text-amber-600" />
              Combine Orders
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {!selectedCombineGroup ? (
              <>
                <p className="text-sm text-muted-foreground">
                  These customers have placed multiple orders to the same address. 
                  Combine them to pick and ship together for efficiency.
                </p>
                <div className="space-y-3">
                  {combinableGroups.map((group) => (
                    <Card 
                      key={group.addressHash} 
                      className="cursor-pointer hover:border-amber-400 transition-colors"
                      onClick={() => {
                        setSelectedCombineGroup(group);
                        setSelectedOrderIds(group.orders.map(o => o.id));
                      }}
                      data-testid={`card-combine-group-${group.orders[0]?.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <User2 className="h-4 w-4 text-muted-foreground" />
                              <span className="font-medium">{group.customerName}</span>
                            </div>
                            {group.shippingAddress && (
                              <div className="flex items-start gap-2 text-sm text-muted-foreground">
                                <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                                <span>
                                  {group.shippingAddress}, {group.shippingCity}, {group.shippingState} {group.shippingPostalCode}
                                </span>
                              </div>
                            )}
                          </div>
                          <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                            {group.totalOrders} orders
                          </Badge>
                        </div>
                        <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
                          <span>{group.totalItems} items</span>
                          <span>{group.totalUnits} units</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                  {combinableGroups.length === 0 && (
                    <div className="text-center py-8 text-muted-foreground">
                      <Merge className="h-12 w-12 mx-auto mb-3 opacity-20" />
                      <p>No combinable orders found</p>
                      <p className="text-xs mt-1">Orders to the same address will appear here</p>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="bg-muted/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <User2 className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{selectedCombineGroup.customerName}</span>
                  </div>
                  {selectedCombineGroup.shippingAddress && (
                    <div className="flex items-start gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>
                        {selectedCombineGroup.shippingAddress}, {selectedCombineGroup.shippingCity}, {selectedCombineGroup.shippingState} {selectedCombineGroup.shippingPostalCode}
                      </span>
                    </div>
                  )}
                </div>
                
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Select orders to combine:</Label>
                  {selectedCombineGroup.orders.map((order) => (
                    <div 
                      key={order.id}
                      className={cn(
                        "flex items-center justify-between p-3 border rounded-lg cursor-pointer transition-colors",
                        selectedOrderIds.includes(order.id) 
                          ? "border-amber-400 bg-amber-50" 
                          : "hover:bg-muted/50"
                      )}
                      onClick={() => {
                        if (selectedOrderIds.includes(order.id)) {
                          if (selectedOrderIds.length > 2) {
                            setSelectedOrderIds(selectedOrderIds.filter(id => id !== order.id));
                          }
                        } else {
                          setSelectedOrderIds([...selectedOrderIds, order.id]);
                        }
                      }}
                      data-testid={`checkbox-order-${order.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "h-5 w-5 rounded border-2 flex items-center justify-center",
                          selectedOrderIds.includes(order.id) 
                            ? "bg-amber-500 border-amber-500 text-white" 
                            : "border-gray-300"
                        )}>
                          {selectedOrderIds.includes(order.id) && <Check className="h-3 w-3" />}
                        </div>
                        <div>
                          <div className="font-medium">{order.orderNumber}</div>
                          <div className="text-xs text-muted-foreground">
                            {order.itemCount} items, {order.unitCount} units
                          </div>
                        </div>
                      </div>
                      {order.totalAmount && (
                        <span className="text-sm font-medium">${order.totalAmount}</span>
                      )}
                    </div>
                  ))}
                </div>
                
                {selectedOrderIds.length < 2 && (
                  <p className="text-sm text-amber-600">Select at least 2 orders to combine</p>
                )}
              </>
            )}
          </div>
          
          <DialogFooter className="gap-2">
            {selectedCombineGroup ? (
              <>
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setSelectedCombineGroup(null);
                    setSelectedOrderIds([]);
                  }} 
                  className="min-h-[44px]"
                  data-testid="button-back-combine"
                >
                  Back
                </Button>
                <Button 
                  onClick={() => combineOrdersMutation.mutate(selectedOrderIds)}
                  disabled={selectedOrderIds.length < 2 || combineOrdersMutation.isPending}
                  className="min-h-[44px] bg-amber-600 hover:bg-amber-700"
                  data-testid="button-confirm-combine"
                >
                  {combineOrdersMutation.isPending ? "Combining..." : `Combine ${selectedOrderIds.length} Orders`}
                </Button>
              </>
            ) : (
              <Button 
                variant="outline" 
                onClick={() => setIsCombineOpen(false)} 
                className="min-h-[44px]"
                data-testid="button-close-combine"
              >
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
