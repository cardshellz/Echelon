export const WMS_ORDER_BUCKETS = [
  "needs_pick",
  "picked",
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

const NEEDS_PICK_STATUSES = new Set(["ready", "in_progress", "partially_shipped"]);
const PICKED_STATUSES = new Set(["completed", "ready_to_ship"]);
const ISSUE_STATUSES = new Set(["exception", "on_hold"]);
const SHIPPED_STATUSES = new Set(["shipped"]);
const CANCELLED_STATUSES = new Set(["cancelled"]);

const EMPTY_BUCKET_COUNTS: WmsOrderBucketCounts = {
  needsPick: 0,
  picked: 0,
  issues: 0,
  shipped: 0,
  cancelled: 0,
  all: 0,
};

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
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function parsePagination(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function normalizeSearchTerm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

export function isWmsOrderOnHold(order: Pick<WmsOrderListOrder, "onHold" | "warehouseStatus">): boolean {
  return order.onHold === true || Number(order.onHold ?? 0) === 1 || normalizeStatus(order.warehouseStatus) === "on_hold";
}

export function orderMatchesBucket(order: WmsOrderListOrder, bucket: WmsOrderBucket): boolean {
  if (bucket === "all") return true;
  if (bucket === "issues") return isWmsOrderOnHold(order) || ISSUE_STATUSES.has(normalizeStatus(order.warehouseStatus));

  if (isWmsOrderOnHold(order)) return false;

  const status = normalizeStatus(order.warehouseStatus);
  if (bucket === "needs_pick") return NEEDS_PICK_STATUSES.has(status);
  if (bucket === "picked") return PICKED_STATUSES.has(status);
  if (bucket === "shipped") return SHIPPED_STATUSES.has(status);
  if (bucket === "cancelled") return CANCELLED_STATUSES.has(status);
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

    if (orderMatchesBucket(order, "issues")) {
      counts.issues += 1;
      continue;
    }

    if (orderMatchesBucket(order, "needs_pick")) counts.needsPick += 1;
    else if (orderMatchesBucket(order, "picked")) counts.picked += 1;
    else if (orderMatchesBucket(order, "shipped")) counts.shipped += 1;
    else if (orderMatchesBucket(order, "cancelled")) counts.cancelled += 1;
  }

  return counts;
}

export function compareWmsOrdersNewestFirst(a: WmsOrderListOrder, b: WmsOrderListOrder): number {
  return toTime(b.createdAt) - toTime(a.createdAt);
}

function normalizeStatus(status: string | null | undefined): string {
  return String(status ?? "").trim().toLowerCase();
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
