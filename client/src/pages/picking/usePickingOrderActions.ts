import React from "react";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { canReleasePickingAssignment } from "@shared/types/picking-assignment-release";
import type { SoundType } from "@/lib/sounds";
import {
  claimOrder,
  holdOrder,
  mapPickerOrder,
  releaseHoldOrder,
  releaseOrder,
  reportReplenSourceEmpty,
  resolveException,
  setOrderPriority,
  shouldShowReleasedPickProgress,
  sortPickingQueueItems,
  submitBinCount,
  updateWarehouseFifo,
  type BinCountResponse,
  type ClaimSource,
  type OrderWithItems,
  type PickBatch,
  type PickInventoryContext,
  type PickItem,
  type PickingSortBy,
  type PickingViewState,
  type SingleOrder,
} from "./picking-types-and-helpers";

export function usePickingOrderActions({
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
}: {
  queryClient: QueryClient;
  apiOrders: OrderWithItems[];
  ordersFromApi: SingleOrder[];
  singleQueue: SingleOrder[];
  queue: PickBatch[];
  setQueue: React.Dispatch<React.SetStateAction<PickBatch[]>>;
  setLocalSingleQueue: React.Dispatch<React.SetStateAction<SingleOrder[]>>;
  pickingMode: "batch" | "single";
  pickerId: string;
  permissions: any;
  sortBy: PickingSortBy;
  sortDirection: "asc" | "desc";
  activeOrderId: string | null;
  setActiveOrderId: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveBatchId: React.Dispatch<React.SetStateAction<string | null>>;
  setCurrentItemIndex: React.Dispatch<React.SetStateAction<number>>;
  view: PickingViewState;
  setView: React.Dispatch<React.SetStateAction<PickingViewState>>;
  setScanInput: React.Dispatch<React.SetStateAction<string>>;
  setClaimError: React.Dispatch<React.SetStateAction<string | null>>;
  setDebugLog: React.Dispatch<React.SetStateAction<string[]>>;
  setIsSyncing: React.Dispatch<React.SetStateAction<boolean>>;
  binCountPendingRef: React.MutableRefObject<boolean>;
  orderCompletedPendingRef: React.MutableRefObject<boolean>;
  setBinCountOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setBinCountContext: React.Dispatch<React.SetStateAction<PickInventoryContext | null>>;
  setBinCountQty: React.Dispatch<React.SetStateAction<string>>;
  refetch: () => Promise<{ data?: OrderWithItems[] }>;
  refetchFifo: () => unknown;
  playSound: (type: SoundType) => void;
  triggerHaptic: (type: "light" | "medium" | "heavy") => void;
  toast: (opts: any) => void;
}) {
  const toggleFifoMutation = useMutation({
    mutationFn: updateWarehouseFifo,
    onSuccess: () => {
      refetchFifo();
      void refetch();
      toast({ title: "Routing Rules Updated", description: "Warehouse priority routing has been updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

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
    },
  });

  const claimMutation = useMutation({
    mutationFn: ({ orderId, claimSource }: { orderId: number; claimSource: ClaimSource }) =>
      claimOrder(orderId, claimSource),
    onSuccess: (claimed) => {
      queryClient.setQueryData<OrderWithItems[]>(["picking-queue"], (current) =>
        current?.map((order) => (order.id === claimed.id ? { ...order, ...claimed } : order)),
      );
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
  });

  const releaseMutation = useMutation({
    mutationFn: ({ orderId }: { orderId: number }) => {
      const order = apiOrders.find((candidate) => candidate.id === orderId);
      if (!order || !canReleasePickingAssignment(pickerId, permissions, order)) {
        throw new Error("You cannot release this picking assignment. Refresh the queue.");
      }
      return releaseOrder(orderId, {
        assignedPickerId: order.assignedPickerId,
        startedAt: order.startedAt ? new Date(order.startedAt).toISOString() : null,
      });
    },
    onSuccess: (released, { orderId }) => {
      setLocalSingleQueue((prev) => prev.filter((o) => o.id !== String(orderId)));
      queryClient.setQueryData<OrderWithItems[]>(["picking-queue"], (current) =>
        current?.map((order) => (order.id === released.id ? { ...order, ...released } : order)),
      );
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
    },
    onError: (error) => {
      console.error("Failed to release order:", error);
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("error");
    },
  });

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

  const releaseHoldMutation = useMutation({
    mutationFn: (orderId: number) => releaseHoldOrder(orderId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({
        title: "Hold removed",
        description: `The order hold on ${data.orderNumber} has been removed.`,
      });
    },
    onError: (error) => {
      console.error("Failed to release hold:", error);
      playSound("error");
      toast({
        title: "Couldn't remove hold",
        description: "Please try again",
        variant: "destructive",
      });
    },
  });

  const priorityMutation = useMutation({
    mutationFn: ({ orderId, priority }: { orderId: number; priority: number | "reset" }) =>
      setOrderPriority(orderId, priority),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["picking-queue"] });
      playSound("success");
      toast({
        title: "Priority updated",
        description: `Order ${data.orderNumber} priority updated to ${data.priority}`,
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

  const reportReplenSourceEmptyMutation = useMutation({
    mutationFn: ({ itemId, sourceLocationCode }: { itemId: number; sourceLocationCode?: string | null }) =>
      reportReplenSourceEmpty(itemId, sourceLocationCode),
    onError: (error: Error) => {
      console.error("[Replen] failed to record source-empty report:", error);
      toast({
        title: "Source-empty report not saved",
        description: error.message || "The short pick can continue, but lead review may need manual follow-up.",
        variant: "destructive",
      });
    },
  });

  const binCountMutation = useMutation({
    mutationFn: ({ sku, locationId, binCount, didReplen: replenDone }: { sku: string; locationId: number; binCount: number; didReplen: boolean }) =>
      submitBinCount({ sku, locationId, binCount, didReplen: replenDone }),
    onSuccess: (result: BinCountResponse) => {
      binCountPendingRef.current = false;
      setBinCountOpen(false);
      setBinCountContext(null);
      setBinCountQty("");

      if (result.adjustment !== 0) {
        toast({
          title: "Bin count adjusted",
          description: `Adjusted by ${result.adjustment > 0 ? "+" : ""}${result.adjustment} (was ${result.systemQtyBefore}, now ${result.actualBinQty})`,
        });
      } else {
        toast({ title: "Bin count verified", description: "Count matches system" });
      }
      if (result.parentCycleCountTriggered) {
        toast({
          title: "Parent location flagged",
          description: `Cycle count created for source bin ${result.parentCycleCountLocationCode} — verify case qty.`,
        });
      }
      if (result.replenTriggered && !result.replenFailReason) {
        if (result.replenTaskStatus === "completed") {
          toast({ title: "Replen completed", description: "Inventory moved from source to pick bin" });
        } else if (result.replenTaskStatus) {
          toast({ title: "Replen queued", description: "A replen task was created for warehouse follow-up" });
        }
      } else if (result.replenFailReason) {
        const reasonLabels: Record<string, string> = {
          no_source_stock: "Source bin had no available stock — replen task was not created",
          execute_failed: "Replen task was created but inventory movement failed",
        };
        const reason = reasonLabels[result.replenFailReason] || result.replenFailReason;
        toast({
          title: "Replen failed",
          description: `${reason}. Bin count was still recorded.`,
          variant: "destructive",
        });
      }

      if (orderCompletedPendingRef.current) {
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
      } else {
        playSound("success");
      }
    },
    onError: (error: Error) => {
      toast({ title: "Bin count failed", description: error.message, variant: "destructive" });
      playSound("error");
    },
  });

  const handleStartPicking = async (
    id: string,
    options: { allowPreservedProgress?: boolean; claimSource?: ClaimSource } = {},
  ) => {
    setClaimError(null);
    setDebugLog([]);

    if (pickingMode === "batch") {
      setQueue((prev) =>
        prev.map((b) => (b.id === id ? { ...b, status: "in_progress" as const, assignee: "You" } : b)),
      );
      setActiveBatchId(id);
      setCurrentItemIndex(0);
      setView("picking");
      triggerHaptic("medium");
    } else {
      const isCombinedGroup = id.startsWith("combined-");

      if (isCombinedGroup) {
        const combinedOrder = ordersFromApi.find((o) => o.id === id);
        if (!combinedOrder || !combinedOrder.combinedOrders) {
          console.error("Combined order not found:", id);
          return;
        }

        try {
          if (shouldShowReleasedPickProgress(combinedOrder) && !options.allowPreservedProgress) {
            toast({
              title: "Pick progress preserved",
              description: "Use Resume to continue this partially picked order.",
              variant: "default",
            });
            return;
          }

          const claimedItems = new Map<number, PickItem>();
          for (const subOrder of combinedOrder.combinedOrders) {
            const subOrderId = parseInt(subOrder.id);
            if (!isNaN(subOrderId)) {
              const claimed = await claimMutation.mutateAsync({
                orderId: subOrderId,
                claimSource: options.claimSource || "combined_group",
              });
              for (const item of mapPickerOrder(claimed).items) claimedItems.set(item.id, item);
            }
          }

          const claimedCombinedOrder = {
            ...combinedOrder,
            items: combinedOrder.items.map((item) => claimedItems.get(item.id) ?? item),
          };
          setLocalSingleQueue((prev) => {
            const existing = prev.find((o) => o.id === id);
            if (existing) {
              return prev.map((o) =>
                o.id === id ? { ...claimedCombinedOrder, status: "in_progress" as const, assignee: "You" } : o,
              );
            }
            return [...prev, { ...claimedCombinedOrder, status: "in_progress" as const, assignee: "You" }];
          });

          setActiveOrderId(id);
          setCurrentItemIndex(0);
          setView("picking");
          triggerHaptic("medium");
        } catch (error: any) {
          console.error("Failed to claim combined order:", error);
          setClaimError(
            error?.message
              ? `Could not claim group: ${error.message}`
              : "One or more orders in this group could not be claimed.",
          );
          void refetch();
          triggerHaptic("heavy");
          playSound("error");
        }
        return;
      }

      const numericId = parseInt(id);

      try {
        const orderToPick = ordersFromApi.find((o) => o.id === id);
        if (orderToPick && shouldShowReleasedPickProgress(orderToPick) && !options.allowPreservedProgress) {
          toast({
            title: "Pick progress preserved",
            description: "Use Resume to continue this partially picked order.",
            variant: "default",
          });
          return;
        }

        const claimed = await claimMutation.mutateAsync({
          orderId: numericId,
          claimSource: options.claimSource || "card_click",
        });
        const claimedOrder = mapPickerOrder({ ...apiOrders.find((order) => order.id === numericId), ...claimed });
        if (claimedOrder) {
          setLocalSingleQueue((prev) => {
            const existing = prev.find((o) => o.id === id);
            if (existing) {
              return prev.map((o) =>
                o.id === id ? { ...claimedOrder, status: "in_progress" as const, assignee: "You" } : o,
              );
            }
            return [...prev, { ...claimedOrder, status: "in_progress" as const, assignee: "You" }];
          });
        }
        setActiveOrderId(id);
        setCurrentItemIndex(0);
        setView("picking");
        triggerHaptic("medium");
      } catch (error: any) {
        console.error("Failed to claim order:", error);
        setClaimError(
          error?.message
            ? `${error.message}. The queue has been refreshed.`
            : "This order could not be claimed. The queue has been refreshed.",
        );
        void refetch();
        triggerHaptic("heavy");
        playSound("error");
      }
    }
  };

  const handleGrabNext = async () => {
    if (pickingMode === "batch") {
      const nextBatch = queue.find((b) => b.status === "ready");
      if (nextBatch) {
        void handleStartPicking(nextBatch.id);
      }
    } else {
      // Refresh data first and use the freshly fetched payload to avoid claiming stale orders
      const refreshed = await refetch();
      const sourceOrders = refreshed.data
        ? refreshed.data
            .map(mapPickerOrder)
            .filter((o) => !(o.combinedGroupId && o.combinedRole === "child"))
            .map((o) =>
              o.combinedGroupId && o.combinedRole === "parent"
                ? { ...o, id: `combined-${o.combinedGroupId}`, isCombinedGroup: true }
                : o,
            )
        : ordersFromApi;
      const freshQueue = sourceOrders.filter(
        (o) => o.status === "ready" && !o.onHold && !shouldShowReleasedPickProgress(o),
      );
      const sortedQueue = sortPickingQueueItems(freshQueue, sortBy, sortDirection);
      const nextOrder = sortedQueue[0];
      if (nextOrder) {
        void handleStartPicking(nextOrder.id, { claimSource: "grab_next" });
      } else if (sourceOrders.some((o) => o.status === "ready" && !o.onHold && shouldShowReleasedPickProgress(o))) {
        toast({
          title: "Only preserved-progress orders are ready",
          description: "Use Resume on a partially picked order to continue it.",
          variant: "default",
        });
      }
    }
  };

  const getSubOrderIds = (id: string): number[] => {
    if (id.startsWith("combined-")) {
      const combinedOrder = ordersFromApi.find((o) => o.id === id) || singleQueue.find((o) => o.id === id);
      if (combinedOrder?.combinedOrders) {
        return combinedOrder.combinedOrders
          .map((o) => parseInt(o.id))
          .filter((n) => !isNaN(n));
      }
      return [];
    }
    const numId = parseInt(id);
    return isNaN(numId) ? [] : [numId];
  };

  const handleBackToQueue = async () => {
    if (activeOrderId && pickingMode === "single") {
      const subOrderIds = getSubOrderIds(activeOrderId);
      const currentActiveOrder = singleQueue.find((o) => o.id === activeOrderId);
      const hasPickedItems = currentActiveOrder?.items.some(
        (item) => item.picked > 0 || item.status === "completed" || item.status === "short",
      );

      if (!hasPickedItems && subOrderIds.length > 0) {
        try {
          for (const subId of subOrderIds) {
            await releaseMutation.mutateAsync({ orderId: subId });
          }
        } catch (error) {
          console.error("Failed to release order:", error);
          toast({
            title: "Couldn't release picking assignment",
            description: error instanceof Error ? error.message : "Refresh the queue before retrying.",
            variant: "destructive",
          });
        }
      }
    }

    void refetch();
    setLocalSingleQueue([]);
    setView("queue");
    setActiveBatchId(null);
    setActiveOrderId(null);
    setCurrentItemIndex(0);
    setScanInput("");
  };

  const handleSyncOrders = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/shopify/sync-orders", { method: "POST" });
      const data = await response.json();
      if (data.success) {
        void refetch();
      }
    } catch (error) {
      console.error("Failed to sync orders:", error);
    } finally {
      setIsSyncing(false);
    }
  };

  // Release the picking assignment without removing holds or undoing picks.
  const releasableOrders = (id: string) => {
    const ids = getSubOrderIds(id);
    const members = ids.map((memberId) => apiOrders.find((order) => order.id === memberId));
    if (members.some((order) => !order)) return [];
    const active = members.filter((order): order is OrderWithItems => order?.warehouseStatus === "in_progress");
    return active.every((order) => canReleasePickingAssignment(pickerId, permissions, order)) ? active : [];
  };
  const canReleaseOrder = (id: string) => releasableOrders(id).length > 0;

  const handleReleaseOrder = async (orderStringId: string) => {
    if (releaseMutation.isPending) return;
    console.log("[RELEASE] Attempting to release order:", orderStringId);
    const subOrderIds = releasableOrders(orderStringId).map((order) => order.id);
    if (subOrderIds.length === 0) {
      console.error("[RELEASE] No valid order IDs found for:", orderStringId);
      toast({
        title: "Couldn't release picking assignment",
        description: "No assignment you may release was found. Refresh the queue.",
        variant: "destructive",
      });
      return;
    }

    try {
      console.log("[RELEASE] Releasing with progress preserved");
      for (const subId of subOrderIds) {
        await releaseMutation.mutateAsync({ orderId: subId });
      }
      toast({
        title: "Picking assignment released",
        description: "Picking assignment ended. Pick progress and holds are preserved.",
      });
      if (view === "picking") {
        setView("queue");
        setActiveOrderId(null);
        setCurrentItemIndex(0);
      }
    } catch (error) {
      console.error("[RELEASE] Failed to release:", error);
      toast({
        title: "Couldn't release picking assignment",
        description: error instanceof Error ? error.message : "Refresh the queue before retrying.",
        variant: "destructive",
      });
    }
  };

  return {
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
  };
}
