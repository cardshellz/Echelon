import { sendPickingCommand, PickingCommandRejectedError } from "@/lib/picking-command";
import { pickingSourcePlanSchema, type PickingSourcePlan } from "@shared/picking-source-plan";
import { sortByWalkPath } from "@shared/warehouse/walk-path";
import type { PickingAssignmentSnapshot } from "@shared/types/picking-assignment-release";
import { derivePickerLineProgress } from "@/lib/picking-progress";
import type { Order, OrderItem, ItemStatus } from "@shared/schema";

export type ReplenSourceCandidateOption = {
  locationId: number;
  locationCode: string;
  variantId: number;
  variantSku: string | null;
  variantName: string | null;
  availableQty: number;
  unitsPerVariant: number;
  qtySourceUnits: number;
  qtyTargetUnits: number;
  replenMethod: string;
};

export type ReplenPrediction = {
  systemQty: number;
  postPickQty: number;
  triggerValue: number | null;
  replenNeeded: boolean;
  replenMethod: string;
  autoReplen: number;
  stockout: boolean;
  executionMode: string;
  sourceLocationId?: number | null;
  sourceLocationCode: string | null;
  sourceQty: number;
  sourceVariantName: string | null;
  qtySourceUnits?: number;
  qtyTargetUnits?: number;
  availableSources?: ReplenSourceCandidateOption[];
  existingTaskId?: number | null;
  existingTaskStatus?: number | string | null;
  existingTaskExecutionMode?: string | null;
  existingTaskBlocksShipment?: boolean;
};

export type OrderItemWithReplen = OrderItem & {
  sourcePlan?: PickingSourcePlan;
  replenPrediction?: ReplenPrediction | null;
};

// API response type
export interface OrderWithItems extends Order {
  items: OrderItemWithReplen[];
  pickerName?: string | null;
  c2pMs?: number | null; // Click to Pick time in milliseconds
  channelName?: string | null; // Channel display name
  channelProvider?: string | null; // Provider type (shopify, ebay, amazon, manual)
}

export type ClaimSource =
  | "card_click"
  | "grab_next"
  | "active_resume"
  | "preserved_progress_resume"
  | "combined_group";

export type PickInventoryContext = {
  deducted: boolean;
  systemQtyAfter: number | null;
  locationId: number | null;
  locationCode: string | null;
  sku: string;
  binCountNeeded: boolean;
  resolution?: {
    autoResolved: boolean;
    code: string | null;
    reviewRequired: boolean;
    pickerBlocking: boolean;
    shipmentBlocking: boolean;
    message: string | null;
  };
  replen: {
    triggered: boolean;
    taskId: number | null;
    taskStatus: string | null;
    autoExecuted: boolean;
    autoExecutedMoved: number | null;
    autoExecutedMovedBaseUnits: number | null;
    autoExecutedMovedUom: string | null;
    autoExecutedFailed: boolean;
    autoExecuteFailReason: string | null;
    stockout: boolean;
    sourceLocationCode: string | null;
    sourceVariantSku: string | null;
    sourceVariantName: string | null;
    qtyToMove: number | null;
  };
};

export type PickResponse = {
  item: OrderItem;
  inventory: PickInventoryContext;
  followupPending?: boolean;
  message?: string;
};

export type ResolveAllocationResponse = {
  success: boolean;
  item?: OrderItem;
  selectedLocation?: { id: number; code: string; zone: string | null };
  autoFixedSetup?: boolean;
  reviewNeeded?: boolean;
  error?: string;
  message?: string;
};

export type BinCountResponse = {
  success: boolean;
  systemQtyBefore: number;
  actualBinQty: number;
  adjustment: number;
  replenTriggered: boolean;
  replenTaskStatus: string | null;
  replenFailReason: string | null;
  parentCycleCountTriggered: boolean;
  parentCycleCountLocationCode: string | null;
};

export interface PickItem {
  sourcePlan?: PickingSourcePlan;
  id: number;
  sku: string;
  name: string;
  location: string;
  qty: number;
  picked: number;
  status: "pending" | "in_progress" | "completed" | "short";
  orderId: string;
  /** True when this line is held: not pickable, ships on its own once released. */
  onHold: boolean;
  /**
   * Numeric WMS order id this line belongs to. `orderId` above is the display
   * order number, and a combined group's id is not a real order, so line-level
   * actions (hold) must address the owning order through this field.
   */
  wmsOrderId: number;
  image: string;
  barcode?: string;
  replenPrediction?: ReplenPrediction | null;
}

export interface PickBatch {
  id: string;
  orders: number;
  items: PickItem[];
  priority: number;
  age: string;
  zones: string[];
  status: "ready" | "in_progress" | "completed";
  assignee: string | null;
}

// Single order data for single picking mode
export interface SingleOrder {
  id: string;
  orderNumber: string;
  customer: string;
  items: PickItem[];
  priority: number;
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
  // Priority badge data populated by WMS sync at order ingest time
  shippingServiceLevel?: "standard" | "expedited" | "overnight" | null;
  memberPlanName?: string | null;
  memberPlanColor?: string | null;
}

export type PickingActiveFilter = "all" | "ready" | "active" | "rush" | "done" | "hold" | "exceptions" | "combined";
export type PickingViewState = "queue" | "picking" | "complete" | "exceptions";
export type PickingSortBy = "priority" | "items" | "order" | "age";

export type ReplenGuidanceData = {
  action: "replen_inline" | "short_pick_with_replen" | "true_short_pick";
  source?: { locationCode: string; availableQty: number; variantSku: string; variantName: string };
  targetItem?: { id: number; sku: string; location: string };
};

// API functions
export async function fetchPickingQueue({ signal }: { signal?: AbortSignal }): Promise<OrderWithItems[]> {
  const res = await fetch("/api/picking/queue", { credentials: "include", signal });
  if (!res.ok) throw new Error("Failed to fetch picking queue");
  return res.json();
}

export async function claimOrder(orderId: number, claimSource: ClaimSource): Promise<OrderWithItems> {
  const res = await fetch(`/api/picking/orders/${orderId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimSource }),
  });
  if (!res.ok) {
    // Prefer the server's structured reason so the picker sees the truth
    // (on hold / actively picked by X / not claimable) rather than a guess.
    let message = "Failed to claim order";
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // Non-JSON error body — fall back to the generic message.
    }
    throw new Error(message);
  }
  return res.json();
}

export async function releaseOrder(orderId: number, expectedAssignment: PickingAssignmentSnapshot): Promise<Order> {
  const res = await fetch(`/api/picking/orders/${orderId}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedAssignment }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(typeof body?.error === "string" ? body.error : "Failed to release picking assignment. Refresh the queue.");
  }
  return res.json();
}

const IN_PROGRESS_CONFLICT_CODES = new Set([
  "PICKING_COMMAND_IN_PROGRESS",
  "FINANCIAL_COMMAND_IN_PROGRESS",
]);

export function isDefiniteCommandRejection(status: number, body: any): boolean {
  if (status < 400 || status >= 500) return false;
  if (body?.ambiguous === true) return false;
  if (IN_PROGRESS_CONFLICT_CODES.has(String(body?.code ?? ""))) return false;
  if (status !== 409) return true;
  if (body?.commandRejected === false) return false;
  return true;
}

export function sortPickItemsByWalkPath(items: readonly PickItem[]): PickItem[] {
  return sortByWalkPath(items, (item) => {
    const code =
      item.sourcePlan?.status === "ready"
        ? item.sourcePlan.locationCode
        : item.location;
    return {
      id: item.id,
      sku: item.sku,
      code,
      isUnassigned:
        (item.sourcePlan?.status === "confirmation_only" ||
          item.sourcePlan?.status === "blocked") &&
        (!code || code === "UNASSIGNED"),
    };
  });
}

export async function unpickItem(itemId: number, qty: number, reason: string = "Picker unpick"): Promise<PickResponse> {
  return sendPickingCommand("unpick", itemId, { qty, reason }, async ({ commandId, payload }) => {
    const res = await fetch(`/api/picking/items/${itemId}/unpick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...payload, commandId }),
    });
    if (!res.ok) {
      let message = "Failed to unpick item";
      let body: any = null;
      try {
        body = await res.json();
        if (body?.error || body?.message) message = body.error || body.message;
      } catch {
        // Non-JSON error body.
      }
      throw isDefiniteCommandRejection(res.status, body) ? new PickingCommandRejectedError(message) : new Error(message);
    }
    return res.json();
  });
}

export async function holdOrder(orderId: number): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to hold order");
  return res.json();
}

export async function releaseHoldOrder(orderId: number): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/release-hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  if (!res.ok) throw new Error("Failed to remove hold");
  return res.json();
}

export async function setOrderPriority(orderId: number, priority: number | "reset"): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/priority`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ priority }),
  });
  if (!res.ok) throw new Error("Failed to set priority");
  return res.json();
}

export async function updateOrderItem(
  itemId: number,
  status: ItemStatus,
  pickedQuantity?: number,
  shortReason?: string,
  pickMethod?: "scan" | "manual" | "pick_all" | "button" | "short",
  warehouseLocationId?: number,
  options?: {
    replenSourceLocationId?: number;
    confirmFoundOnShelf?: boolean;
    confirmCaseBreak?: boolean;
  },
): Promise<PickResponse> {
  return sendPickingCommand(
    "pick",
    itemId,
    {
      status,
      pickedQuantity,
      shortReason,
      pickMethod,
      warehouseLocationId,
      ...(options?.replenSourceLocationId !== undefined
        ? { replenSourceLocationId: options.replenSourceLocationId }
        : {}),
      ...(options?.confirmFoundOnShelf !== undefined
        ? { confirmFoundOnShelf: options.confirmFoundOnShelf }
        : {}),
      ...(options?.confirmCaseBreak !== undefined
        ? { confirmCaseBreak: options.confirmCaseBreak }
        : {}),
    },
    async ({ commandId, payload }) => {
      const res = await fetch(`/api/picking/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, commandId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }));
        const message = err.message || err.error || `Failed to update item (${res.status})`;
        throw isDefiniteCommandRejection(res.status, err)
          ? new PickingCommandRejectedError(message, err?.error || err?.code, err)
          : new Error(message);
      }
      return res.json();
    },
  );
}

export async function resolveAllocationBin(itemId: number, locationCode: string): Promise<ResolveAllocationResponse> {
  const res = await fetch(`/api/picking/items/${itemId}/resolve-allocation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ locationCode }),
  });
  const data = await res.json().catch(() => ({ error: "Unknown error" }));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Failed to resolve allocation (${res.status})`);
  }
  return data;
}

export async function reportReplenSourceEmpty(itemId: number, sourceLocationCode?: string | null): Promise<{ success: boolean; taskId: number }> {
  const res = await fetch(`/api/picking/items/${itemId}/replen-source-empty`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ sourceLocationCode }),
  });
  const data = await res.json().catch(() => ({ error: "Unknown error" }));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Failed to report replen source empty (${res.status})`);
  }
  return data;
}

export async function markOrderReadyToShip(orderId: number): Promise<Order> {
  const res = await fetch(`/api/picking/orders/${orderId}/ready-to-ship`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to mark ready to ship" }));
    throw new Error(err.error || "Failed to mark ready to ship");
  }
  return res.json();
}

export async function fetchExceptions(): Promise<OrderWithItems[]> {
  const res = await fetch("/api/orders/exceptions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch exceptions");
  return res.json();
}

export async function resolveException(orderId: number, resolution: string, notes?: string): Promise<Order> {
  const res = await fetch(`/api/orders/${orderId}/resolve-exception`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ resolution, notes }),
  });
  if (!res.ok) throw new Error("Failed to resolve exception");
  return res.json();
}

export async function fetchWarehouseFifo(): Promise<{ enabled: boolean }> {
  const res = await fetch(`/api/warehouses/1/fifo`);
  if (!res.ok) return { enabled: false };
  return res.json();
}

export async function updateWarehouseFifo(enabled: boolean) {
  const res = await fetch(`/api/warehouses/1/fifo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error("Failed to update FIFO settings");
  return res.json();
}

export async function submitBinCount({
  sku,
  locationId,
  binCount,
  didReplen,
}: {
  sku: string;
  locationId: number;
  binCount: number;
  didReplen: boolean;
}): Promise<BinCountResponse> {
  const res = await fetch("/api/picking/bin-count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku, locationId, binCount, didReplen }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Failed to submit bin count" }));
    throw new Error(err.error || "Failed to submit bin count");
  }
  return res.json() as Promise<BinCountResponse>;
}

export async function fetchReplenBins(itemIds: number[]): Promise<{ replenBins: Record<string, { locationCode: string }> }> {
  const res = await fetch(`/api/picking/replen-bins?itemIds=${itemIds.join(",")}`, {
    credentials: "include",
  });
  if (!res.ok) return { replenBins: {} };
  return res.json();
}

export async function fetchReplenGuidance(orderItemId: number): Promise<ReplenGuidanceData> {
  const resp = await fetch("/api/picking/replen-guidance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderItemId }),
  });
  if (!resp.ok) {
    const errBody = await resp.json().catch(() => null);
    throw new Error(errBody?.error || `Replenishment guidance check failed (${resp.status})`);
  }
  return resp.json();
}

// Helper to calculate order age from order date
export function getOrderAge(orderDate: Date | string | null | undefined): string {
  if (!orderDate) return "0m";
  const now = new Date();
  // Handle date strings without timezone - assume UTC
  let dateStr = String(orderDate);
  // If no timezone indicator, append Z to treat as UTC
  if (!dateStr.includes("Z") && !dateStr.includes("+") && !dateStr.includes("T")) {
    dateStr = dateStr.replace(" ", "T") + "Z";
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
export function formatC2P(c2pMs: number | null | undefined): string | null {
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
export function getChannelBadgeStyle(provider: string | null | undefined): { className: string; label: string } {
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

/**
 * True when any line on this order/batch is held. A held line is not pickable,
 * so the order belongs under Hold rather than Ready.
 */
export function hasHeldLine(work: { items?: PickItem[] } | null | undefined): boolean {
  return (work?.items ?? []).some((item) => item.onHold === true);
}

export function getOrderPickProgress(items: PickItem[]) {
  const totalUnits = items.reduce((sum, item) => sum + Math.max(0, item.qty), 0);
  const pickedUnits = items.reduce((sum, item) => sum + Math.max(0, item.picked), 0);
  const pickedLines = items.filter(
    (item) => item.picked > 0 || item.status === "completed" || item.status === "short",
  ).length;

  return {
    totalUnits,
    pickedUnits,
    totalLines: items.length,
    pickedLines,
    hasProgress: pickedUnits > 0 || pickedLines > 0,
    isFullyPicked: totalUnits > 0 && pickedUnits >= totalUnits,
  };
}

export function shouldShowReleasedPickProgress(order: SingleOrder) {
  return order.status === "ready" && !order.onHold && getOrderPickProgress(order.items).hasProgress;
}

export function formatOrderDate(dateInput: string | Date | undefined | null): string {
  if (!dateInput) return "";
  let date: Date;
  if (typeof dateInput === "string") {
    const hasTimezone = dateInput.includes("Z") || dateInput.includes("+") || /\d{2}:\d{2}:\d{2}-\d{2}/.test(dateInput);
    date = new Date(hasTimezone ? dateInput : dateInput.replace(" ", "T") + "Z");
  } else {
    date = dateInput;
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function mapPickerOrder(order: OrderWithItems): SingleOrder {
  return {
    id: String(order.id),
    orderNumber: order.orderNumber,
    customer: order.customerName,
    priority: order.priority,
    age: getOrderAge(order.orderPlacedAt || order.shopifyCreatedAt || order.createdAt),
    orderDate: formatOrderDate(order.orderPlacedAt || order.shopifyCreatedAt || order.createdAt),
    status:
      order.warehouseStatus === "in_progress"
        ? "in_progress"
        : order.warehouseStatus === "completed" ||
            order.warehouseStatus === "ready_to_ship" ||
            order.warehouseStatus === "shipped"
          ? "completed"
          : "ready",
    assignee: order.assignedPickerId,
    onHold: order.onHold === 1,
    pickerName: order.pickerName || null,
    completedAt: order.completedAt ? String(order.completedAt) : null,
    c2p: formatC2P(order.c2pMs),
    channelName: order.channelName || null,
    channelProvider: order.channelProvider || null,
    combinedGroupId: order.combinedGroupId,
    combinedRole: order.combinedRole,
    shippingServiceLevel: (order as any).shippingServiceLevel,
    memberPlanName: (order as any).memberPlanName,
    memberPlanColor: (order as any).memberPlanColor,
    items: sortPickItemsByWalkPath(
      order.items
        .map((item): PickItem => {
          const progress = derivePickerLineProgress({
            quantity: item.quantity,
            pickedQuantity: item.pickedQuantity || 0,
            fulfilledQuantity: item.fulfilledQuantity || 0,
            status: item.status as PickItem["status"],
          });
          return {
            id: item.id,
            sku: item.sku,
            name: item.name,
            location: item.location,
            sourcePlan: item.sourcePlan ? pickingSourcePlanSchema.parse(item.sourcePlan) : undefined,
            qty: progress.targetQuantity,
            picked: progress.pickedQuantity,
            status: progress.status,
            orderId: order.orderNumber,
            wmsOrderId: order.id,
            onHold: item.onHold === true,
            image: item.imageUrl || "",
            barcode: item.barcode || undefined,
            replenPrediction: item.replenPrediction ?? null,
          };
        })
        .filter((item) => item.qty > 0 || item.status === "short"),
    ),
  };
}

export function groupMappedPickerOrders(allOrdersMapped: SingleOrder[]): SingleOrder[] {
  const result: SingleOrder[] = [];
  const processedGroupIds = new Set<number>();
  const ordersByCombinedGroupId = new Map<number, SingleOrder[]>();

  for (const order of allOrdersMapped) {
    if (!order.combinedGroupId) continue;
    const existing = ordersByCombinedGroupId.get(order.combinedGroupId) || [];
    existing.push(order);
    ordersByCombinedGroupId.set(order.combinedGroupId, existing);
  }

  for (const order of allOrdersMapped) {
    if (order.combinedGroupId && order.combinedRole === "child") {
      continue;
    }

    if (order.combinedGroupId && order.combinedRole === "parent") {
      if (processedGroupIds.has(order.combinedGroupId)) continue;
      processedGroupIds.add(order.combinedGroupId);

      const groupOrders = ordersByCombinedGroupId.get(order.combinedGroupId) || [order];
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

      const orderNumbers = groupOrders.map((o) => o.orderNumber).join(", ");

      result.push({
        ...order,
        id: `combined-${order.combinedGroupId}`,
        orderNumber: orderNumbers,
        items: sortPickItemsByWalkPath(allItems),
        combinedOrders: combinedOrdersList,
        isCombinedGroup: true,
      });
    } else {
      result.push(order);
    }
  }

  return result;
}

export function mergePickerSingleQueue(
  pickingMode: string,
  ordersFromApi: SingleOrder[],
  localSingleQueue: SingleOrder[],
): SingleOrder[] {
  if (pickingMode !== "single" || ordersFromApi.length === 0) {
    return localSingleQueue;
  }

  const localOrdersById = new Map(localSingleQueue.map((order) => [order.id, order]));
  const apiOrderIds = new Set(ordersFromApi.map((order) => order.id));

  const merged = ordersFromApi.map((apiOrder) => {
    const localOrder = localOrdersById.get(apiOrder.id);
    if (apiOrder.status === "completed") {
      return apiOrder;
    }
    if (!localOrder) {
      return apiOrder;
    }
    const apiItemsById = new Map(apiOrder.items.map((item) => [item.id, item]));
    return {
      ...localOrder,
      onHold: apiOrder.onHold,
      items: localOrder.items.map((localItem) => {
        const apiItem = apiItemsById.get(localItem.id);
        if (!apiItem) return localItem;
        return {
          ...localItem,
          location: apiItem.location || localItem.location,
          sourcePlan: apiItem.sourcePlan ?? localItem.sourcePlan,
          onHold: apiItem.onHold,
          barcode: apiItem.barcode || localItem.barcode,
          image: apiItem.image || localItem.image,
          replenPrediction: apiItem.replenPrediction ?? localItem.replenPrediction,
        };
      }),
    };
  });

  const completedLocalOrders = localSingleQueue.filter(
    (lo) => lo.status === "completed" && !apiOrderIds.has(lo.id),
  );
  return [...merged, ...completedLocalOrders];
}

export function parseAgeToMinutes(age: string): number {
  let total = 0;
  const hoursMatch = age.match(/(\d+)h/);
  const minsMatch = age.match(/(\d+)m/);
  if (hoursMatch) total += parseInt(hoursMatch[1], 10) * 60;
  if (minsMatch) total += parseInt(minsMatch[1], 10);
  return total;
}

export function sortPickingQueueItems<T extends PickBatch | SingleOrder>(
  items: T[],
  sortBy: PickingSortBy,
  sortDirection: "asc" | "desc",
): T[] {
  return [...items].sort((a, b) => {
    let result = 0;
    switch (sortBy) {
      case "priority": {
        const aRank = (a as any).sortRank || "";
        const bRank = (b as any).sortRank || "";
        result = aRank < bRank ? -1 : aRank > bRank ? 1 : 0;
        break;
      }
      case "items":
        result = a.items.length - b.items.length;
        break;
      case "order": {
        const aNum = "orderNumber" in a ? (a as SingleOrder).orderNumber || a.id : a.id;
        const bNum = "orderNumber" in b ? (b as SingleOrder).orderNumber || b.id : b.id;
        result = aNum.localeCompare(bNum);
        break;
      }
      case "age":
        result = parseAgeToMinutes(a.age) - parseAgeToMinutes(b.age);
        break;
      default:
        result = 0;
    }
    return sortDirection === "desc" ? -result : result;
  });
}

export function patchResolvedAllocationInPickItem(
  item: PickItem,
  updatedItem: OrderItem,
  selectedLocation?: { id: number; code: string; zone: string | null },
): PickItem {
  if (item.id !== updatedItem.id) return item;
  const nextSourcePlan =
    item.sourcePlan?.status === "blocked" && updatedItem.location && updatedItem.location !== "UNASSIGNED"
      ? selectedLocation && updatedItem.productId
        ? {
            status: "ready" as const,
            productVariantId: updatedItem.productId,
            warehouseLocationId: selectedLocation.id,
            warehouseId: null,
            locationCode: selectedLocation.code,
          }
        : undefined
      : item.sourcePlan;
  return {
    ...item,
    location: updatedItem.location,
    sourcePlan: nextSourcePlan,
  };
}

export function patchResolvedAllocationInOrderList(
  oldData: OrderWithItems[] | undefined,
  updatedItem: OrderItem,
  selectedLocation?: { id: number; code: string; zone: string | null },
): OrderWithItems[] | undefined {
  if (!oldData) return oldData;
  return oldData.map((order) => ({
    ...order,
    items: order.items.map((item) =>
      item.id === updatedItem.id
        ? {
            ...item,
            ...updatedItem,
            sourcePlan:
              (item as any).sourcePlan?.status === "blocked" && selectedLocation && updatedItem.productId
                ? {
                    status: "ready" as const,
                    productVariantId: updatedItem.productId,
                    warehouseLocationId: selectedLocation.id,
                    warehouseId: order.warehouseId ?? null,
                    locationCode: selectedLocation.code,
                  }
                : (item as any).sourcePlan,
          }
        : item,
    ),
  }));
}

export function mapExceptionOrdersToSingleOrders(exceptionOrders: OrderWithItems[]): SingleOrder[] {
  return exceptionOrders.map((order): SingleOrder => ({
    id: String(order.id),
    orderNumber: order.orderNumber,
    customer: order.customerName,
    priority: order.priority,
    age: getOrderAge(order.orderPlacedAt || order.shopifyCreatedAt || order.createdAt),
    status: "ready" as const,
    assignee: order.assignedPickerId,
    onHold: false,
    pickerName: order.pickerName || null,
    completedAt: order.completedAt ? String(order.completedAt) : null,
    items: order.items.map((item): PickItem => {
      const validStatuses = ["pending", "in_progress", "completed", "short"];
      const status = validStatuses.includes(item.status)
        ? (item.status as "pending" | "in_progress" | "completed" | "short")
        : "pending";
      return {
        id: item.id,
        sku: item.sku,
        name: item.name,
        location: item.location,
        sourcePlan: item.sourcePlan ? pickingSourcePlanSchema.parse(item.sourcePlan) : undefined,
        qty: item.quantity,
        picked: item.pickedQuantity,
        status,
        orderId: order.orderNumber,
        wmsOrderId: order.id,
        onHold: (item as { onHold?: boolean }).onHold === true,
        image: item.imageUrl || "",
        barcode: item.barcode || undefined,
        replenPrediction: item.replenPrediction ?? null,
      };
    }),
  }));
}

export function findNextPendingItemIndex(items: PickItem[], currentItemIndex: number): number {
  for (let i = currentItemIndex + 1; i < items.length; i++) {
    if (items[i].status === "pending" || items[i].status === "in_progress") {
      return i;
    }
  }
  for (let i = 0; i < currentItemIndex; i++) {
    if (items[i].status === "pending" || items[i].status === "in_progress") {
      return i;
    }
  }
  return -1;
}
