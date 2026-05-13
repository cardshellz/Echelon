export type ActionFilter =
  | "all"
  | "negative_inventory"
  | "aging_receiving"
  | "pallet_drop"
  | "stuck_replen"
  | "stale_bin";

export interface ActionQueueCounts {
  negative_inventory: number;
  aging_receiving: number;
  pallet_drop: number;
  stuck_replen: number;
  stale_bin: number;
}

export interface ActionQueueItem {
  id: string;
  type: Exclude<ActionFilter, "all">;
  priority: number;
  locationId: number;
  locationCode: string;
  locationType: string;
  variantId: number | null;
  sku: string | null;
  name: string | null;
  qty: number | null;
  detail: string | null;
  action: "adjust" | "replenish" | "move" | "investigate";
  bulkAvailable: number | null;
  pendingReplenStatus: string | null;
  daysSinceMovement: number | null;
  skuCount: number | null;
  hoursAging: number | null;
  taskId: number | null;
  fromLocationId: number | null;
  fromLocationCode: string | null;
}

export interface ActionQueueResponse {
  items: ActionQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: ActionQueueCounts;
}

export type PickReplenHealthFilter =
  | "all"
  | "stuck_replen"
  | "stale_replen_no_demand"
  | "duplicate_replen"
  | "short_pick_unresolved"
  | "open_allocation_exception"
  | "cycle_count_review"
  | "exception_order_no_blocker"
  | "pick_bin_needs_replen";

export interface PickReplenHealthCounts {
  stuck_replen: number;
  stale_replen_no_demand: number;
  duplicate_replen: number;
  short_pick_unresolved: number;
  open_allocation_exception: number;
  cycle_count_review: number;
  exception_order_no_blocker: number;
  pick_bin_needs_replen: number;
}

export interface PickReplenHealthItem {
  id: string;
  type: Exclude<PickReplenHealthFilter, "all">;
  priority: number;
  taskId: number | null;
  exceptionId: number | null;
  cycleCountId: number | null;
  orderId: number | null;
  orderNumber: string | null;
  orderItemId: number | null;
  variantId: number | null;
  sku: string | null;
  name: string | null;
  locationId: number | null;
  locationCode: string | null;
  sourceLocationCode: string | null;
  status: string | null;
  exceptionReason: string | null;
  qty: number | null;
  ageHours: number | null;
  createdAt: string | null;
  detail: string | null;
  action: string;
}

export interface PickReplenHealthResponse {
  items: PickReplenHealthItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: PickReplenHealthCounts;
}
