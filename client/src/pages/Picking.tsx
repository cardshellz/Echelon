import React, { useState, useEffect, useRef } from "react";
import { 
  Scan, 
  CheckCircle2, 
  Box, 
  ArrowRight, 
  AlertTriangle,
  PackageCheck,
  ChevronRight,
  MapPin,
  Package,
  ClipboardList,
  Clock,
  RotateCcw,
  Trophy,
  Zap
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
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

// Initial mock data
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

export default function Picking() {
  // Core state
  const [queue, setQueue] = useState<PickBatch[]>(createInitialQueue);
  const [view, setView] = useState<"queue" | "picking" | "complete">("queue");
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);
  
  // UI state
  const [scanInput, setScanInput] = useState("");
  const [scanStatus, setScanStatus] = useState<"idle" | "success" | "error">("idle");
  const [shortPickOpen, setShortPickOpen] = useState(false);
  const [shortPickReason, setShortPickReason] = useState("");
  const [shortPickQty, setShortPickQty] = useState("0");
  const [multiQtyOpen, setMultiQtyOpen] = useState(false);
  const [pickQty, setPickQty] = useState(1);
  
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Computed values
  const activeBatch = queue.find(b => b.id === activeBatchId);
  const currentItem = activeBatch?.items[currentItemIndex];
  const completedItems = activeBatch?.items.filter(i => i.status === "completed" || i.status === "short").length || 0;
  const totalItems = activeBatch?.items.length || 0;
  const progressPercent = totalItems > 0 ? (completedItems / totalItems) * 100 : 0;
  
  // Focus input when entering pick mode
  useEffect(() => {
    if (view === "picking" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [view, currentItemIndex]);
  
  // Start picking a batch
  const handleStartPicking = (batchId: string) => {
    setQueue(prev => prev.map(b => 
      b.id === batchId ? { ...b, status: "in_progress" as const, assignee: "You" } : b
    ));
    setActiveBatchId(batchId);
    setCurrentItemIndex(0);
    setView("picking");
  };
  
  // Grab next available batch
  const handleGrabNext = () => {
    const nextBatch = queue.find(b => b.status === "ready");
    if (nextBatch) {
      handleStartPicking(nextBatch.id);
    }
  };
  
  // Handle scan input
  const handleScan = (value: string) => {
    setScanInput(value);
    if (!currentItem) return;
    
    const normalizedInput = value.toUpperCase().replace(/-/g, "");
    const normalizedSku = currentItem.sku.toUpperCase().replace(/-/g, "");
    
    if (normalizedInput === normalizedSku) {
      setScanStatus("success");
      
      if (currentItem.qty > 1) {
        // Multi-quantity item - show confirmation dialog
        setTimeout(() => {
          setMultiQtyOpen(true);
          setScanStatus("idle");
          setScanInput("");
        }, 400);
      } else {
        // Single quantity - auto-confirm
        setTimeout(() => {
          confirmPick(1);
        }, 500);
      }
    }
  };
  
  // Confirm pick
  const confirmPick = (qty: number) => {
    if (!activeBatch || !currentItem) return;
    
    setQueue(prev => prev.map(batch => {
      if (batch.id !== activeBatchId) return batch;
      
      const newItems = batch.items.map((item, idx) => {
        if (idx !== currentItemIndex) return item;
        const newPicked = item.picked + qty;
        return {
          ...item,
          picked: newPicked,
          status: newPicked >= item.qty ? "completed" as const : "in_progress" as const
        };
      });
      
      return { ...batch, items: newItems };
    }));
    
    setScanStatus("idle");
    setScanInput("");
    setMultiQtyOpen(false);
    
    // Move to next item or complete
    setTimeout(() => advanceToNext(), 300);
  };
  
  // Short pick
  const handleShortPick = () => {
    if (!activeBatch || !currentItem) return;
    
    const shortQty = parseInt(shortPickQty) || 0;
    
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
    
    setShortPickOpen(false);
    setShortPickReason("");
    setShortPickQty("0");
    
    setTimeout(() => advanceToNext(), 300);
  };
  
  // Advance to next item
  const advanceToNext = () => {
    if (!activeBatch) return;
    
    // Find next pending item
    const nextIndex = activeBatch.items.findIndex((item, idx) => 
      idx > currentItemIndex && (item.status === "pending" || item.status === "in_progress")
    );
    
    if (nextIndex !== -1) {
      setCurrentItemIndex(nextIndex);
    } else {
      // Check if all items are done
      const refreshedBatch = queue.find(b => b.id === activeBatchId);
      const allDone = refreshedBatch?.items.every(i => i.status === "completed" || i.status === "short");
      
      if (allDone) {
        // Complete the batch
        setQueue(prev => prev.map(b => 
          b.id === activeBatchId ? { ...b, status: "completed" as const } : b
        ));
        setView("complete");
      }
    }
  };
  
  // Back to queue
  const handleBackToQueue = () => {
    setView("queue");
    setActiveBatchId(null);
    setCurrentItemIndex(0);
  };
  
  // Reset demo
  const handleResetDemo = () => {
    setQueue(createInitialQueue());
    setView("queue");
    setActiveBatchId(null);
    setCurrentItemIndex(0);
  };

  // ===== RENDER =====
  
  // QUEUE VIEW
  if (view === "queue") {
    const readyBatches = queue.filter(b => b.status === "ready");
    const inProgressBatches = queue.filter(b => b.status === "in_progress");
    const completedBatches = queue.filter(b => b.status === "completed");
    
    return (
      <div className="flex flex-col min-h-full bg-muted/20 overflow-auto">
        <div className="bg-card border-b p-4 md:p-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
            <div>
              <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
                <PackageCheck className="h-6 w-6 text-primary" />
                Picking Queue
              </h1>
              <p className="text-muted-foreground text-sm">
                {readyBatches.length} batches ready • {readyBatches.reduce((acc, b) => acc + b.items.length, 0)} items to pick
              </p>
            </div>
            
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleResetDemo}
                data-testid="button-reset-demo"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset Demo
              </Button>
              <Button 
                onClick={handleGrabNext}
                className="bg-emerald-600 hover:bg-emerald-700"
                disabled={readyBatches.length === 0}
                data-testid="button-grab-next"
              >
                <Zap className="h-4 w-4 mr-2" />
                Grab Next Batch
              </Button>
            </div>
          </div>

          {/* Queue Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-primary">{readyBatches.length}</div>
              <div className="text-xs text-muted-foreground">Ready</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-amber-600">{inProgressBatches.length}</div>
              <div className="text-xs text-muted-foreground">In Progress</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-red-600">{queue.filter(b => b.priority === "rush" && b.status === "ready").length}</div>
              <div className="text-xs text-muted-foreground">Rush</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-emerald-600">{completedBatches.length}</div>
              <div className="text-xs text-muted-foreground">Completed</div>
            </div>
          </div>
        </div>

        {/* Queue List */}
        <div className="p-4 md:p-6 space-y-3">
          {queue.filter(b => b.status !== "completed").map((batch) => (
            <Card 
              key={batch.id} 
              className={cn(
                "cursor-pointer hover:border-primary/50 transition-colors",
                batch.priority === "rush" && "border-l-4 border-l-red-500",
                batch.priority === "high" && "border-l-4 border-l-amber-500",
                batch.status === "in_progress" && "bg-amber-50/50 dark:bg-amber-950/20"
              )}
              onClick={() => batch.status === "ready" ? handleStartPicking(batch.id) : null}
              data-testid={`card-batch-${batch.id}`}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={cn(
                      "h-10 w-10 rounded-lg flex items-center justify-center",
                      batch.status === "in_progress" ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary"
                    )}>
                      {batch.id.startsWith("BATCH") ? <ClipboardList size={20} /> : <Package size={20} />}
                    </div>
                    <div>
                      <div className="font-semibold flex items-center gap-2">
                        {batch.id}
                        {batch.priority === "rush" && <Badge variant="destructive" className="text-[10px] px-1.5 py-0">RUSH</Badge>}
                        {batch.priority === "high" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-50">HIGH</Badge>}
                        {batch.status === "in_progress" && <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-100">IN PROGRESS</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {batch.orders} order{batch.orders > 1 ? "s" : ""} • {batch.items.length} items • Zones: {batch.zones.join(", ")}
                      </div>
                    </div>
                  </div>
                  <div className="text-right flex items-center gap-3">
                    <div>
                      <div className="text-sm text-muted-foreground flex items-center gap-1 justify-end">
                        <Clock size={12} /> {batch.age}
                      </div>
                      {batch.assignee && (
                        <div className="text-xs text-muted-foreground mt-1">{batch.assignee}</div>
                      )}
                    </div>
                    {batch.status === "ready" && (
                      <ChevronRight className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          
          {/* Completed section */}
          {completedBatches.length > 0 && (
            <div className="pt-4">
              <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                Completed Today ({completedBatches.length})
              </h3>
              {completedBatches.map((batch) => (
                <Card key={batch.id} className="bg-muted/30 border-muted opacity-60">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-emerald-100 text-emerald-700">
                          <CheckCircle2 size={20} />
                        </div>
                        <div>
                          <div className="font-semibold flex items-center gap-2">
                            {batch.id}
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-emerald-100 text-emerald-700">DONE</Badge>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {batch.items.length} items picked
                          </div>
                        </div>
                      </div>
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
    return (
      <div className="flex flex-col items-center justify-center min-h-full bg-gradient-to-b from-emerald-50 to-background dark:from-emerald-950/20 p-6">
        <div className="text-center space-y-6 max-w-md">
          <div className="h-24 w-24 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 flex items-center justify-center animate-in zoom-in duration-300">
            <Trophy className="w-12 h-12" />
          </div>
          
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-emerald-700 dark:text-emerald-400">Batch Complete!</h1>
            <p className="text-muted-foreground">
              {activeBatch?.id} has been fully picked and is ready for packing.
            </p>
          </div>
          
          <div className="bg-card border rounded-lg p-4 text-left space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Items Picked</span>
              <span className="font-medium">{activeBatch?.items.filter(i => i.status === "completed").length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Short Picks</span>
              <span className="font-medium text-amber-600">{activeBatch?.items.filter(i => i.status === "short").length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Orders</span>
              <span className="font-medium">{activeBatch?.orders}</span>
            </div>
          </div>
          
          <div className="flex flex-col gap-3 pt-4">
            <Button 
              onClick={handleGrabNext}
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={queue.filter(b => b.status === "ready").length === 0}
              data-testid="button-next-batch"
            >
              <ArrowRight className="h-4 w-4 mr-2" />
              Grab Next Batch
            </Button>
            <Button variant="outline" onClick={handleBackToQueue} data-testid="button-back-queue">
              Back to Queue
            </Button>
          </div>
        </div>
      </div>
    );
  }
  
  // PICKING VIEW
  return (
    <div className="flex flex-col min-h-full bg-muted/20 overflow-auto">
      {/* Header */}
      <div className="bg-card border-b p-4 md:p-6 sticky top-0 z-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <Button variant="ghost" size="sm" onClick={handleBackToQueue} className="mb-2 -ml-2 text-muted-foreground">
              <ChevronRight className="h-4 w-4 mr-1 rotate-180" /> Back to Queue
            </Button>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <PackageCheck className="h-6 w-6 text-primary" />
              {activeBatch?.id}
            </h1>
          </div>
          
          <Badge 
            variant="outline" 
            className={cn(
              "text-xs px-3 py-1",
              activeBatch?.priority === "rush" && "border-red-300 bg-red-50 text-red-700",
              activeBatch?.priority === "high" && "border-amber-300 bg-amber-50 text-amber-700"
            )}
          >
            {activeBatch?.priority === "rush" ? "RUSH ORDER" : activeBatch?.priority === "high" ? "HIGH PRIORITY" : "STANDARD"}
          </Badge>
        </div>

        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm font-medium">
            <span>Progress ({completedItems}/{totalItems} items)</span>
            <span>{Math.round(progressPercent)}%</span>
          </div>
          <Progress value={progressPercent} className="h-3" />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-4 md:p-6 overflow-hidden flex flex-col max-w-4xl mx-auto w-full">
        
        <Tabs defaultValue="current" className="flex-1 flex flex-col">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="current">Current Task</TabsTrigger>
            <TabsTrigger value="list">Full Pick List ({completedItems}/{totalItems})</TabsTrigger>
          </TabsList>

          {/* Current Task */}
          <TabsContent value="current" className="mt-0 flex-1 flex flex-col gap-4">
            {currentItem ? (
              <Card className={cn(
                "flex-1 shadow-md flex flex-col transition-all duration-300",
                scanStatus === "success" && "border-emerald-500 bg-emerald-50/30 dark:bg-emerald-950/20"
              )}>
                <CardHeader className="bg-muted/30 pb-2">
                  <div className="flex justify-between items-start">
                    <div className="flex flex-col items-start gap-1">
                      <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Pick Location</span>
                      <Badge variant="secondary" className="text-xl py-1 px-3 font-mono border-2 border-primary/20 bg-background text-foreground">
                        <MapPin className="w-5 h-5 mr-2 text-primary" /> {currentItem.location}
                      </Badge>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="destructive" className="animate-pulse text-sm px-3 py-1">
                        PICK {currentItem.qty - currentItem.picked} UNIT{currentItem.qty - currentItem.picked > 1 ? "S" : ""}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-medium">Order {currentItem.orderId}</span>
                    </div>
                  </div>
                  
                  {/* Progress dots */}
                  <div className="mt-4 flex items-center gap-1 text-xs text-muted-foreground">
                    {activeBatch?.items.map((item, idx) => (
                      <React.Fragment key={item.id}>
                        <div className={cn(
                          "h-2 w-2 rounded-full transition-colors",
                          item.status === "completed" && "bg-emerald-500",
                          item.status === "short" && "bg-amber-500",
                          idx === currentItemIndex && "bg-primary ring-2 ring-primary/30",
                          item.status === "pending" && idx !== currentItemIndex && "bg-border"
                        )} />
                        {idx < activeBatch.items.length - 1 && (
                          <div className={cn(
                            "h-0.5 w-3",
                            item.status === "completed" || item.status === "short" ? "bg-emerald-500" : "bg-border"
                          )} />
                        )}
                      </React.Fragment>
                    ))}
                    <span className="ml-2">Item {currentItemIndex + 1} of {totalItems}</span>
                  </div>
                </CardHeader>
                
                <CardContent className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-6">
                  <div className="relative">
                    <img 
                      src={currentItem.image} 
                      alt={currentItem.name}
                      className={cn(
                        "w-48 h-48 object-cover rounded-lg border-2 shadow-sm transition-all",
                        scanStatus === "success" ? "border-emerald-500" : "border-muted"
                      )}
                    />
                    <div className={cn(
                      "absolute -bottom-3 -right-3 bg-card border shadow-sm p-2 rounded-full transition-colors",
                      scanStatus === "success" && "bg-emerald-500 border-emerald-500"
                    )}>
                      {scanStatus === "success" ? (
                        <CheckCircle2 className="w-6 h-6 text-white" />
                      ) : (
                        <Scan className="w-6 h-6 text-primary" />
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-1">
                    <h2 className="text-2xl font-bold">{currentItem.sku}</h2>
                    <p className="text-muted-foreground text-lg">{currentItem.name}</p>
                  </div>

                  <div className="w-full max-w-sm space-y-3 mt-4">
                    {scanStatus === "success" ? (
                      <div className="h-12 bg-emerald-100 border-2 border-emerald-500 rounded-md flex items-center justify-center gap-2 text-emerald-700 font-medium animate-in zoom-in-95">
                        <CheckCircle2 className="h-5 w-5" />
                        Scan Confirmed!
                      </div>
                    ) : (
                      <div className="relative">
                        <Scan className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input 
                          ref={inputRef}
                          placeholder="Scan SKU barcode..." 
                          className="pl-10 h-12 text-lg border-primary/30 focus-visible:ring-primary"
                          value={scanInput}
                          onChange={(e) => handleScan(e.target.value)}
                          data-testid="input-scan-sku"
                        />
                      </div>
                    )}
                    
                    <div className="text-xs text-center text-muted-foreground bg-muted/50 rounded-md py-2 px-3">
                      <span className="font-medium text-foreground">Type SKU: {currentItem.sku.replace(/-/g, "")}</span>
                      {(currentItem.qty - currentItem.picked) > 1 && <span> • Multi-qty will prompt for count</span>}
                    </div>
                    
                    <Button 
                      variant="outline"
                      className="w-full h-10 text-sm"
                      onClick={() => currentItem.qty > 1 ? setMultiQtyOpen(true) : confirmPick(1)}
                      data-testid="button-manual-confirm"
                    >
                      Skip Scan - Manually Confirm
                    </Button>
                    
                    <Button 
                      variant="ghost" 
                      className="w-full text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                      onClick={() => setShortPickOpen(true)}
                      data-testid="button-short-pick"
                    >
                      <AlertTriangle className="mr-2 h-4 w-4" />
                      Can't Find / Short Pick
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-muted-foreground">No items remaining</p>
              </div>
            )}
            
            {/* Next up preview */}
            {activeBatch && currentItemIndex < activeBatch.items.length - 1 && (
              <div className="h-20 bg-card border rounded-lg p-3 flex items-center gap-4 opacity-60 hover:opacity-80 transition-opacity">
                <div className="bg-muted h-14 w-14 rounded-md flex items-center justify-center shrink-0 overflow-hidden">
                  <img 
                    src={activeBatch.items[currentItemIndex + 1].image} 
                    alt="Next" 
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-muted-foreground uppercase">Next Up</p>
                  <p className="font-medium truncate">{activeBatch.items[currentItemIndex + 1].sku}</p>
                  <p className="text-sm text-muted-foreground">{activeBatch.items[currentItemIndex + 1].location}</p>
                </div>
                <ChevronRight className="text-muted-foreground" />
              </div>
            )}
          </TabsContent>

          {/* Full List */}
          <TabsContent value="list" className="mt-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-4">
              <div className="space-y-3">
                {activeBatch?.items.map((item, idx) => (
                  <Card 
                    key={item.id} 
                    className={cn(
                      item.status === "completed" && "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200",
                      item.status === "short" && "bg-amber-50/50 dark:bg-amber-950/20 border-amber-200",
                      idx === currentItemIndex && item.status === "pending" && "border-l-4 border-l-primary"
                    )}
                  >
                    <CardContent className="p-4 flex items-center gap-4">
                      <div className="h-14 w-14 bg-white rounded-md border p-1 shrink-0 overflow-hidden">
                        <img src={item.image} alt={item.name} className="w-full h-full object-cover rounded-sm" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-bold text-sm">{item.sku}</span>
                          {item.status === "completed" && (
                            <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200">
                              <CheckCircle2 className="h-3 w-3 mr-1" /> Picked
                            </Badge>
                          )}
                          {item.status === "short" && (
                            <Badge className="bg-amber-100 text-amber-700 border-amber-200">
                              <AlertTriangle className="h-3 w-3 mr-1" /> Short
                            </Badge>
                          )}
                          {item.status === "pending" && (
                            <Badge variant="outline">{item.qty} QTY</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">{item.name}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <MapPin className="h-3 w-3" /> {item.location}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
      
      {/* Multi-Qty Confirm Dialog */}
      <Dialog open={multiQtyOpen} onOpenChange={setMultiQtyOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Quantity</DialogTitle>
            <DialogDescription>
              Pick {currentItem?.qty} units of {currentItem?.sku}?
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            <div className="flex items-center justify-center gap-4">
              <Button 
                variant="outline" 
                size="icon"
                onClick={() => setPickQty(Math.max(1, pickQty - 1))}
              >
                -
              </Button>
              <span className="text-3xl font-bold w-16 text-center">{pickQty}</span>
              <Button 
                variant="outline" 
                size="icon"
                onClick={() => setPickQty(Math.min(currentItem?.qty || 1, pickQty + 1))}
              >
                +
              </Button>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              of {currentItem?.qty} requested
            </p>
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button 
              className="w-full bg-emerald-600 hover:bg-emerald-700"
              onClick={() => confirmPick(pickQty)}
            >
              Confirm {pickQty} Unit{pickQty > 1 ? "s" : ""}
            </Button>
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => { setMultiQtyOpen(false); setPickQty(1); }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Short Pick Dialog */}
      <Dialog open={shortPickOpen} onOpenChange={setShortPickOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="h-5 w-5" />
              Short Pick
            </DialogTitle>
            <DialogDescription>
              Report issue with {currentItem?.sku}
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4 space-y-4">
            <RadioGroup value={shortPickReason} onValueChange={setShortPickReason}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="not_found" id="not_found" />
                <Label htmlFor="not_found">Item not at location</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="damaged" id="damaged" />
                <Label htmlFor="damaged">Item damaged</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="wrong_item" id="wrong_item" />
                <Label htmlFor="wrong_item">Wrong item in bin</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="partial" id="partial" />
                <Label htmlFor="partial">Partial quantity available</Label>
              </div>
            </RadioGroup>
            
            {shortPickReason === "partial" && (
              <div className="space-y-2">
                <Label>How many can you pick?</Label>
                <Input 
                  type="number" 
                  value={shortPickQty} 
                  onChange={(e) => setShortPickQty(e.target.value)}
                  max={currentItem?.qty}
                  min={0}
                />
              </div>
            )}
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button 
              className="w-full bg-amber-600 hover:bg-amber-700"
              onClick={handleShortPick}
              disabled={!shortPickReason}
            >
              Report Short Pick
            </Button>
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => setShortPickOpen(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
