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
  Check,
  Building2,
  ChevronRight,
  X,
  Truck,
  MapPin as MapPinIcon,
  Mail,
  FileText,
  ArrowLeft,
  Box,
  DollarSign,
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
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
  imageUrl: string | null;
  location: string;
  zone: string;
  priceCents: number | null;
  discountCents: number | null;
  totalPriceCents: number | null;
  requiresShipping: number;
  barcode: string | null;
  shortReason: string | null;
  pickedAt: string | null;
}

interface Order {
  id: number;
  orderNumber: string;
  customerName: string;
  customerEmail: string | null;
  source: string;
  channelId: number | null;
  channel: Channel | null;
  warehouseId: number | null;
  warehouseStatus: string;
  priority: string;
  itemCount: number;
  unitCount: number;
  pickedCount: number;
  totalAmount: string | null;
  currency: string | null;
  onHold: number;
  createdAt: string;
  orderPlacedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  items: OrderItem[];
  combinedGroupId: number | null;
  combinedRole: string | null;
  slaDueAt: string | null;
  slaStatus: string | null;
  shippingName: string | null;
  shippingAddress: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
  financialStatus: string | null;
  shopifyFulfillmentStatus: string | null;
  notes: string | null;
  batchId: string | null;
  assignedPickerId: string | null;
  externalOrderId: string | null;
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
  combinedGroupId: number | null;
  combinedRole: string | null;
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
  awaiting_3pl: "bg-violet-50 text-violet-700 border-violet-200",
  cancelled: "bg-gray-50 text-gray-700 border-gray-200",
};

const priorityColors: Record<string, string> = {
  rush: "bg-red-500 text-white",
  high: "bg-orange-500 text-white",
  normal: "",
};

function CombineOrderItems({ orderId }: { orderId: number }) {
  const { data, isLoading } = useQuery<{ items: { id: number; sku: string; name: string; quantity: number; pickedQuantity: number; requiresShipping: number }[] }>({
    queryKey: ["/api/oms/orders", orderId],
    queryFn: async () => {
      const res = await fetch(`/api/oms/orders/${orderId}`);
      if (!res.ok) throw new Error("Failed to fetch order items");
      return res.json();
    },
  });

  if (isLoading) {
    return <div className="px-11 pb-2 text-xs text-muted-foreground">Loading items...</div>;
  }

  // Only show shippable/pickable items (same filter as pick queue)
  const items = (data?.items || []).filter(item => item.requiresShipping === 1);
  if (items.length === 0) {
    return <div className="px-11 pb-2 text-xs text-muted-foreground">No shippable items</div>;
  }

  return (
    <div className="px-11 pb-2 space-y-0.5 border-t border-dashed">
      {items.map((item) => (
        <div key={item.id} className="flex justify-between gap-2 text-xs text-muted-foreground py-0.5">
          <div className="min-w-0 break-words">
            <span className="font-mono text-foreground/70">{item.sku}</span>
            <span className="ml-2">{item.name}</span>
          </div>
          <span className="shrink-0">x{item.quantity}</span>
        </div>
      ))}
    </div>
  );
}

// --- Order Detail Panel ---

interface OrderDetail extends Order {
  items: OrderItem[];
  channel: Channel | null;
}

const itemStatusColors: Record<string, string> = {
  pending: "bg-slate-100 text-slate-600",
  picked: "bg-green-100 text-green-700",
  shorted: "bg-red-100 text-red-700",
  cancelled: "bg-gray-100 text-gray-500",
};

const financialStatusColors: Record<string, string> = {
  paid: "bg-green-100 text-green-700 border-green-200",
  authorized: "bg-blue-100 text-blue-700 border-blue-200",
  pending: "bg-amber-100 text-amber-700 border-amber-200",
  partially_refunded: "bg-orange-100 text-orange-700 border-orange-200",
  refunded: "bg-red-100 text-red-700 border-red-200",
  voided: "bg-gray-100 text-gray-500 border-gray-200",
};

function OrderDetailPanel({ orderId, onClose }: { orderId: number; onClose: () => void }) {
  const { data: order, isLoading } = useQuery<OrderDetail>({
    queryKey: ["/api/oms/orders", orderId, "detail"],
    queryFn: async () => {
      const res = await fetch(`/api/oms/orders/${orderId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch order");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <Card className="sticky top-6">
        <CardContent className="py-12 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="text-sm text-muted-foreground mt-3">Loading order...</p>
        </CardContent>
      </Card>
    );
  }

  if (!order) {
    return (
      <Card className="sticky top-6">
        <CardContent className="py-12 text-center text-muted-foreground">
          <p>Order not found</p>
        </CardContent>
      </Card>
    );
  }

  const shippableItems = order.items?.filter(i => i.requiresShipping === 1) ?? [];
  const digitalItems = order.items?.filter(i => i.requiresShipping === 0) ?? [];
  const totalPicked = shippableItems.reduce((s, i) => s + i.pickedQuantity, 0);
  const totalQty = shippableItems.reduce((s, i) => s + i.quantity, 0);

  const hasAddress = order.shippingAddress || order.shippingCity;
  const addressLines = [
    order.shippingName,
    order.shippingAddress,
    [order.shippingCity, order.shippingState, order.shippingPostalCode].filter(Boolean).join(", "),
    order.shippingCountry && order.shippingCountry !== "US" ? order.shippingCountry : null,
  ].filter(Boolean);

  // Calculate order total from items if totalAmount not available
  const itemsTotal = order.items?.reduce((s, i) => s + (i.totalPriceCents || 0), 0) ?? 0;
  const displayTotal = order.totalAmount
    ? `$${parseFloat(order.totalAmount).toFixed(2)}`
    : itemsTotal > 0 ? `$${(itemsTotal / 100).toFixed(2)}` : null;

  return (
    <div className="space-y-4 sticky top-6">
      {/* Header */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <div>
                <h3 className="font-bold text-lg">#{order.orderNumber}</h3>
                <p className="text-xs text-muted-foreground">
                  {order.source !== "manual" && order.externalOrderId && (
                    <span className="mr-2">Ext: {order.externalOrderId}</span>
                  )}
                  ID: {order.id}
                </p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Status badges */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            <Badge variant="outline" className={cn("text-xs", statusColors[order.warehouseStatus] || "")}>
              {order.warehouseStatus.replace("_", " ")}
            </Badge>
            {order.financialStatus && (
              <Badge variant="outline" className={cn("text-xs", financialStatusColors[order.financialStatus] || "")}>
                {order.financialStatus.replace("_", " ")}
              </Badge>
            )}
            {order.priority !== "normal" && (
              <Badge className={cn("text-xs", priorityColors[order.priority])}>
                {order.priority.toUpperCase()}
              </Badge>
            )}
            {order.onHold === 1 && <Badge variant="destructive" className="text-xs">ON HOLD</Badge>}
            {order.batchId && (
              <Badge variant="outline" className="text-xs bg-violet-50 text-violet-700 border-violet-200">
                Batch: {order.batchId}
              </Badge>
            )}
          </div>

          {/* Key info grid */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            {order.channel && (
              <div className="flex items-center gap-2">
                <Store className="h-3.5 w-3.5 text-muted-foreground" />
                <span>{order.channel.name}</span>
              </div>
            )}
            {displayTotal && (
              <div className="flex items-center gap-2">
                <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{displayTotal}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{order.orderPlacedAt ? format(new Date(order.orderPlacedAt), "MMM d, h:mm a") : format(new Date(order.createdAt), "MMM d, h:mm a")}</span>
            </div>
            <div className="flex items-center gap-2">
              <Box className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{order.itemCount} items, {order.unitCount || order.itemCount} units</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Customer & Shipping */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <User2 className="h-4 w-4" /> Customer
          </h4>
          <div className="text-sm space-y-1">
            <p className="font-medium">{order.customerName}</p>
            {order.customerEmail && (
              <p className="text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3 w-3" /> {order.customerEmail}
              </p>
            )}
          </div>

          {hasAddress && (
            <>
              <div className="border-t pt-3">
                <h4 className="text-sm font-semibold flex items-center gap-2 mb-2">
                  <Truck className="h-4 w-4" /> Shipping Address
                </h4>
                <div className="text-sm text-muted-foreground space-y-0.5">
                  {addressLines.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Pick Progress */}
      {totalQty > 0 && order.warehouseStatus !== "shipped" && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between text-sm mb-2">
              <h4 className="font-semibold">Pick Progress</h4>
              <span className={cn("font-medium", totalPicked === totalQty ? "text-green-600" : "")}>
                {totalPicked}/{totalQty}
              </span>
            </div>
            <Progress value={(totalPicked / totalQty) * 100} className="h-2" />
            {order.assignedPickerId && (
              <p className="text-xs text-muted-foreground mt-2">Picker: {order.assignedPickerId}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Line Items */}
      <Card>
        <CardContent className="p-4">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Package className="h-4 w-4" /> Line Items ({shippableItems.length})
          </h4>
          <div className="space-y-2">
            {shippableItems.map((item) => (
              <div key={item.id} className="border rounded-md p-3">
                <div className="flex items-start gap-3">
                  {item.imageUrl ? (
                    <img src={item.imageUrl} className="w-10 h-10 rounded object-cover border" />
                  ) : (
                    <div className="w-10 h-10 rounded bg-muted flex items-center justify-center">
                      <Package className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium truncate">{item.name}</p>
                        <p className="text-xs font-mono text-muted-foreground">{item.sku}</p>
                      </div>
                      <Badge variant="outline" className={cn("text-[10px] shrink-0", itemStatusColors[item.status] || "")}>
                        {item.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                      <span>Qty: <strong className="text-foreground">{item.quantity}</strong></span>
                      <span>Picked: <strong className={item.pickedQuantity === item.quantity ? "text-green-600" : "text-foreground"}>{item.pickedQuantity}</strong></span>
                      {item.location && item.location !== "UNASSIGNED" && (
                        <span className="flex items-center gap-0.5">
                          <MapPinIcon className="h-3 w-3" /> {item.location}
                        </span>
                      )}
                    </div>
                    {item.priceCents != null && (
                      <div className="text-xs text-muted-foreground mt-1">
                        ${(item.priceCents / 100).toFixed(2)} ea
                        {item.discountCents && item.discountCents > 0 && (
                          <span className="text-red-500 ml-1">(-${(item.discountCents / 100).toFixed(2)})</span>
                        )}
                        {item.totalPriceCents != null && (
                          <span className="ml-2 font-medium text-foreground">= ${(item.totalPriceCents / 100).toFixed(2)}</span>
                        )}
                      </div>
                    )}
                    {item.shortReason && (
                      <p className="text-xs text-red-500 mt-1">Short: {item.shortReason}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {digitalItems.length > 0 && (
            <div className="mt-3 pt-3 border-t">
              <h5 className="text-xs font-semibold text-muted-foreground mb-2">Digital / Non-shipping ({digitalItems.length})</h5>
              {digitalItems.map((item) => (
                <div key={item.id} className="flex justify-between text-xs py-1">
                  <span>{item.name} <span className="font-mono text-muted-foreground">({item.sku})</span></span>
                  <span>x{item.quantity}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      {order.notes && (
        <Card>
          <CardContent className="p-4">
            <h4 className="text-sm font-semibold flex items-center gap-2 mb-2">
              <FileText className="h-4 w-4" /> Notes
            </h4>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{order.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Timestamps */}
      <Card>
        <CardContent className="p-4">
          <h4 className="text-sm font-semibold mb-2">Timeline</h4>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            {order.orderPlacedAt && (
              <div className="flex justify-between">
                <span>Placed</span>
                <span>{format(new Date(order.orderPlacedAt), "MMM d, yyyy h:mm a")}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>Imported</span>
              <span>{format(new Date(order.createdAt), "MMM d, yyyy h:mm a")}</span>
            </div>
            {order.startedAt && (
              <div className="flex justify-between">
                <span>Picking started</span>
                <span>{format(new Date(order.startedAt), "MMM d, yyyy h:mm a")}</span>
              </div>
            )}
            {order.completedAt && (
              <div className="flex justify-between">
                <span>Completed</span>
                <span>{format(new Date(order.completedAt), "MMM d, yyyy h:mm a")}</span>
              </div>
            )}
            {order.slaDueAt && (
              <div className="flex justify-between">
                <span>SLA Due</span>
                <span className={cn(
                  order.slaStatus === "overdue" && "text-red-500 font-medium",
                  order.slaStatus === "at_risk" && "text-amber-500 font-medium",
                )}>
                  {format(new Date(order.slaDueAt), "MMM d, yyyy h:mm a")}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

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
  const [warehouseFilter, setWarehouseFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("active");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCombineOpen, setIsCombineOpen] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedCombineGroup, setSelectedCombineGroup] = useState<CombinableGroup | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const [expandedOrderIds, setExpandedOrderIds] = useState<Set<number>>(new Set());
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
      if (statusFilter === "active" || statusFilter === "combined") {
        params.append("status", "ready");
        params.append("status", "in_progress");
      } else if (statusFilter === "completed") {
        params.append("status", "shipped");
        params.append("status", "packed");
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

  const { data: allWarehouses = [] } = useQuery<{ id: number; code: string; name: string; warehouseType: string }[]>({
    queryKey: ["/api/warehouses"],
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
      setExpandedOrderIds(new Set());
      toast({ title: "Orders combined", description: "The selected orders have been grouped for combined picking and shipping." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const combineAllMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/orders/combine-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to combine all orders");
      }
      return res.json();
    },
    onSuccess: (data: { groupsCreated: number; totalOrdersCombined: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/orders/combinable"] });
      queryClient.invalidateQueries({ queryKey: ["/api/oms/orders"] });
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      setIsCombineOpen(false);
      toast({ title: "All orders combined", description: `Created ${data.groupsCreated} groups from ${data.totalOrdersCombined} orders.` });
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
    // Warehouse filter
    if (warehouseFilter !== "all" && String(order.warehouseId || "") !== warehouseFilter) return false;
    // Search filter
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
      if (order.combinedGroupId) {
        // Skip if we've already rendered this group (could be reached via parent or child)
        if (processedGroupIds.has(order.combinedGroupId)) continue;
        processedGroupIds.add(order.combinedGroupId);

        // Look up ALL group members from the full orders list (not filteredOrders) so
        // the count is correct even when the search term only matches one order in the group
        const groupOrders = orders.filter(o => o.combinedGroupId === order.combinedGroupId);
        const parentOrder = groupOrders.find(o => o.combinedRole === "parent") || groupOrders[0];

        const totalItemCount = groupOrders.reduce((sum, o) => sum + o.itemCount, 0);
        const totalPickedCount = groupOrders.reduce((sum, o) => sum + o.pickedCount, 0);
        const combinedOrdersList = groupOrders.map(o => ({
          id: o.id,
          orderNumber: o.orderNumber,
          itemCount: o.itemCount,
          status: o.warehouseStatus,
        }));

        result.push({
          ...parentOrder,
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

  const activeCount = orders.filter(o => o.warehouseStatus === "ready" || o.warehouseStatus === "in_progress").length;
  const exceptionCount = orders.filter(o => o.warehouseStatus === "exception").length;
  const completedCount = orders.filter(o => o.warehouseStatus === "shipped" || o.warehouseStatus === "packed").length;
  const combinedCount = groupedOrders.filter(o => o.isCombinedGroup).length;

  // Apply combined filter if active
  const displayOrders = statusFilter === "combined"
    ? groupedOrders.filter(o => o.isCombinedGroup)
    : groupedOrders;

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
              {combinedCount > 0 && (
                <TabsTrigger
                  value="combined"
                  className="rounded-none border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent px-3 md:px-4 py-2 text-sm text-indigo-600"
                  data-testid="tab-combined"
                >
                  Combined ({combinedCount})
                </TabsTrigger>
              )}
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
        <div className={cn("md:col-span-2 space-y-4", selectedOrderId && "hidden md:block")}>
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
              {allWarehouses.length > 1 && (
                <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                  <SelectTrigger className="w-full sm:w-[180px] h-11">
                    <Building2 className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="All Warehouses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Warehouses</SelectItem>
                    {allWarehouses.map((wh) => (
                      <SelectItem key={wh.id} value={String(wh.id)}>{wh.code} - {wh.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button variant="outline" size="icon" onClick={() => refetchOrders()} className="min-h-[44px] min-w-[44px]" data-testid="button-refresh-orders">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {ordersLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : displayOrders.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <ShoppingCart className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">{statusFilter === "combined" ? "No combined orders" : "No orders found"}</p>
                <p className="text-sm">{statusFilter === "combined" ? "Combined order groups will appear here when orders are grouped." : "Orders from your connected channels will appear here."}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {displayOrders.map((order) => (
                <Card
                  key={order.isCombinedGroup ? `combined-${order.combinedGroupId}` : order.id}
                  className={cn(
                    "hover:border-primary/50 transition-colors cursor-pointer group",
                    order.isCombinedGroup && "border-l-4 border-l-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20",
                    selectedOrderId === order.id && "border-primary ring-1 ring-primary/30"
                  )}
                  onClick={() => setSelectedOrderId(order.id)}
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
                                  {order.warehouseStatus === "awaiting_3pl" ? "3PL" : order.warehouseStatus.replace("_", " ")}
                                </Badge>
                                {order.warehouseId && allWarehouses.length > 1 && (() => {
                                  const wh = allWarehouses.find(w => w.id === order.warehouseId);
                                  if (!wh) return null;
                                  return (
                                    <Badge variant="outline" className={cn("text-xs", wh.warehouseType === "3pl" ? "bg-purple-50 text-purple-700 border-purple-200" : "bg-slate-50 text-slate-600 border-slate-200")}>
                                      {wh.code}
                                    </Badge>
                                  );
                                })()}
                                {order.slaStatus && order.slaStatus !== "on_time" && order.slaStatus !== "met" && (
                                  <Badge variant="outline" className={cn("text-xs",
                                    order.slaStatus === "overdue" ? "bg-red-50 text-red-700 border-red-200" :
                                    order.slaStatus === "at_risk" ? "bg-amber-50 text-amber-700 border-amber-200" : ""
                                  )}>
                                    {order.slaStatus === "overdue" ? "SLA Overdue" : "SLA At Risk"}
                                  </Badge>
                                )}
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

        {selectedOrderId ? (
          <div className="space-y-6 overflow-y-auto max-h-[calc(100vh-12rem)]">
            <OrderDetailPanel orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />
          </div>
        ) : (
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
        )}
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
                  {selectedCombineGroup.orders.map((order) => {
                    const isExpanded = expandedOrderIds.has(order.id);
                    const isSelected = selectedOrderIds.includes(order.id);
                    return (
                      <Collapsible
                        key={order.id}
                        open={isExpanded}
                        onOpenChange={(open) => setExpandedOrderIds(prev => {
                          const next = new Set(prev);
                          if (open) next.add(order.id); else next.delete(order.id);
                          return next;
                        })}
                      >
                        <div
                          className={cn(
                            "border rounded-lg transition-colors overflow-hidden",
                            isSelected
                              ? "border-amber-400 bg-amber-50"
                              : "hover:bg-muted/50"
                          )}
                        >
                          <CollapsibleTrigger asChild>
                            <div
                              className="flex items-center justify-between p-3 cursor-pointer"
                              data-testid={`row-order-${order.id}`}
                            >
                              <div className="flex items-center gap-3">
                                <div
                                  className={cn(
                                    "h-5 w-5 rounded border-2 flex items-center justify-center shrink-0",
                                    isSelected
                                      ? "bg-amber-500 border-amber-500 text-white"
                                      : "border-gray-300"
                                  )}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (isSelected) {
                                      if (selectedOrderIds.length > 2) {
                                        setSelectedOrderIds(selectedOrderIds.filter(id => id !== order.id));
                                      }
                                    } else {
                                      setSelectedOrderIds([...selectedOrderIds, order.id]);
                                    }
                                  }}
                                  data-testid={`checkbox-order-${order.id}`}
                                >
                                  {isSelected && <Check className="h-3 w-3" />}
                                </div>
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium">{order.orderNumber}</span>
                                    {order.combinedGroupId && (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-indigo-300 text-indigo-600">
                                        <Merge className="h-2.5 w-2.5 mr-0.5" />
                                        combined
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="text-xs text-muted-foreground">
                                    {order.itemCount} items, {order.unitCount} units
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {order.totalAmount && (
                                  <span className="text-sm font-medium">${order.totalAmount}</span>
                                )}
                                <ChevronRight className={cn("h-4 w-4 transition-transform text-muted-foreground", isExpanded && "rotate-90")} />
                              </div>
                            </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <CombineOrderItems orderId={order.id} />
                          </CollapsibleContent>
                        </div>
                      </Collapsible>
                    );
                  })}
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
                    setExpandedOrderIds(new Set());
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
              <>
                <Button 
                  variant="outline" 
                  onClick={() => setIsCombineOpen(false)} 
                  className="min-h-[44px]"
                  data-testid="button-close-combine"
                >
                  Close
                </Button>
                {combinableGroups.length > 0 && (
                  <Button 
                    onClick={() => combineAllMutation.mutate()}
                    disabled={combineAllMutation.isPending}
                    className="min-h-[44px] bg-amber-600 hover:bg-amber-700"
                    data-testid="button-combine-all"
                  >
                    {combineAllMutation.isPending ? "Combining..." : `Combine All (${combinableGroups.length} groups)`}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
