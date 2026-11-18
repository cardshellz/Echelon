import React from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  CloudDownload,
  Layers,
  Package,
  PackageCheck,
  Pause,
  Play,
  Search,
  Trophy,
  Truck,
  Unlock,
  User,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { QueryLoadError } from "@/components/query-load-error";
import { PickCorrections } from "@/features/picking/PickCorrections";
import { cn } from "@/lib/utils";
import PickingHistory from "./PickingHistory";
import {
  PriorityBadges,
  ReleasedPickProgressBadge,
  ReleasedPickProgressNotice,
} from "./PickingBadges";
import {
  getChannelBadgeStyle,
  hasHeldLine,
  mapExceptionOrdersToSingleOrders,
  parseAgeToMinutes,
  shouldShowReleasedPickProgress,
  sortPickingQueueItems,
  type ClaimSource,
  type OrderWithItems,
  type PickBatch,
  type PickingActiveFilter,
  type PickingSortBy,
  type PickingViewState,
  type SingleOrder,
} from "./picking-types-and-helpers";

export function CompletedOrderDetailDialog({
  selectedCompletedOrder,
  setSelectedCompletedOrder,
}: {
  selectedCompletedOrder: SingleOrder | null;
  setSelectedCompletedOrder: (order: SingleOrder | null) => void;
}) {
  return (
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
                    <div
                      className={cn(
                        "text-xs font-medium",
                        item.status === "completed" ? "text-emerald-600" : "text-amber-600",
                      )}
                    >
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
  );
}

export interface PickingQueueViewProps {
  user: { id: string } | null | undefined;
  hasPermission: (resource: any, action: any) => boolean;
  pickingMode: "batch" | "single";
  setPickingMode: (mode: "batch" | "single") => void;
  queue: PickBatch[];
  singleQueue: SingleOrder[];
  channelFilter: string;
  setChannelFilter: (channel: string) => void;
  activeFilter: PickingActiveFilter;
  setActiveFilter: (filter: PickingActiveFilter) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortBy: PickingSortBy;
  setSortBy: (sort: PickingSortBy) => void;
  sortDirection: "asc" | "desc";
  setSortDirection: (dir: "asc" | "desc") => void;
  isSyncing: boolean;
  handleSyncOrders: () => void;
  canResolveExceptions: boolean;
  exceptionOrdersCount: number;
  setView: (view: PickingViewState) => void;
  handleGrabNext: () => void;
  claimError: string | null;
  setClaimError: (err: string | null) => void;
  canManagePickingSettings: boolean;
  fifoEnabled: boolean;
  toggleFifoMutation: { mutate: (enabled: boolean) => void; isPending: boolean };
  queueError: boolean;
  queueFetching: boolean;
  dataUpdatedAt: number;
  isLoading: boolean;
  refetch: () => unknown;
  handleStartPicking: (
    id: string,
    options?: { allowPreservedProgress?: boolean; claimSource?: ClaimSource },
  ) => void;
  pickerId: string;
  isAdminOrLead: boolean;
  canChangePriority: boolean;
  canManageHolds: boolean;
  flashingOrderId: string | null;
  setFlashingOrderId: (id: string | null) => void;
  priorityMutation: { mutate: (vars: { orderId: number; priority: number | "reset" }) => void };
  holdMutation: { mutate: (orderId: number) => void };
  releaseHoldMutation: { mutate: (orderId: number) => void; isPending: boolean };
  releaseLineHoldMutation: { mutate: (vars: { wmsOrderId: number; itemId: number }) => void; isPending: boolean };
  releaseMutation: { isPending: boolean };
  getSubOrderIds: (id: string) => number[];
  canReleaseOrder: (id: string) => boolean;
  handleReleaseOrder: (id: string) => void;
  selectedCompletedOrder: SingleOrder | null;
  setSelectedCompletedOrder: (order: SingleOrder | null) => void;
  toast: (opts: any) => void;
}

export function PickingQueueView({
  user,
  hasPermission,
  pickingMode,
  setPickingMode,
  queue,
  singleQueue,
  channelFilter,
  setChannelFilter,
  activeFilter,
  setActiveFilter,
  searchQuery,
  setSearchQuery,
  sortBy,
  setSortBy,
  sortDirection,
  setSortDirection,
  isSyncing,
  handleSyncOrders,
  canResolveExceptions,
  exceptionOrdersCount,
  setView,
  handleGrabNext,
  claimError,
  setClaimError,
  canManagePickingSettings,
  fifoEnabled,
  toggleFifoMutation,
  queueError,
  queueFetching,
  dataUpdatedAt,
  isLoading,
  refetch,
  handleStartPicking,
  pickerId,
  isAdminOrLead,
  canChangePriority,
  canManageHolds,
  flashingOrderId,
  setFlashingOrderId,
  priorityMutation,
  holdMutation,
  releaseHoldMutation,
  releaseLineHoldMutation,
  releaseMutation,
  getSubOrderIds,
  canReleaseOrder,
  handleReleaseOrder,
  selectedCompletedOrder,
  setSelectedCompletedOrder,
  toast,
}: PickingQueueViewProps) {
  const channelMatch = (item: any): boolean => {
    if (channelFilter === "all") return true;
    return item.channelProvider === channelFilter;
  };
  const readyItems = (pickingMode === "batch"
    ? queue.filter(b => b.status === "ready")
    : singleQueue.filter(o => o.status === "ready" && !o.onHold)
  ).filter(channelMatch);
  const inProgressItems = (pickingMode === "batch"
    ? queue.filter(b => b.status === "in_progress")
    : singleQueue.filter(o => o.status === "in_progress")
  ).filter(channelMatch);
  const completedItems = (pickingMode === "batch"
    ? queue.filter(b => b.status === "completed")
    : singleQueue.filter(o => o.status === "completed")
  ).filter(channelMatch);
  // An order counts as held when the whole order is held OR any line is
  // held. A line hold does not set the order flag, and without this such an
  // order shows in neither Ready (nothing pickable) nor Hold — it vanishes.
  const holdItems = pickingMode === "single"
    ? singleQueue.filter(o => o.onHold || hasHeldLine(o))
    : [];
  const combinedItems = pickingMode === "single"
    ? singleQueue.filter(o => o.isCombinedGroup && o.status !== "completed")
    : [];
  const totalItemsToPick = readyItems.reduce((acc, item) => acc + item.items.length, 0);

  // Filtered and sorted queue
  const filteredQueue = (pickingMode === "batch" ? queue : singleQueue).filter(channelMatch).filter(item => {
    // History renders its own server-paged read model, never action cards.
    if (activeFilter === "done" || item.status === "completed") return false;

    // By default, hide held items unless filtering for "hold". Line-level
    // holds count too: the order has no pickable work left.
    const itemOnHold = ("onHold" in item && item.onHold) || hasHeldLine(item);
    if (activeFilter !== "hold" && itemOnHold) return false;

    // Apply status filter
    if (activeFilter === "ready" && (item.status !== "ready" || itemOnHold)) return false;
    if (activeFilter === "active" && item.status !== "in_progress") return false;
    if (activeFilter === "rush" && item.priority < 9999) return false;
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

  const sortedQueue = sortPickingQueueItems(filteredQueue, sortBy, sortDirection);

  return (
    <>
      {/* Queue view only: above an open order it pushed the items to pick off
          screen once the gun scrolled to them (2026-10-18). */}
      {user && hasPermission("picking", "view") && (
        <PickCorrections
          userId={user.id}
          canPerform={hasPermission("picking", "perform")}
          canOverride={hasPermission("picking", "release_any")}
        />
      )}
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
              {/* Channel Filter */}
              <select
                aria-label="Picking channel"
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value)}
                className="h-8 text-xs rounded-md border bg-background px-2"
              >
                <option value="all">All</option>
                <option value="shopify">Shopify</option>
                <option value="ebay">eBay</option>
              </select>
              {/* Mode Toggle - Compact */}
              <div className="flex items-center rounded-md border bg-muted/50 p-0.5">
                <Button
                  variant={pickingMode === "batch" ? "default" : "ghost"}
                  size="sm"
                  disabled={queue.length === 0}
                  title={queue.length === 0 ? "No active pick batches" : "Batch picking mode"}
                  onClick={() => setPickingMode("batch")}
                  className={cn(
                    "h-7 px-2 text-xs",
                    pickingMode === "batch" && "bg-primary shadow-sm",
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
                    pickingMode === "single" && "bg-primary shadow-sm",
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
              {canResolveExceptions && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 min-h-[40px] min-w-[40px] relative"
                  onClick={() => setView("exceptions")}
                  title="Exceptions"
                  data-testid="button-exceptions"
                >
                  <AlertTriangle className="h-5 w-5" />
                  {exceptionOrdersCount > 0 && (
                    <Badge variant="destructive" className="absolute -top-1.5 -right-1.5 h-5 w-5 p-0 flex items-center justify-center text-[10px]">
                      {exceptionOrdersCount}
                    </Badge>
                  )}
                </Button>
              )}

              {/* Grab Next - Primary Action */}
              {activeFilter !== "done" && (
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
              )}
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
                  : "bg-muted/60 text-muted-foreground hover:bg-muted",
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
                  : "bg-muted/60 text-muted-foreground hover:bg-muted",
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
                  : "bg-muted/60 text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setActiveFilter(activeFilter === "rush" ? "all" : "rush")}
              data-testid="filter-rush"
            >
              <span className="font-bold">{readyItems.filter(item => item.priority >= 9999).length}</span> Rush
            </button>
            {holdItems.length > 0 && (
              <button
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-full text-sm font-medium whitespace-nowrap transition-colors",
                  activeFilter === "hold"
                    ? "bg-slate-500 text-white"
                    : "bg-muted/60 text-muted-foreground hover:bg-muted",
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
                    : "bg-muted/60 text-muted-foreground hover:bg-muted",
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
                  : "bg-muted/60 text-muted-foreground hover:bg-muted",
              )}
              onClick={() => setActiveFilter(activeFilter === "done" ? "all" : "done")}
              data-testid="filter-done"
            >
              History
            </button>
          </div>
        </div>

        {/* Queue Routing Override (Admins/Leads) */}
        {canManagePickingSettings && activeFilter !== "done" && (
          <div className="px-3 py-2 bg-amber-50/50 border-b flex justify-between items-center transition-all duration-300">
            <div className="text-xs text-amber-800">
              <span className="font-semibold block sm:inline">Warehouse Routing Mode:</span>
              <span className="opacity-80 sm:ml-1 block sm:inline">
                {fifoEnabled
                  ? "Strict FIFO (Oldest First). Base SLAs are ignored."
                  : "Smart SLA Priority (Based on rules)."}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="fifo-mode" className="text-xs font-semibold cursor-pointer shrink-0">Global FIFO</Label>
              <Switch
                id="fifo-mode"
                checked={fifoEnabled}
                onCheckedChange={(checked) => toggleFifoMutation.mutate(checked)}
                disabled={toggleFifoMutation.isPending}
                className="scale-90 data-[state=checked]:bg-amber-600"
              />
            </div>
          </div>
        )}

        {/* Search and Sort - Mobile responsive */}
        <div className="px-3 py-2 bg-muted/30 border-b">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search orders, SKUs..."
                value={searchQuery}
                maxLength={200}
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
              {activeFilter !== "done" && (
                <>
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
                </>
              )}
              {(searchQuery || activeFilter !== "all") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 min-h-[44px] px-3 text-sm shrink-0"
                  onClick={() => {
                    setSearchQuery("");
                    if (activeFilter !== "done") setActiveFilter("all");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Queue List */}
        <div className="p-3 md:p-6 space-y-3">
          {activeFilter === "done" ? (
            <PickingHistory search={searchQuery} provider={channelFilter} />
          ) : (
            <>
              {queueError && (
                <QueryLoadError
                  subject="the picking queue"
                  retry={() => void refetch()}
                  refreshing={queueFetching}
                  stale={dataUpdatedAt > 0}
                />
              )}
              {isLoading && <p role="status">Loading the picking queue…</p>}
              {pickingMode === "batch" ? (
                (sortedQueue as PickBatch[]).map((batch) => (
                  <Card
                    key={batch.id}
                    className={cn(
                      "cursor-pointer hover:border-primary/50 transition-colors active:scale-[0.99]",
                      batch.priority >= 9999 && "border-l-4 border-l-red-500",
                      batch.priority >= 300 && batch.priority < 9999 && "border-l-4 border-l-orange-500",
                      batch.status === "in_progress" && "bg-amber-50/50 dark:bg-amber-950/20",
                    )}
                    onClick={() => (batch.status === "ready" ? handleStartPicking(batch.id) : null)}
                    data-testid={`card-batch-${batch.id}`}
                  >
                    <CardContent className="p-3 md:p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 md:gap-4">
                          <div
                            className={cn(
                              "h-12 w-12 md:h-10 md:w-10 rounded-lg flex items-center justify-center shrink-0",
                              batch.status === "in_progress" ? "bg-amber-100 text-amber-700" : "bg-primary/10 text-primary",
                            )}
                          >
                            <ClipboardList size={24} />
                          </div>
                          <div>
                            <div className="font-semibold flex items-center gap-2 text-base">
                              {batch.id}
                              {batch.priority >= 9999 && (
                                <Badge variant="destructive" className="text-[10px] px-1.5 py-0">🔼 BUMPED</Badge>
                              )}
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
                (sortedQueue as SingleOrder[]).map((order, queueIndex) => (
                  <Card
                    key={order.id}
                    data-queue-rank={queueIndex + 1}
                    className={cn(
                      "cursor-pointer hover:border-primary/50 transition-all active:scale-[0.99]",
                      order.isCombinedGroup && "border-l-4 border-l-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/20",
                      !order.isCombinedGroup && order.priority >= 9999 && "border-l-4 border-l-red-500",
                      !order.isCombinedGroup && order.priority < 9999 && order.shippingServiceLevel === "overnight" && "border-l-4 border-l-red-500",
                      !order.isCombinedGroup && order.priority < 9999 && order.shippingServiceLevel === "expedited" && "border-l-4 border-l-amber-500",
                      !order.isCombinedGroup && order.priority < 9999 && (!order.shippingServiceLevel || order.shippingServiceLevel === "standard") && order.memberPlanName && order.memberPlanColor && "border-l-4",
                      order.status === "in_progress" && "bg-amber-50/50 dark:bg-amber-950/20",
                      shouldShowReleasedPickProgress(order) && "bg-amber-50/40 dark:bg-amber-950/20",
                      order.onHold && "opacity-60 bg-slate-100 dark:bg-slate-800/40",
                      flashingOrderId === order.id && "animate-pulse ring-2 ring-amber-400 bg-amber-50 dark:bg-amber-900/30",
                    )}
                    style={
                      !order.isCombinedGroup &&
                      order.priority < 9999 &&
                      (!order.shippingServiceLevel || order.shippingServiceLevel === "standard") &&
                      order.memberPlanName &&
                      order.memberPlanColor &&
                      order.memberPlanName.toLowerCase() !== ".core" &&
                      order.memberPlanName.toLowerCase() !== "core"
                        ? { borderLeftColor: order.memberPlanColor }
                        : undefined
                    }
                    onClick={() => {
                      console.log("Card clicked:", order.id, "status:", order.status, "onHold:", order.onHold, "assignee:", order.assignee);
                      if (order.status === "ready" && !order.onHold) {
                        if (shouldShowReleasedPickProgress(order)) {
                          toast({
                            title: "Pick progress preserved",
                            description: "Use Resume to continue this partially picked order.",
                            variant: "default",
                          });
                          return;
                        }
                        handleStartPicking(order.id, { claimSource: "card_click" });
                      } else if (order.status === "completed") {
                        console.log("Opening completed order dialog:", order.orderNumber, order);
                        toast({ title: "Opening order details", description: order.orderNumber });
                        setSelectedCompletedOrder(order);
                      } else if (order.status === "in_progress") {
                        const isMyOrder = order.assignee === pickerId || !order.assignee;
                        if (isMyOrder) {
                          handleStartPicking(order.id, { claimSource: "active_resume" });
                        } else if (canReleaseOrder(order.id)) {
                          toast({
                            title: "Order in progress",
                            description: `This order is being picked by ${order.pickerName || "another user"}. Use Release picking assignment to make it available to another picker.`,
                            variant: "default",
                          });
                        } else {
                          toast({
                            title: "Order unavailable",
                            description: `This order is being picked by ${order.pickerName || "another user"}`,
                            variant: "destructive",
                          });
                        }
                      }
                    }}
                    data-testid={`card-order-${order.id}`}
                  >
                    <CardContent className="p-3 md:p-4">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-3">
                          {/* Rail: rank (always) + lines + units stacked */}
                          <div
                            className={cn(
                              "min-w-[58px] rounded-lg flex flex-col items-center justify-center shrink-0 text-center py-2 px-1.5 border",
                              order.onHold
                                ? "bg-slate-100 border-slate-200 text-slate-500"
                                : order.status === "completed"
                                  ? "bg-emerald-50 border-emerald-100"
                                  : order.status === "in_progress"
                                    ? "bg-amber-50 border-amber-100"
                                    : "bg-slate-50 border-slate-100",
                            )}
                          >
                            {!order.isCombinedGroup && sortBy === "priority" && sortDirection === "desc" && (
                              <div className="flex items-baseline gap-1 leading-none mb-1.5">
                                <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Rank</span>
                                <span
                                  className={cn(
                                    "text-[13px] font-bold font-mono",
                                    queueIndex === 0 ? "text-orange-600" : "text-foreground",
                                  )}
                                >
                                  #{queueIndex + 1}
                                </span>
                              </div>
                            )}
                            <div className="flex flex-col items-center gap-0.5 leading-tight">
                              <div className="text-[10px] text-muted-foreground">
                                <span className="font-bold text-foreground font-mono">{order.items.length}</span> {order.items.length === 1 ? "line" : "lines"}
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                <span className="font-bold text-foreground font-mono">{order.items.reduce((sum, i) => sum + i.qty, 0)}</span> units
                              </div>
                            </div>
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
                                  {order.combinedOrders.map((co) => (
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
                                  <span className="text-xs text-muted-foreground font-normal flex items-center gap-1">
                                    <Clock size={10} /> {order.age}
                                    {order.orderDate && <><span className="opacity-40">·</span><span>{order.orderDate}</span></>}
                                  </span>
                                  <span className="ml-auto inline-flex gap-1 items-center">
                                    <ReleasedPickProgressBadge order={order} />
                                    <PriorityBadges
                                      shippingServiceLevel={order.shippingServiceLevel}
                                      memberPlanName={order.memberPlanName}
                                      memberPlanColor={order.memberPlanColor}
                                      size="xs"
                                    />
                                  </span>
                                </div>
                                <div className="text-xs text-muted-foreground truncate flex items-center gap-2">
                                  <span>{order.customer}</span>
                                  {order.channelProvider && (
                                    <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0", getChannelBadgeStyle(order.channelProvider).className)}>
                                      {getChannelBadgeStyle(order.channelProvider).label}
                                    </Badge>
                                  )}
                                </div>
                                <ReleasedPickProgressNotice order={order} />
                                {/* SLA / Ship-by deadline surfaced to every picker */}
                                {(order as any).channelShipByDate && (
                                  (() => {
                                    const shipBy = new Date((order as any).channelShipByDate);
                                    const now = new Date();
                                    const hoursLeft = (shipBy.getTime() - now.getTime()) / (1000 * 60 * 60);
                                    const urgent = hoursLeft <= 24;
                                    const critical = hoursLeft <= 6;
                                    const overdue = hoursLeft < 0;
                                    return (
                                      <div
                                        className={cn(
                                          "text-[10px] font-semibold flex items-center gap-1 mt-0.5",
                                          overdue
                                            ? "text-red-700"
                                            : critical
                                              ? "text-red-600"
                                              : urgent
                                                ? "text-amber-600"
                                                : "text-muted-foreground",
                                        )}
                                      >
                                        <Clock size={10} />
                                        {overdue ? "OVERDUE" : urgent ? "SHIP BY" : "Ship by"} {shipBy.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                        {urgent && ` · ${Math.round(Math.abs(hoursLeft))}h ${overdue ? "ago" : "left"}`}
                                      </div>
                                    );
                                  })()
                                )}
                                {isAdminOrLead && (
                                  <div className="text-[9px] text-muted-foreground/70 font-mono mt-0.5">
                                    ship={order.shippingServiceLevel || "std"}
                                    {" · "}plan={(order.memberPlanName && order.memberPlanName.toLowerCase() !== ".core" && order.memberPlanName.toLowerCase() !== "core") ? order.memberPlanName : "none"}
                                    {" · "}age={parseAgeToMinutes(order.age)}m
                                    {order.onHold && " · HOLD"}
                                    {order.priority >= 9999 && " · BUMPED"}
                                    {(order as any).sortRank && <>{" · rank="}{(order as any).sortRank}</>}
                                  </div>
                                )}
                                {/* Admin action buttons (Bump / Normal / Hold / Remove hold) — kept inline */}
                                {(canChangePriority || canManageHolds) && (
                                  <div className="text-[10px] text-muted-foreground/70 flex items-center gap-2 mt-0.5">
                                    {canChangePriority && order.status === "ready" && !order.onHold && order.priority < 9999 && (
                                      <button
                                        className="text-red-500 hover:text-red-600 flex items-center gap-0.5 font-medium"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setFlashingOrderId(order.id);
                                          priorityMutation.mutate({ orderId: parseInt(order.id), priority: 9999 });
                                          setTimeout(() => setFlashingOrderId(null), 600);
                                        }}
                                        data-testid={`button-bump-${order.id}`}
                                      >
                                        <Zap className="h-3 w-3" />
                                        Bump
                                      </button>
                                    )}
                                    {canChangePriority && order.status === "ready" && !order.onHold && order.priority >= 9999 && (
                                      <button
                                        className="text-slate-500 hover:text-slate-600 flex items-center gap-0.5 font-medium"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setFlashingOrderId(order.id);
                                          priorityMutation.mutate({ orderId: parseInt(order.id), priority: "reset" });
                                          setTimeout(() => setFlashingOrderId(null), 600);
                                        }}
                                        data-testid={`button-normalize-${order.id}`}
                                      >
                                        <Zap className="h-3 w-3" />
                                        Normal
                                      </button>
                                    )}
                                    {canManageHolds && order.status === "ready" && !order.onHold && (
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
                                    {canManageHolds && (order.onHold || hasHeldLine(order)) && (
                                      <button
                                        className="text-emerald-600 hover:text-emerald-700 flex items-center gap-0.5 font-medium"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setFlashingOrderId(order.id);
                                          if (order.onHold) {
                                            for (const subId of getSubOrderIds(order.id)) {
                                              releaseHoldMutation.mutate(subId);
                                            }
                                          }
                                          // An order can sit under Hold because of a held line alone.
                                          for (const heldItem of order.items.filter((item) => item.onHold)) {
                                            releaseLineHoldMutation.mutate({ wmsOrderId: heldItem.wmsOrderId, itemId: heldItem.id });
                                          }
                                          setTimeout(() => setFlashingOrderId(null), 600);
                                        }}
                                        data-testid={`button-release-hold-${order.id}`}
                                        disabled={releaseHoldMutation.isPending || releaseLineHoldMutation.isPending}
                                        title="Remove the order and line holds. This does not end the picking assignment."
                                      >
                                        <Play className="h-3 w-3" />
                                        Remove hold
                                      </button>
                                    )}
                                  </div>
                                )}
                                {/* Show who is picking this order if in_progress and assigned to another user */}
                                {order.status === "in_progress" && order.assignee && order.assignee !== pickerId && (
                                  <div className="text-[10px] text-amber-600 flex items-center gap-1 mt-0.5">
                                    <User size={10} />
                                    <span>Being picked by {order.pickerName || "another user"}</span>
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
                            {/* Channel pill for combined groups only — singles show it on row 2 */}
                            {order.channelProvider && order.isCombinedGroup && (
                              <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0.5", getChannelBadgeStyle(order.channelProvider).className)} data-testid={`badge-channel-${order.id}`}>
                                {getChannelBadgeStyle(order.channelProvider).label}
                              </Badge>
                            )}
                            {order.onHold && <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 border-slate-400 text-slate-600 bg-slate-100">HOLD</Badge>}
                            {order.priority >= 9999 && !order.onHold && <Badge variant="destructive" className="text-[9px] px-1.5 py-0.5">🔼 BUMPED</Badge>}
                            {order.status === "completed" && order.c2p && (
                              <span className="text-xs text-emerald-600 font-medium">C2P {order.c2p}</span>
                            )}
                            {shouldShowReleasedPickProgress(order) && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-9 px-2 border-amber-300 text-amber-700 bg-white hover:bg-amber-50"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleStartPicking(order.id, {
                                    allowPreservedProgress: true,
                                    claimSource: "preserved_progress_resume",
                                  });
                                }}
                                data-testid={`button-resume-preserved-${order.id}`}
                              >
                                <Play className="h-4 w-4 mr-1" />
                                Resume
                              </Button>
                            )}
                            {(order.status === "ready" && !order.onHold && !isAdminOrLead && !shouldShowReleasedPickProgress(order)) && (
                              <ChevronRight className="h-5 w-5 text-muted-foreground" />
                            )}
                            {isAdminOrLead && order.status === "ready" && !order.onHold && !shouldShowReleasedPickProgress(order) && (
                              <ChevronRight className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                        </div>
                        {canReleaseOrder(order.id) && (
                          <div className="flex items-center gap-1 justify-end border-t pt-2 mt-1 flex-wrap">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-9 px-2 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReleaseOrder(order.id);
                              }}
                              data-testid={`button-release-${order.id}`}
                              title="End the picking assignment. Pick progress and holds are preserved."
                              disabled={releaseMutation.isPending}
                            >
                              <Unlock className="h-4 w-4 mr-1" />
                              Release picking assignment
                            </Button>
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
                    Completed this session ({completedItems.length})
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
            </>
          )}
        </div>
      </div>

      <CompletedOrderDetailDialog
        selectedCompletedOrder={selectedCompletedOrder}
        setSelectedCompletedOrder={setSelectedCompletedOrder}
      />
    </>
  );
}

export function PickingExceptionsView({
  exceptionOrders,
  setView,
  resolveExceptionMutation,
}: {
  exceptionOrders: OrderWithItems[];
  setView: (view: PickingViewState) => void;
  resolveExceptionMutation: {
    mutate: (vars: { orderId: number; resolution: string; notes?: string }) => void;
    isPending: boolean;
  };
}) {
  const exceptionItems = mapExceptionOrdersToSingleOrders(exceptionOrders);

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
                              notes: "Shipped partial - remaining items backordered",
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
                              notes: "Waiting for inventory",
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
                              notes: "Issue resolved - back to picking",
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
                              resolution: "cancelled",
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

export function PickingCompleteView({
  pickingMode,
  queue,
  singleQueue,
  activeBatch,
  activeOrder,
  activeWork,
  handleGrabNext,
  handleBackToQueue,
}: {
  pickingMode: "batch" | "single";
  queue: PickBatch[];
  singleQueue: SingleOrder[];
  activeBatch: PickBatch | undefined;
  activeOrder: SingleOrder | undefined;
  activeWork: PickBatch | SingleOrder | undefined;
  handleGrabNext: () => void;
  handleBackToQueue: () => void;
}) {
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
