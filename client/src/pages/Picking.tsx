import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Scan, 
  CheckCircle2, 
  ArrowRight, 
  ArrowLeft,
  AlertTriangle,
  PackageCheck,
  ChevronRight,
  Package,
  ClipboardList,
  Clock,
  RotateCcw,
  Trophy,
  Zap,
  Volume2,
  VolumeX,
  Maximize,
  Smartphone,
  Layers,
  User,
  Focus,
  List,
  MapPin,
  RefreshCw,
  CloudDownload,
  Search,
  ArrowUpDown,
  ArrowDown,
  ArrowUp,
  X,
  XCircle,
  Unlock,
  Pause,
  Play,
  Truck,
  Plus,
  Minus,
  Edit3
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import type { Order, OrderItem, ItemStatus } from "@shared/schema";

// API response type
interface OrderWithItems extends Order {
  items: OrderItem[];
  pickerName?: string | null;
  c2pMs?: number | null; // Click to Pick time in milliseconds
  channelName?: string | null; // Channel display name
  channelProvider?: string | null; // Provider type (shopify, ebay, amazon, manual)
}

// API functions
async function fetchPickingQueue(): Promise<OrderWithItems[]> {
  const res = await fetch("/api/picking/queue");
  if (!res.ok) throw new Error("Failed to fetch picking queue");
  return res.json();
}

async function claimOrder(orderId: number, pickerId: string): Promise<OrderWithItems> {
  const res = await fetch(`/api/picking/orders/${orderId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pickerId }),
  });
  if (!res.ok) throw new Error("Failed to claim order");
  return res.json();
}

async function releaseOrder(orderId: number, resetProgress: boolean = true): Promise<Order> {
  const res = await fetch(`/api/picking/orders/${orderId}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resetProgress }),
  });
  if (!res.ok) throw new Error("Failed to release order");
  return res.json();
}

async function holdOrder(orderId: number): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to hold order");
  return res.json();
}

async function releaseHoldOrder(orderId: number): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/release-hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to release hold");
  return res.json();
}

async function setOrderPriority(orderId: number, priority: "rush" | "high" | "normal"): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/priority`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ priority }),
  });
  if (!res.ok) throw new Error("Failed to set priority");
  return res.json();
}

async function forceReleaseOrder(orderId: number, resetProgress: boolean = false): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/force-release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ resetProgress }),
  });
  if (!res.ok) throw new Error("Failed to force release order");
  return res.json();
}

type PickInventoryContext = {
  deducted: boolean;
  systemQtyAfter: number;
  locationId: number | null;
  locationCode: string | null;
  sku: string;
  binCountNeeded: boolean;
  replen: {
    triggered: boolean;
    taskId: number | null;
    taskStatus: string | null;
    autoExecuted: boolean;
    stockout: boolean;
  };
};

type PickResponse = {
  item: OrderItem;
  inventory: PickInventoryContext;
};

type BinCountResponse = {
  success: boolean;
  systemQtyBefore: number;
  actualBinQty: number;
  adjustment: number;
  replenTriggered: boolean;
  replenTaskStatus: string | null;
};

async function updateOrderItem(
  itemId: number,
  status: ItemStatus,
  pickedQuantity?: number,
  shortReason?: string,
  pickMethod?: "scan" | "manual" | "pick_all" | "button" | "short"
): Promise<PickResponse> {
  const res = await fetch(`/api/picking/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, pickedQuantity, shortReason, pickMethod }),
  });
  if (!res.ok) throw new Error("Failed to update item");
  return res.json();
}

async function confirmBinCount(sku: string, locationId: number, actualQty: number): Promise<BinCountResponse> {
  const res = await fetch("/api/picking/case-break/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku, warehouseLocationId: locationId, actualBinQty: actualQty }),
  });
  if (!res.ok) throw new Error("Failed to confirm bin count");
  return res.json();
}

async function skipBinCount(sku: string, locationId: number, actualQty: number): Promise<BinCountResponse> {
  const res = await fetch("/api/picking/case-break/skip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku, warehouseLocationId: locationId, actualBinQty: actualQty }),
  });
  if (!res.ok) throw new Error("Failed to skip bin count");
  return res.json();
}

async function markOrderReadyToShip(orderId: number): Promise<Order> {
  const res = await fetch(`/api/picking/orders/${orderId}/ready-to-ship`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to mark ready to ship");
  return res.json();
}

async function fetchExceptions(): Promise<OrderWithItems[]> {
  const res = await fetch("/api/orders/exceptions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch exceptions");
  return res.json();
}

async function resolveException(orderId: number, resolution: string, notes?: string): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/resolve-exception`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ resolution, notes }),
  });
  if (!res.ok) throw new Error("Failed to resolve exception");
  return res.json();
}

// Helper to calculate order age from order date
function getOrderAge(orderDate: Date | string | null | undefined): string {
  if (!orderDate) return "0m";
  const now = new Date();
  // Handle date strings without timezone - assume UTC
  let dateStr = String(orderDate);
  // If no timezone indicator, append Z to treat as UTC
  if (!dateStr.includes('Z') && !dateStr.includes('+') && !dateStr.includes('T')) {
    dateStr = dateStr.replace(' ', 'T') + 'Z';
  }
  const created = new Date(dateStr);
  const diffMs = Math.max(0, now.getTime() - created.getTime()); // Never negative
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return `${hours}h ${mins}m`;
}

// Format C2P (Click to Pick) time from milliseconds
function formatC2P(c2pMs: number | null | undefined): string | null {
  if (!c2pMs || c2pMs < 0) return null;
  
  const totalMinutes = Math.floor(c2pMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = totalMinutes % 60;
  
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (totalHours > 0) {
    return `${totalHours}h ${mins}m`;
  }
  return `${mins}m`;
}

// Helper function to get channel badge styling
function getChannelBadgeStyle(provider: string | null | undefined): { className: string; label: string } {
  switch (provider?.toLowerCase()) {
    case "shopify":
      return { className: "bg-green-100 text-green-700 border-green-300", label: "Shopify" };
    case "amazon":
      return { className: "bg-orange-100 text-orange-700 border-orange-300", label: "Amazon" };
    case "ebay":
      return { className: "bg-blue-100 text-blue-700 border-blue-300", label: "eBay" };
    case "etsy":
      return { className: "bg-orange-50 text-orange-600 border-orange-200", label: "Etsy" };
    case "manual":
      return { className: "bg-slate-100 text-slate-600 border-slate-300", label: "Manual" };
    default:
      return { className: "bg-gray-100 text-gray-600 border-gray-300", label: provider || "Unknown" };
  }
}

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Types
interface PickItem {
  id: number;
  sku: string;
  name: string;
  location: string;
  qty: number;
  picked: number;
  status: "pending" | "in_progress" | "completed" | "short";
  orderId: string;
  image: string;
  barcode?: string;
}

interface PickBatch {
  id: string;
  orders: number;
  items: PickItem[];
  priority: "rush" | "high" | "normal";
  age: string;
  zones: string[];
  status: "ready" | "in_progress" | "completed";
  assignee: string | null;
}

// Single order data for single picking mode
interface SingleOrder {
  id: string;
  orderNumber: string;
  customer: string;
  items: PickItem[];
  priority: "rush" | "high" | "normal";
  age: string;
  orderDate?: string;
  status: "ready" | "in_progress" | "completed";
  assignee: string | null;
  onHold?: boolean;
  pickerName?: string | null;
  completedAt?: string | null;
  c2p?: string | null; // Click to Pick time formatted (e.g., "2d 3h")
  channelName?: string | null; // Channel display name
  channelProvider?: string | null; // Provider type (shopify, ebay, amazon, manual)
  combinedGroupId?: number | null; // Combined order group ID
  combinedRole?: string | null; // 'parent' or 'child'
  // For combined orders - contains the individual orders in the group
  combinedOrders?: { id: string; orderNumber: string; itemCount: number }[];
  isCombinedGroup?: boolean; // True if this entry represents a combined group
}

const createSingleOrderQueue = (): SingleOrder[] => [
  {
    id: "ORD-1024",
    orderNumber: "#1024",
    customer: "Alice Freeman",
    priority: "high",
    age: "15m",
    status: "ready",
    assignee: null,
    items: [
      { id: 1, sku: "NK-292-BLK", name: "Nike Air Max 90", location: "A-01-02-B", qty: 2, picked: 0, status: "pending", orderId: "#1024", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
      { id: 4, sku: "PM-102-GRY", name: "Puma RS-X", location: "B-12-04-D", qty: 1, picked: 0, status: "pending", orderId: "#1024", image: "https://images.unsplash.com/photo-1608231387042-66d1773070a5?auto=format&fit=crop&w=100&q=80" },
    ]
  },
  {
    id: "ORD-1025",
    orderNumber: "#1025",
    customer: "Bob Smith",
    priority: "rush",
    age: "8m",
    status: "ready",
    assignee: null,
    items: [
      { id: 2, sku: "AD-550-WHT", name: "Adidas Ultraboost", location: "A-01-04-A", qty: 1, picked: 0, status: "pending", orderId: "#1025", image: "https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=100&q=80" },
    ]
  },
  {
    id: "ORD-1026",
    orderNumber: "#1026",
    customer: "Charlie Davis",
    priority: "normal",
    age: "1h 5m",
    status: "ready",
    assignee: null,
    items: [
      { id: 3, sku: "NB-990-NVY", name: "New Balance 990v5", location: "B-12-01-C", qty: 3, picked: 0, status: "pending", orderId: "#1026", image: "https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=100&q=80" },
    ]
  },
  {
    id: "ORD-1030",
    orderNumber: "#1030",
    customer: "Diana Prince",
    priority: "normal",
    age: "45m",
    status: "ready",
    assignee: null,
    items: [
      { id: 5, sku: "NK-AIR-RED", name: "Nike Air Force 1 Red", location: "A-02-01-A", qty: 1, picked: 0, status: "pending", orderId: "#1030", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
      { id: 6, sku: "AD-STN-BLK", name: "Adidas Stan Smith", location: "A-02-03-B", qty: 2, picked: 0, status: "pending", orderId: "#1030", image: "https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=100&q=80" },
    ]
  },
];

// Initial mock data for batch picking mode
const createInitialQueue = (): PickBatch[] => [
  { 
    id: "BATCH-4921", 
    orders: 3, 
    priority: "high", 
    age: "15m", 
    zones: ["A", "B"], 
    status: "ready", 
    assignee: null,
    items: [
      { id: 1, sku: "NK-292-BLK", name: "Nike Air Max 90", location: "A-01-02-B", qty: 2, picked: 0, status: "pending", orderId: "#1024", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
      { id: 2, sku: "AD-550-WHT", name: "Adidas Ultraboost", location: "A-01-04-A", qty: 1, picked: 0, status: "pending", orderId: "#1025", image: "https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=100&q=80" },
      { id: 3, sku: "NB-990-NVY", name: "New Balance 990v5", location: "B-12-01-C", qty: 3, picked: 0, status: "pending", orderId: "#1026", image: "https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=100&q=80" },
      { id: 4, sku: "PM-102-GRY", name: "Puma RS-X", location: "B-12-04-D", qty: 1, picked: 0, status: "pending", orderId: "#1024", image: "https://images.unsplash.com/photo-1608231387042-66d1773070a5?auto=format&fit=crop&w=100&q=80" },
    ]
  },
  { 
    id: "BATCH-4918", 
    orders: 2, 
    priority: "rush", 
    age: "8m", 
    zones: ["A"], 
    status: "ready", 
    assignee: null,
    items: [
      { id: 5, sku: "NK-AIR-RED", name: "Nike Air Force 1 Red", location: "A-02-01-A", qty: 1, picked: 0, status: "pending", orderId: "#1030", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
      { id: 6, sku: "AD-STN-BLK", name: "Adidas Stan Smith", location: "A-02-03-B", qty: 2, picked: 0, status: "pending", orderId: "#1031", image: "https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=100&q=80" },
    ]
  },
  { 
    id: "BATCH-4919", 
    orders: 4, 
    priority: "normal", 
    age: "1h 5m", 
    zones: ["B", "C"], 
    status: "ready", 
    assignee: null,
    items: [
      { id: 7, sku: "VN-OLD-BLK", name: "Vans Old Skool", location: "B-05-02-A", qty: 1, picked: 0, status: "pending", orderId: "#1032", image: "https://images.unsplash.com/photo-1525966222134-fcfa99b8ae77?auto=format&fit=crop&w=100&q=80" },
      { id: 8, sku: "CV-CHK-WHT", name: "Converse Chuck Taylor", location: "B-05-04-C", qty: 2, picked: 0, status: "pending", orderId: "#1033", image: "https://images.unsplash.com/photo-1607522370275-f14206abe5d3?auto=format&fit=crop&w=100&q=80" },
      { id: 9, sku: "RB-CL-TAN", name: "Reebok Classic", location: "C-01-01-A", qty: 1, picked: 0, status: "pending", orderId: "#1034", image: "https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=100&q=80" },
    ]
  },
  { 
    id: "ORD-1035", 
    orders: 1, 
    priority: "normal", 
    age: "45m", 
    zones: ["C"], 
    status: "ready", 
    assignee: null,
    items: [
      { id: 10, sku: "SK-BLZ-BLU", name: "Skechers Blazer Blue", location: "C-03-02-B", qty: 1, picked: 0, status: "pending", orderId: "#1035", image: "https://images.unsplash.com/photo-1608231387042-66d1773070a5?auto=format&fit=crop&w=100&q=80" },
    ]
  },
];

// Sound and haptic imports from shared library
import { 
  playSound as playSoundLib, 
  triggerHaptic as triggerHapticLib,
  themeNames,
  themeDescriptions,
  previewTheme,
  type SoundTheme,
  type SoundType
} from "@/lib/sounds";

export default function Picking() {
  // Get current user for role-based UI
  const { user } = useAuth();
  const isAdminOrLead = user && (user.role === "admin" || user.role === "lead");
  const { toast } = useToast();
  
  // Get picking mode, view mode, and sound/haptic settings from context
  const { 
    pickingMode, setPickingMode, 
    pickerViewMode, setPickerViewMode,
    soundTheme, setSoundTheme,
    hapticEnabled, setHapticEnabled
  } = useSettings();
  
  // Wrapper functions that use settings
  const playSound = (type: SoundType) => {
    if (soundTheme !== "silent") {
      playSoundLib(type, soundTheme);
    }
    if (hapticEnabled) {
      const hapticMap: Record<SoundType, "light" | "medium" | "heavy"> = {
        success: "medium",
        error: "heavy", 
        complete: "heavy",
        scan: "light"
      };
      triggerHapticLib(hapticMap[type]);
    }
  };
  
  const triggerHaptic = (type: "light" | "medium" | "heavy") => {
    if (hapticEnabled) {
      triggerHapticLib(type);
    }
  };
  const queryClient = useQueryClient();
  const pickerId = user?.id || "";
  
  // Fetch orders from API - auto-refresh every 15s and when window regains focus
  const { data: apiOrders = [], isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["picking-queue"],
    queryFn: fetchPickingQueue,
    refetchInterval: 15000, // Refresh every 15s as fallback
    refetchOnWindowFocus: true, // Refresh when picker returns to app
    refetchOnMount: true, // Always fetch fresh data on mount
    staleTime: 5000, // Consider data stale after 5s
  });
  
  // Fetch exceptions for admins/leads only
  const { data: exceptionOrders = [], refetch: refetchExceptions } = useQuery({
    queryKey: ["exception-orders"],
    queryFn: fetchExceptions,
    enabled: !!isAdminOrLead, // Only fetch for admin/lead users
    refetchOnWindowFocus: true,
  });
  
  // Mutation for resolving exceptions
  const resolveExceptionMutation = useMutation({
    mutationFn: ({ orderId, resolution, notes }: { orderId: number; resolution: string; notes?: string }) => 
      resolveException(orderId, resolution, notes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["exception-orders"] });
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      toast({ title: "Exception resolved", description: "Order has been updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to resolve exception", description: error.message, variant: "destructive" });
    }
  });
  
  // WebSocket for real-time order updates and version detection
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let currentVersion: string | null = null;
    
    const connect = () => {
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        console.log("WebSocket connected for real-time order updates");
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "orders:updated") {
            console.log("New order received via WebSocket, refreshing queue");
            refetch();
            if (soundTheme !== "silent") {
              playSoundLib("success", soundTheme);
            }
          } else if (data.type === "version") {
            if (currentVersion === null) {
              // First connection - store the version
              currentVersion = data.version;
              console.log(`[Version] Initial: ${currentVersion}`);
            } else if (currentVersion !== data.version) {
              // Version changed - new deployment!
              console.log(`[Version] Update detected: ${currentVersion} -> ${data.version}`);
              // Auto-reload to get new version
              window.location.reload();
            }
          }
        } catch (e) {
          console.error("WebSocket message parse error:", e);
        }
      };
      
      ws.onclose = () => {
        console.log("WebSocket disconnected, reconnecting in 5s...");
        reconnectTimeout = setTimeout(connect, 5000);
      };
      
      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };
    };
    
    connect();
    
    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [refetch, soundTheme]);
  
  // Transform API orders to SingleOrder format for UI
  const formatOrderDate = (dateInput: string | Date | undefined | null): string => {
    if (!dateInput) return "";
    let date: Date;
    if (typeof dateInput === "string") {
      // If no timezone indicator, treat as UTC by appending Z
      const hasTimezone = dateInput.includes('Z') || dateInput.includes('+') || /\d{2}:\d{2}:\d{2}-\d{2}/.test(dateInput);
      date = new Date(hasTimezone ? dateInput : dateInput.replace(' ', 'T') + 'Z');
    } else {
      date = dateInput;
    }
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  
  // First, map all API orders to SingleOrder format
  const allOrdersMapped: SingleOrder[] = apiOrders.map((order): SingleOrder => ({
    id: String(order.id),
    orderNumber: order.orderNumber,
    customer: order.customerName,
    priority: order.priority as "rush" | "high" | "normal",
    age: getOrderAge(order.orderPlacedAt || order.shopifyCreatedAt || order.createdAt),
    orderDate: formatOrderDate(order.orderPlacedAt || order.shopifyCreatedAt || order.createdAt),
    status: order.warehouseStatus === "in_progress" ? "in_progress" : 
            (order.warehouseStatus === "completed" || order.warehouseStatus === "ready_to_ship" || order.warehouseStatus === "shipped") ? "completed" : "ready",
    assignee: order.assignedPickerId,
    onHold: order.onHold === 1,
    pickerName: order.pickerName || null,
    completedAt: order.completedAt ? String(order.completedAt) : null,
    c2p: formatC2P(order.c2pMs), // Click to Pick time
    channelName: order.channelName || null,
    channelProvider: order.channelProvider || null,
    combinedGroupId: order.combinedGroupId,
    combinedRole: order.combinedRole,
    items: order.items.map((item): PickItem => ({
      id: item.id,
      sku: item.sku,
      name: item.name,
      location: item.location,
      qty: item.quantity,
      picked: item.pickedQuantity,
      status: item.status as "pending" | "in_progress" | "completed" | "short",
      orderId: order.orderNumber,
      image: item.imageUrl || "",
      barcode: item.barcode || undefined,
    })),
  }));

  // Group combined orders into single entries
  const ordersFromApi: SingleOrder[] = (() => {
    const result: SingleOrder[] = [];
    const processedGroupIds = new Set<number>();
    
    for (const order of allOrdersMapped) {
      // Skip child orders - they'll be merged into the parent
      if (order.combinedGroupId && order.combinedRole === "child") {
        continue;
      }
      
      // If this is a parent of a combined group, merge all children
      if (order.combinedGroupId && order.combinedRole === "parent") {
        if (processedGroupIds.has(order.combinedGroupId)) continue;
        processedGroupIds.add(order.combinedGroupId);
        
        // Find all orders in this combined group
        const groupOrders = allOrdersMapped.filter(o => o.combinedGroupId === order.combinedGroupId);
        
        // Combine all items from all orders, preserving which order each item belongs to
        const allItems: PickItem[] = [];
        const combinedOrdersList: { id: string; orderNumber: string; itemCount: number }[] = [];
        
        for (const groupOrder of groupOrders) {
          combinedOrdersList.push({
            id: groupOrder.id,
            orderNumber: groupOrder.orderNumber,
            itemCount: groupOrder.items.length,
          });
          allItems.push(...groupOrder.items);
        }
        
        // Calculate combined totals
        const totalUnits = allItems.reduce((sum, item) => sum + item.qty, 0);
        const orderNumbers = groupOrders.map(o => o.orderNumber).join(", ");
        
        // Create combined entry using parent's data but with merged items
        result.push({
          ...order,
          id: `combined-${order.combinedGroupId}`, // Special ID for combined group
          orderNumber: orderNumbers,
          items: allItems,
          combinedOrders: combinedOrdersList,
          isCombinedGroup: true,
        });
      } else {
        // Regular uncombined order
        result.push(order);
      }
    }
    
    return result;
  })();
  
  // Use API data if available, otherwise fall back to mock data
  const hasApiData = ordersFromApi.length > 0 || apiOrders.length === 0;
  
  // Core state - Batch mode (mock data for batch mode still)
  const [queue, setQueue] = useState<PickBatch[]>(createInitialQueue);
  // Core state - Single mode (local copy for active picking session)
  const [localSingleQueue, setLocalSingleQueue] = useState<SingleOrder[]>([]);
  
  // Merge API data with local state - local state takes precedence for in-progress orders
  // For completed orders, use API data which has picker metadata
  const singleQueue = pickingMode === "single" && ordersFromApi.length > 0 
    ? (() => {
        // Start with API orders, preferring local state for in-progress orders only
        const merged = ordersFromApi.map(apiOrder => {
          const localOrder = localSingleQueue.find(lo => lo.id === apiOrder.id);
          // For completed orders, prefer API data which has picker metadata
          if (apiOrder.status === "completed") {
            return apiOrder;
          }
          return localOrder || apiOrder;
        });
        // Add completed orders from local state that aren't in API anymore (recently completed)
        const completedLocalOrders = localSingleQueue.filter(
          lo => lo.status === "completed" && !ordersFromApi.some(ao => ao.id === lo.id)
        );
        return [...merged, ...completedLocalOrders];
      })()
    : localSingleQueue.length > 0 ? localSingleQueue : createSingleOrderQueue();
  
  // Mutation for claiming orders
  const claimMutation = useMutation({
    mutationFn: ({ orderId }: { orderId: number }) => claimOrder(orderId, pickerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
  });
  
  // Mutation for releasing orders
  const releaseMutation = useMutation({
    mutationFn: ({ orderId, resetProgress = true }: { orderId: number; resetProgress?: boolean }) => 
      releaseOrder(orderId, resetProgress),
    onSuccess: (_, { orderId }) => {
      // Clear local state for this order so it refreshes from API
      setLocalSingleQueue(prev => prev.filter(o => o.id !== String(orderId)));
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
    onError: (error) => {
      console.error("Failed to release order:", error);
      // Show error feedback
      playSound("error");
    },
  });
  
  // Mutation for putting orders on hold
  const holdMutation = useMutation({
    mutationFn: (orderId: number) => {
      console.log("[HOLD] Attempting to hold order:", orderId);
      return holdOrder(orderId);
    },
    onSuccess: (data) => {
      console.log("[HOLD] Success:", data);
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({
        title: "Order on hold",
        description: `Order ${data.orderNumber} has been placed on hold`,
      });
    },
    onError: (error) => {
      console.error("[HOLD] Failed to hold order:", error);
      playSound("error");
      toast({
        title: "Failed to hold order",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });
  
  // Mutation for releasing hold on orders
  const releaseHoldMutation = useMutation({
    mutationFn: (orderId: number) => releaseHoldOrder(orderId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({
        title: "Order released",
        description: `Order ${data.orderNumber} is back in the queue`,
      });
    },
    onError: (error) => {
      console.error("Failed to release hold:", error);
      playSound("error");
      toast({
        title: "Failed to release order",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });
  
  // Mutation for setting order priority (admin/lead only)
  const rushMutation = useMutation({
    mutationFn: ({ orderId, priority }: { orderId: number; priority: "rush" | "high" | "normal" }) => 
      setOrderPriority(orderId, priority),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({
        title: data.priority === "rush" ? "Order marked as RUSH" : "Order priority updated",
        description: `Order ${data.orderNumber} is now ${data.priority} priority`,
      });
    },
    onError: (error) => {
      console.error("Failed to set priority:", error);
      playSound("error");
      toast({
        title: "Failed to set priority",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });
  
  // Mutation for force releasing stuck orders (admin only)
  const forceReleaseMutation = useMutation({
    mutationFn: ({ orderId, resetProgress }: { orderId: number; resetProgress?: boolean }) => 
      forceReleaseOrder(orderId, resetProgress),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      setLocalSingleQueue(prev => prev.filter(o => o.id !== String(data.id)));
      playSound("success");
      toast({
        title: "Order force released",
        description: `Order ${data.orderNumber} has been released and is back in the queue`,
      });
    },
    onError: (error) => {
      console.error("Failed to force release:", error);
      playSound("error");
      toast({
        title: "Failed to force release",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });
  
  // Bin count dialog state
  const [binCountOpen, setBinCountOpen] = useState(false);
  const [binCountContext, setBinCountContext] = useState<PickInventoryContext | null>(null);
  const [binCountQty, setBinCountQty] = useState("");

  // Mutation for updating items
  const updateItemMutation = useMutation({
    mutationFn: ({ itemId, status, pickedQuantity, shortReason, pickMethod }: {
      itemId: number;
      status: ItemStatus;
      pickedQuantity?: number;
      shortReason?: string;
      pickMethod?: "scan" | "manual" | "pick_all" | "button" | "short";
    }) => updateOrderItem(itemId, status, pickedQuantity, shortReason, pickMethod),
    onSuccess: (data: PickResponse) => {
      const { item: updatedItem, inventory } = data;
      queryClient.setQueryData<OrderWithItems[]>(["picking-queue"], (oldData) => {
        if (!oldData) return oldData;
        return oldData.map(order => ({
          ...order,
          items: order.items.map(item =>
            item.id === updatedItem.id ? { ...item, ...updatedItem } : item
          )
        }));
      });
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });

      // Show bin count prompt when needed
      if (inventory?.binCountNeeded) {
        setBinCountContext(inventory);
        setBinCountQty("");
        setBinCountOpen(true);
      }
    },
  });

  // Mutation for confirming bin count
  const binCountMutation = useMutation({
    mutationFn: ({ sku, locationId, actualQty }: { sku: string; locationId: number; actualQty: number }) =>
      confirmBinCount(sku, locationId, actualQty),
    onSuccess: (result: BinCountResponse) => {
      setBinCountOpen(false);
      setBinCountContext(null);
      if (result.adjustment !== 0) {
        toast({
          title: "Bin count adjusted",
          description: `Adjusted by ${result.adjustment > 0 ? "+" : ""}${result.adjustment} (was ${result.systemQtyBefore}, now ${result.actualBinQty})`,
        });
      } else {
        toast({ title: "Bin count verified", description: "Count matches system" });
      }
      if (result.replenTriggered) {
        toast({
          title: result.replenTaskStatus === "blocked" ? "Stockout — no reserve" : "Replen triggered",
          description: result.replenTaskStatus === "blocked"
            ? "No reserve stock available for replenishment"
            : "Replenishment task created for this bin",
          variant: result.replenTaskStatus === "blocked" ? "destructive" : "default",
        });
      }
      playSound("success");
    },
    onError: (error: Error) => {
      toast({ title: "Bin count failed", description: error.message, variant: "destructive" });
      playSound("error");
    },
  });

  // Mutation for skipping bin count / replen
  const skipBinCountMutation = useMutation({
    mutationFn: ({ sku, locationId, actualQty }: { sku: string; locationId: number; actualQty: number }) =>
      skipBinCount(sku, locationId, actualQty),
    onSuccess: () => {
      setBinCountOpen(false);
      setBinCountContext(null);
      toast({ title: "Replen skipped", description: "Pending replen tasks cancelled" });
      playSound("success");
    },
    onError: (error: Error) => {
      toast({ title: "Skip failed", description: error.message, variant: "destructive" });
      playSound("error");
    },
  });
  
  // Mutation for marking order ready to ship
  const readyToShipMutation = useMutation({
    mutationFn: ({ orderId }: { orderId: number }) => markOrderReadyToShip(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
  });
  
  // Helper to update local single queue (wrapper to maintain compatibility)
  const setSingleQueue = (updater: SingleOrder[] | ((prev: SingleOrder[]) => SingleOrder[])) => {
    if (typeof updater === "function") {
      setLocalSingleQueue(prev => {
        const base = prev.length > 0 ? prev : singleQueue;
        return updater(base);
      });
    } else {
      setLocalSingleQueue(updater);
    }
  };
  
  const [view, setView] = useState<"queue" | "picking" | "complete" | "exceptions">("queue");
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  
  // Search, sort, and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"priority" | "items" | "order" | "age">("age");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [activeFilter, setActiveFilter] = useState<"all" | "ready" | "active" | "rush" | "done" | "hold" | "exceptions" | "combined">("all");
  
  // UI state
  const [scanInput, setScanInput] = useState("");
  const [scanStatus, setScanStatus] = useState<"idle" | "success" | "error">("idle");
  const [shortPickOpen, setShortPickOpen] = useState(false);
  const [shortPickReason, setShortPickReason] = useState("");
  const [shortPickQty, setShortPickQty] = useState("0");
  const [shortPickListIndex, setShortPickListIndex] = useState<number | null>(null);
  const [multiQtyOpen, setMultiQtyOpen] = useState(false);
  const [pickQty, setPickQty] = useState(1);
  const [releaseDialogOpen, setReleaseDialogOpen] = useState(false);
  const [releaseOrderId, setReleaseOrderId] = useState<string | null>(null);
  
  // Scanner mode settings
  const [scannerMode, setScannerMode] = useState(false);
  const [soundSettingsOpen, setSoundSettingsOpen] = useState(false);
  const [lastScannedItemId, setLastScannedItemId] = useState<number | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  
  // Hold/release flash animation state
  const [flashingOrderId, setFlashingOrderId] = useState<string | null>(null);
  
  // Completed order detail modal state
  const [selectedCompletedOrder, setSelectedCompletedOrder] = useState<SingleOrder | null>(null);
  
  // Computed sound enabled state for icon display
  const soundEnabled = soundTheme !== "silent";
  
  // Scan input ref for focus management
  const manualInputRef = useRef<HTMLInputElement>(null);
  const focusTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Refs for item elements to enable auto-scroll
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  
  // Global scanner buffer - captures keystrokes even with readOnly input
  const scanBufferRef = useRef<string>("");
  const scanBufferTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Computed values - work for both modes
  const activeBatch = queue.find(b => b.id === activeBatchId);
  const activeOrder = singleQueue.find(o => o.id === activeOrderId);
  const activeWork = pickingMode === "batch" ? activeBatch : activeOrder;
  const currentItem = activeWork?.items[currentItemIndex];
  const completedItems = activeWork?.items.filter(i => i.status === "completed" || i.status === "short").length || 0;
  const totalItems = activeWork?.items.length || 0;
  const progressPercent = totalItems > 0 ? (completedItems / totalItems) * 100 : 0;
  
  // Keep focus on scan input - aggressive refocus for scanner devices
  const maintainFocus = useCallback(() => {
    // Don't steal focus when any dialog is open — let dialogs own their focus
    if (view === "picking" && !shortPickOpen && !multiQtyOpen && !binCountOpen && manualInputRef.current) {
      manualInputRef.current.focus();
    }
  }, [view, shortPickOpen, multiQtyOpen, binCountOpen]);

  // Focus scan input on mount only — do NOT re-focus on every click/touch.
  // The global window keydown handler captures scanner input regardless of focus,
  // so there's no need to aggressively keep the input focused. Removing the
  // click/touchend re-focus lets users dismiss the keyboard normally.
  useEffect(() => {
    if (view === "picking") {
      setTimeout(maintainFocus, 100);
      return () => {
        if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
      };
    }
  }, [view, maintainFocus]);

  // Refocus after dialogs close (but not bin count — it has its own focus)
  useEffect(() => {
    if (!shortPickOpen && !multiQtyOpen && !binCountOpen) {
      setTimeout(maintainFocus, 100);
    }
  }, [shortPickOpen, multiQtyOpen, binCountOpen, maintainFocus]);

  // Prevent other inputs from stealing focus — but allow dialog inputs when a dialog is open
  useEffect(() => {
    if (view === "picking") {
      const handleFocusIn = (e: FocusEvent) => {
        const target = e.target as HTMLElement;
        // If a dialog is open, let its inputs have focus normally
        if (shortPickOpen || multiQtyOpen || binCountOpen) return;
        // Otherwise redirect any stray input focus back to the scan input
        if (target !== manualInputRef.current && target.tagName === "INPUT") {
          e.preventDefault();
          maintainFocus();
        }
      };

      document.addEventListener("focusin", handleFocusIn);
      return () => document.removeEventListener("focusin", handleFocusIn);
    }
  }, [view, shortPickOpen, multiQtyOpen, binCountOpen, maintainFocus]);
  
  // Auto-scroll to keep first pending item visible after each pick
  useEffect(() => {
    if (view !== "picking" || !activeWork) return;
    
    // Find the first pending/in_progress item
    const firstPendingIndex = activeWork.items.findIndex(
      item => item.status === "pending" || item.status === "in_progress"
    );
    
    if (firstPendingIndex !== -1) {
      const item = activeWork.items[firstPendingIndex];
      const element = itemRefs.current.get(item.id);
      if (element) {
        // Scroll the item into view with some padding at top
        element.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [view, activeWork?.items.map(i => `${i.id}:${i.status}`).join(",")]);
  
  // Ref for processScan callback - updated when dependencies change
  const processScanRef = useRef<(value: string) => void>(() => {});
  
  // Global scanner capture - works with readOnly input to suppress keyboard
  // Captures all keystrokes and builds buffer, processes on Enter
  useEffect(() => {
    if (view !== "picking" || shortPickOpen || multiQtyOpen || binCountOpen) {
      return;
    }
    
    const logDebug = (msg: string) => {
      const ts = new Date().toLocaleTimeString();
      setDebugLog(prev => [`${ts}: ${msg}`, ...prev.slice(0, 9)]);
      console.log("[SCAN]", msg);
    };
    
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Ignore modifier keys and special keys
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      
      // Clear timeout on each keystroke
      if (scanBufferTimeoutRef.current) {
        clearTimeout(scanBufferTimeoutRef.current);
      }
      
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const scannedValue = scanBufferRef.current.trim();
        if (scannedValue.length > 0) {
          logDebug(`GLOBAL: Enter with buffer "${scannedValue}"`);
          setScanInput(scannedValue);
          // Process via ref (updated with current activeWork)
          setTimeout(() => {
            processScanRef.current(scannedValue);
            scanBufferRef.current = "";
            setScanInput("");
          }, 10);
        }
        return;
      }
      
      // Only capture printable characters
      if (e.key.length === 1) {
        scanBufferRef.current += e.key;
        setScanInput(scanBufferRef.current);
        
        // Auto-clear buffer after 300ms of no input (in case Enter doesn't come)
        scanBufferTimeoutRef.current = setTimeout(() => {
          if (scanBufferRef.current.length > 0) {
            logDebug(`GLOBAL: Timeout, processing buffer "${scanBufferRef.current}"`);
            const scannedValue = scanBufferRef.current.trim();
            if (scannedValue.length >= 3) {
              processScanRef.current(scannedValue);
            }
            scanBufferRef.current = "";
            setScanInput("");
          }
        }, 300);
      }
    };
    
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      if (scanBufferTimeoutRef.current) {
        clearTimeout(scanBufferTimeoutRef.current);
      }
    };
  }, [view, shortPickOpen, multiQtyOpen, binCountOpen]);
  
  // Claim error state
  const [claimError, setClaimError] = useState<string | null>(null);
  
  // Start picking a batch or order
  const handleStartPicking = async (id: string) => {
    setClaimError(null);
    setDebugLog([]); // Clear debug log for new order
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(b => 
        b.id === id ? { ...b, status: "in_progress" as const, assignee: "You" } : b
      ));
      setActiveBatchId(id);
      setCurrentItemIndex(0);
      setView("picking");
      triggerHaptic("medium");
    } else {
      // Check if this is a combined order group
      const isCombinedGroup = id.startsWith("combined-");
      
      if (isCombinedGroup) {
        // Combined order - claim all orders in the group
        const combinedOrder = ordersFromApi.find(o => o.id === id);
        if (!combinedOrder || !combinedOrder.combinedOrders) {
          console.error("Combined order not found:", id);
          return;
        }
        
        try {
          // Claim all orders in the combined group
          for (const subOrder of combinedOrder.combinedOrders) {
            const subOrderId = parseInt(subOrder.id);
            if (!isNaN(subOrderId)) {
              await claimMutation.mutateAsync({ orderId: subOrderId });
            }
          }
          
          // Success - copy the combined order to local state
          setLocalSingleQueue(prev => {
            const existing = prev.find(o => o.id === id);
            if (existing) {
              return prev.map(o => o.id === id ? { ...combinedOrder, status: "in_progress" as const, assignee: "You" } : o);
            } else {
              return [...prev, { ...combinedOrder, status: "in_progress" as const, assignee: "You" }];
            }
          });
          
          setActiveOrderId(id);
          setCurrentItemIndex(0);
          setView("picking");
          triggerHaptic("medium");
        } catch (error: any) {
          console.error("Failed to claim combined order:", error);
          setClaimError("One or more orders in this group were claimed by another picker.");
          refetch();
          triggerHaptic("heavy");
          playSound("error");
        }
        return;
      }
      
      // For single mode, claim the order via API if it's a real order (numeric id)
      const numericId = parseInt(id);
      const isRealOrder = !isNaN(numericId) && ordersFromApi.some(o => o.id === id);
      
      if (isRealOrder) {
        try {
          await claimMutation.mutateAsync({ orderId: numericId });
          // Success - copy the order to local state for picking session
          const orderToPick = ordersFromApi.find(o => o.id === id);
          if (orderToPick) {
            setLocalSingleQueue(prev => {
              // Add or update this order in local state
              const existing = prev.find(o => o.id === id);
              if (existing) {
                return prev.map(o => o.id === id ? { ...orderToPick, status: "in_progress" as const, assignee: "You" } : o);
              } else {
                return [...prev, { ...orderToPick, status: "in_progress" as const, assignee: "You" }];
              }
            });
          }
          setActiveOrderId(id);
          setCurrentItemIndex(0);
          setView("picking");
          triggerHaptic("medium");
        } catch (error: any) {
          console.error("Failed to claim order:", error);
          // Order was claimed by someone else - refresh the queue
          setClaimError("This order was just claimed by another picker. The queue has been refreshed.");
          refetch();
          triggerHaptic("heavy");
          playSound("error");
        }
      } else {
        // Mock order - proceed without API call
        setSingleQueue(prev => prev.map(o => 
          o.id === id ? { ...o, status: "in_progress" as const, assignee: "You" } : o
        ));
        setActiveOrderId(id);
        setCurrentItemIndex(0);
        setView("picking");
        triggerHaptic("medium");
      }
    }
  };
  
  // Helper to parse age string like "45m" or "1h 5m" into total minutes
  const parseAgeToMinutes = (age: string): number => {
    let total = 0;
    const hoursMatch = age.match(/(\d+)h/);
    const minsMatch = age.match(/(\d+)m/);
    if (hoursMatch) total += parseInt(hoursMatch[1], 10) * 60;
    if (minsMatch) total += parseInt(minsMatch[1], 10);
    return total;
  };
  
  // Apply sorting logic consistent with the queue display
  const applySortToOrders = (orders: SingleOrder[]): SingleOrder[] => {
    return [...orders].sort((a, b) => {
      let result = 0;
      switch (sortBy) {
        case "priority": {
          const priorityOrder = { rush: 0, high: 1, normal: 2 };
          result = priorityOrder[a.priority] - priorityOrder[b.priority];
          break;
        }
        case "items":
          result = a.items.length - b.items.length;
          break;
        case "order":
          const aNum = a.orderNumber || a.id;
          const bNum = b.orderNumber || b.id;
          result = aNum.localeCompare(bNum);
          break;
        case "age":
          result = parseAgeToMinutes(a.age) - parseAgeToMinutes(b.age);
          break;
        default:
          result = 0;
      }
      return sortDirection === "desc" ? -result : result;
    });
  };
  
  // Grab next available batch or order
  const handleGrabNext = async () => {
    // Refresh data first to avoid claiming stale orders
    if (pickingMode === "single") {
      await refetch();
    }
    
    if (pickingMode === "batch") {
      const nextBatch = queue.find(b => b.status === "ready");
      if (nextBatch) {
        handleStartPicking(nextBatch.id);
      }
    } else {
      // Use fresh data from API, filtering out orders we just completed locally
      const freshQueue = ordersFromApi.filter(o => 
        o.status === "ready" && !o.onHold
      );
      // Apply the same sorting as the displayed queue
      const sortedQueue = applySortToOrders(freshQueue);
      const nextOrder = sortedQueue[0];
      if (nextOrder) {
        handleStartPicking(nextOrder.id);
      }
    }
  };
  
  // Handle scan input (matches SKU or barcode)
  const handleScan = (value: string) => {
    setScanInput(value);
    if (!currentItem) return;
    
    const normalizedInput = value.toUpperCase().replace(/-/g, "").trim();
    const normalizedSku = currentItem.sku.toUpperCase().replace(/-/g, "");
    const normalizedBarcode = currentItem.barcode?.toUpperCase().replace(/-/g, "") || "";
    
    // Check for match (SKU or barcode)
    if (normalizedInput === normalizedSku || normalizedInput === normalizedBarcode) {
      setScanStatus("success");
      playSound("scan");
      triggerHaptic("medium");
      
      if (currentItem.qty > 1) {
        setTimeout(() => {
          setMultiQtyOpen(true);
          setScanStatus("idle");
          setScanInput("");
        }, 400);
      } else {
        setTimeout(() => {
          confirmPick(1);
        }, 400);
      }
    } else if (normalizedInput.length >= normalizedSku.length && normalizedInput !== normalizedSku) {
      // Wrong barcode scanned
      setScanStatus("error");
      playSound("error");
      triggerHaptic("heavy");
      
      setTimeout(() => {
        setScanStatus("idle");
        setScanInput("");
        maintainFocus();
      }, 1000);
    }
  };
  
  // Confirm pick
  const confirmPick = (qty: number) => {
    if (!activeWork || !currentItem) return;
    
    const newPicked = currentItem.picked + qty;
    const newStatus: ItemStatus = newPicked >= currentItem.qty ? "completed" : "in_progress";
    
    // Sync with API if this is a real order item (all modes)
    const isRealItem = !isNaN(currentItem.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({
        itemId: currentItem.id,
        status: newStatus, 
        pickedQuantity: newPicked,
        pickMethod: "scan"
      });
    }
    
    let orderCompleted = false;
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((item, idx) => {
          if (idx !== currentItemIndex) return item;
          return {
            ...item,
            picked: newPicked,
            status: newStatus as "pending" | "in_progress" | "completed" | "short"
          };
        });
        
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        
        return { ...batch, items: newItems };
      }));
    } else {
      setSingleQueue(prev => prev.map(order => {
        if (order.id !== activeOrderId) return order;
        
        const newItems = order.items.map((item, idx) => {
          if (idx !== currentItemIndex) return item;
          return {
            ...item,
            picked: newPicked,
            status: newStatus as "pending" | "in_progress" | "completed" | "short"
          };
        });
        
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        
        return { ...order, items: newItems, status: allDone ? "completed" as const : order.status };
      }));
    }
    
    setScanStatus("idle");
    setScanInput("");
    setMultiQtyOpen(false);
    setPickQty(1);

    if (orderCompleted && !binCountOpen) {
      setTimeout(() => {
        if (pickingMode === "batch") {
          setActiveBatchId(null);
        } else {
          setActiveOrderId(null);
        }
        playSound("complete");
        triggerHaptic("heavy");
        setCurrentItemIndex(0);
        setView("queue");
      }, 500);
    } else {
      setTimeout(() => {
        advanceToNext();
        maintainFocus();
      }, 300);
    }
  };
  
  // Short pick - works for both card view (currentItem) and list view (shortPickListIndex)
  const handleShortPick = () => {
    if (!activeWork) return;
    
    // Determine which item we're shorting
    const isListView = shortPickListIndex !== null;
    const itemIndex = isListView ? shortPickListIndex : currentItemIndex;
    const targetItem = isListView ? activeWork.items[shortPickListIndex] : currentItem;
    
    if (!targetItem) return;
    
    const shortQty = parseInt(shortPickQty) || 0;
    
    // Sync with API if this is a real order item (all modes)
    const isRealItem = !isNaN(targetItem.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({
        itemId: targetItem.id,
        status: "short" as ItemStatus, 
        pickedQuantity: shortQty,
        shortReason: shortPickReason || undefined,
        pickMethod: "short"
      });
    }
    
    let orderCompleted = false;
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((item, idx) => {
          if (idx !== itemIndex) return item;
          return {
            ...item,
            picked: shortQty,
            status: "short" as const
          };
        });
        
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        
        return { ...batch, items: newItems };
      }));
    } else {
      setSingleQueue(prev => prev.map(order => {
        if (order.id !== activeOrderId) return order;
        
        const newItems = order.items.map((item, idx) => {
          if (idx !== itemIndex) return item;
          return {
            ...item,
            picked: shortQty,
            status: "short" as const
          };
        });
        
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        
        return { ...order, items: newItems, status: allDone ? "completed" as const : order.status };
      }));
    }
    
    playSound("error");
    triggerHaptic("medium");
    
    setShortPickOpen(false);
    setShortPickReason("");
    setShortPickQty("0");
    setShortPickListIndex(null);
    
    if (orderCompleted) {
      setTimeout(() => {
        if (pickingMode === "batch") {
          setActiveBatchId(null);
        } else {
          setActiveOrderId(null);
        }
        playSound("complete");
        triggerHaptic("heavy");
        setCurrentItemIndex(0);
        setView("queue");
      }, 500);
    } else if (!isListView) {
      setTimeout(() => {
        advanceToNext();
        maintainFocus();
      }, 300);
    }
  };
  
  // Helper to add debug log entry
  const addDebug = (msg: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLog(prev => [`${timestamp}: ${msg}`, ...prev.slice(0, 9)]);
    console.log("[SCAN]", msg);
  };
  
  // Simple scan handler - process when Enter is pressed
  const handleScanKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = e.currentTarget.value;
      addDebug(`Enter: "${value}"`);
      
      if (!activeWork || !value.trim()) {
        addDebug(`No value or no order`);
        setScanInput("");
        return;
      }
      
      const normalizedInput = value.toUpperCase().replace(/-/g, "").trim();
      
      // Find matching unpicked item
      const matchingIndex = activeWork.items.findIndex(item => {
        if (item.status === "completed" || item.status === "short") return false;
        const normalizedSku = item.sku.toUpperCase().replace(/-/g, "");
        const normalizedBarcode = item.barcode?.toUpperCase().replace(/-/g, "") || "";
        return normalizedInput === normalizedSku || normalizedInput === normalizedBarcode;
      });
      
      if (matchingIndex !== -1) {
        const item = activeWork.items[matchingIndex];
        const newPicked = item.picked + 1;
        const isItemComplete = newPicked >= item.qty;
        addDebug(`MATCH! ${item.sku} (${newPicked}/${item.qty})`);
        setScanStatus("success");
        playSound("success");
        triggerHaptic("medium");
        
        // Pick one unit at a time
        handleListItemPickOne(matchingIndex);
        
        setTimeout(() => {
          setScanStatus("idle");
          setScanInput("");
          maintainFocus();
        }, 300);
      } else {
        addDebug(`NO MATCH: "${normalizedInput}"`);
        setScanStatus("error");
        playSound("error");
        triggerHaptic("heavy");
        
        setTimeout(() => {
          setScanStatus("idle");
          setScanInput("");
          maintainFocus();
        }, 1000);
      }
    }
  };
  
  // Simple onChange - just update display
  const handleListScan = (value: string) => {
    setScanInput(value);
    addDebug(`Input: "${value}"`);
  };
  
  // Update processScanRef with current scan logic (for global keyboard capture)
  useEffect(() => {
    processScanRef.current = (value: string) => {
      if (!activeWork || !value.trim()) {
        addDebug(`Global scan: no value or no order`);
        return;
      }
      
      const normalizedInput = value.toUpperCase().replace(/-/g, "").trim();
      
      // Find matching unpicked item
      const matchingIndex = activeWork.items.findIndex(item => {
        if (item.status === "completed" || item.status === "short") return false;
        const normalizedSku = item.sku.toUpperCase().replace(/-/g, "");
        const normalizedBarcode = item.barcode?.toUpperCase().replace(/-/g, "") || "";
        return normalizedInput === normalizedSku || normalizedInput === normalizedBarcode;
      });
      
      if (matchingIndex !== -1) {
        const item = activeWork.items[matchingIndex];
        const newPicked = item.picked + 1;
        addDebug(`GLOBAL MATCH! ${item.sku} (${newPicked}/${item.qty})`);
        setScanStatus("success");
        playSound("success");
        triggerHaptic("medium");
        
        // Pick one unit at a time
        handleListItemPickOne(matchingIndex);
        
        setTimeout(() => {
          setScanStatus("idle");
          maintainFocus();
        }, 300);
      } else {
        addDebug(`GLOBAL NO MATCH: "${normalizedInput}"`);
        setScanStatus("error");
        playSound("error");
        triggerHaptic("heavy");
        
        setTimeout(() => {
          setScanStatus("idle");
          maintainFocus();
        }, 1000);
      }
    };
  }, [activeWork, playSound, triggerHaptic, maintainFocus]);
  
  // Handle picking ONE unit of an item (for scanning - increments by 1)
  const handleListItemPickOne = (idx: number) => {
    if (!activeWork) return;
    
    const item = activeWork.items[idx];
    if (!item) return;
    
    const newPicked = item.picked + 1;
    const isItemComplete = newPicked >= item.qty;
    
    console.log("[PICK] Picking 1 unit of:", item.sku, `(${newPicked}/${item.qty})`);
    
    // Visual feedback
    setLastScannedItemId(item.id);
    setTimeout(() => setLastScannedItemId(null), 2000);
    
    // Sync with API (all modes)
    const isRealItem = !isNaN(item.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({
        itemId: item.id,
        status: isItemComplete ? "completed" as ItemStatus : "in_progress" as ItemStatus, 
        pickedQuantity: newPicked,
        pickMethod: "scan"
      });
    }
    
    // Helper to check completion and handle it
    const checkAndHandleCompletion = (items: typeof activeWork.items) => {
      const allDone = items.every(it => it.status === "completed" || it.status === "short");
      if (allDone) {
        setTimeout(() => {
          playSound("complete");
          triggerHaptic("heavy");
          setActiveOrderId(null);
          setActiveBatchId(null);
          setCurrentItemIndex(0);
          setView("queue");
        }, 500);
      }
      return allDone;
    };
    
    if (pickingMode === "batch") {
      // Update batch queue
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((it, i) => {
          if (i !== idx) return it;
          return {
            ...it,
            picked: newPicked,
            status: isItemComplete ? "completed" as const : "in_progress" as const
          };
        });
        
        checkAndHandleCompletion(newItems);
        return { ...batch, items: newItems };
      }));
    } else {
      // Update single order queue
      setLocalSingleQueue(prev => {
        const orderExists = prev.some(o => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter(o => o.id === activeOrderId)];
        
        return base.map(order => {
          if (order.id !== activeOrderId) return order;
          
          const newItems = order.items.map((it, i) => {
            if (i !== idx) return it;
            return {
              ...it,
              picked: newPicked,
              status: isItemComplete ? "completed" as const : "in_progress" as const
            };
          });
          
          const allDone = checkAndHandleCompletion(newItems);
          return { ...order, items: newItems, status: allDone ? "completed" as const : order.status };
        });
      });
    }
  };
  
  // Handle picking an item directly from list view by index (picks full qty - for button clicks)
  const handleListItemPickDirect = (idx: number, qty: number) => {
    if (!activeWork) return;
    
    const item = activeWork.items[idx];
    if (!item) return;
    
    console.log("[PICK] Picking full qty:", item.sku, "idx:", idx, "qty:", qty);
    
    // Visual feedback - highlight the scanned item
    setLastScannedItemId(item.id);
    setTimeout(() => setLastScannedItemId(null), 2000);
    
    // Sync with API (all modes)
    const isRealItem = !isNaN(item.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      console.log("[PICK] Sending API update for item:", item.id);
      updateItemMutation.mutate({
        itemId: item.id,
        status: "completed" as ItemStatus,
        pickedQuantity: qty,
        pickMethod: "pick_all"
      });
    }
    
    let orderCompleted = false;
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((it, i) => {
          if (i !== idx) return it;
          return { ...it, picked: qty, status: "completed" as const };
        });
        
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        return { ...batch, items: newItems, status: allDone ? "completed" as const : batch.status };
      }));
    } else {
      setLocalSingleQueue(prev => {
        const orderExists = prev.some(o => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter(o => o.id === activeOrderId)];
        
        return base.map(order => {
          if (order.id !== activeOrderId) return order;
          
          const newItems = order.items.map((it, i) => {
            if (i !== idx) return it;
            return { ...it, picked: qty, status: "completed" as const };
          });
          
          const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;
          return { ...order, items: newItems, status: allDone ? "completed" as const : order.status };
        });
      });
    }
    
    if (orderCompleted) {
      setTimeout(() => {
        if (pickingMode === "batch") {
          setActiveBatchId(null);
        } else {
          setActiveOrderId(null);
        }
        playSound("complete");
        triggerHaptic("heavy");
        setCurrentItemIndex(0);
        setView("queue");
      }, 500);
    }
  };
  
  // Handle clicking pick button on list item
  const handleListItemPick = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;
    
    playSound("success");
    triggerHaptic("medium");
    handleListItemPickDirect(idx, item.qty);
    
    // Blur the input to prevent keyboard from popping up
    if (manualInputRef.current) {
      manualInputRef.current.blur();
    }
    
    // Scroll to next pending item after a short delay (to allow state to update)
    setTimeout(() => {
      const updatedWork = pickingMode === "batch"
        ? queue.find(b => b.id === activeBatchId)
        : localSingleQueue.find(o => o.id === activeOrderId) || singleQueue.find(o => o.id === activeOrderId);
      
      if (!updatedWork) return;
      
      // Find next pending item after the one we just picked
      let nextItem = null;
      for (let i = idx + 1; i < updatedWork.items.length; i++) {
        if (updatedWork.items[i].status === "pending" || updatedWork.items[i].status === "in_progress") {
          nextItem = updatedWork.items[i];
          break;
        }
      }
      // Wrap around if not found
      if (!nextItem) {
        for (let i = 0; i < idx; i++) {
          if (updatedWork.items[i].status === "pending" || updatedWork.items[i].status === "in_progress") {
            nextItem = updatedWork.items[i];
            break;
          }
        }
      }
      
      // Scroll to the next item using its id
      if (nextItem) {
        const nextItemElement = document.querySelector(`[data-testid="list-item-${nextItem.id}"]`);
        if (nextItemElement) {
          nextItemElement.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }, 100);
  };
  
  // Handle clicking short pick button on list item - opens dialog
  const handleListItemShort = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;
    
    // Set the current picked qty as the short qty default
    setShortPickQty(String(item.picked || 0));
    setShortPickReason("");
    setShortPickListIndex(idx);
    setShortPickOpen(true);
  };
  
  // Legacy immediate short (kept for compatibility, not used currently)
  const handleListItemShortImmediate = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;
    
    playSound("error");
    triggerHaptic("medium");
    
    // Sync with API (all modes)
    const isRealItem = !isNaN(item.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({
        itemId: item.id,
        status: "short" as ItemStatus,
        pickedQuantity: 0,
        pickMethod: "short"
      });
    }
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((it, i) => {
          if (i !== idx) return it;
          return {
            ...it,
            picked: 0,
            status: "short" as const
          };
        });
        
        return { ...batch, items: newItems };
      }));
    } else {
      // Update localSingleQueue directly
      setLocalSingleQueue(prev => {
        const orderExists = prev.some(o => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter(o => o.id === activeOrderId)];
        
        return base.map(order => {
          if (order.id !== activeOrderId) return order;
          
          const newItems = order.items.map((it, i) => {
            if (i !== idx) return it;
            return {
              ...it,
              picked: 0,
              status: "short" as const
            };
          });
          
          return { ...order, items: newItems };
        });
      });
    }
  };
  
  // Handle manual +1 pick (without scan) - tracks as "manual" pick method
  const handleListItemManualPickOne = (idx: number) => {
    if (!activeWork) return;
    
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;
    
    const newPicked = item.picked + 1;
    const isItemComplete = newPicked >= item.qty;
    
    playSound("success");
    triggerHaptic("light");
    
    // Visual feedback
    setLastScannedItemId(item.id);
    setTimeout(() => setLastScannedItemId(null), 1000);
    
    // Sync with API for real items (both single and batch modes)
    const isRealItem = !isNaN(item.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({ 
        itemId: item.id, 
        status: isItemComplete ? "completed" as ItemStatus : "in_progress" as ItemStatus, 
        pickedQuantity: newPicked,
        pickMethod: "manual"
      });
    }
    
    let orderCompleted = false;
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        const newItems = batch.items.map((it, i) => {
          if (i !== idx) return it;
          return { ...it, picked: newPicked, status: isItemComplete ? "completed" as const : "in_progress" as const };
        });
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        return { ...batch, items: newItems, status: allDone ? "completed" as const : batch.status };
      }));
    } else {
      setLocalSingleQueue(prev => {
        const orderExists = prev.some(o => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter(o => o.id === activeOrderId)];
        return base.map(order => {
          if (order.id !== activeOrderId) return order;
          const newItems = order.items.map((it, i) => {
            if (i !== idx) return it;
            return { ...it, picked: newPicked, status: isItemComplete ? "completed" as const : "in_progress" as const };
          });
          const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;
          return { ...order, items: newItems, status: allDone ? "completed" as const : order.status };
        });
      });
    }
    
    if (orderCompleted) {
      setTimeout(() => {
        if (pickingMode === "batch") {
          setActiveBatchId(null);
        } else {
          setActiveOrderId(null);
        }
        playSound("complete");
        triggerHaptic("heavy");
        setCurrentItemIndex(0);
        setView("queue");
      }, 500);
    }
  };
  
  // Handle decrement (-1) - for correcting over-picks
  const handleListItemDecrement = (idx: number) => {
    if (!activeWork) return;
    
    const item = activeWork.items[idx];
    if (!item || item.picked <= 0) return;
    
    const newPicked = item.picked - 1;
    const newStatus: ItemStatus = newPicked === 0 ? "pending" : "in_progress";
    
    triggerHaptic("light");
    
    // Sync with API for real items (both single and batch modes)
    const isRealItem = !isNaN(item.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({ 
        itemId: item.id, 
        status: newStatus, 
        pickedQuantity: newPicked,
        pickMethod: "manual"
      });
    }
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        const newItems = batch.items.map((it, i) => {
          if (i !== idx) return it;
          return { ...it, picked: newPicked, status: newStatus };
        });
        return { ...batch, items: newItems };
      }));
    } else {
      setLocalSingleQueue(prev => {
        const orderExists = prev.some(o => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter(o => o.id === activeOrderId)];
        return base.map(order => {
          if (order.id !== activeOrderId) return order;
          const newItems = order.items.map((it, i) => {
            if (i !== idx) return it;
            return { ...it, picked: newPicked, status: newStatus };
          });
          return { ...order, items: newItems };
        });
      });
    }
  };
  
  // State and handler for editing item quantity directly
  const [editQtyOpen, setEditQtyOpen] = useState(false);
  const [editQtyIdx, setEditQtyIdx] = useState<number | null>(null);
  const [editQtyValue, setEditQtyValue] = useState(0);
  
  const openEditQtyDialog = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item) return;
    setEditQtyIdx(idx);
    setEditQtyValue(item.picked);
    setEditQtyOpen(true);
  };
  
  const handleEditQtyConfirm = () => {
    if (!activeWork || editQtyIdx === null) return;
    
    const item = activeWork.items[editQtyIdx];
    if (!item) return;
    
    const newPicked = Math.max(0, Math.min(item.qty, editQtyValue));
    const isItemComplete = newPicked >= item.qty;
    const newStatus: ItemStatus = newPicked === 0 ? "pending" : isItemComplete ? "completed" : "in_progress";
    
    // Sync with API for real items (both single and batch modes)
    const isRealItem = !isNaN(item.id) && ordersFromApi.length > 0;
    if (isRealItem) {
      updateItemMutation.mutate({ 
        itemId: item.id, 
        status: newStatus, 
        pickedQuantity: newPicked,
        pickMethod: "manual"
      });
    }
    
    let orderCompleted = false;
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        const newItems = batch.items.map((it, i) => {
          if (i !== editQtyIdx) return it;
          return { ...it, picked: newPicked, status: newStatus };
        });
        const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
        if (allDone) orderCompleted = true;
        return { ...batch, items: newItems, status: allDone ? "completed" as const : batch.status };
      }));
    } else {
      setLocalSingleQueue(prev => {
        const orderExists = prev.some(o => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter(o => o.id === activeOrderId)];
        return base.map(order => {
          if (order.id !== activeOrderId) return order;
          const newItems = order.items.map((it, i) => {
            if (i !== editQtyIdx) return it;
            return { ...it, picked: newPicked, status: newStatus };
          });
          const allDone = newItems.every(it => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;
          return { ...order, items: newItems, status: allDone ? "completed" as const : order.status };
        });
      });
    }
    
    if (orderCompleted) {
      setTimeout(() => {
        if (pickingMode === "batch") {
          setActiveBatchId(null);
        } else {
          setActiveOrderId(null);
        }
        playSound("complete");
        triggerHaptic("heavy");
        setCurrentItemIndex(0);
        setView("queue");
      }, 500);
    }
    
    setEditQtyOpen(false);
    setEditQtyIdx(null);
  };
  
  
  // Advance to next item
  const advanceToNext = () => {
    const updatedWork = pickingMode === "batch" 
      ? queue.find(b => b.id === activeBatchId)
      : singleQueue.find(o => o.id === activeOrderId);
    
    if (!updatedWork) return;
    
    // Find next pending item
    let nextIndex = -1;
    for (let i = currentItemIndex + 1; i < updatedWork.items.length; i++) {
      if (updatedWork.items[i].status === "pending" || updatedWork.items[i].status === "in_progress") {
        nextIndex = i;
        break;
      }
    }
    
    if (nextIndex !== -1) {
      setCurrentItemIndex(nextIndex);
    } else {
      // Check from beginning (wrap around)
      for (let i = 0; i < currentItemIndex; i++) {
        if (updatedWork.items[i].status === "pending" || updatedWork.items[i].status === "in_progress") {
          nextIndex = i;
          break;
        }
      }
      
      if (nextIndex !== -1) {
        setCurrentItemIndex(nextIndex);
      } else {
        // All items done - mark complete and clear active IDs to prevent re-claim attempts
        if (pickingMode === "batch") {
          setQueue(prev => prev.map(b => 
            b.id === activeBatchId ? { ...b, status: "completed" as const } : b
          ));
          setActiveBatchId(null);
        } else {
          setSingleQueue(prev => prev.map(o => 
            o.id === activeOrderId ? { ...o, status: "completed" as const } : o
          ));
          setActiveOrderId(null);
        }
        playSound("complete");
        triggerHaptic("heavy");
        setCurrentItemIndex(0);
        setView("queue");
      }
    }
  };
  
  // Back to queue
  const handleBackToQueue = async () => {
    // Release the order if we're picking a real order (from API)
    // BUT only if the picker hasn't started picking anything yet
    if (activeOrderId && pickingMode === "single") {
      const subOrderIds = getSubOrderIds(activeOrderId);
      const isRealOrder = subOrderIds.length > 0 && ordersFromApi.some(o => o.id === activeOrderId);

      if (isRealOrder) {
        // Check if any items have been picked
        const activeOrder = singleQueue.find(o => o.id === activeOrderId);
        const hasPickedItems = activeOrder?.items.some(item => item.picked > 0 || item.status === "completed" || item.status === "short");

        if (!hasPickedItems) {
          // No items picked yet - release the order(s) so another picker can grab them
          try {
            for (const subId of subOrderIds) {
              await releaseMutation.mutateAsync({ orderId: subId });
            }
          } catch (error) {
            console.error("Failed to release order:", error);
          }
        }
        // If items have been picked, keep the order claimed (in progress)
      }
    }
    
    // Refresh the queue data from API
    refetch();
    // Clear local state to use fresh API data
    setLocalSingleQueue([]);
    setView("queue");
    setActiveBatchId(null);
    setActiveOrderId(null);
    setCurrentItemIndex(0);
    setScanInput("");
  };
  
  // Refresh queue data
  const handleRefreshQueue = () => {
    refetch();
    setLocalSingleQueue([]);
  };
  
  // Sync orders from Shopify state
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{created: number, updated: number, total: number} | null>(null);
  
  const handleSyncOrders = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    try {
      const response = await fetch("/api/shopify/sync-orders", { method: "POST" });
      const data = await response.json();
      if (data.success) {
        setSyncResult({ created: data.created, updated: data.updated, total: data.total });
        refetch();
      }
    } catch (error) {
      console.error("Failed to sync orders:", error);
    } finally {
      setIsSyncing(false);
    }
  };
  
  // Reset demo (only for mock data mode)
  const handleResetDemo = () => {
    setQueue(createInitialQueue());
    setLocalSingleQueue([]);
    setView("queue");
    setActiveBatchId(null);
    setActiveOrderId(null);
    setCurrentItemIndex(0);
    setScanInput("");
  };
  
  // Toggle fullscreen
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };
  
  // Helper: get all numeric sub-order IDs for a given order ID (handles combined groups)
  const getSubOrderIds = (id: string): number[] => {
    if (id.startsWith("combined-")) {
      const combinedOrder = ordersFromApi.find(o => o.id === id) || singleQueue.find(o => o.id === id);
      if (combinedOrder?.combinedOrders) {
        return combinedOrder.combinedOrders
          .map(o => parseInt(o.id))
          .filter(n => !isNaN(n));
      }
      return [];
    }
    const numId = parseInt(id);
    return isNaN(numId) ? [] : [numId];
  };

  // Release order handler - shows dialog if partially picked
  const handleReleaseOrder = async (orderStringId: string) => {
    console.log("[RELEASE] Attempting to release order:", orderStringId);
    const order = singleQueue.find(o => o.id === orderStringId);
    console.log("[RELEASE] Found order in singleQueue:", order ? "yes" : "no");

    // Also check API data directly for more accurate item status
    const apiOrder = ordersFromApi.find(o => o.id === orderStringId);
    console.log("[RELEASE] Found order in API data:", apiOrder ? "yes" : "no");

    // Use API data if local queue doesn't have the order
    const checkOrder = order || apiOrder;
    const pickedCount = checkOrder?.items.filter(i => i.status === "completed" || i.status === "short" || i.picked > 0).length || 0;
    console.log("[RELEASE] Picked/short item count:", pickedCount);

    const subOrderIds = getSubOrderIds(orderStringId);
    if (subOrderIds.length === 0) {
      console.error("[RELEASE] No valid order IDs found for:", orderStringId);
      toast({ title: "Failed to release", description: "Could not find order IDs", variant: "destructive" });
      return;
    }

    if (pickedCount === 0) {
      // No items picked - just release immediately
      try {
        console.log("[RELEASE] No picked items, releasing immediately with reset");
        for (const subId of subOrderIds) {
          await releaseMutation.mutateAsync({ orderId: subId, resetProgress: true });
        }
        toast({ title: "Order released", description: "Order is back in the queue" });
        if (view === "picking") {
          setView("queue");
          setActiveOrderId(null);
          setCurrentItemIndex(0);
        }
      } catch (error) {
        console.error("[RELEASE] Failed to release:", error);
        toast({ title: "Failed to release", description: "Please try again", variant: "destructive" });
      }
    } else {
      // Partially picked - show confirmation dialog
      console.log("[RELEASE] Has picked items, showing dialog");
      setReleaseOrderId(orderStringId);
      setReleaseDialogOpen(true);
    }
  };
  
  // Confirm release with chosen option
  const confirmRelease = async (resetProgress: boolean) => {
    if (releaseOrderId) {
      const subOrderIds = getSubOrderIds(releaseOrderId);
      if (subOrderIds.length === 0) {
        toast({ title: "Failed to release", description: "Could not find order IDs", variant: "destructive" });
        return;
      }
      try {
        console.log("[RELEASE] Confirming release with resetProgress:", resetProgress);
        for (const subId of subOrderIds) {
          await releaseMutation.mutateAsync({ orderId: subId, resetProgress });
        }
        toast({
          title: "Order released",
          description: resetProgress ? "Order reset and back in queue" : "Order released, progress kept"
        });
        setReleaseDialogOpen(false);
        setReleaseOrderId(null);
        if (view === "picking") {
          setView("queue");
          setActiveOrderId(null);
          setCurrentItemIndex(0);
        }
      } catch (error) {
        console.error("[RELEASE] Failed to confirm release:", error);
        toast({ title: "Failed to release", description: "Please try again", variant: "destructive" });
      }
    }
  };

  // ===== RENDER =====
  
  // QUEUE VIEW
  if (view === "queue") {
    // Use different data based on picking mode
    const readyItems = pickingMode === "batch" 
      ? queue.filter(b => b.status === "ready")
      : singleQueue.filter(o => o.status === "ready" && !o.onHold);
    const inProgressItems = pickingMode === "batch"
      ? queue.filter(b => b.status === "in_progress")
      : singleQueue.filter(o => o.status === "in_progress");
    const completedItems = pickingMode === "batch"
      ? queue.filter(b => b.status === "completed")
      : singleQueue.filter(o => o.status === "completed");
    const holdItems = pickingMode === "single"
      ? singleQueue.filter(o => o.onHold)
      : [];
    const combinedItems = pickingMode === "single"
      ? singleQueue.filter(o => o.isCombinedGroup && o.status !== "completed")
      : [];
    const totalItemsToPick = readyItems.reduce((acc, item) => acc + item.items.length, 0);

    // Filtered and sorted queue
    const filteredQueue = (pickingMode === "batch" ? queue : singleQueue).filter(item => {
      // By default, hide completed items unless filtering for "done"
      if (activeFilter !== "done" && item.status === "completed") return false;
      
      // By default, hide held items unless filtering for "hold"
      const itemOnHold = "onHold" in item && item.onHold;
      if (activeFilter !== "hold" && itemOnHold) return false;
      
      // Apply status filter
      if (activeFilter === "ready" && (item.status !== "ready" || itemOnHold)) return false;
      if (activeFilter === "active" && item.status !== "in_progress") return false;
      if (activeFilter === "done" && item.status !== "completed") return false;
      if (activeFilter === "rush" && item.priority !== "rush") return false;
      if (activeFilter === "hold" && !itemOnHold) return false;
      if (activeFilter === "combined" && !("isCombinedGroup" in item && (item as any).isCombinedGroup)) return false;
      
      // Apply search filter
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const orderNumber = "orderNumber" in item ? (item as SingleOrder).orderNumber?.toLowerCase() : item.id.toLowerCase();
        const customer = "customer" in item ? (item as SingleOrder).customer?.toLowerCase() : "";
        const skus = item.items.map(i => i.sku.toLowerCase()).join(" ");
        if (!orderNumber?.includes(query) && !customer?.includes(query) && !skus.includes(query)) {
          return false;
        }
      }
      return true;
    });
    
    // Sort the filtered queue (parseAgeToMinutes is defined above)
    const sortedQueue = [...filteredQueue].sort((a, b) => {
      let result = 0;
      switch (sortBy) {
        case "priority": {
          const priorityOrder = { rush: 0, high: 1, normal: 2 };
          result = priorityOrder[a.priority] - priorityOrder[b.priority];
          break;
        }
        case "items":
          result = a.items.length - b.items.length;
          break;
        case "order":
          const aNum = "orderNumber" in a ? (a as SingleOrder).orderNumber || a.id : a.id;
          const bNum = "orderNumber" in b ? (b as SingleOrder).orderNumber || b.id : b.id;
          result = aNum.localeCompare(bNum);
          break;
        case "age":
          result = parseAgeToMinutes(a.age) - parseAgeToMinutes(b.age);
          break;
        default:
          result = 0;
      }
      return sortDirection === "desc" ? -result : result;
    });
    
    return (
      <>
      <div className="flex flex-col min-h-full bg-muted/20 overflow-auto">
        {/* Compact Header - Row 1: Title + Actions */}
        <div className="bg-card border-b px-3 py-2 md:px-4 md:py-3">
          <div className="flex items-center justify-between gap-2">
            {/* Left: Title + Stats */}
            <div className="flex items-center gap-2 min-w-0">
              <PackageCheck className="h-5 w-5 text-primary shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-sm md:text-base truncate">Queue</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                    {readyItems.length} ready
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground hidden sm:block">
                  {totalItemsToPick} items to pick
                </p>
              </div>
            </div>
            
            {/* Right: Actions */}
            <div className="flex items-center gap-1.5">
              {/* Mode Toggle - Compact */}
              <div className="flex items-center rounded-md border bg-muted/50 p-0.5">
                <Button
                  variant={pickingMode === "batch" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setPickingMode("batch")}
                  className={cn(
                    "h-7 px-2 text-xs",
                    pickingMode === "batch" && "bg-primary shadow-sm"
                  )}
                  data-testid="button-batch-mode"
                >
                  <Layers className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant={pickingMode === "single" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setPickingMode("single")}
                  className={cn(
                    "h-7 px-2 text-xs",
                    pickingMode === "single" && "bg-primary shadow-sm"
                  )}
                  data-testid="button-single-mode"
                >
                  <Package className="h-3.5 w-3.5" />
                </Button>
              </div>
              
              {/* Sync Shopify - Icon only on mobile */}
              <Button 
                variant="outline" 
                size="icon"
                className="h-10 w-10 min-h-[40px] min-w-[40px]"
                onClick={handleSyncOrders}
                disabled={isSyncing}
                title="Sync Shopify"
                data-testid="button-sync-orders"
              >
                <CloudDownload className={cn("h-5 w-5", isSyncing && "animate-bounce")} />
              </Button>
              
              {/* Exceptions - Admin/Lead Only */}
              {isAdminOrLead && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 min-h-[40px] min-w-[40px] relative"
                  onClick={() => setView("exceptions")}
                  title="Exceptions"
                  data-testid="button-exceptions"
                >
                  <AlertTriangle className="h-5 w-5" />
                  {exceptionOrders.length > 0 && (
                    <Badge variant="destructive" className="absolute -top-1.5 -right-1.5 h-5 w-5 p-0 flex items-center justify-center text-[10px]">
                      {exceptionOrders.length}
                    </Badge>
                  )}
                </Button>
              )}
              
              {/* Grab Next - Primary Action */}
              <Button 
                onClick={handleGrabNext}
                className="bg-emerald-600 hover:bg-emerald-700 h-11 min-h-[44px] px-4 text-base font-medium"
                disabled={readyItems.length === 0}
                data-testid="button-grab-next"
              >
                <Zap className="h-5 w-5 mr-1.5" />
                <span className="hidden sm:inline">Grab Next</span>
                <span className="sm:hidden">Next</span>
              </Button>
            </div>
          </div>

          {/* Claim Error Alert - Compact */}
          {claimError && (
            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-amber-800 text-xs flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">{claimError}</span>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setClaimError(null)}
                className="h-5 px-1.5 text-amber-800 hover:text-amber-900"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}

          {/* Row 2: Filter Tabs - Horizontal Scroll, touch-friendly */}
          <div className="flex items-center gap-2 mt-3 overflow-x-auto pb-1 -mx-1 px-1">
            <button 
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                activeFilter === "ready" 
                  ? "bg-primary text-primary-foreground" 
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
              onClick={() => setActiveFilter(activeFilter === "ready" ? "all" : "ready")}
              data-testid="filter-ready"
            >
              <span className="font-bold">{readyItems.length}</span> Ready
            </button>
            <button 
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                activeFilter === "active" 
                  ? "bg-amber-500 text-white" 
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
              onClick={() => setActiveFilter(activeFilter === "active" ? "all" : "active")}
              data-testid="filter-active"
            >
              <span className="font-bold">{inProgressItems.length}</span> Active
            </button>
            <button 
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                activeFilter === "rush" 
                  ? "bg-red-500 text-white" 
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
              onClick={() => setActiveFilter(activeFilter === "rush" ? "all" : "rush")}
              data-testid="filter-rush"
            >
              <span className="font-bold">{readyItems.filter(item => item.priority === "rush").length}</span> Rush
            </button>
            {holdItems.length > 0 && (
              <button
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                  activeFilter === "hold"
                    ? "bg-slate-500 text-white"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted"
                )}
                onClick={() => setActiveFilter(activeFilter === "hold" ? "all" : "hold")}
                data-testid="filter-hold"
              >
                <span className="font-bold">{holdItems.length}</span> Hold
              </button>
            )}
            {combinedItems.length > 0 && (
              <button
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                  activeFilter === "combined"
                    ? "bg-indigo-500 text-white"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted"
                )}
                onClick={() => setActiveFilter(activeFilter === "combined" ? "all" : "combined")}
                data-testid="filter-combined"
              >
                <span className="font-bold">{combinedItems.length}</span> Combined
              </button>
            )}
            <button
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                activeFilter === "done"
                  ? "bg-emerald-500 text-white"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
              onClick={() => setActiveFilter(activeFilter === "done" ? "all" : "done")}
              data-testid="filter-done"
            >
              <span className="font-bold">{completedItems.length}</span> Done
            </button>
          </div>
        </div>

        {/* Search and Sort - Mobile responsive */}
        <div className="px-3 py-2 bg-muted/30 border-b">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search orders, SKUs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-11 min-h-[44px] pl-10 pr-10 text-base"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-search-queue"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9"
                  onClick={() => setSearchQuery("")}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="flex-1 sm:w-[120px] h-11 min-h-[44px] text-sm" data-testid="select-sort">
                  <SelectValue placeholder="Sort..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority">Priority</SelectItem>
                  <SelectItem value="items">Items</SelectItem>
                  <SelectItem value="order">Order #</SelectItem>
                  <SelectItem value="age">Age</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setSortDirection(sortDirection === "asc" ? "desc" : "asc")}
                className="h-11 w-11 min-h-[44px] min-w-[44px] shrink-0"
                title={sortDirection === "desc" ? "Oldest first" : "Newest first"}
                data-testid="button-sort-direction"
              >
                {sortDirection === "desc" ? (
                  <ArrowDown className="h-4 w-4" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </Button>
              {(searchQuery || activeFilter !== "all") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 min-h-[44px] px-3 text-sm shrink-0"
                  onClick={() => { setSearchQuery(""); setActiveFilter("all"); }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Queue List */}
        <div className="p-3 md:p-6 space-y-3">
          {pickingMode === "batch" ? (
            (sortedQueue as PickBatch[]).map((batch) => (
              <Card 
                key={batch.id} 
                className={cn(
                  "cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.99]",
                  batch.priority === "rush" && "border-l-4 border-l-red-500",
                  batch.priority === "high" && "border-l-4 border-l-amber-500",
                  batch.status === "in_progress" && "bg-amber-50/50 dark:bg-amber-950/20"
                )}
                onClick={() => batch.status === "ready" ? handleStartPicking(batch.id) : null}
                data-testid={`card-batch-${batch.id}`}
              >
                <CardContent className="p-3 md:p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 md:gap-4">
                      <div className={cn(
                        "h-12 w-12 md:h-10 md:w-10 rounded-lg flex items-center justify-center shrink-0",
                        batch.status === "in_progress" ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary"
                      )}>
                        <ClipboardList size={24} />
                      </div>
                      <div>
                        <div className="font-semibold flex items-center gap-2 text-base">
                          {batch.id}
                          {batch.priority === "rush" && <Badge variant="destructive" className="text-[10px] px-1.5 py-0">RUSH</Badge>}
                          {batch.priority === "high" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-50">HIGH</Badge>}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {batch.orders} order{batch.orders > 1 ? "s" : ""} • {batch.items.length} items
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <div className="text-sm text-muted-foreground flex items-center gap-1">
                        <Clock size={14} /> {batch.age}
                      </div>
                      {batch.status === "ready" && (
                        <ChevronRight className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            (sortedQueue as SingleOrder[]).map((order) => (
              <Card 
                key={order.id} 
                className={cn(
                  "cursor-pointer hover:border-primary/50 transition-all active:scale-[0.99]",
                  order.isCombinedGroup && "border-l-4 border-l-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20",
                  !order.isCombinedGroup && order.priority === "rush" && "border-l-4 border-l-red-500",
                  !order.isCombinedGroup && order.priority === "high" && "border-l-4 border-l-amber-500",
                  order.status === "in_progress" && "bg-amber-50/50 dark:bg-amber-950/20",
                  order.onHold && "opacity-60 bg-slate-100 dark:bg-slate-800/40",
                  flashingOrderId === order.id && "animate-pulse ring-2 ring-amber-400 bg-amber-50 dark:bg-amber-900/30"
                )}
                onClick={() => {
                  console.log("Card clicked:", order.id, "status:", order.status, "onHold:", order.onHold, "assignee:", order.assignee);
                  if (order.status === "ready" && !order.onHold) {
                    handleStartPicking(order.id);
                  } else if (order.status === "completed") {
                    console.log("Opening completed order dialog:", order.orderNumber, order);
                    toast({ title: "Opening order details", description: order.orderNumber });
                    setSelectedCompletedOrder(order);
                  } else if (order.status === "in_progress") {
                    // Check if this order is assigned to the current picker or is unassigned
                    const isMyOrder = order.assignee === pickerId || !order.assignee;
                    if (isMyOrder) {
                      // Resume picking own order
                      handleStartPicking(order.id);
                    } else if (isAdminOrLead) {
                      // Admin/lead can force release and take over
                      toast({
                        title: "Order in progress",
                        description: `This order is being picked by ${order.pickerName || 'another user'}. Use Force Release to take over.`,
                        variant: "default"
                      });
                    } else {
                      // Another picker has this order
                      toast({
                        title: "Order unavailable",
                        description: `This order is being picked by ${order.pickerName || 'another user'}`,
                        variant: "destructive"
                      });
                    }
                  }
                }}
                data-testid={`card-order-${order.id}`}
              >
                <CardContent className="p-3 md:p-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "h-12 w-12 md:h-10 md:w-10 rounded-lg flex flex-col items-center justify-center shrink-0 text-center",
                        order.onHold ? "bg-slate-200 text-slate-600" : 
                        order.status === "completed" ? "bg-emerald-100 text-emerald-700" :
                        order.status === "in_progress" ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary"
                      )}>
                        <span className="text-base md:text-sm font-bold leading-none">{order.items.reduce((sum, i) => sum + i.qty, 0)}</span>
                        <span className="text-[9px] leading-none mt-0.5">units</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        {order.isCombinedGroup && order.combinedOrders ? (
                          <>
                            <div className="font-semibold flex items-center gap-1.5 text-base md:text-sm flex-wrap">
                              <Badge className="bg-indigo-600 text-white text-[10px] px-1.5 py-0">
                                {order.combinedOrders.length} Orders Combined
                              </Badge>
                              <span className="text-xs text-muted-foreground font-normal flex items-center gap-0.5">
                                <Clock size={10} /> {order.age}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                              {order.combinedOrders.map((co, idx) => (
                                <div key={co.id} className="flex items-center gap-1">
                                  <span className="font-medium text-foreground">{co.orderNumber}</span>
                                  <span className="text-muted-foreground">({co.itemCount} {co.itemCount === 1 ? "line" : "lines"})</span>
                                </div>
                              ))}
                            </div>
                            <div className="text-xs text-muted-foreground mt-1">
                              {order.customer} • {order.items.length} total lines
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="font-semibold flex items-center gap-1.5 text-base md:text-sm flex-wrap">
                              {order.orderNumber}
                              <span className="text-xs text-muted-foreground font-normal flex items-center gap-0.5">
                                <Clock size={10} /> {order.age}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {order.customer} • {order.items.length} {order.items.length === 1 ? "line" : "lines"}
                            </div>
                            {/* Show who is picking this order if in_progress and assigned to another user */}
                            {order.status === "in_progress" && order.assignee && order.assignee !== pickerId && (
                              <div className="text-[10px] text-amber-600 flex items-center gap-1 mt-0.5">
                                <User size={10} />
                                <span>Being picked by {order.pickerName || 'another user'}</span>
                              </div>
                            )}
                            {order.orderDate && (
                              <div className="text-[10px] text-muted-foreground/70 flex items-center gap-2">
                                <span>{order.orderDate}</span>
                                {/* Admin inline Rush/Hold buttons for ready orders */}
                                {isAdminOrLead && order.status === "ready" && !order.onHold && order.priority !== "rush" && (
                                  <button
                                    className="text-red-600 hover:text-red-700 flex items-center gap-0.5 font-medium"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFlashingOrderId(order.id);
                                      rushMutation.mutate({ orderId: parseInt(order.id), priority: "rush" });
                                      setTimeout(() => setFlashingOrderId(null), 600);
                                    }}
                                    data-testid={`button-rush-${order.id}`}
                                  >
                                    <Zap className="h-3 w-3" />
                                    Rush
                                  </button>
                                )}
                                {isAdminOrLead && order.status === "ready" && !order.onHold && order.priority === "rush" && (
                                  <button
                                    className="text-slate-500 hover:text-slate-600 flex items-center gap-0.5 font-medium"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFlashingOrderId(order.id);
                                      rushMutation.mutate({ orderId: parseInt(order.id), priority: "normal" });
                                      setTimeout(() => setFlashingOrderId(null), 600);
                                    }}
                                    data-testid={`button-unrush-${order.id}`}
                                  >
                                    <Zap className="h-3 w-3" />
                                    Unrush
                                  </button>
                                )}
                                {order.status === "ready" && !order.onHold && (
                                  <button
                                    className="text-slate-600 hover:text-slate-700 flex items-center gap-0.5 font-medium"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFlashingOrderId(order.id);
                                      holdMutation.mutate(parseInt(order.id));
                                      setTimeout(() => setFlashingOrderId(null), 600);
                                    }}
                                    data-testid={`button-hold-${order.id}`}
                                  >
                                    <Pause className="h-3 w-3" />
                                    Hold
                                  </button>
                                )}
                                {order.onHold && (
                                  <button
                                    className="text-emerald-600 hover:text-emerald-700 flex items-center gap-0.5 font-medium"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setFlashingOrderId(order.id);
                                      const holdSubIds = getSubOrderIds(order.id);
                                      for (const subId of holdSubIds) {
                                        releaseHoldMutation.mutate(subId);
                                      }
                                      setTimeout(() => setFlashingOrderId(null), 600);
                                    }}
                                    data-testid={`button-release-hold-${order.id}`}
                                  >
                                    <Play className="h-3 w-3" />
                                    Release
                                  </button>
                                )}
                              </div>
                            )}
                            {order.status === "completed" && order.pickerName && (
                              <div className="text-[10px] text-muted-foreground">
                                Picked by {order.pickerName}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {order.channelProvider && !order.isCombinedGroup && (
                          <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0.5", getChannelBadgeStyle(order.channelProvider).className)} data-testid={`badge-channel-${order.id}`}>
                            {getChannelBadgeStyle(order.channelProvider).label}
                          </Badge>
                        )}
                        {order.onHold && <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 border-slate-400 text-slate-600 bg-slate-100">HOLD</Badge>}
                        {order.priority === "rush" && !order.onHold && <Badge variant="destructive" className="text-[9px] px-1.5 py-0.5">RUSH</Badge>}
                        {order.priority === "high" && !order.onHold && <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 border-amber-300 text-amber-700 bg-amber-50">HIGH</Badge>}
                        {order.status === "completed" && order.c2p && (
                          <span className="text-xs text-emerald-600 font-medium">C2P {order.c2p}</span>
                        )}
                        {(order.status === "ready" && !order.onHold && !isAdminOrLead) && (
                          <ChevronRight className="h-5 w-5 text-muted-foreground" />
                        )}
                        {isAdminOrLead && order.status === "ready" && !order.onHold && (
                          <ChevronRight className="h-5 w-5 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                    {isAdminOrLead && order.status === "in_progress" && (
                    <div className="flex items-center gap-1 justify-end border-t pt-2 mt-1 flex-wrap">
                      {order.status === "in_progress" && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 px-2 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReleaseOrder(order.id);
                            }}
                            data-testid={`button-release-${order.id}`}
                          >
                            <Unlock className="h-4 w-4 mr-1" />
                            Release
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-9 px-2 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`Force release order ${order.orderNumber}? This will put it back in the queue.`)) {
                                const subIds = getSubOrderIds(order.id);
                                for (const subId of subIds) {
                                  forceReleaseMutation.mutate({ orderId: subId, resetProgress: false });
                                }
                              }
                            }}
                            data-testid={`button-force-release-${order.id}`}
                            title="Force release stuck order (admin)"
                          >
                            <AlertTriangle className="h-4 w-4 mr-1" />
                            Force
                          </Button>
                        </>
                      )}
                    </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
          
          {completedItems.length > 0 && (
            <div className="pt-4">
              <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Completed ({completedItems.length})
              </h3>
              {completedItems.map((item) => (
                <Card 
                  key={item.id} 
                  className="bg-muted/30 border-muted mb-2 cursor-pointer hover:border-emerald-300 transition-colors"
                  onClick={() => setSelectedCompletedOrder(item as SingleOrder)}
                  data-testid={`card-completed-${item.id}`}
                >
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-emerald-100 text-emerald-700">
                      <CheckCircle2 size={20} />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{(item as SingleOrder).orderNumber || item.id}</span>
                        <span className="text-sm text-muted-foreground">• {item.items.length} items</span>
                      </div>
                      {(item as SingleOrder).pickerName && (
                        <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <User size={10} /> Picked by {(item as SingleOrder).pickerName}
                        </div>
                      )}
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
      
      {/* Completed Order Detail Dialog - Mobile Optimized */}
      <Dialog open={!!selectedCompletedOrder} onOpenChange={(open) => !open && setSelectedCompletedOrder(null)}>
        <DialogContent className="w-[95vw] max-w-md max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="p-3 pb-2 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              {selectedCompletedOrder?.orderNumber}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {selectedCompletedOrder?.customer}
            </DialogDescription>
          </DialogHeader>
          
          {selectedCompletedOrder && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              <div className="bg-muted/50 rounded-lg p-2.5 space-y-1.5 text-xs">
                {selectedCompletedOrder.pickerName && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Picked by</span>
                    <span className="font-medium">{selectedCompletedOrder.pickerName}</span>
                  </div>
                )}
                {selectedCompletedOrder.completedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Completed</span>
                    <span className="font-medium">
                      {new Date(selectedCompletedOrder.completedAt).toLocaleString()}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Items</span>
                  <span className="font-medium">{selectedCompletedOrder.items.length} items</span>
                </div>
              </div>
              
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-muted-foreground">Picked Items</h4>
                {selectedCompletedOrder.items.map((item) => (
                  <div 
                    key={item.id} 
                    className="flex items-center gap-2 p-2 border rounded-lg bg-background"
                  >
                    {item.image ? (
                      <img 
                        src={item.image} 
                        alt={item.name}
                        className="h-8 w-8 rounded object-cover shrink-0"
                      />
                    ) : (
                      <div className="h-8 w-8 rounded bg-muted flex items-center justify-center shrink-0">
                        <Package size={14} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{item.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {item.sku} • {item.location}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={cn(
                        "text-xs font-medium",
                        item.status === "completed" ? "text-emerald-600" : "text-amber-600"
                      )}>
                        {item.picked}/{item.qty}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {item.status === "short" ? "Short" : "Picked"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <div className="p-3 pt-2 border-t shrink-0">
            <Button 
              variant="outline" 
              className="w-full h-10"
              onClick={() => setSelectedCompletedOrder(null)}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </>
    );
  }
  
  // EXCEPTIONS VIEW - Admin/Lead only
  if (view === "exceptions" && isAdminOrLead) {
    // Transform API orders to display format
    const exceptionItems = exceptionOrders.map((order): SingleOrder => ({
      id: String(order.id),
      orderNumber: order.orderNumber,
      customer: order.customerName,
      priority: order.priority as "rush" | "high" | "normal",
      age: getOrderAge(order.orderPlacedAt || order.shopifyCreatedAt || order.createdAt),
      status: "ready" as const,
      assignee: order.assignedPickerId,
      onHold: false,
      pickerName: order.pickerName || null,
      completedAt: order.completedAt ? String(order.completedAt) : null,
      items: order.items.map((item): PickItem => {
        // Safely map item status to known values
        const validStatuses = ["pending", "in_progress", "completed", "short"];
        const status = validStatuses.includes(item.status) 
          ? item.status as "pending" | "in_progress" | "completed" | "short"
          : "pending"; // Default unknown statuses to pending
        return {
          id: item.id,
          sku: item.sku,
          name: item.name,
          location: item.location,
          qty: item.quantity,
          picked: item.pickedQuantity,
          status,
          orderId: order.orderNumber,
          image: item.imageUrl || "",
          barcode: item.barcode || undefined,
        };
      }),
    }));
    
    return (
      <div className="flex flex-col min-h-full bg-muted/20 overflow-auto">
        <div className="bg-card border-b p-4 md:p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
                <AlertTriangle className="h-6 w-6 text-orange-500" />
                Exception Queue
                <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 ml-2">
                  {exceptionOrders.length} orders
                </Badge>
              </h1>
              <p className="text-muted-foreground text-sm">
                Orders with short picks or issues requiring lead review
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setView("queue")}
              data-testid="button-back-to-queue"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Queue
            </Button>
          </div>
        </div>
        
        <div className="flex-1 p-4 md:p-6">
          {exceptionItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <CheckCircle2 className="h-16 w-16 text-emerald-500 mb-4" />
              <h2 className="text-xl font-semibold mb-2">No Exceptions</h2>
              <p className="text-muted-foreground">All orders are processing normally</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {exceptionItems.map((order) => {
                const shortItems = order.items.filter(i => i.status === "short");
                const originalOrder = exceptionOrders.find(o => o.id === Number(order.id));
                
                return (
                  <Card key={order.id} className="border-orange-200 bg-orange-50/50" data-testid={`exception-order-${order.id}`}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-lg flex items-center gap-2">
                            {order.orderNumber}
                            {order.channelProvider && (
                              <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0.5", getChannelBadgeStyle(order.channelProvider).className)} data-testid={`badge-channel-exception-${order.id}`}>
                                {getChannelBadgeStyle(order.channelProvider).label}
                              </Badge>
                            )}
                            <Badge variant="outline" className="bg-orange-100 text-orange-700 border-orange-300">
                              {shortItems.length} short {shortItems.length === 1 ? "item" : "items"}
                            </Badge>
                          </CardTitle>
                          <p className="text-sm text-muted-foreground">{order.customer}</p>
                        </div>
                        <div className="text-right text-sm text-muted-foreground">
                          <div>Age: {order.age}</div>
                          {order.pickerName && <div>Picker: {order.pickerName}</div>}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pb-4">
                      {/* Short Items */}
                      <div className="mb-4">
                        <h4 className="text-sm font-medium mb-2 text-orange-700">Short Picks:</h4>
                        <div className="space-y-2">
                          {shortItems.map((item) => (
                            <div key={item.id} className="flex items-center justify-between bg-white rounded-lg p-2 border">
                              <div>
                                <div className="font-medium text-sm">{item.sku}</div>
                                <div className="text-xs text-muted-foreground">{item.name}</div>
                                <div className="text-xs text-muted-foreground">Location: {item.location}</div>
                              </div>
                              <div className="text-right">
                                <div className="font-bold text-orange-600">{item.picked}/{item.qty}</div>
                                <div className="text-xs text-muted-foreground">picked</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* Resolution Buttons */}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="default"
                          size="sm"
                          className="bg-blue-600 hover:bg-blue-700"
                          onClick={() => {
                            if (confirm("Ship this order with available quantities? Short items will be marked as backordered.")) {
                              resolveExceptionMutation.mutate({
                                orderId: Number(order.id),
                                resolution: "ship_partial",
                                notes: "Shipped partial - remaining items backordered"
                              });
                            }
                          }}
                          disabled={resolveExceptionMutation.isPending}
                          data-testid={`button-ship-partial-${order.id}`}
                        >
                          <Truck className="h-4 w-4 mr-1" />
                          Ship Partial
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            if (confirm("Put this order on hold until all items are available?")) {
                              resolveExceptionMutation.mutate({
                                orderId: Number(order.id),
                                resolution: "hold",
                                notes: "Waiting for inventory"
                              });
                            }
                          }}
                          disabled={resolveExceptionMutation.isPending}
                          data-testid={`button-hold-${order.id}`}
                        >
                          <Pause className="h-4 w-4 mr-1" />
                          Hold Order
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-emerald-600 hover:text-emerald-700"
                          onClick={() => {
                            if (confirm("Mark this exception as resolved and send back to queue?")) {
                              resolveExceptionMutation.mutate({
                                orderId: Number(order.id),
                                resolution: "resolved",
                                notes: "Issue resolved - back to picking"
                              });
                            }
                          }}
                          disabled={resolveExceptionMutation.isPending}
                          data-testid={`button-resolve-${order.id}`}
                        >
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                          Resolved
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => {
                            if (confirm("Cancel this order? This action cannot be undone.")) {
                              resolveExceptionMutation.mutate({
                                orderId: Number(order.id),
                                resolution: "cancelled"
                              });
                            }
                          }}
                          disabled={resolveExceptionMutation.isPending}
                          data-testid={`button-cancel-${order.id}`}
                        >
                          <XCircle className="h-4 w-4 mr-1" />
                          Cancel
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }
  
  // COMPLETE VIEW
  if (view === "complete") {
    const readyCount = pickingMode === "batch" 
      ? queue.filter(b => b.status === "ready").length
      : singleQueue.filter(o => o.status === "ready").length;
    
    return (
      <div className="flex flex-col items-center justify-center min-h-full bg-gradient-to-b from-emerald-50 to-background dark:from-emerald-950/20 p-6">
        <div className="text-center space-y-6 max-w-md w-full">
          <div className="h-28 w-28 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 flex items-center justify-center animate-in zoom-in duration-300">
            <Trophy className="w-14 h-14" />
          </div>
          
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-emerald-700 dark:text-emerald-400">
              {pickingMode === "batch" ? "Batch" : "Order"} Complete!
            </h1>
            <p className="text-muted-foreground text-lg">
              {pickingMode === "single" && activeOrder ? activeOrder.orderNumber : activeWork?.id} is ready for packing
            </p>
          </div>
          
          <div className="bg-card border rounded-lg p-4 text-left space-y-3">
            <div className="flex justify-between text-base">
              <span className="text-muted-foreground">Items Picked</span>
              <span className="font-bold text-emerald-600">{activeWork?.items.filter(i => i.status === "completed").length}</span>
            </div>
            {(activeWork?.items.filter(i => i.status === "short").length || 0) > 0 && (
              <div className="flex justify-between text-base">
                <span className="text-muted-foreground">Short Picks</span>
                <span className="font-bold text-amber-600">{activeWork?.items.filter(i => i.status === "short").length}</span>
              </div>
            )}
            {pickingMode === "batch" && activeBatch && (
              <div className="flex justify-between text-base">
                <span className="text-muted-foreground">Orders</span>
                <span className="font-bold">{activeBatch.orders}</span>
              </div>
            )}
            {pickingMode === "single" && activeOrder && (
              <div className="flex justify-between text-base">
                <span className="text-muted-foreground">Customer</span>
                <span className="font-bold">{activeOrder.customer}</span>
              </div>
            )}
          </div>
          
          <div className="flex flex-col gap-3 pt-4">
            <Button 
              onClick={handleGrabNext}
              className="bg-emerald-600 hover:bg-emerald-700 h-14 text-lg"
              disabled={readyCount === 0}
              data-testid="button-next-batch"
            >
              <ArrowRight className="h-5 w-5 mr-2" />
              {readyCount > 0 ? `Grab Next (${readyCount} waiting)` : `No More ${pickingMode === "batch" ? "Batches" : "Orders"}`}
            </Button>
            <Button variant="outline" onClick={handleBackToQueue} className="h-12" data-testid="button-back-queue">
              Back to Queue
            </Button>
          </div>
        </div>
      </div>
    );
  }
  
  // PICKING VIEW (Scanner Optimized)
  return (
    <div className="flex flex-col min-h-full bg-muted/20 overflow-auto select-none">
      {/* Compact Header */}
      <div className="bg-card border-b p-3 md:p-4 sticky top-0 z-10">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={handleBackToQueue} className="text-muted-foreground h-8 px-2">
              <ChevronRight className="h-4 w-4 rotate-180" /> Exit
            </Button>
            {pickingMode === "single" && activeOrderId && (
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => handleReleaseOrder(activeOrderId)}
                className="text-amber-600 hover:text-amber-700 hover:bg-amber-50 h-8 px-2"
                title="Release order back to queue"
              >
                <Unlock className="h-4 w-4 mr-1" /> Release
              </Button>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            {/* View Mode Toggle */}
            <div className="flex items-center border rounded-lg overflow-hidden h-8">
              <Button
                variant={pickerViewMode === "focus" ? "default" : "ghost"}
                size="sm"
                onClick={() => setPickerViewMode("focus")}
                className={cn(
                  "h-8 px-2 rounded-none",
                  pickerViewMode === "focus" && "bg-primary text-primary-foreground"
                )}
                title="Focus View"
                data-testid="button-focus-view"
              >
                <Focus className="h-4 w-4" />
              </Button>
              <Button
                variant={pickerViewMode === "list" ? "default" : "ghost"}
                size="sm"
                onClick={() => setPickerViewMode("list")}
                className={cn(
                  "h-8 px-2 rounded-none",
                  pickerViewMode === "list" && "bg-primary text-primary-foreground"
                )}
                title="List View"
                data-testid="button-list-view"
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSoundSettingsOpen(true)}
              className="h-8 w-8"
              title="Sound & Haptic Settings"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
{/* Priority badge only - order # shown below */}
            {(activeWork?.priority === "rush" || activeWork?.priority === "high") && (
              <Badge 
                variant="outline" 
                className={cn(
                  "text-xs px-2 py-0.5",
                  activeWork?.priority === "rush" && "border-red-300 bg-red-50 text-red-700",
                  activeWork?.priority === "high" && "border-amber-300 bg-amber-50 text-amber-700"
                )}
              >
                {activeWork?.priority === "rush" ? "RUSH" : "HIGH"}
              </Badge>
            )}
          </div>
        </div>

        {/* Order Number - Prominent */}
        <div className="text-center py-1">
          <span className="text-2xl font-bold text-primary">
            {pickingMode === "single" && activeOrder ? activeOrder.orderNumber : activeWork?.id}
          </span>
        </div>
        
        {/* Progress Bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm font-medium">
            <span>{completedItems}/{totalItems} items</span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <Progress value={progressPercent} className="h-2" />
        </div>
      </div>

      {/* Main Pick Interface */}
      {pickerViewMode === "focus" ? (
        /* FOCUS VIEW - Single item at a time, optimized for scanner */
        <div className="flex-1 p-3 md:p-4 flex flex-col max-w-2xl mx-auto w-full">
          {currentItem ? (
            <Card className={cn(
              "flex-1 shadow-lg flex flex-col transition-all duration-200",
              scanStatus === "success" && "border-emerald-500 border-2 bg-emerald-50/50 dark:bg-emerald-950/30",
              scanStatus === "error" && "border-red-500 border-2 bg-red-50/50 dark:bg-red-950/30 animate-shake"
            )}>
              {/* Location Header - BIG and prominent */}
              <CardHeader className="bg-muted/50 py-4 px-4 text-center border-b">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest mb-1">GO TO</div>
                <div className="text-4xl md:text-5xl font-black font-mono text-primary tracking-wide">
                  {currentItem.location}
                </div>
                <div className="flex items-center justify-center gap-2 mt-2">
                  {activeWork?.items.map((item, idx) => (
                    <div 
                      key={item.id}
                      className={cn(
                        "h-2 w-2 rounded-full transition-all",
                        item.status === "completed" && "bg-emerald-500",
                        item.status === "short" && "bg-amber-500",
                        idx === currentItemIndex && "bg-primary w-4",
                        item.status === "pending" && idx !== currentItemIndex && "bg-muted-foreground/30"
                      )} 
                    />
                  ))}
                </div>
              </CardHeader>
              
              <CardContent className="flex-1 flex flex-col p-4 gap-4">
                {/* Product Info */}
                <div className="flex items-center gap-4">
                  <div className="relative shrink-0">
                    {currentItem.image ? (
                      <img 
                        src={currentItem.image} 
                        alt={currentItem.name}
                        className="w-24 h-24 md:w-28 md:h-28 object-cover rounded-lg border-2 border-muted"
                      />
                    ) : (
                      <div className="w-24 h-24 md:w-28 md:h-28 rounded-lg border-2 border-muted bg-muted flex items-center justify-center">
                        <Package className="w-12 h-12 text-muted-foreground" />
                      </div>
                    )}
                    {scanStatus === "success" && (
                      <div className="absolute inset-0 bg-emerald-500/20 rounded-lg flex items-center justify-center">
                        <CheckCircle2 className="w-12 h-12 text-emerald-600" />
                      </div>
                    )}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="text-2xl md:text-3xl font-bold font-mono mb-1">{currentItem.sku}</div>
                    <div className="text-muted-foreground text-sm md:text-base truncate">{currentItem.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">Order {currentItem.orderId}</div>
                  </div>
                </div>
                
                {/* Quantity Badge - HUGE */}
                <div className={cn(
                  "py-4 rounded-xl text-center",
                  scanStatus === "success" ? "bg-emerald-100 dark:bg-emerald-900/50" : "bg-red-100 dark:bg-red-900/30"
                )}>
                  <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Pick Quantity</div>
                  <div className={cn(
                    "text-6xl md:text-7xl font-black",
                    scanStatus === "success" ? "text-emerald-600" : "text-red-600"
                  )}>
                    {currentItem.qty - currentItem.picked}
                  </div>
                </div>
                
                {/* Scan Input - Always visible and focused */}
                <div className="mt-auto space-y-3">
                  {scanStatus === "success" ? (
                    <div className="h-14 bg-emerald-100 border-2 border-emerald-500 rounded-xl flex items-center justify-center gap-3 text-emerald-700 font-bold text-lg animate-in zoom-in-95">
                      <CheckCircle2 className="h-6 w-6" />
                      Confirmed!
                    </div>
                  ) : scanStatus === "error" ? (
                    <div className="h-14 bg-red-100 border-2 border-red-500 rounded-xl flex items-center justify-center gap-3 text-red-700 font-bold text-lg">
                      <AlertTriangle className="h-6 w-6" />
                      Wrong Item!
                    </div>
                  ) : (
                    <div className="relative">
                      <Scan className="absolute left-4 top-1/2 -translate-y-1/2 text-primary h-6 w-6" />
                      <Input 
                        ref={manualInputRef}
                        placeholder="Scan barcode..." 
                        className="pl-14 h-14 text-xl font-mono border-2 border-primary/50 focus-visible:ring-primary rounded-xl"
                        value={scanInput}
                        onChange={(e) => handleScan(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        enterKeyHint="done"
                        data-testid="input-scan-sku"
                      />
                    </div>
                  )}
                  
                  {/* Action Buttons - Large touch targets */}
                  <div className="grid grid-cols-2 gap-3">
                    <Button 
                      variant="outline"
                      className="h-14 min-h-[44px] text-base font-medium"
                      onClick={() => currentItem.qty > 1 ? setMultiQtyOpen(true) : confirmPick(1)}
                      data-testid="button-manual-confirm"
                    >
                      <CheckCircle2 className="h-5 w-5 mr-2" />
                      Manual OK
                    </Button>
                    <Button 
                      variant="outline"
                      className="h-14 min-h-[44px] text-base font-medium text-amber-600 border-amber-300 hover:bg-amber-50"
                      onClick={() => setShortPickOpen(true)}
                      data-testid="button-short-pick"
                    >
                      <AlertTriangle className="h-5 w-5 mr-2" />
                      Short Pick
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground">No items remaining</p>
            </div>
          )}
        </div>
      ) : (
        /* LIST VIEW - All items visible, can pick in any order */
        <div className="flex-1 p-3 md:p-4 flex flex-col max-w-2xl mx-auto w-full">
          {/* Scan input at top for list view */}
          <div className="mb-2">
            <div className="relative">
              <Scan className="absolute left-3 top-1/2 -translate-y-1/2 text-primary h-5 w-5" />
              <Input 
                ref={manualInputRef}
                placeholder="Scan any item barcode..." 
                className="pl-12 h-12 text-lg font-mono border-2 border-primary/50 focus-visible:ring-primary rounded-lg"
                inputMode="numeric"
                value={scanInput}
                onChange={(e) => setScanInput(e.target.value)}
                onKeyDown={handleScanKeyDown}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                data-testid="input-scan-sku-list"
              />
            </div>
            {/* Debug log panel - shows scan activity */}
            {debugLog.length > 0 && (
              <div className="mt-1 p-2 bg-slate-900 text-green-400 rounded text-[10px] font-mono max-h-20 overflow-auto">
                {debugLog.map((log, i) => (
                  <div key={i} className={i === 0 ? "font-bold" : "text-green-600"}>{log}</div>
                ))}
              </div>
            )}
          </div>
          
          {/* Scrollable item list - COMPACT ROWS */}
          <ScrollArea className="flex-1">
            <div className="space-y-1 pb-4">
              {activeWork?.items.map((item, idx) => {
                const remaining = item.qty - item.picked;
                const isCompleted = item.status === "completed" || item.status === "short";
                const justScanned = item.id === lastScannedItemId;
                
                return (
                  <div 
                    key={item.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(item.id, el);
                      else itemRefs.current.delete(item.id);
                    }}
                    className={cn(
                      "flex flex-col gap-1 p-1.5 md:p-2 rounded-lg border w-full",
                      item.status === "completed" && "bg-emerald-50 border-emerald-200",
                      item.status === "short" && "bg-amber-50 border-amber-200",
                      !isCompleted && "bg-white border-slate-200",
                      justScanned && "ring-2 ring-emerald-500 bg-emerald-100"
                    )}
                    style={{ overflow: 'hidden' }}
                    data-testid={`list-item-${item.id}`}
                  >
                    {/* Top row: Image, Location/Qty, Buttons */}
                    <div className="flex items-center gap-1.5 md:gap-2">
                      {/* Image - fixed size, smaller on mobile */}
                      <div className="w-10 h-10 md:w-12 md:h-12 flex-shrink-0">
                        {item.image ? (
                          <img src={item.image} alt="" className="w-10 h-10 md:w-12 md:h-12 rounded object-cover" />
                        ) : (
                          <div className="w-10 h-10 md:w-12 md:h-12 rounded bg-slate-100 flex items-center justify-center">
                            <Package className="h-4 w-4 md:h-5 md:w-5 text-slate-400" />
                          </div>
                        )}
                      </div>
                      
                      {/* Location + Qty + SKU/Barcode */}
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
                          <span className={cn("text-base md:text-lg font-black font-mono flex-shrink-0", isCompleted ? "text-slate-400" : "text-primary")}>
                            {item.location}
                          </span>
                          <button
                            onClick={() => openEditQtyDialog(idx)}
                            className={cn(
                              "text-sm md:text-base font-bold px-2 py-0.5 md:px-2.5 md:py-1 rounded flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all",
                              isCompleted 
                                ? "bg-emerald-100 text-emerald-700" 
                                : "bg-amber-100 text-amber-800"
                            )}
                            data-testid={`qty-badge-${item.id}`}
                          >
                            {item.picked}/{item.qty}
                          </button>
                        </div>
                        <div className="text-[10px] md:text-xs font-mono font-semibold text-slate-500 truncate">{item.sku}</div>
                        {item.barcode && <div className="text-[9px] md:text-[10px] font-mono text-blue-500 truncate">BC: {item.barcode}</div>}
                      </div>
                    
                      {/* Buttons - fixed width, always visible, touch-friendly */}
                      <div className="flex-shrink-0 flex gap-1 justify-end">
                        {!isCompleted ? (
                          <div className="flex gap-1">
                            {/* -1 Button */}
                            <Button 
                              size="icon" 
                              variant="outline"
                              className="h-9 w-9 md:h-11 md:w-11 border-slate-300 text-slate-600 flex-shrink-0"
                              onClick={() => handleListItemDecrement(idx)}
                              disabled={item.picked <= 0}
                              data-testid={`button-minus-${item.id}`}
                            >
                              <Minus className="h-4 w-4 md:h-5 md:w-5" />
                            </Button>
                            {/* +1 Button */}
                            <Button 
                              size="icon" 
                              variant="outline"
                              className="h-9 w-9 md:h-11 md:w-11 border-blue-400 text-blue-600 flex-shrink-0"
                              onClick={() => handleListItemManualPickOne(idx)}
                              disabled={item.picked >= item.qty}
                              data-testid={`button-plus-${item.id}`}
                            >
                              <Plus className="h-4 w-4 md:h-5 md:w-5" />
                            </Button>
                            {/* Pick All Button */}
                            <Button 
                              size="icon" 
                              className="h-9 w-9 md:h-11 md:w-11 bg-emerald-500 text-white flex-shrink-0" 
                              onClick={() => handleListItemPick(idx)} 
                              data-testid={`button-pick-${item.id}`}
                            >
                              <CheckCircle2 className="h-4 w-4 md:h-5 md:w-5" />
                            </Button>
                          </div>
                        ) : (
                          <div className="h-9 w-9 md:h-11 md:w-11 flex items-center justify-center">
                            {item.status === "completed" ? <CheckCircle2 className="h-5 w-5 md:h-6 md:w-6 text-emerald-500" /> : <AlertTriangle className="h-5 w-5 md:h-6 md:w-6 text-amber-500" />}
                          </div>
                        )}
                      </div>
                    </div>
                    
                    {/* Bottom row: Product name - full width */}
                    <div className="text-xs md:text-sm text-slate-600 pl-0.5">{item.name}</div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          
          {/* Check if all done */}
          {activeWork && activeWork.items.every(i => i.status === "completed" || i.status === "short") && (
            <div className="pt-3">
              <Button 
                className="w-full h-14 bg-emerald-600 hover:bg-emerald-700 text-lg"
                onClick={() => {
                  // Mark the work as completed in state
                  if (pickingMode === "batch") {
                    setQueue(prev => prev.map(b =>
                      b.id === activeBatchId ? { ...b, status: "completed" as const } : b
                    ));
                  } else {
                    setSingleQueue(prev => prev.map(o =>
                      o.id === activeOrderId ? { ...o, status: "completed" as const } : o
                    ));
                  }
                  playSound("complete");
                  triggerHaptic("heavy");
                  setView("queue");
                }}
                data-testid="button-complete-all"
              >
                <CheckCircle2 className="h-5 w-5 mr-2" />
                Complete {pickingMode === "batch" ? "Batch" : "Order"}
              </Button>
            </div>
          )}
        </div>
      )}
      
      {/* Multi-Qty Confirm Dialog */}
      <Dialog open={multiQtyOpen} onOpenChange={setMultiQtyOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Confirm Quantity</DialogTitle>
            <DialogDescription className="text-center">
              How many did you pick?
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-4">
              <Button 
                variant="outline" 
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => setPickQty(Math.max(1, pickQty - 1))}
              >
                -
              </Button>
              <span className="text-5xl font-bold w-20 text-center">{pickQty}</span>
              <Button 
                variant="outline" 
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => setPickQty(Math.min(currentItem?.qty || 1, pickQty + 1))}
              >
                +
              </Button>
            </div>
            <p className="text-center text-muted-foreground">
              of {currentItem?.qty} needed
            </p>
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button 
              className="w-full h-14 min-h-[44px] text-lg bg-emerald-600 hover:bg-emerald-700"
              onClick={() => confirmPick(pickQty)}
            >
              Confirm {pickQty}
            </Button>
            <Button 
              variant="ghost" 
              className="w-full h-12 min-h-[44px]"
              onClick={() => { setMultiQtyOpen(false); setPickQty(1); }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Edit Quantity Dialog */}
      <Dialog open={editQtyOpen} onOpenChange={setEditQtyOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Edit Picked Qty</DialogTitle>
            <DialogDescription className="text-center">
              Tap number to type directly or use +/- buttons
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-3">
              <Button 
                variant="outline" 
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => setEditQtyValue(Math.max(0, editQtyValue - 1))}
              >
                -
              </Button>
              <Input
                type="number"
                inputMode="numeric"
                pattern="[0-9]*"
                value={editQtyValue}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || 0;
                  const maxQty = editQtyIdx !== null && activeWork ? activeWork.items[editQtyIdx]?.qty || 0 : 0;
                  setEditQtyValue(Math.max(0, Math.min(maxQty, val)));
                }}
                className="w-full max-w-[100px] h-16 text-4xl font-bold text-center border-2 border-primary/50"
                data-testid="input-edit-qty"
              />
              <Button 
                variant="outline" 
                size="icon"
                className="h-16 w-16 min-h-[44px] min-w-[44px] text-2xl"
                onClick={() => {
                  const maxQty = editQtyIdx !== null && activeWork ? activeWork.items[editQtyIdx]?.qty || 0 : 0;
                  setEditQtyValue(Math.min(maxQty, editQtyValue + 1));
                }}
              >
                +
              </Button>
            </div>
            <p className="text-center text-muted-foreground">
              of {editQtyIdx !== null && activeWork ? activeWork.items[editQtyIdx]?.qty : 0} needed
            </p>
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button 
              className="w-full h-14 min-h-[44px] text-lg bg-primary hover:bg-primary/90"
              onClick={handleEditQtyConfirm}
            >
              Set to {editQtyValue}
            </Button>
            <Button 
              variant="ghost" 
              className="w-full h-12 min-h-[44px]"
              onClick={() => { setEditQtyOpen(false); setEditQtyIdx(null); }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Sound & Haptic Settings Dialog */}
      <Dialog open={soundSettingsOpen} onOpenChange={setSoundSettingsOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2">
              <Volume2 className="h-5 w-5" />
              Sound & Haptic Settings
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4 space-y-6">
            <div className="space-y-3">
              <Label className="text-sm font-medium">Sound Theme</Label>
              <RadioGroup 
                value={soundTheme} 
                onValueChange={(value) => {
                  setSoundTheme(value as SoundTheme);
                  if (value !== "silent") {
                    setTimeout(() => previewTheme(value as SoundTheme), 100);
                  }
                }} 
                className="space-y-2"
              >
                {(Object.keys(themeNames) as SoundTheme[]).map((theme) => (
                  <div 
                    key={theme}
                    className={cn(
                      "flex items-center justify-between p-3 border rounded-lg cursor-pointer transition-colors",
                      soundTheme === theme && "border-primary bg-primary/5"
                    )}
                    onClick={() => {
                      setSoundTheme(theme);
                      if (theme !== "silent") {
                        setTimeout(() => previewTheme(theme), 100);
                      }
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <RadioGroupItem value={theme} id={`theme-${theme}`} />
                      <div>
                        <Label htmlFor={`theme-${theme}`} className="cursor-pointer font-medium">
                          {themeNames[theme]}
                        </Label>
                        <p className="text-xs text-muted-foreground">{themeDescriptions[theme]}</p>
                      </div>
                    </div>
                    {theme !== "silent" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          previewTheme(theme);
                        }}
                      >
                        <Volume2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </RadioGroup>
            </div>
            
            <div className="flex items-center justify-between p-3 border rounded-lg">
              <div>
                <Label className="font-medium">Haptic Feedback</Label>
                <p className="text-xs text-muted-foreground">Vibration on scan & pick</p>
              </div>
              <Switch 
                checked={hapticEnabled} 
                onCheckedChange={setHapticEnabled}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button 
              className="w-full"
              onClick={() => setSoundSettingsOpen(false)}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Release Order Dialog */}
      <Dialog open={releaseDialogOpen} onOpenChange={setReleaseDialogOpen}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2">
              <Unlock className="h-5 w-5" />
              Release Order
            </DialogTitle>
            <DialogDescription className="text-center">
              This order has items that were partially picked. What would you like to do with the progress?
            </DialogDescription>
          </DialogHeader>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col pt-4">
            <Button 
              className="w-full h-14 min-h-[44px] text-base bg-emerald-600 hover:bg-emerald-700"
              onClick={() => confirmRelease(false)}
            >
              Keep Progress
              <span className="text-xs opacity-80 ml-2">(Next picker continues)</span>
            </Button>
            <Button 
              variant="outline"
              className="w-full h-14 min-h-[44px] text-base"
              onClick={() => confirmRelease(true)}
            >
              Reset Progress
              <span className="text-xs opacity-80 ml-2">(Start fresh)</span>
            </Button>
            <Button 
              variant="ghost" 
              className="w-full h-12 min-h-[44px]"
              onClick={() => setReleaseDialogOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Short Pick Dialog */}
      <Dialog open={shortPickOpen} onOpenChange={(open) => { if (!open) { setShortPickOpen(false); setShortPickListIndex(null); } }}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Short Pick
            </DialogTitle>
            {(() => {
              const targetItem = shortPickListIndex !== null 
                ? activeWork?.items[shortPickListIndex] 
                : currentItem;
              return targetItem && (
                <DialogDescription className="text-center">
                  <span className="font-medium">{targetItem.sku}</span>
                  <br />
                  <span className="text-xs">Need {targetItem.qty}, picked {targetItem.picked || 0}</span>
                </DialogDescription>
              );
            })()}
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            <RadioGroup value={shortPickReason} onValueChange={setShortPickReason} className="space-y-3">
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="out_of_stock" id="out_of_stock" />
                <Label htmlFor="out_of_stock" className="flex-1 cursor-pointer">Out of Stock</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="not_found" id="not_found" />
                <Label htmlFor="not_found" className="flex-1 cursor-pointer">Not at location</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="damaged" id="damaged" />
                <Label htmlFor="damaged" className="flex-1 cursor-pointer">Damaged</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="wrong_item" id="wrong_item" />
                <Label htmlFor="wrong_item" className="flex-1 cursor-pointer">Wrong item in bin</Label>
              </div>
              <div className="flex items-center space-x-3 p-3 border rounded-lg">
                <RadioGroupItem value="partial" id="partial" />
                <Label htmlFor="partial" className="flex-1 cursor-pointer">Partial qty only</Label>
              </div>
            </RadioGroup>
            
            {shortPickReason === "partial" && (
              <div className="space-y-2">
                <Label>Available quantity:</Label>
                <Input 
                  type="number" 
                  inputMode="numeric"
                  value={shortPickQty} 
                  onChange={(e) => setShortPickQty(e.target.value)}
                  max={(shortPickListIndex !== null ? activeWork?.items[shortPickListIndex]?.qty : currentItem?.qty) || 0}
                  min={0}
                  className="w-full h-14 text-xl text-center font-bold"
                />
              </div>
            )}
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button 
              className="w-full h-14 min-h-[44px] text-lg bg-amber-600 hover:bg-amber-700"
              onClick={handleShortPick}
              disabled={!shortPickReason}
            >
              Report Short Pick
            </Button>
            <Button 
              variant="ghost" 
              className="w-full h-12 min-h-[44px]"
              onClick={() => setShortPickOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Completed Order Detail Dialog - Mobile Optimized */}
      <Dialog open={!!selectedCompletedOrder} onOpenChange={(open) => !open && setSelectedCompletedOrder(null)}>
        <DialogContent className="w-[95vw] max-w-md max-h-[90vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="p-3 pb-2 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              {selectedCompletedOrder?.orderNumber}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {selectedCompletedOrder?.customer}
            </DialogDescription>
          </DialogHeader>
          
          {selectedCompletedOrder && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              <div className="bg-muted/50 rounded-lg p-2.5 space-y-1.5 text-xs">
                {selectedCompletedOrder.pickerName && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Picked by</span>
                    <span className="font-medium">{selectedCompletedOrder.pickerName}</span>
                  </div>
                )}
                {selectedCompletedOrder.completedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Completed</span>
                    <span className="font-medium">
                      {new Date(selectedCompletedOrder.completedAt).toLocaleString()}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Items</span>
                  <span className="font-medium">{selectedCompletedOrder.items.length} items</span>
                </div>
              </div>
              
              <div className="space-y-1.5">
                <h4 className="text-xs font-medium text-muted-foreground">Picked Items</h4>
                {selectedCompletedOrder.items.map((item) => (
                  <div 
                    key={item.id} 
                    className="flex items-center gap-2 p-2 border rounded-lg bg-background"
                  >
                    {item.image ? (
                      <img 
                        src={item.image} 
                        alt={item.name}
                        className="h-8 w-8 rounded object-cover shrink-0"
                      />
                    ) : (
                      <div className="h-8 w-8 rounded bg-muted flex items-center justify-center shrink-0">
                        <Package size={14} className="text-muted-foreground" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{item.name}</div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {item.sku} • {item.location}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={cn(
                        "text-xs font-medium",
                        item.status === "completed" ? "text-emerald-600" : "text-amber-600"
                      )}>
                        {item.picked}/{item.qty}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {item.status === "short" ? "Short" : "Picked"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          <div className="p-3 pt-2 border-t shrink-0">
            <Button 
              variant="outline" 
              className="w-full h-10"
              onClick={() => setSelectedCompletedOrder(null)}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Bin Count Dialog — shown after pick when inventory needs verification */}
      <Dialog open={binCountOpen} onOpenChange={(open) => { if (!open) { setBinCountOpen(false); setBinCountContext(null); } }}>
        <DialogContent className="w-[95vw] max-w-sm p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2">
              {binCountContext && !binCountContext.deducted ? (
                <>
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                  Inventory Discrepancy
                </>
              ) : binCountContext?.replen.stockout ? (
                <>
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                  Out of Stock
                </>
              ) : (
                <>
                  <PackageCheck className="h-5 w-5 text-blue-600" />
                  Bin Count
                </>
              )}
            </DialogTitle>
            {binCountContext && (
              <DialogDescription className="text-center space-y-1">
                <div>
                  <span className="font-mono font-medium">{binCountContext.sku}</span>
                  {binCountContext.locationCode && (
                    <span className="ml-2 text-muted-foreground">@ {binCountContext.locationCode}</span>
                  )}
                </div>
                <div className="text-xs">
                  Expected: <span className="font-medium">{binCountContext.systemQtyAfter}</span>
                  {binCountContext.replen.autoExecuted && <span className="text-blue-600"> (after pick + replen)</span>}
                  {!binCountContext.replen.autoExecuted && <span className="text-muted-foreground"> (after pick)</span>}
                </div>
                {!binCountContext.deducted && (
                  <div className="text-xs text-amber-600 font-medium">
                    System inventory may be out of sync
                  </div>
                )}
                {binCountContext.replen.autoExecuted && (
                  <div className="text-xs text-blue-600 font-medium">
                    Replenished from reserve
                  </div>
                )}
                {binCountContext.replen.stockout && (
                  <div className="text-xs text-red-600 font-medium">
                    No reserve stock available
                  </div>
                )}
              </DialogDescription>
            )}
          </DialogHeader>

          <div className="py-4 space-y-3">
            <label className="text-sm font-medium">Count what's left in the bin after picking complete</label>
            <Input
              type="number"
              inputMode="numeric"
              value={binCountQty}
              onChange={(e) => setBinCountQty(e.target.value)}
              min={0}
              className="w-full h-14 text-xl text-center font-bold"
              onKeyDown={(e) => {
                if (e.key === "Enter" && binCountQty !== "" && binCountContext?.locationId) {
                  binCountMutation.mutate({
                    sku: binCountContext.sku,
                    locationId: binCountContext.locationId,
                    actualQty: parseInt(binCountQty),
                  });
                }
              }}
            />
          </div>

          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button
              className="w-full h-14 min-h-[44px] text-lg"
              onClick={() => {
                if (binCountContext?.locationId && binCountQty !== "") {
                  binCountMutation.mutate({
                    sku: binCountContext.sku,
                    locationId: binCountContext.locationId,
                    actualQty: parseInt(binCountQty),
                  });
                }
              }}
              disabled={binCountQty === "" || !binCountContext?.locationId || binCountMutation.isPending}
            >
              {binCountMutation.isPending ? "Saving..." : "Confirm Count"}
            </Button>
            {binCountContext?.replen.triggered && !binCountContext.replen.stockout && (
              <Button
                variant="outline"
                className="w-full h-12 min-h-[44px] text-amber-600 border-amber-300"
                onClick={() => {
                  if (binCountContext?.locationId && binCountQty !== "") {
                    skipBinCountMutation.mutate({
                      sku: binCountContext.sku,
                      locationId: binCountContext.locationId,
                      actualQty: parseInt(binCountQty),
                    });
                  }
                }}
                disabled={binCountQty === "" || !binCountContext?.locationId || skipBinCountMutation.isPending}
              >
                {skipBinCountMutation.isPending ? "Skipping..." : "Skip Replen"}
              </Button>
            )}
            <Button
              variant="ghost"
              className="w-full h-10 min-h-[44px] text-xs text-muted-foreground"
              onClick={() => { setBinCountOpen(false); setBinCountContext(null); }}
            >
              Dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CSS for shake animation */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
      `}</style>
    </div>
  );
}
