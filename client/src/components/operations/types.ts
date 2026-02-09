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
}

export interface ActionQueueResponse {
  items: ActionQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: ActionQueueCounts;
}
