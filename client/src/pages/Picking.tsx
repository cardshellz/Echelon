import React, { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
  Scan, 
  CheckCircle2, 
  ArrowRight, 
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
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/lib/settings";
import type { Order, OrderItem, ItemStatus } from "@shared/schema";

// API response type
interface OrderWithItems extends Order {
  items: OrderItem[];
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

async function releaseOrder(orderId: number): Promise<Order> {
  const res = await fetch(`/api/picking/orders/${orderId}/release`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to release order");
  return res.json();
}

async function updateOrderItem(
  itemId: number, 
  status: ItemStatus, 
  pickedQuantity?: number, 
  shortReason?: string
): Promise<OrderItem> {
  const res = await fetch(`/api/picking/items/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, pickedQuantity, shortReason }),
  });
  if (!res.ok) throw new Error("Failed to update item");
  return res.json();
}

async function markOrderReadyToShip(orderId: number): Promise<Order> {
  const res = await fetch(`/api/picking/orders/${orderId}/ready-to-ship`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to mark ready to ship");
  return res.json();
}

// Helper to calculate order age from createdAt
function getOrderAge(createdAt: Date | string): string {
  const now = new Date();
  const created = new Date(createdAt);
  const diffMs = now.getTime() - created.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return `${hours}h ${mins}m`;
}

// Generate a simple picker ID (in production, this would come from auth)
function getPickerId(): string {
  let pickerId = localStorage.getItem("pickerId");
  if (!pickerId) {
    pickerId = `picker-${Math.random().toString(36).substring(2, 8)}`;
    localStorage.setItem("pickerId", pickerId);
  }
  return pickerId;
}
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
  status: "ready" | "in_progress" | "completed";
  assignee: string | null;
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

// Sound effects
const playSound = (type: "success" | "error" | "complete") => {
  const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  if (type === "success") {
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(1108, audioContext.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
  } else if (type === "error") {
    oscillator.frequency.setValueAtTime(200, audioContext.currentTime);
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } else if (type === "complete") {
    oscillator.frequency.setValueAtTime(523, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(659, audioContext.currentTime + 0.15);
    oscillator.frequency.setValueAtTime(784, audioContext.currentTime + 0.3);
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  }
};

// Haptic feedback
const triggerHaptic = (type: "light" | "medium" | "heavy") => {
  if ("vibrate" in navigator) {
    const patterns = {
      light: [30],
      medium: [50],
      heavy: [100, 30, 100]
    };
    navigator.vibrate(patterns[type]);
  }
};

export default function Picking() {
  // Get picking mode and picker view mode from settings (persisted)
  const { pickingMode, setPickingMode, pickerViewMode, setPickerViewMode } = useSettings();
  const queryClient = useQueryClient();
  const pickerId = getPickerId();
  
  // Fetch orders from API
  const { data: apiOrders = [], isLoading, refetch } = useQuery({
    queryKey: ["picking-queue"],
    queryFn: fetchPickingQueue,
    refetchInterval: 30000, // Refresh every 30s
  });
  
  // Transform API orders to SingleOrder format for UI
  const ordersFromApi: SingleOrder[] = apiOrders.map((order): SingleOrder => ({
    id: String(order.id),
    orderNumber: order.orderNumber,
    customer: order.customerName,
    priority: order.priority as "rush" | "high" | "normal",
    age: getOrderAge(order.createdAt),
    status: order.status === "in_progress" ? "in_progress" : order.status === "completed" ? "completed" : "ready",
    assignee: order.assignedPickerId,
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
    })),
  }));
  
  // Use API data if available, otherwise fall back to mock data
  const hasApiData = ordersFromApi.length > 0 || apiOrders.length === 0;
  
  // Core state - Batch mode (mock data for batch mode still)
  const [queue, setQueue] = useState<PickBatch[]>(createInitialQueue);
  // Core state - Single mode (local copy for active picking session)
  const [localSingleQueue, setLocalSingleQueue] = useState<SingleOrder[]>([]);
  
  // Merge API data with local state - local state takes precedence for in-progress orders
  const singleQueue = pickingMode === "single" && ordersFromApi.length > 0 
    ? ordersFromApi.map(apiOrder => {
        const localOrder = localSingleQueue.find(lo => lo.id === apiOrder.id);
        return localOrder || apiOrder;
      })
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
    mutationFn: ({ orderId }: { orderId: number }) => releaseOrder(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
  });
  
  // Mutation for updating items
  const updateItemMutation = useMutation({
    mutationFn: ({ itemId, status, pickedQuantity, shortReason }: { 
      itemId: number; 
      status: ItemStatus; 
      pickedQuantity?: number; 
      shortReason?: string;
    }) => updateOrderItem(itemId, status, pickedQuantity, shortReason),
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
  
  const [view, setView] = useState<"queue" | "picking" | "complete">("queue");
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  
  // Search, sort, and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"priority" | "items" | "order" | "age">("priority");
  const [activeFilter, setActiveFilter] = useState<"all" | "ready" | "active" | "rush" | "done">("all");
  
  // UI state
  const [scanInput, setScanInput] = useState("");
  const [scanStatus, setScanStatus] = useState<"idle" | "success" | "error">("idle");
  const [shortPickOpen, setShortPickOpen] = useState(false);
  const [shortPickReason, setShortPickReason] = useState("");
  const [shortPickQty, setShortPickQty] = useState("0");
  const [multiQtyOpen, setMultiQtyOpen] = useState(false);
  const [pickQty, setPickQty] = useState(1);
  
  // Scanner mode settings
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [scannerMode, setScannerMode] = useState(false);
  
  const scanInputRef = useRef<HTMLInputElement>(null);
  const focusTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
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
    if (view === "picking" && !shortPickOpen && !multiQtyOpen && scanInputRef.current) {
      scanInputRef.current.focus();
    }
  }, [view, shortPickOpen, multiQtyOpen]);
  
  // Auto-focus on mount and after any interaction
  useEffect(() => {
    if (view === "picking") {
      maintainFocus();
      
      // Set up interval to maintain focus (for scanner devices)
      const interval = setInterval(maintainFocus, 500);
      
      // Also refocus on any click/touch on the document
      const handleInteraction = () => {
        if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
        focusTimeoutRef.current = setTimeout(maintainFocus, 100);
      };
      
      document.addEventListener("click", handleInteraction);
      document.addEventListener("touchend", handleInteraction);
      
      return () => {
        clearInterval(interval);
        document.removeEventListener("click", handleInteraction);
        document.removeEventListener("touchend", handleInteraction);
        if (focusTimeoutRef.current) clearTimeout(focusTimeoutRef.current);
      };
    }
  }, [view, maintainFocus]);
  
  // Refocus after dialogs close
  useEffect(() => {
    if (!shortPickOpen && !multiQtyOpen) {
      setTimeout(maintainFocus, 100);
    }
  }, [shortPickOpen, multiQtyOpen, maintainFocus]);
  
  // Prevent other inputs from stealing focus in picking mode
  useEffect(() => {
    if (view === "picking") {
      const handleFocusIn = (e: FocusEvent) => {
        const target = e.target as HTMLElement;
        if (target !== scanInputRef.current && target.tagName === "INPUT") {
          e.preventDefault();
          maintainFocus();
        }
      };
      
      document.addEventListener("focusin", handleFocusIn);
      return () => document.removeEventListener("focusin", handleFocusIn);
    }
  }, [view, maintainFocus]);
  
  // Handle keyboard Enter for scanner (many scanners send Enter after barcode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && view === "picking" && scanInput.length > 0) {
        e.preventDefault();
      }
    };
    
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [view, scanInput]);
  
  // Claim error state
  const [claimError, setClaimError] = useState<string | null>(null);
  
  // Start picking a batch or order
  const handleStartPicking = async (id: string) => {
    setClaimError(null);
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(b => 
        b.id === id ? { ...b, status: "in_progress" as const, assignee: "You" } : b
      ));
      setActiveBatchId(id);
      setCurrentItemIndex(0);
      setView("picking");
      triggerHaptic("medium");
    } else {
      // For single mode, claim the order via API if it's a real order (numeric id)
      const numericId = parseInt(id);
      const isRealOrder = !isNaN(numericId) && ordersFromApi.some(o => o.id === id);
      
      if (isRealOrder) {
        try {
          await claimMutation.mutateAsync({ orderId: numericId });
          // Success - proceed to picking
          setSingleQueue(prev => prev.map(o => 
            o.id === id ? { ...o, status: "in_progress" as const, assignee: "You" } : o
          ));
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
          if (soundEnabled) playSound("error");
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
  
  // Grab next available batch or order
  const handleGrabNext = () => {
    if (pickingMode === "batch") {
      const nextBatch = queue.find(b => b.status === "ready");
      if (nextBatch) {
        handleStartPicking(nextBatch.id);
      }
    } else {
      const nextOrder = singleQueue.find(o => o.status === "ready");
      if (nextOrder) {
        handleStartPicking(nextOrder.id);
      }
    }
  };
  
  // Handle scan input
  const handleScan = (value: string) => {
    setScanInput(value);
    if (!currentItem) return;
    
    const normalizedInput = value.toUpperCase().replace(/-/g, "").trim();
    const normalizedSku = currentItem.sku.toUpperCase().replace(/-/g, "");
    
    // Check for match
    if (normalizedInput === normalizedSku) {
      setScanStatus("success");
      if (soundEnabled) playSound("success");
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
      if (soundEnabled) playSound("error");
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
    
    // Sync with API if this is a real order item
    const isRealItem = !isNaN(currentItem.id) && ordersFromApi.length > 0;
    if (isRealItem && pickingMode === "single") {
      updateItemMutation.mutate({ 
        itemId: currentItem.id, 
        status: newStatus, 
        pickedQuantity: newPicked 
      });
    }
    
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
        
        return { ...order, items: newItems };
      }));
    }
    
    setScanStatus("idle");
    setScanInput("");
    setMultiQtyOpen(false);
    setPickQty(1);
    
    setTimeout(() => {
      advanceToNext();
      maintainFocus();
    }, 300);
  };
  
  // Short pick
  const handleShortPick = () => {
    if (!activeWork || !currentItem) return;
    
    const shortQty = parseInt(shortPickQty) || 0;
    
    // Sync with API if this is a real order item
    const isRealItem = !isNaN(currentItem.id) && ordersFromApi.length > 0;
    if (isRealItem && pickingMode === "single") {
      updateItemMutation.mutate({ 
        itemId: currentItem.id, 
        status: "short" as ItemStatus, 
        pickedQuantity: shortQty,
        shortReason: shortPickReason || undefined
      });
    }
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((item, idx) => {
          if (idx !== currentItemIndex) return item;
          return {
            ...item,
            picked: shortQty,
            status: "short" as const
          };
        });
        
        return { ...batch, items: newItems };
      }));
    } else {
      setSingleQueue(prev => prev.map(order => {
        if (order.id !== activeOrderId) return order;
        
        const newItems = order.items.map((item, idx) => {
          if (idx !== currentItemIndex) return item;
          return {
            ...item,
            picked: shortQty,
            status: "short" as const
          };
        });
        
        return { ...order, items: newItems };
      }));
    }
    
    if (soundEnabled) playSound("error");
    triggerHaptic("medium");
    
    setShortPickOpen(false);
    setShortPickReason("");
    setShortPickQty("0");
    
    setTimeout(() => {
      advanceToNext();
      maintainFocus();
    }, 300);
  };
  
  // Handle list view scan - finds matching item and picks it
  const handleListScan = (value: string) => {
    setScanInput(value);
    if (!activeWork) return;
    
    const normalizedInput = value.toUpperCase().replace(/-/g, "").trim();
    
    // Find matching unpicked item
    const matchingIndex = activeWork.items.findIndex(item => {
      if (item.status === "completed" || item.status === "short") return false;
      const normalizedSku = item.sku.toUpperCase().replace(/-/g, "");
      return normalizedInput === normalizedSku;
    });
    
    if (matchingIndex !== -1) {
      const item = activeWork.items[matchingIndex];
      setScanStatus("success");
      if (soundEnabled) playSound("success");
      triggerHaptic("medium");
      
      // Pick the item
      setTimeout(() => {
        handleListItemPickDirect(matchingIndex, item.qty);
        setScanStatus("idle");
        setScanInput("");
      }, 400);
    } else if (normalizedInput.length >= 5) {
      // Check if it's a wrong barcode (not matching any pending item)
      const anyMatch = activeWork.items.some(item => {
        const normalizedSku = item.sku.toUpperCase().replace(/-/g, "");
        return normalizedInput === normalizedSku;
      });
      
      if (!anyMatch) {
        setScanStatus("error");
        if (soundEnabled) playSound("error");
        triggerHaptic("heavy");
        
        setTimeout(() => {
          setScanStatus("idle");
          setScanInput("");
          maintainFocus();
        }, 1000);
      }
    }
  };
  
  // Handle picking an item directly from list view by index
  const handleListItemPickDirect = (idx: number, qty: number) => {
    if (!activeWork) return;
    
    if (pickingMode === "batch") {
      setQueue(prev => prev.map(batch => {
        if (batch.id !== activeBatchId) return batch;
        
        const newItems = batch.items.map((item, i) => {
          if (i !== idx) return item;
          return {
            ...item,
            picked: qty,
            status: "completed" as const
          };
        });
        
        return { ...batch, items: newItems };
      }));
    } else {
      setSingleQueue(prev => prev.map(order => {
        if (order.id !== activeOrderId) return order;
        
        const newItems = order.items.map((item, i) => {
          if (i !== idx) return item;
          return {
            ...item,
            picked: qty,
            status: "completed" as const
          };
        });
        
        return { ...order, items: newItems };
      }));
    }
  };
  
  // Handle clicking pick button on list item
  const handleListItemPick = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;
    
    if (soundEnabled) playSound("success");
    triggerHaptic("medium");
    handleListItemPickDirect(idx, item.qty);
  };
  
  // Handle clicking short pick button on list item
  const handleListItemShort = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;
    
    if (soundEnabled) playSound("error");
    triggerHaptic("medium");
    
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
      setSingleQueue(prev => prev.map(order => {
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
      }));
    }
  };
  
  // Check if all items are done and complete the work (used by list view)
  const checkAndCompleteWork = () => {
    // Re-fetch current state to check completion
    const currentWork = pickingMode === "batch"
      ? queue.find(b => b.id === activeBatchId)
      : singleQueue.find(o => o.id === activeOrderId);
    
    if (!currentWork) return;
    
    const allDone = currentWork.items.every(i => i.status === "completed" || i.status === "short");
    
    if (allDone) {
      if (pickingMode === "batch") {
        setQueue(prev => prev.map(b =>
          b.id === activeBatchId ? { ...b, status: "completed" as const } : b
        ));
      } else {
        setSingleQueue(prev => prev.map(o =>
          o.id === activeOrderId ? { ...o, status: "completed" as const } : o
        ));
      }
      if (soundEnabled) playSound("complete");
      triggerHaptic("heavy");
      setView("complete");
    }
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
        // All items done
        if (pickingMode === "batch") {
          setQueue(prev => prev.map(b => 
            b.id === activeBatchId ? { ...b, status: "completed" as const } : b
          ));
        } else {
          setSingleQueue(prev => prev.map(o => 
            o.id === activeOrderId ? { ...o, status: "completed" as const } : o
          ));
        }
        if (soundEnabled) playSound("complete");
        triggerHaptic("heavy");
        setView("complete");
      }
    }
  };
  
  // Back to queue
  const handleBackToQueue = async () => {
    // Release the order if we're picking a real order (from API)
    // BUT only if the picker hasn't started picking anything yet
    if (activeOrderId && pickingMode === "single") {
      const numericId = parseInt(activeOrderId);
      // Compare as numbers - ordersFromApi has numeric IDs
      const isRealOrder = !isNaN(numericId) && ordersFromApi.some(o => o.id === String(numericId));
      
      if (isRealOrder) {
        // Check if any items have been picked
        const activeOrder = singleQueue.find(o => o.id === activeOrderId);
        const hasPickedItems = activeOrder?.items.some(item => item.picked > 0 || item.status === "completed" || item.status === "short");
        
        if (!hasPickedItems) {
          // No items picked yet - release the order so another picker can grab it
          try {
            await releaseMutation.mutateAsync({ orderId: numericId });
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

  // ===== RENDER =====
  
  // QUEUE VIEW
  if (view === "queue") {
    // Use different data based on picking mode
    const readyItems = pickingMode === "batch" 
      ? queue.filter(b => b.status === "ready")
      : singleQueue.filter(o => o.status === "ready");
    const inProgressItems = pickingMode === "batch"
      ? queue.filter(b => b.status === "in_progress")
      : singleQueue.filter(o => o.status === "in_progress");
    const completedItems = pickingMode === "batch"
      ? queue.filter(b => b.status === "completed")
      : singleQueue.filter(o => o.status === "completed");
    const totalItemsToPick = readyItems.reduce((acc, item) => acc + item.items.length, 0);
    
    // Filtered and sorted queue
    const filteredQueue = (pickingMode === "batch" ? queue : singleQueue).filter(item => {
      // Apply status filter
      if (activeFilter === "ready" && item.status !== "ready") return false;
      if (activeFilter === "active" && item.status !== "in_progress") return false;
      if (activeFilter === "done" && item.status !== "completed") return false;
      if (activeFilter === "rush" && item.priority !== "rush") return false;
      
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
    
    // Sort the filtered queue
    const sortedQueue = [...filteredQueue].sort((a, b) => {
      switch (sortBy) {
        case "priority": {
          const priorityOrder = { rush: 0, high: 1, normal: 2 };
          return priorityOrder[a.priority] - priorityOrder[b.priority];
        }
        case "items":
          return b.items.length - a.items.length;
        case "order":
          const aNum = "orderNumber" in a ? (a as SingleOrder).orderNumber || a.id : a.id;
          const bNum = "orderNumber" in b ? (b as SingleOrder).orderNumber || b.id : b.id;
          return aNum.localeCompare(bNum);
        case "age":
          return a.age.localeCompare(b.age);
        default:
          return 0;
      }
    });
    
    return (
      <div className="flex flex-col min-h-full bg-muted/20 overflow-auto">
        <div className="bg-card border-b p-4 md:p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
                <PackageCheck className="h-6 w-6 text-primary" />
                Picking Queue
                <Badge variant="outline" className={cn(
                  "text-xs ml-2",
                  pickingMode === "batch" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-purple-50 text-purple-700 border-purple-200"
                )}>
                  {pickingMode === "batch" ? <Layers className="h-3 w-3 mr-1" /> : <Package className="h-3 w-3 mr-1" />}
                  {pickingMode === "batch" ? "Batch Mode" : "Single Order"}
                </Badge>
              </h1>
              <p className="text-muted-foreground text-sm">
                {readyItems.length} {pickingMode === "batch" ? "batches" : "orders"} ready • {totalItemsToPick} items to pick
              </p>
            </div>
            
            <div className="flex items-center gap-2 flex-wrap">
              {/* Picking Mode Toggle */}
              <div className="flex items-center rounded-lg border bg-muted/50 p-1">
                <Button
                  variant={pickingMode === "batch" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setPickingMode("batch")}
                  className={cn(
                    "gap-1.5",
                    pickingMode === "batch" && "bg-primary shadow-sm"
                  )}
                  data-testid="button-batch-mode"
                >
                  <Layers className="h-4 w-4" />
                  Batch
                </Button>
                <Button
                  variant={pickingMode === "single" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setPickingMode("single")}
                  className={cn(
                    "gap-1.5",
                    pickingMode === "single" && "bg-primary shadow-sm"
                  )}
                  data-testid="button-single-mode"
                >
                  <Package className="h-4 w-4" />
                  Single
                </Button>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setScannerMode(!scannerMode)}
                className={cn(scannerMode && "bg-primary text-primary-foreground")}
                title="Scanner Mode"
              >
                <Smartphone className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={toggleFullscreen}
                title="Fullscreen"
              >
                <Maximize className="h-4 w-4" />
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleRefreshQueue}
                disabled={isLoading}
                data-testid="button-refresh-queue"
              >
                <RefreshCw className={cn("h-4 w-4 mr-2", isLoading && "animate-spin")} />
                Refresh
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleSyncOrders}
                disabled={isSyncing}
                data-testid="button-sync-orders"
              >
                <CloudDownload className={cn("h-4 w-4 mr-2", isSyncing && "animate-bounce")} />
                {isSyncing ? "Syncing..." : "Sync Shopify"}
              </Button>
              {ordersFromApi.length === 0 && (
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={handleResetDemo}
                  data-testid="button-reset-demo"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Demo
                </Button>
              )}
              <Button 
                onClick={handleGrabNext}
                className="bg-emerald-600 hover:bg-emerald-700 h-12 px-6 text-base"
                disabled={readyItems.length === 0}
                data-testid="button-grab-next"
              >
                <Zap className="h-5 w-5 mr-2" />
                Grab Next
              </Button>
            </div>
          </div>

          {/* Claim Error Alert */}
          {claimError && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{claimError}</span>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={() => setClaimError(null)}
                className="ml-auto h-6 px-2 text-amber-800 hover:text-amber-900"
              >
                Dismiss
              </Button>
            </div>
          )}

          {/* Queue Stats */}
          <div className="grid grid-cols-4 gap-2 md:gap-3 mt-4">
            <div className="bg-muted/50 rounded-lg p-2 md:p-3 text-center">
              <div className="text-xl md:text-2xl font-bold text-primary">{readyItems.length}</div>
              <div className="text-[10px] md:text-xs text-muted-foreground">Ready</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-2 md:p-3 text-center">
              <div className="text-xl md:text-2xl font-bold text-amber-600">{inProgressItems.length}</div>
              <div className="text-[10px] md:text-xs text-muted-foreground">Active</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-2 md:p-3 text-center">
              <div className="text-xl md:text-2xl font-bold text-red-600">{readyItems.filter(item => item.priority === "rush").length}</div>
              <div className="text-[10px] md:text-xs text-muted-foreground">Rush</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-2 md:p-3 text-center">
              <div className="text-xl md:text-2xl font-bold text-emerald-600">{completedItems.length}</div>
              <div className="text-[10px] md:text-xs text-muted-foreground">Done</div>
            </div>
          </div>
        </div>

        {/* Queue List */}
        <div className="p-3 md:p-6 space-y-2 md:space-y-3">
          {pickingMode === "batch" ? (
            queue.filter(b => b.status !== "completed").map((batch) => (
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
            singleQueue.filter(o => o.status !== "completed").map((order) => (
              <Card 
                key={order.id} 
                className={cn(
                  "cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.99]",
                  order.priority === "rush" && "border-l-4 border-l-red-500",
                  order.priority === "high" && "border-l-4 border-l-amber-500",
                  order.status === "in_progress" && "bg-amber-50/50 dark:bg-amber-950/20"
                )}
                onClick={() => order.status === "ready" ? handleStartPicking(order.id) : null}
                data-testid={`card-order-${order.id}`}
              >
                <CardContent className="p-3 md:p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 md:gap-4">
                      <div className={cn(
                        "h-12 w-12 md:h-10 md:w-10 rounded-lg flex items-center justify-center shrink-0",
                        order.status === "in_progress" ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary"
                      )}>
                        <Package size={24} />
                      </div>
                      <div>
                        <div className="font-semibold flex items-center gap-2 text-base">
                          {order.orderNumber}
                          {order.priority === "rush" && <Badge variant="destructive" className="text-[10px] px-1.5 py-0">RUSH</Badge>}
                          {order.priority === "high" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-50">HIGH</Badge>}
                        </div>
                        <div className="text-sm text-muted-foreground flex items-center gap-1">
                          <User size={12} /> {order.customer} • {order.items.length} items
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex items-center gap-2">
                      <div className="text-sm text-muted-foreground flex items-center gap-1">
                        <Clock size={14} /> {order.age}
                      </div>
                      {order.status === "ready" && (
                        <ChevronRight className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>
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
                <Card key={item.id} className="bg-muted/30 border-muted mb-2">
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-emerald-100 text-emerald-700">
                      <CheckCircle2 size={20} />
                    </div>
                    <div className="flex-1">
                      <span className="font-medium">{item.id}</span>
                      <span className="text-sm text-muted-foreground ml-2">• {item.items.length} items</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
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
              {activeWork?.id} is ready for packing
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
          <Button variant="ghost" size="sm" onClick={handleBackToQueue} className="text-muted-foreground h-8 px-2">
            <ChevronRight className="h-4 w-4 rotate-180" /> Exit
          </Button>
          
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
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="h-8 w-8"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
            <Badge 
              variant="outline" 
              className={cn(
                "text-xs px-2 py-0.5",
                activeWork?.priority === "rush" && "border-red-300 bg-red-50 text-red-700",
                activeWork?.priority === "high" && "border-amber-300 bg-amber-50 text-amber-700"
              )}
            >
              {activeWork?.id}
            </Badge>
          </div>
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
                        ref={scanInputRef}
                        placeholder="Scan barcode..." 
                        className="pl-14 h-14 text-xl font-mono border-2 border-primary/50 focus-visible:ring-primary rounded-xl"
                        value={scanInput}
                        onChange={(e) => handleScan(e.target.value)}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        inputMode="none"
                        data-testid="input-scan-sku"
                      />
                    </div>
                  )}
                  
                  {/* Action Buttons - Large touch targets */}
                  <div className="grid grid-cols-2 gap-2">
                    <Button 
                      variant="outline"
                      className="h-12 text-sm font-medium"
                      onClick={() => currentItem.qty > 1 ? setMultiQtyOpen(true) : confirmPick(1)}
                      data-testid="button-manual-confirm"
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Manual OK
                    </Button>
                    <Button 
                      variant="outline"
                      className="h-12 text-sm font-medium text-amber-600 border-amber-300 hover:bg-amber-50"
                      onClick={() => setShortPickOpen(true)}
                      data-testid="button-short-pick"
                    >
                      <AlertTriangle className="h-4 w-4 mr-2" />
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
          <div className="mb-3">
            <div className="relative">
              <Scan className="absolute left-3 top-1/2 -translate-y-1/2 text-primary h-5 w-5" />
              <Input 
                ref={scanInputRef}
                placeholder="Scan any item barcode..." 
                className="pl-12 h-12 text-lg font-mono border-2 border-primary/50 focus-visible:ring-primary rounded-lg"
                value={scanInput}
                onChange={(e) => handleListScan(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                inputMode="none"
                data-testid="input-scan-sku-list"
              />
            </div>
          </div>
          
          {/* Scrollable item list */}
          <ScrollArea className="flex-1">
            <div className="space-y-2 pb-4">
              {activeWork?.items.map((item, idx) => {
                const remaining = item.qty - item.picked;
                const isCompleted = item.status === "completed" || item.status === "short";
                
                return (
                  <Card 
                    key={item.id} 
                    className={cn(
                      "transition-all duration-200",
                      isCompleted && "opacity-60 bg-muted/30",
                      idx === currentItemIndex && !isCompleted && "border-primary border-2 shadow-md"
                    )}
                    data-testid={`list-item-${item.id}`}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-center gap-3">
                        {/* Status indicator */}
                        <div className={cn(
                          "h-10 w-10 rounded-lg flex items-center justify-center shrink-0",
                          item.status === "completed" && "bg-emerald-100 text-emerald-600",
                          item.status === "short" && "bg-amber-100 text-amber-600",
                          item.status === "pending" && "bg-muted text-muted-foreground",
                          item.status === "in_progress" && "bg-primary/10 text-primary"
                        )}>
                          {item.status === "completed" ? (
                            <CheckCircle2 className="h-5 w-5" />
                          ) : item.status === "short" ? (
                            <AlertTriangle className="h-5 w-5" />
                          ) : (
                            <span className="text-lg font-bold">{remaining}</span>
                          )}
                        </div>
                        
                        {/* Product thumbnail */}
                        {item.image ? (
                          <img 
                            src={item.image} 
                            alt={item.name}
                            className="h-10 w-10 rounded object-cover shrink-0 border"
                          />
                        ) : (
                          <div className="h-10 w-10 rounded bg-muted flex items-center justify-center shrink-0 border">
                            <Package className="h-5 w-5 text-muted-foreground" />
                          </div>
                        )}
                        
                        {/* Item info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-base">{item.sku}</span>
                            {item.status === "completed" && (
                              <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">Done</Badge>
                            )}
                            {item.status === "short" && (
                              <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">Short</Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{item.name}</div>
                        </div>
                        
                        {/* Location */}
                        <div className="text-right shrink-0">
                          <div className="flex items-center gap-1 text-primary font-mono font-bold text-sm">
                            <MapPin className="h-3 w-3" />
                            {item.location}
                          </div>
                          <div className="text-xs text-muted-foreground">Qty: {item.qty}</div>
                        </div>
                        
                        {/* Quick action buttons */}
                        {!isCompleted && (
                          <div className="flex gap-1 shrink-0">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-10 w-10 text-emerald-600 hover:bg-emerald-50"
                              onClick={() => handleListItemPick(idx)}
                              data-testid={`button-pick-${item.id}`}
                            >
                              <CheckCircle2 className="h-5 w-5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-10 w-10 text-amber-600 hover:bg-amber-50"
                              onClick={() => handleListItemShort(idx)}
                              data-testid={`button-short-${item.id}`}
                            >
                              <AlertTriangle className="h-5 w-5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
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
                  if (soundEnabled) playSound("complete");
                  triggerHaptic("heavy");
                  setView("complete");
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
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-center text-xl">Confirm Quantity</DialogTitle>
            <DialogDescription className="text-center">
              How many did you pick?
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-6 space-y-4">
            <div className="flex items-center justify-center gap-6">
              <Button 
                variant="outline" 
                size="icon"
                className="h-14 w-14 text-2xl"
                onClick={() => setPickQty(Math.max(1, pickQty - 1))}
              >
                -
              </Button>
              <span className="text-5xl font-bold w-20 text-center">{pickQty}</span>
              <Button 
                variant="outline" 
                size="icon"
                className="h-14 w-14 text-2xl"
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
              className="w-full h-14 text-lg bg-emerald-600 hover:bg-emerald-700"
              onClick={() => confirmPick(pickQty)}
            >
              Confirm {pickQty}
            </Button>
            <Button 
              variant="ghost" 
              className="w-full h-12"
              onClick={() => { setMultiQtyOpen(false); setPickQty(1); }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Short Pick Dialog */}
      <Dialog open={shortPickOpen} onOpenChange={setShortPickOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Short Pick
            </DialogTitle>
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            <RadioGroup value={shortPickReason} onValueChange={setShortPickReason} className="space-y-3">
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
                  value={shortPickQty} 
                  onChange={(e) => setShortPickQty(e.target.value)}
                  max={currentItem?.qty}
                  min={0}
                  className="h-12 text-lg text-center"
                />
              </div>
            )}
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button 
              className="w-full h-12 bg-amber-600 hover:bg-amber-700"
              onClick={handleShortPick}
              disabled={!shortPickReason}
            >
              Report Short Pick
            </Button>
            <Button 
              variant="ghost" 
              className="w-full h-10"
              onClick={() => setShortPickOpen(false)}
            >
              Cancel
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
