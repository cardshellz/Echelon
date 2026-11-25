import React, { useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { OrderItem, ItemStatus } from "@shared/schema";
import { useSettings } from "@/lib/settings";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import {
  clearPendingPickingCommand,
  getPendingPickingCommand,
  PendingPickingCommandConflictError,
} from "@/lib/picking-command";
import { derivePickerLineProgress } from "@/lib/picking-progress";
import {
  playSound as playSoundLib,
  triggerHaptic as triggerHapticLib,
  type SoundType,
} from "@/lib/sounds";
import {
  fetchExceptions,
  fetchPickingQueue,
  fetchReplenBins,
  fetchReplenGuidance,
  fetchWarehouseFifo,
  findNextPendingItemIndex,
  groupMappedPickerOrders,
  mapPickerOrder,
  mergePickerSingleQueue,
  patchResolvedAllocationInOrderList,
  patchResolvedAllocationInPickItem,
  resolveAllocationBin,
  unpickItem,
  updateOrderItem,
  type OrderItemWithReplen,
  type OrderWithItems,
  type PickBatch,
  type PickInventoryContext,
  type PickItem,
  type PickingActiveFilter,
  type PickingSortBy,
  type PickingViewState,
  type PickResponse,
  type ReplenGuidanceData,
  type SingleOrder,
} from "./picking/picking-types-and-helpers";
import {
  usePickingFocusAndRefs,
  usePickingRealtimeUpdates,
  usePickingScanHandlers,
  useSyncCompletedOrders,
} from "./picking/usePickingScanner";
import { usePickingOrderActions } from "./picking/usePickingOrderActions";
import {
  PickingCompleteView,
  PickingExceptionsView,
  PickingQueueView,
} from "./picking/PickingQueueViews";
import { PickingActiveItemView } from "./picking/PickingActiveItemView";
import { PickingDialogs, type FoundOnShelfPromptState } from "./picking/PickingDialogs";

export * from "./picking/picking-types-and-helpers";
export * from "./picking/PickingBadges";

export default function Picking() {
  return <PickingWorkspace />;
}

function PickingWorkspace() {
  // Supervisor affordances use verified assignments, never the legacy label.
  const { user, permissions, hasPermission, refetch: refetchAuth } = useAuth();
  const canResolveExceptions = hasPermission("orders", "resolve_exception");
  const canManagePickingSettings = hasPermission("picking", "manage_settings");
  const canViewReplenTasks = hasPermission("inventory", "view");
  const canChangePriority = hasPermission("orders", "priority");
  const isAdminOrLead = canChangePriority || canResolveExceptions || canManagePickingSettings;
  const canManageHolds = hasPermission("orders", "hold");
  const { toast } = useToast();

  // Get picking mode, view mode, and sound/haptic settings from context
  const {
    pickingMode,
    setPickingMode,
    pickerViewMode,
    setPickerViewMode,
    soundTheme,
    setSoundTheme,
    hapticEnabled,
    setHapticEnabled,
  } = useSettings();

  const playSound = (type: SoundType) => {
    if (soundTheme !== "silent") {
      playSoundLib(type, soundTheme);
    }
    if (hapticEnabled) {
      const hapticMap: Record<SoundType, "light" | "medium" | "heavy"> = {
        success: "medium",
        error: "heavy",
        complete: "heavy",
        scan: "light",
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
  const [activeFilter, setActiveFilter] = useState<PickingActiveFilter>("all");

  // Fetch orders from API - auto-refresh every 15s and when window regains focus
  const {
    data: apiOrders = [],
    isLoading,
    isError: queueError,
    isFetching: queueFetching,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["picking-queue"],
    meta: { handlesLoadError: true },
    queryFn: fetchPickingQueue,
    enabled: activeFilter !== "done",
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    staleTime: 5000,
  });

  // Fetch exceptions for admins/leads only
  const { data: exceptionOrders = [] } = useQuery({
    queryKey: ["exception-orders"],
    queryFn: fetchExceptions,
    enabled: canResolveExceptions,
    refetchOnWindowFocus: true,
  });

  const { data: fifoSettings, refetch: refetchFifo } = useQuery({
    queryKey: ["warehouse-fifo", 1],
    queryFn: fetchWarehouseFifo,
  });

  usePickingRealtimeUpdates({ queryClient, soundTheme, refetchAuth });

  const allOrdersMapped = useMemo<SingleOrder[]>(() => apiOrders.map(mapPickerOrder), [apiOrders]);
  const ordersFromApi = useMemo<SingleOrder[]>(() => groupMappedPickerOrders(allOrdersMapped), [allOrdersMapped]);

  // Core state - Batch mode
  const [queue, setQueue] = useState<PickBatch[]>([]);
  // Core state - Single mode (local copy for active picking session)
  const [localSingleQueue, setLocalSingleQueue] = useState<SingleOrder[]>([]);

  const singleQueue = useMemo<SingleOrder[]>(
    () => mergePickerSingleQueue(pickingMode, ordersFromApi, localSingleQueue),
    [pickingMode, ordersFromApi, localSingleQueue],
  );

  useSyncCompletedOrders({ pickingMode, ordersFromApi, setLocalSingleQueue });

  // Reconcile any retained client pick commands whose server state has already advanced
  useEffect(() => {
    for (const order of ordersFromApi) {
      for (const item of order.items) {
        const pending = getPendingPickingCommand("pick", item.id);
        if (!pending) continue;
        const pendingQty = Number(pending.payload.pickedQuantity);
        const pendingStatus = String(pending.payload.status ?? "");
        const serverCommitted =
          (Number.isFinite(pendingQty) && item.picked >= pendingQty) ||
          (pendingStatus === "completed" && item.status === "completed") ||
          (pendingStatus === "short" && item.status === "short");
        if (serverCommitted) {
          clearPendingPickingCommand("pick", item.id);
        }
      }
    }
  }, [ordersFromApi]);

  // Bin count dialog state for true inventory discrepancies.
  const [binCountOpen, setBinCountOpen] = useState(false);
  const [binCountContext, setBinCountContext] = useState<PickInventoryContext | null>(null);
  const [binCountQty, setBinCountQty] = useState("");
  const binCountPendingRef = useRef(false);
  const orderCompletedPendingRef = useRef(false);
  const focusedScanTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const scanPickInFlightRef = useRef<Set<number>>(new Set());

  const [view, setView] = useState<PickingViewState>(() => {
    const value = new URLSearchParams(window.location.search).get("view");
    return value === "picking" || value === "complete" || value === "exceptions" ? value : "queue";
  });
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const [currentItemIndex, setCurrentItemIndex] = useState(0);

  // Search, sort, and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<PickingSortBy>("priority");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  // UI state
  const [scanInput, setScanInput] = useState("");
  const [scanStatus, setScanStatus] = useState<"idle" | "success" | "error">("idle");
  const [shortPickOpen, setShortPickOpen] = useState(false);
  const [shortPickReason, setShortPickReason] = useState("");
  const [shortPickQty, setShortPickQty] = useState("0");
  const [shortPickListIndex, setShortPickListIndex] = useState<number | null>(null);
  const [replenGuidanceOpen, setReplenGuidanceOpen] = useState(false);
  const [replenGuidanceData, setReplenGuidanceData] = useState<ReplenGuidanceData | null>(null);
  const [replenGuidanceLoading, setReplenGuidanceLoading] = useState(false);
  const [multiQtyOpen, setMultiQtyOpen] = useState(false);
  const [multiQtyMethod, setMultiQtyMethod] = useState<"scan" | "manual">("scan");
  const [pickQty, setPickQty] = useState(1);
  const [selectedReplenSourceByItem, setSelectedReplenSourceByItem] = useState<Record<number, number>>({});
  const [foundOnShelfPrompt, setFoundOnShelfPrompt] = useState<FoundOnShelfPromptState | null>(null);
  const [allocationDialogOpen, setAllocationDialogOpen] = useState(false);
  const [allocationTargetIndex, setAllocationTargetIndex] = useState<number | null>(null);
  const [allocationBinCode, setAllocationBinCode] = useState("");
  const [soundSettingsOpen, setSoundSettingsOpen] = useState(false);
  const [lastScannedItemId, setLastScannedItemId] = useState<number | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [flashingOrderId, setFlashingOrderId] = useState<string | null>(null);
  const [selectedCompletedOrder, setSelectedCompletedOrder] = useState<SingleOrder | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [editQtyOpen, setEditQtyOpen] = useState(false);
  const [editQtyIdx, setEditQtyIdx] = useState<number | null>(null);
  const [editQtyValue, setEditQtyValue] = useState(0);

  const soundEnabled = soundTheme !== "silent";

  const {
    toggleFifoMutation,
    resolveExceptionMutation,
    releaseMutation,
    holdMutation,
    releaseHoldMutation,
    priorityMutation,
    reportReplenSourceEmptyMutation,
    binCountMutation,
    handleStartPicking,
    handleGrabNext,
    getSubOrderIds,
    handleBackToQueue,
    handleSyncOrders,
    canReleaseOrder,
    handleReleaseOrder,
  } = usePickingOrderActions({
    queryClient,
    apiOrders,
    ordersFromApi,
    singleQueue,
    queue,
    setQueue,
    setLocalSingleQueue,
    pickingMode,
    pickerId,
    permissions,
    sortBy,
    sortDirection,
    activeOrderId,
    setActiveOrderId,
    setActiveBatchId,
    setCurrentItemIndex,
    view,
    setView,
    setScanInput,
    setClaimError,
    setDebugLog,
    setIsSyncing,
    binCountPendingRef,
    orderCompletedPendingRef,
    setBinCountOpen,
    setBinCountContext,
    setBinCountQty,
    refetch,
    refetchFifo,
    playSound,
    triggerHaptic,
    toast,
  });

  const applyServerItemToLocalQueues = (updatedItem: OrderItemWithReplen) => {
    const applyToPickItem = (item: PickItem): PickItem => {
      if (item.id !== updatedItem.id) return item;

      const progress = derivePickerLineProgress({
        quantity: updatedItem.quantity,
        pickedQuantity: updatedItem.pickedQuantity || 0,
        fulfilledQuantity: updatedItem.fulfilledQuantity || 0,
        status: updatedItem.status as PickItem["status"],
      });

      return {
        ...item,
        sku: updatedItem.sku,
        name: updatedItem.name,
        location: updatedItem.location,
        qty: progress.targetQuantity,
        picked: progress.pickedQuantity,
        status: progress.status,
        image: updatedItem.imageUrl || item.image,
        barcode: updatedItem.barcode || item.barcode,
        replenPrediction: updatedItem.replenPrediction ?? item.replenPrediction ?? null,
      };
    };

    setLocalSingleQueue(prev => prev.map(order => {
      if (!order.items.some(item => item.id === updatedItem.id)) return order;

      const items = order.items.map(applyToPickItem).filter(item => item.qty > 0 || item.status === "short");
      const allDone = items.length > 0 && items.every(item => item.status === "completed" || item.status === "short");
      return {
        ...order,
        items,
        status: allDone ? "completed" : order.status === "completed" ? "in_progress" : order.status,
      };
    }));

    setQueue(prev => prev.map(batch => {
      if (!batch.items.some(item => item.id === updatedItem.id)) return batch;

      const items = batch.items.map(applyToPickItem).filter(item => item.qty > 0 || item.status === "short");
      const allDone = items.length > 0 && items.every(item => item.status === "completed" || item.status === "short");
      return {
        ...batch,
        items,
        status: allDone ? "completed" : batch.status === "completed" ? "in_progress" : batch.status,
      };
    }));
  };

  const discardOptimisticLocalOrderForItem = (itemId: number) => {
    const confirmedItem = queryClient.getQueryData<OrderWithItems[]>(["picking-queue"])
      ?.flatMap(order => order.items).find(item => item.id === itemId);
    if (confirmedItem) applyServerItemToLocalQueues(confirmedItem);
    else {
      setLocalSingleQueue(prev => prev.filter(order => !order.items.some(item => item.id === itemId)));
      setQueue(prev => prev.filter(batch => !batch.items.some(item => item.id === itemId)));
    }
  };

  const handlePendingCommandConflict = (conflictError: PendingPickingCommandConflictError) => {
    toast({
      title: "Previous action pending",
      description: conflictError.message,
      variant: "destructive",
      action: (
        <ToastAction
          altText="Clear stuck retry"
          onClick={() => {
            clearPendingPickingCommand(conflictError.action, conflictError.itemId);
            queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
            toast({
              title: "Cleared pending retry",
              description: "Refreshed order state — you can record the pick now.",
            });
          }}
        >
          Clear stuck retry
        </ToastAction>
      ),
    });
    playSound("error");
    queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
  };

  // Mutation for updating items
  const updateItemMutation = useMutation({
    mutationFn: ({
      itemId,
      status,
      pickedQuantity,
      shortReason,
      pickMethod,
      replenSourceLocationId,
      confirmFoundOnShelf,
    }: {
      itemId: number;
      status: ItemStatus;
      pickedQuantity?: number;
      shortReason?: string;
      pickMethod?: "scan" | "manual" | "pick_all" | "button" | "short";
      replenSourceLocationId?: number;
      confirmFoundOnShelf?: boolean;
    }) => {
      const item = singleQueue.flatMap(order => order.items).find(item => item.id === itemId)
        ?? queue.flatMap(batch => batch.items).find(item => item.id === itemId);
      if (item?.sourcePlan?.status === "blocked") throw new Error(item.sourcePlan.message);
      const source = item?.sourcePlan?.status === "ready" ? item.sourcePlan.warehouseLocationId : undefined;
      const effectiveReplenSourceId = replenSourceLocationId ?? selectedReplenSourceByItem[itemId];
      const effectiveConfirmFoundOnShelf =
        confirmFoundOnShelf !== undefined
          ? confirmFoundOnShelf
          : status !== "short"
            ? false
            : undefined;
      return updateOrderItem(itemId, status, pickedQuantity, shortReason, pickMethod, source, {
        replenSourceLocationId: effectiveReplenSourceId,
        confirmFoundOnShelf: effectiveConfirmFoundOnShelf,
      });
    },
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
      applyServerItemToLocalQueues(updatedItem);
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });

      if (data.followupPending) {
        orderCompletedPendingRef.current = false;
        toast({ title: "Pick recorded; follow-up pending", description: data.message, duration: 8000 });
        return;
      }

      if (inventory?.resolution?.reviewRequired && !inventory.resolution.autoResolved) {
        orderCompletedPendingRef.current = false;
        toast({ title: "Pick not saved", description: inventory.resolution.message, variant: "destructive" });
        return;
      }
      const replen = inventory?.replen;
      binCountPendingRef.current = false;
      if (inventory?.resolution?.autoResolved && inventory.resolution.reviewRequired) {
        toast({
          title: "Inventory variance recorded",
          description: inventory.resolution.message || "System inventory was corrected and queued for review.",
        });
      }
      if (replen?.triggered) {
        if (replen.autoExecutedFailed) {
          toast({
            title: "Replen needs review",
            description: replen.autoExecuteFailReason
              ? `Replen could not complete: ${replen.autoExecuteFailReason}`
              : "Replen could not complete.",
            variant: "destructive",
          });
        } else if (replen.autoExecuted) {
          toast({
            title: "Replen completed",
            description: "Inventory moved without interrupting picking.",
          });
        } else if (replen.taskStatus && replen.taskStatus !== "completed") {
          toast({
            title: "Replen queued",
            description: "A replen task was created without interrupting picking.",
          });
        }
      }

      // If the last item's pick deferred order completion, resolve it now
      if (orderCompletedPendingRef.current && !binCountPendingRef.current) {
        orderCompletedPendingRef.current = false;
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
    },
    onError: (error: Error, variables) => {
      // Critical: Reset all state so scanner can work again
      binCountPendingRef.current = false;
      orderCompletedPendingRef.current = false;
      setBinCountOpen(false);
      setBinCountContext(null);
      setMultiQtyOpen(false);
      discardOptimisticLocalOrderForItem(variables.itemId);

      const errCode = (error as any)?.code;
      const errDetails = (error as any)?.details ?? {};
      if (
        errCode === "found_on_shelf_confirmation_required" &&
        variables.status !== "short" &&
        typeof setFoundOnShelfPrompt === "function"
      ) {
        const matchedItem =
          singleQueue.flatMap((o) => o.items).find((it) => it.id === variables.itemId) ??
          queue.flatMap((b) => b.items).find((it) => it.id === variables.itemId);
        setFoundOnShelfPrompt({
          itemId: variables.itemId,
          sku: matchedItem?.sku || "SKU",
          locationCode: String(errDetails.locationCode || matchedItem?.location || "Bin"),
          systemQty: Number(errDetails.systemQty ?? 0),
          status: variables.status === "in_progress" ? "in_progress" : "completed",
          pickedQuantity: Number(variables.pickedQuantity ?? matchedItem?.qty ?? 1),
          pickMethod:
            variables.pickMethod && variables.pickMethod !== "short"
              ? variables.pickMethod
              : "manual",
          replenSourceLocationId: variables.replenSourceLocationId,
        });
        playSound("error");
        return;
      }

      if (
        error?.name === "PendingPickingCommandConflictError" &&
        typeof handlePendingCommandConflict === "function"
      ) {
        handlePendingCommandConflict(error as PendingPickingCommandConflictError);
        return;
      }

      // Show error to user
      toast({
        title: "Pick failed",
        description: error.message || "Failed to update item. Try again.",
        variant: "destructive",
      });
      playSound("error");

      // Refetch to ensure UI is in sync with backend
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
    onSettled: (_data, _error, variables) => {
      scanPickInFlightRef.current.delete(variables.itemId);
    },
  });

  const unpickItemMutation = useMutation({
    mutationFn: ({ itemId, qty, reason }: { itemId: number; qty: number; reason?: string }) =>
      unpickItem(itemId, qty, reason),
    onSuccess: (data: PickResponse) => {
      const { item: updatedItem } = data;
      if (data.followupPending) toast({ title: "Unpick recorded; follow-up pending", description: data.message, duration: 8000 });
      queryClient.setQueryData<OrderWithItems[]>(["picking-queue"], (oldData) => {
        if (!oldData) return oldData;
        return oldData.map((order) => ({
          ...order,
          items: order.items.map((item) =>
            item.id === updatedItem.id ? { ...item, ...updatedItem } : item,
          ),
        }));
      });
      applyServerItemToLocalQueues(updatedItem);
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
    onError: (error: Error, variables) => {
      discardOptimisticLocalOrderForItem(variables.itemId);
      toast({
        title: "Unpick failed",
        description: error.message || "Failed to unpick item. Try again.",
        variant: "destructive",
      });
      playSound("error");
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
  });

  function applyResolvedAllocation(
    updatedItem: OrderItem,
    selectedLocation?: { id: number; code: string; zone: string | null },
  ) {
    setQueue((prev) =>
      prev.map((batch) => ({
        ...batch,
        items: batch.items.map((it) => patchResolvedAllocationInPickItem(it, updatedItem, selectedLocation)),
      })),
    );
    setLocalSingleQueue((prev) =>
      prev.map((order) => ({
        ...order,
        items: order.items.map((it) => patchResolvedAllocationInPickItem(it, updatedItem, selectedLocation)),
      })),
    );
    queryClient.setQueryData<OrderWithItems[]>(["picking-queue"], (oldData) =>
      patchResolvedAllocationInOrderList(oldData, updatedItem, selectedLocation),
    );
  }

  // Hold a single line so the rest of the order can ship now. The server
  // splits the held line onto its own shipment, re-pushes the main shipment
  // without it, and the pick queue stops showing the order for this line.
  const holdLineItemMutation = useMutation({
    mutationFn: async ({ wmsOrderId, itemId }: { wmsOrderId: number; itemId: number }) => {
      const res = await fetch(`/api/orders/${wmsOrderId}/items/${itemId}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to hold line");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({
        title: "Line held",
        description: "It ships separately once released. The rest of the order can go now.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't hold line",
        description: error.message || "Failed to hold line. Try again.",
        variant: "destructive",
      });
      playSound("error");
    },
  });

  // Release a held line. A line that already shipped is closed out server-side
  // instead of being re-sent to ShipStation.
  const releaseLineHoldMutation = useMutation({
    mutationFn: async ({ wmsOrderId, itemId }: { wmsOrderId: number; itemId: number }) => {
      const res = await fetch(`/api/orders/${wmsOrderId}/items/${itemId}/release-hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to remove hold");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({ title: "Hold removed", description: "The hold is off this line." });
    },
    onError: (error: Error) => {
      toast({
        title: "Couldn't remove hold",
        description: error.message || "Failed to remove hold. Try again.",
        variant: "destructive",
      });
      playSound("error");
    },
  });

  const resolveAllocationMutation = useMutation({
    mutationFn: ({ itemId, locationCode }: { itemId: number; locationCode: string }) =>
      resolveAllocationBin(itemId, locationCode),
    onSuccess: (data) => {
      if (data.item) {
        applyResolvedAllocation(data.item, data.selectedLocation);
      }
      setAllocationDialogOpen(false);
      setAllocationTargetIndex(null);
      setAllocationBinCode("");
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      toast({
        title: data.reviewNeeded ? "Bin accepted for review" : "Bin assigned",
        description: data.selectedLocation?.code
          ? `${data.item?.sku || "Item"} assigned to ${data.selectedLocation.code}`
          : undefined,
      });
      playSound("success");
    },
    onError: (error: Error) => {
      toast({
        title: "Could not assign bin",
        description: error.message,
        variant: "destructive",
      });
      playSound("error");
    },
  });

  const setSingleQueue = (updater: SingleOrder[] | ((prev: SingleOrder[]) => SingleOrder[])) => {
    if (typeof updater === "function") {
      setLocalSingleQueue((prev) => {
        const base = prev.length > 0 ? prev : singleQueue;
        return updater(base);
      });
    } else {
      setLocalSingleQueue(updater);
    }
  };

  // Computed values - work for both modes
  const activeBatch = queue.find((b) => b.id === activeBatchId);
  const activeOrder = singleQueue.find((o) => o.id === activeOrderId);
  const activeWork = pickingMode === "batch" ? activeBatch : activeOrder;
  const currentItem = activeWork?.items[currentItemIndex];
  const completedItems = activeWork?.items.filter((i) => i.status === "completed" || i.status === "short").length || 0;
  const totalItems = activeWork?.items.length || 0;
  const progressPercent = totalItems > 0 ? (completedItems / totalItems) * 100 : 0;

  const activePickItemIds = useMemo(
    () => (activeWork?.items ?? []).map((item) => item.id).sort((a, b) => a - b),
    [activeWork],
  );
  const { data: replenBinsData } = useQuery<{ replenBins: Record<string, { locationCode: string }> }>({
    queryKey: ["pick-replen-bins", activePickItemIds.join(",")],
    enabled: activePickItemIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchReplenBins(activePickItemIds),
  });
  const replenBins = replenBinsData?.replenBins ?? {};

  function openAllocationDialog(itemIndex: number | null) {
    const item = itemIndex === null ? currentItem : activeWork?.items[itemIndex];
    if (!item) return;
    setAllocationTargetIndex(itemIndex);
    setAllocationBinCode(item.location && item.location !== "UNASSIGNED" ? item.location : "");
    setAllocationDialogOpen(true);
  }

  function submitAllocationDialog() {
    const item = allocationTargetIndex === null ? currentItem : activeWork?.items[allocationTargetIndex];
    const locationCode = allocationBinCode.trim().toUpperCase();
    if (!item || !locationCode) return;
    resolveAllocationMutation.mutate({ itemId: item.id, locationCode });
  }

  const { manualInputRef, hiddenScannerRef, itemRefs, maintainFocus } = usePickingFocusAndRefs({
    view,
    shortPickOpen,
    multiQtyOpen,
    binCountOpen,
    allocationDialogOpen,
    editQtyOpen,
    replenGuidanceOpen,
    soundSettingsOpen,
    foundOnShelfOpen: Boolean(foundOnShelfPrompt),
    activeWork,
  });

  const clearFocusedScanTimeout = () => {
    if (focusedScanTimeoutRef.current) {
      clearTimeout(focusedScanTimeoutRef.current);
      focusedScanTimeoutRef.current = null;
    }
  };

  const rejectScan = (resetDelayMs = 900) => {
    clearFocusedScanTimeout();
    setScanStatus("error");
    playSound("error");
    triggerHaptic("heavy");

    setTimeout(() => {
      setScanStatus("idle");
      setScanInput("");
      maintainFocus();
    }, resetDelayMs);
  };

  const advanceToNext = () => {
    const updatedWork =
      pickingMode === "batch"
        ? queue.find((b) => b.id === activeBatchId)
        : singleQueue.find((o) => o.id === activeOrderId);

    if (!updatedWork) return;

    const nextIndex = findNextPendingItemIndex(updatedWork.items, currentItemIndex);
    if (nextIndex !== -1) {
      setCurrentItemIndex(nextIndex);
    } else {
      if (pickingMode === "batch") {
        setQueue((prev) =>
          prev.map((b) => (b.id === activeBatchId ? { ...b, status: "completed" as const } : b)),
        );
        setActiveBatchId(null);
      } else {
        setSingleQueue((prev) =>
          prev.map((o) => (o.id === activeOrderId ? { ...o, status: "completed" as const } : o)),
        );
        setActiveOrderId(null);
      }
      playSound("complete");
      triggerHaptic("heavy");
      setCurrentItemIndex(0);
      setView("queue");
    }
  };

  const confirmPick = (qty: number, method: "scan" | "manual" = "scan") => {
    if (!activeWork || !currentItem) return;
    if (scanPickInFlightRef.current.has(currentItem.id)) return;
    scanPickInFlightRef.current.add(currentItem.id);

    const newPicked = currentItem.picked + qty;
    const newStatus: ItemStatus = newPicked >= currentItem.qty ? "completed" : "in_progress";

    updateItemMutation.mutate({
      itemId: currentItem.id,
      status: newStatus,
      pickedQuantity: newPicked,
      pickMethod: method,
      replenSourceLocationId: selectedReplenSourceByItem[currentItem.id],
      confirmFoundOnShelf: false,
    });

    let orderCompleted = false;

    if (pickingMode === "batch") {
      setQueue((prev) =>
        prev.map((batch) => {
          if (batch.id !== activeBatchId) return batch;

          const newItems = batch.items.map((item, idx) => {
            if (idx !== currentItemIndex) return item;
            return {
              ...item,
              picked: newPicked,
              status: newStatus as "pending" | "in_progress" | "completed" | "short",
            };
          });

          const allDone = newItems.every((it) => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;

          return { ...batch, items: newItems };
        }),
      );
    } else {
      setSingleQueue((prev) =>
        prev.map((order) => {
          if (order.id !== activeOrderId) return order;

          const newItems = order.items.map((item, idx) => {
            if (idx !== currentItemIndex) return item;
            return {
              ...item,
              picked: newPicked,
              status: newStatus as "pending" | "in_progress" | "completed" | "short",
            };
          });

          const allDone = newItems.every((it) => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;

          return { ...order, items: newItems, status: allDone ? ("completed" as const) : order.status };
        }),
      );
    }

    setScanStatus("idle");
    setScanInput("");
    setMultiQtyOpen(false);
    setMultiQtyMethod("scan");
    setPickQty(1);

    if (orderCompleted) {
      orderCompletedPendingRef.current = true;
    } else {
      setTimeout(() => {
        advanceToNext();
      }, 300);
    }
    // Return focus to the visible scan box after each pick (pre-#2158 behavior).
    // Moving it onto the hidden scanner sink was part of the #2158 change that
    // stopped hardware scans registering on the handhelds.
    setTimeout(() => {
      if (manualInputRef.current && !shortPickOpen && !binCountOpen) {
        manualInputRef.current.focus();
      }
    }, 500);
  };

  const checkReplenGuidance = async (item: PickItem, listIndex: number | null) => {
    if (!item.location || item.location === "UNASSIGNED") {
      setShortPickQty(String(item.picked || 0));
      setShortPickReason("");
      setShortPickListIndex(listIndex);
      setShortPickOpen(true);
      return;
    }

    setReplenGuidanceLoading(true);
    try {
      const guidance = await fetchReplenGuidance(item.id);
      if (guidance.action === "replen_inline" && guidance.source) {
        setReplenGuidanceData({ ...guidance, targetItem: { id: item.id, sku: item.sku, location: item.location } });
        setShortPickListIndex(listIndex);
        setReplenGuidanceOpen(true);
      } else {
        setShortPickQty(String(item.picked || 0));
        setShortPickReason("");
        setShortPickListIndex(listIndex);
        setShortPickOpen(true);
      }
    } catch (err) {
      console.warn("[ReplenGuidance] Failed:", err);
      toast({
        title: "Replenishment check failed",
        description: "Could not verify reserve stock — retry or confirm shortage manually.",
        variant: "destructive",
      });
      setShortPickQty(String(item.picked || 0));
      setShortPickReason("");
      setShortPickListIndex(listIndex);
      setShortPickOpen(true);
    } finally {
      setReplenGuidanceLoading(false);
    }
  };

  const openHoldLine = (item: PickItem | null | undefined) => {
    if (!item || item.picked > 0 || holdLineItemMutation.isPending) return;
    holdLineItemMutation.mutate({ wmsOrderId: item.wmsOrderId, itemId: item.id });
  };

  const handleShortPick = () => {
    if (!activeWork) return;

    const isListView = shortPickListIndex !== null;
    const itemIndex = isListView ? shortPickListIndex : currentItemIndex;
    const targetItem = isListView ? activeWork.items[shortPickListIndex] : currentItem;

    if (!targetItem) return;

    const shortQty = parseInt(shortPickQty) || 0;

    updateItemMutation.mutate({
      itemId: targetItem.id,
      status: "short" as ItemStatus,
      pickedQuantity: shortQty,
      shortReason: shortPickReason || undefined,
      pickMethod: "short",
    });

    let orderCompleted = false;

    if (pickingMode === "batch") {
      setQueue((prev) =>
        prev.map((batch) => {
          if (batch.id !== activeBatchId) return batch;

          const newItems = batch.items.map((item, idx) => {
            if (idx !== itemIndex) return item;
            return { ...item, picked: shortQty, status: "short" as const };
          });

          const allDone = newItems.every((it) => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;

          return { ...batch, items: newItems };
        }),
      );
    } else {
      setSingleQueue((prev) =>
        prev.map((order) => {
          if (order.id !== activeOrderId) return order;

          const newItems = order.items.map((item, idx) => {
            if (idx !== itemIndex) return item;
            return { ...item, picked: shortQty, status: "short" as const };
          });

          const allDone = newItems.every((it) => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;

          return { ...order, items: newItems, status: allDone ? ("completed" as const) : order.status };
        }),
      );
    }

    playSound("error");
    triggerHaptic("medium");

    setShortPickOpen(false);
    setShortPickReason("");
    setShortPickQty("0");
    setShortPickListIndex(null);

    if (orderCompleted) {
      orderCompletedPendingRef.current = true;
    } else if (!isListView) {
      setTimeout(() => {
        advanceToNext();
        maintainFocus();
      }, 300);
    }
  };

  // Handle picking ONE unit of an item (for scanning - increments by 1)
  const handleListItemPickOne = (idx: number) => {
    if (!activeWork) return;
    
    const item = activeWork.items[idx];
    if (!item) return;
    if (item.status === "completed" || item.status === "short" || item.picked >= item.qty) {
      rejectScan(500);
      return;
    }
    if (scanPickInFlightRef.current.has(item.id)) {
      rejectScan(500);
      return;
    }
    scanPickInFlightRef.current.add(item.id);
    
    const newPicked = item.picked + 1;
    const isItemComplete = newPicked >= item.qty;
    
    console.log("[PICK] Picking 1 unit of:", item.sku, `(${newPicked}/${item.qty})`);
    
    // Visual feedback
    setLastScannedItemId(item.id);
    setTimeout(() => setLastScannedItemId(null), 2000);
    
    updateItemMutation.mutate({
      itemId: item.id,
      status: isItemComplete ? "completed" as ItemStatus : "in_progress" as ItemStatus, 
      pickedQuantity: newPicked,
      pickMethod: "scan",
    });
    
    const checkAndHandleCompletion = (items: typeof activeWork.items) => {
      const allDone = items.every(it => it.status === "completed" || it.status === "short");
      if (allDone) {
        orderCompletedPendingRef.current = true;
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
    
    updateItemMutation.mutate({
      itemId: item.id,
      status: "completed" as ItemStatus,
      pickedQuantity: qty,
      pickMethod: "pick_all",
    });
    
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
      orderCompletedPendingRef.current = true;
    }
  };

  const handleListItemPick = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;

    playSound("success");
    triggerHaptic("medium");
    handleListItemPickDirect(idx, item.qty);

    setTimeout(maintainFocus, 50);

    setTimeout(() => {
      const updatedWork =
        pickingMode === "batch"
          ? queue.find((b) => b.id === activeBatchId)
          : localSingleQueue.find((o) => o.id === activeOrderId) || singleQueue.find((o) => o.id === activeOrderId);

      if (!updatedWork) return;

      const nextIdx = findNextPendingItemIndex(updatedWork.items, idx);
      if (nextIdx !== -1) {
        const nextItem = updatedWork.items[nextIdx];
        const nextItemElement = document.querySelector(`[data-testid="list-item-${nextItem.id}"]`);
        if (nextItemElement) {
          nextItemElement.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }, 100);
  };

  const handleListItemShort = (idx: number) => {
    if (!activeWork) return;
    const item = activeWork.items[idx];
    if (!item || item.status === "completed" || item.status === "short") return;

    checkReplenGuidance(item, idx);
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
    
    updateItemMutation.mutate({ 
      itemId: item.id, 
      status: isItemComplete ? "completed" as ItemStatus : "in_progress" as ItemStatus, 
      pickedQuantity: newPicked,
      pickMethod: "manual",
    });
    
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
      orderCompletedPendingRef.current = true;
    }
  };

  const handleListItemDecrement = (idx: number) => {
    if (!activeWork) return;

    const item = activeWork.items[idx];
    if (!item || item.picked <= 0) return;

    triggerHaptic("light");

    unpickItemMutation.mutate({
      itemId: item.id,
      qty: 1,
      reason: "Picker decremented picked quantity",
    });
  };

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
    if (newPicked === item.picked) {
      setEditQtyOpen(false);
      setEditQtyIdx(null);
      return;
    }

    if (newPicked < item.picked) {
      unpickItemMutation.mutate({
        itemId: item.id,
        qty: item.picked - newPicked,
        reason: "Picker edited picked quantity down",
      });
      setEditQtyOpen(false);
      setEditQtyIdx(null);
      return;
    }

    const isItemComplete = newPicked >= item.qty;
    const newStatus: ItemStatus = newPicked === 0 ? "pending" : isItemComplete ? "completed" : "in_progress";

    updateItemMutation.mutate({
      itemId: item.id,
      status: newStatus,
      pickedQuantity: newPicked,
      pickMethod: "manual",
      replenSourceLocationId: selectedReplenSourceByItem[item.id],
      confirmFoundOnShelf: false,
    });

    let orderCompleted = false;

    if (pickingMode === "batch") {
      setQueue((prev) =>
        prev.map((batch) => {
          if (batch.id !== activeBatchId) return batch;
          const newItems = batch.items.map((it, i) => {
            if (i !== editQtyIdx) return it;
            return { ...it, picked: newPicked, status: newStatus };
          });
          const allDone = newItems.every((it) => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;
          return { ...batch, items: newItems, status: allDone ? ("completed" as const) : batch.status };
        }),
      );
    } else {
      setLocalSingleQueue((prev) => {
        const orderExists = prev.some((o) => o.id === activeOrderId);
        const base = orderExists ? prev : [...prev, ...singleQueue.filter((o) => o.id === activeOrderId)];
        return base.map((order) => {
          if (order.id !== activeOrderId) return order;
          const newItems = order.items.map((it, i) => {
            if (i !== editQtyIdx) return it;
            return { ...it, picked: newPicked, status: newStatus };
          });
          const allDone = newItems.every((it) => it.status === "completed" || it.status === "short");
          if (allDone) orderCompleted = true;
          return { ...order, items: newItems, status: allDone ? ("completed" as const) : order.status };
        });
      });
    }

    if (orderCompleted) {
      orderCompletedPendingRef.current = true;
    }

    setEditQtyOpen(false);
    setEditQtyIdx(null);
  };

  const { processScanRef, handleScan, processFocusedScan, handleScanKeyDown } = usePickingScanHandlers({
    view,
    pickerViewMode,
    activeWork,
    currentItem,
    shortPickOpen,
    multiQtyOpen,
    binCountOpen,
    allocationDialogOpen,
    editQtyOpen,
    replenGuidanceOpen,
    soundSettingsOpen,
    foundOnShelfOpen: Boolean(foundOnShelfPrompt),
    setScanInput,
    setScanStatus,
    setDebugLog,
    setMultiQtyOpen,
    scanPickInFlightRef,
    focusedScanTimeoutRef,
    clearFocusedScanTimeout,
    rejectScan,
    confirmPick,
    handleListItemPickOne,
    playSound,
    triggerHaptic,
    maintainFocus,
  });

  // ===== RENDER =====

  if (view === "queue") {
    return (
      <PickingQueueView
        user={user}
        hasPermission={hasPermission}
        pickingMode={pickingMode}
        setPickingMode={setPickingMode}
        queue={queue}
        singleQueue={singleQueue}
        channelFilter={channelFilter}
        setChannelFilter={setChannelFilter}
        activeFilter={activeFilter}
        setActiveFilter={setActiveFilter}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        sortBy={sortBy}
        setSortBy={setSortBy}
        sortDirection={sortDirection}
        setSortDirection={setSortDirection}
        isSyncing={isSyncing}
        handleSyncOrders={handleSyncOrders}
        canResolveExceptions={canResolveExceptions}
        exceptionOrdersCount={exceptionOrders.length}
        setView={setView}
        handleGrabNext={handleGrabNext}
        claimError={claimError}
        setClaimError={setClaimError}
        canManagePickingSettings={canManagePickingSettings}
        fifoEnabled={fifoSettings?.enabled || false}
        toggleFifoMutation={toggleFifoMutation}
        queueError={queueError}
        queueFetching={queueFetching}
        dataUpdatedAt={dataUpdatedAt}
        isLoading={isLoading}
        refetch={refetch}
        handleStartPicking={handleStartPicking}
        pickerId={pickerId}
        isAdminOrLead={isAdminOrLead}
        canChangePriority={canChangePriority}
        canManageHolds={canManageHolds}
        flashingOrderId={flashingOrderId}
        setFlashingOrderId={setFlashingOrderId}
        priorityMutation={priorityMutation}
        holdMutation={holdMutation}
        releaseHoldMutation={releaseHoldMutation}
        releaseLineHoldMutation={releaseLineHoldMutation}
        releaseMutation={releaseMutation}
        getSubOrderIds={getSubOrderIds}
        canReleaseOrder={canReleaseOrder}
        handleReleaseOrder={handleReleaseOrder}
        selectedCompletedOrder={selectedCompletedOrder}
        setSelectedCompletedOrder={setSelectedCompletedOrder}
        toast={toast}
      />
    );
  }

  if (view === "exceptions" && canResolveExceptions) {
    return (
      <PickingExceptionsView
        exceptionOrders={exceptionOrders}
        setView={setView}
        resolveExceptionMutation={resolveExceptionMutation}
      />
    );
  }

  if (view === "complete") {
    return (
      <PickingCompleteView
        pickingMode={pickingMode}
        queue={queue}
        singleQueue={singleQueue}
        activeBatch={activeBatch}
        activeOrder={activeOrder}
        activeWork={activeWork}
        handleGrabNext={handleGrabNext}
        handleBackToQueue={handleBackToQueue}
      />
    );
  }

  return (
    <PickingActiveItemView
      hiddenScannerRef={hiddenScannerRef}
      manualInputRef={manualInputRef}
      itemRefs={itemRefs}
      processScanRef={processScanRef}
      scanInput={scanInput}
      setScanInput={setScanInput}
      scanStatus={scanStatus}
      handleBackToQueue={handleBackToQueue}
      pickingMode={pickingMode}
      activeOrderId={activeOrderId}
      canReleaseOrder={canReleaseOrder}
      handleReleaseOrder={handleReleaseOrder}
      releaseMutation={releaseMutation}
      pickerViewMode={pickerViewMode}
      setPickerViewMode={setPickerViewMode}
      soundEnabled={soundEnabled}
      setSoundSettingsOpen={setSoundSettingsOpen}
      activeWork={activeWork}
      activeOrder={activeOrder}
      completedItems={completedItems}
      totalItems={totalItems}
      progressPercent={progressPercent}
      hasPermission={hasPermission}
      getSubOrderIds={getSubOrderIds}
      onAssemblyHandedOff={async (ticket, station) => {
        toast({
          title: `${ticket} sent to ${station}`,
          description: "Pass this order’s label and instructions to the station. Assembly is still outstanding.",
        });
        const fresh = await refetch();
        setLocalSingleQueue([]);
        if (
          activeOrder &&
          fresh.data &&
          getSubOrderIds(activeOrder.id).every((id) => !fresh.data.some((order) => order.id === id))
        ) {
          setView("queue");
          setActiveOrderId(null);
          setCurrentItemIndex(0);
          setScanInput("");
        }
      }}
      currentItem={currentItem}
      currentItemIndex={currentItemIndex}
      openAllocationDialog={openAllocationDialog}
      replenBins={replenBins}
      canViewReplenTasks={canViewReplenTasks}
      handleScan={handleScan}
      processFocusedScan={processFocusedScan}
      setMultiQtyOpen={(open) => {
        if (!open) setMultiQtyMethod("scan");
        setMultiQtyOpen(open);
      }}
      openManualMultiQty={() => {
        setMultiQtyMethod("manual");
        setMultiQtyOpen(true);
      }}
      confirmPick={confirmPick}
      selectedReplenSourceByItem={selectedReplenSourceByItem}
      onSelectReplenSource={(itemId, locationId) =>
        setSelectedReplenSourceByItem((prev) => ({ ...prev, [itemId]: locationId }))
      }
      checkReplenGuidance={checkReplenGuidance}
      replenGuidanceLoading={replenGuidanceLoading}
      canManageHolds={canManageHolds}
      releaseLineHoldMutation={releaseLineHoldMutation}
      holdLineItemMutation={holdLineItemMutation}
      openHoldLine={openHoldLine}
      handleScanKeyDown={handleScanKeyDown}
      debugLog={debugLog}
      lastScannedItemId={lastScannedItemId}
      openEditQtyDialog={openEditQtyDialog}
      handleListItemManualPickOne={handleListItemManualPickOne}
      handleListItemPick={handleListItemPick}
      handleListItemShort={handleListItemShort}
      handleListItemDecrement={handleListItemDecrement}
      updateItemMutation={updateItemMutation}
      unpickItemMutation={unpickItemMutation}
      onCompleteAll={() => {
        if (pickingMode === "batch") {
          setQueue((prev) =>
            prev.map((b) => (b.id === activeBatchId ? { ...b, status: "completed" as const } : b)),
          );
        } else {
          setSingleQueue((prev) =>
            prev.map((o) => (o.id === activeOrderId ? { ...o, status: "completed" as const } : o)),
          );
        }
        void refetch();
        playSound("complete");
        triggerHaptic("heavy");
        setView("queue");
      }}
    >
      <PickingDialogs
        multiQtyOpen={multiQtyOpen}
        setMultiQtyOpen={(open) => {
          if (!open) setMultiQtyMethod("scan");
          setMultiQtyOpen(open);
        }}
        multiQtyMethod={multiQtyMethod}
        pickQty={pickQty}
        setPickQty={setPickQty}
        currentItem={currentItem}
        confirmPick={confirmPick}
        foundOnShelfPrompt={foundOnShelfPrompt}
        setFoundOnShelfPrompt={setFoundOnShelfPrompt}
        onConfirmFoundOnShelf={() => {
          if (!foundOnShelfPrompt) return;
          const prompt = foundOnShelfPrompt;
          setFoundOnShelfPrompt(null);
          updateItemMutation.mutate({
            itemId: prompt.itemId,
            status: prompt.status,
            pickedQuantity: prompt.pickedQuantity,
            pickMethod: prompt.pickMethod,
            replenSourceLocationId: prompt.replenSourceLocationId,
            confirmFoundOnShelf: true,
          });
        }}
        onShortFromFoundOnShelf={() => {
          if (!foundOnShelfPrompt) return;
          const targetIdx = activeWork?.items.findIndex((it) => it.id === foundOnShelfPrompt.itemId) ?? -1;
          const target = targetIdx >= 0 ? activeWork?.items[targetIdx] : currentItem;
          setFoundOnShelfPrompt(null);
          setShortPickListIndex(pickerViewMode === "list" && targetIdx >= 0 ? targetIdx : null);
          setShortPickQty(String(target?.picked || 0));
          setShortPickReason("out_of_stock");
          setShortPickOpen(true);
        }}
        editQtyOpen={editQtyOpen}
        setEditQtyOpen={setEditQtyOpen}
        editQtyIdx={editQtyIdx}
        setEditQtyIdx={setEditQtyIdx}
        editQtyValue={editQtyValue}
        setEditQtyValue={setEditQtyValue}
        activeWork={activeWork}
        handleEditQtyConfirm={handleEditQtyConfirm}
        soundSettingsOpen={soundSettingsOpen}
        setSoundSettingsOpen={setSoundSettingsOpen}
        soundTheme={soundTheme}
        setSoundTheme={setSoundTheme}
        hapticEnabled={hapticEnabled}
        setHapticEnabled={setHapticEnabled}
        replenGuidanceOpen={replenGuidanceOpen}
        setReplenGuidanceOpen={setReplenGuidanceOpen}
        replenGuidanceData={replenGuidanceData}
        setReplenGuidanceData={setReplenGuidanceData}
        shortPickListIndex={shortPickListIndex}
        setShortPickListIndex={setShortPickListIndex}
        reportReplenSourceEmptyMutation={reportReplenSourceEmptyMutation}
        shortPickOpen={shortPickOpen}
        setShortPickOpen={setShortPickOpen}
        shortPickReason={shortPickReason}
        setShortPickReason={setShortPickReason}
        shortPickQty={shortPickQty}
        setShortPickQty={setShortPickQty}
        handleShortPick={handleShortPick}
        selectedCompletedOrder={selectedCompletedOrder}
        setSelectedCompletedOrder={setSelectedCompletedOrder}
        binCountOpen={binCountOpen}
        binCountContext={binCountContext}
        binCountQty={binCountQty}
        setBinCountQty={setBinCountQty}
        binCountMutation={binCountMutation}
        allocationDialogOpen={allocationDialogOpen}
        setAllocationDialogOpen={setAllocationDialogOpen}
        allocationTargetIndex={allocationTargetIndex}
        allocationBinCode={allocationBinCode}
        setAllocationBinCode={setAllocationBinCode}
        resolveAllocationMutation={resolveAllocationMutation}
        submitAllocationDialog={submitAllocationDialog}
      />
    </PickingActiveItemView>
  );
}
