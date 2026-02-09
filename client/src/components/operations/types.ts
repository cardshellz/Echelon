export type ActionFilter =
  | "all"
  | "negative_inventory"
  | "empty_pick_face"
  | "stale_bin"
  | "pending_replen"
  | "unassigned";

export interface ActionQueueCounts {
  negative_inventory: number;
  empty_pick_face: number;
  stale_bin: number;
  pending_replen: number;
  unassigned: number;
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
  action: "adjust" | "replenish" | "move";
  bulkAvailable: number | null;
  pendingReplenStatus: string | null;
  daysSinceMovement: number | null;
  skuCount: number | null;
}

export interface ActionQueueResponse {
  items: ActionQueueItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: ActionQueueCounts;
}
