import {
  isOpenHeldLine,
  isOrderLevelHold,
  isTerminalOrder,
  normalizeWmsStatus,
} from "./wms-hold-release";

export const WMS_ORDER_BUCKETS = [
  "needs_pick",
  "picked",
  "hold",
  "issues",
  "shipped",
  "cancelled",
  "all",
] as const;

export type WmsOrderBucket = (typeof WMS_ORDER_BUCKETS)[number];

export interface WmsOrderListItem {
  sku?: string | null;
  name?: string | null;
  title?: string | null;
  /** Line-hold evidence for the hold bucket. Absent means "not held". */
  onHold?: boolean | null;
  status?: string | null;
  quantity?: number | null;
}

export interface WmsOrderListOrder {
  id: number;
  orderNumber?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  externalOrderId?: string | null;
  source?: string | null;
  channelId?: number | null;
  warehouseId?: number | null;
  warehouseStatus?: string | null;
  onHold?: number | boolean | null;
  createdAt?: Date | string | null;
  items?: WmsOrderListItem[] | null;
}

export interface WmsOrderBucketCounts {
  needsPick: number;
  picked: number;
  hold: number;
  issues: number;
  shipped: number;
  cancelled: number;
  all: number;
}

export interface WmsOrderScopeFilters {
  channelId?: number;
  warehouseId?: number;
  source?: string;
  search?: string;
}

// Also used by the database read model so pagination preserves bucket policy.
// Membership of `hold` is not status-based; see isWmsOrderInHoldQueue. The
// legacy 'on_hold' status counts as an order-level hold, so it files under hold.
export const WMS_BUCKET_STATUSES = {
  needs_pick: ["ready", "in_progress", "partially_shipped"],
  picked: ["completed", "ready_to_ship"],
  issues: ["exception"],
  shipped: ["shipped"],
  cancelled: ["cancelled"],
} as const;
const NEEDS_PICK_STATUSES = new Set<string>(WMS_BUCKET_STATUSES.needs_pick);
const PICKED_STATUSES = new Set<string>(WMS_BUCKET_STATUSES.picked);
const ISSUE_STATUSES = new Set<string>(WMS_BUCKET_STATUSES.issues);
const SHIPPED_STATUSES = new Set<string>(WMS_BUCKET_STATUSES.shipped);
const CANCELLED_STATUSES = new Set<string>(WMS_BUCKET_STATUSES.cancelled);

const EMPTY_BUCKET_COUNTS: WmsOrderBucketCounts = {
  needsPick: 0,
  picked: 0,
  hold: 0,
  issues: 0,
  shipped: 0,
  cancelled: 0,
  all: 0,
};

// Every order lands in at most one of these; "all" counts every order.
const COUNTED_BUCKETS: ReadonlyArray<[Exclude<WmsOrderBucket, "all">, keyof WmsOrderBucketCounts]> = [
  ["hold", "hold"],
  ["issues", "issues"],
  ["needs_pick", "needsPick"],
  ["picked", "picked"],
  ["shipped", "shipped"],
  ["cancelled", "cancelled"],
];

export function parseWmsOrderBucket(value: unknown): WmsOrderBucket {
  if (typeof value !== "string") return "needs_pick";
  const normalized = value.trim().toLowerCase();
  return WMS_ORDER_BUCKETS.includes(normalized as WmsOrderBucket)
    ? (normalized as WmsOrderBucket)
    : "needs_pick";
}

export function isWmsOrderBucket(value: unknown): value is WmsOrderBucket {
  return typeof value === "string" && WMS_ORDER_BUCKETS.includes(value.trim().toLowerCase() as WmsOrderBucket);
}

export function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function parsePagination(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function normalizeSearchTerm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function isWmsOrderOnHold(order: Pick<WmsOrderListOrder, "onHold" | "warehouseStatus">): boolean {
  return isOrderLevelHold(order);
}

/**
 * The order is waiting on a release: the whole order is held, or one of its
 * lines is. A line hold leaves the order flag alone, so without the line check
 * an order whose held line is all that is left would show in no hold view.
 * Shipped and cancelled orders never qualify, whatever flag was left behind.
 */
export function isWmsOrderInHoldQueue(order: WmsOrderListOrder): boolean {
  if (isTerminalOrder(order)) return false;
  return isOrderLevelHold(order) || (order.items ?? []).some(isOpenHeldLine);
}

export function orderMatchesBucket(order: WmsOrderListOrder, bucket: WmsOrderBucket): boolean {
  if (bucket === "all") return true;

  const status = normalizeWmsStatus(order.warehouseStatus);
  if (bucket === "shipped") return SHIPPED_STATUSES.has(status);
  if (bucket === "cancelled") return CANCELLED_STATUSES.has(status);

  // Hold wins over every open bucket: a held order needs a person to act.
  const inHoldQueue = isWmsOrderInHoldQueue(order);
  if (bucket === "hold") return inHoldQueue;
  if (inHoldQueue) return false;

  if (bucket === "issues") return ISSUE_STATUSES.has(status);
  if (bucket === "needs_pick") return NEEDS_PICK_STATUSES.has(status);
  if (bucket === "picked") return PICKED_STATUSES.has(status);
  return false;
}

export function orderMatchesScope(order: WmsOrderListOrder, filters: WmsOrderScopeFilters): boolean {
  if (filters.channelId !== undefined && order.channelId !== filters.channelId) return false;
  if (filters.warehouseId !== undefined && order.warehouseId !== filters.warehouseId) return false;
  if (filters.source && order.source !== filters.source) return false;
  if (filters.search && !orderMatchesSearch(order, filters.search)) return false;
  return true;
}

export function orderMatchesSearch(order: WmsOrderListOrder, normalizedSearch: string): boolean {
  const fields = [
    order.orderNumber,
    order.customerName,
    order.customerEmail,
    order.externalOrderId,
  ];

  for (const field of fields) {
    if (stringIncludes(field, normalizedSearch)) return true;
  }

  for (const item of order.items ?? []) {
    if (stringIncludes(item.sku, normalizedSearch) || stringIncludes(item.name, normalizedSearch) || stringIncludes(item.title, normalizedSearch)) {
      return true;
    }
  }

  return false;
}

export function buildWmsOrderBucketCounts(orders: WmsOrderListOrder[]): WmsOrderBucketCounts {
  const counts = { ...EMPTY_BUCKET_COUNTS };

  for (const order of orders) {
    counts.all += 1;
    const match = COUNTED_BUCKETS.find(([bucket]) => orderMatchesBucket(order, bucket));
    if (match) counts[match[1]] += 1;
  }

  return counts;
}

export function compareWmsOrdersNewestFirst(a: WmsOrderListOrder, b: WmsOrderListOrder): number {
  return toTime(b.createdAt) - toTime(a.createdAt);
}

function stringIncludes(value: string | null | undefined, normalizedSearch: string): boolean {
  return String(value ?? "").toLowerCase().includes(normalizedSearch);
}

function toTime(value: Date | string | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
