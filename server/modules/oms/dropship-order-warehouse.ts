/**
 * Warehouse authority for Dropship orders inside WMS sync.
 *
 * A Dropship order's warehouse is decided once, at acceptance, from the store
 * connection's default warehouse: acceptance locks inventory there and writes
 * it to oms_orders.warehouse_id. WMS sync must fulfil from that same warehouse
 * instead of asking the generic fulfillment router; otherwise the quantity the
 * vendor was shown (Channel Allocation over the Dropship OMS warehouses), the
 * stock that was locked, and the stock that ships could be three different
 * warehouses. Pure: every fact is loaded by the caller.
 */

export type WmsDropshipWarehouseErrorCode =
  /** The order has no warehouse although acceptance always pins one. */
  | "WMS_SYNC_DROPSHIP_WAREHOUSE_REQUIRED"
  /** The pinned warehouse no longer exists or is inactive. */
  | "WMS_SYNC_DROPSHIP_WAREHOUSE_INACTIVE"
  /** The pinned warehouse is not an enabled Dropship OMS assignment. */
  | "WMS_SYNC_DROPSHIP_WAREHOUSE_NOT_ALLOCATED";

/** Permanent by nature: retrying without a configuration change cannot succeed. */
export class WmsDropshipWarehouseError extends Error {
  readonly classification = "permanent" as const;

  constructor(
    readonly code: WmsDropshipWarehouseErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "WmsDropshipWarehouseError";
  }
}

export interface DropshipOrderIdentity {
  omsOrderChannelId: number | null;
  /** The resolved Dropship OMS channel id, or null when it could not be resolved. */
  dropshipOmsChannelId: number | null;
  /** True when acceptance stamped `raw_payload.dropship` on the OMS order. */
  hasDropshipAcceptanceStamp: boolean;
}

export interface DropshipOrderWarehouseFacts extends DropshipOrderIdentity {
  omsOrderId: number;
  omsOrderWarehouseId: number | null;
  /** The warehouse row behind omsOrderWarehouseId, or null when it does not exist. */
  warehouse: { id: number; isActive: number; warehouseType: string } | null;
  /** Whether that warehouse is an enabled assignment of the order's channel. */
  enabledForChannel: boolean;
}

export type DropshipOrderWarehouseDecision =
  | { kind: "not_dropship" }
  | { kind: "pinned"; warehouseId: number; warehouseType: string };

/**
 * A Dropship order is one on the Dropship OMS channel. The acceptance stamp is
 * the belt-and-braces signal: if the channel could not be resolved, an order
 * that acceptance wrote must still never fall through to the generic router.
 */
export function isDropshipOmsOrder(identity: DropshipOrderIdentity): boolean {
  if (identity.hasDropshipAcceptanceStamp) return true;
  return identity.dropshipOmsChannelId !== null
    && identity.omsOrderChannelId === identity.dropshipOmsChannelId;
}

/** Reads the acceptance stamp without trusting the payload's shape. */
export function hasDropshipAcceptanceStamp(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return false;
  const stamp = (rawPayload as { dropship?: unknown }).dropship;
  return Boolean(stamp && typeof stamp === "object" && !Array.isArray(stamp));
}

export function decideDropshipOrderWarehouse(
  facts: DropshipOrderWarehouseFacts,
): DropshipOrderWarehouseDecision {
  if (!isDropshipOmsOrder(facts)) return { kind: "not_dropship" };

  const warehouseId = facts.omsOrderWarehouseId;
  const context = {
    omsOrderId: facts.omsOrderId,
    channelId: facts.omsOrderChannelId,
    warehouseId,
  };
  if (warehouseId === null || !Number.isSafeInteger(warehouseId) || warehouseId <= 0) {
    throw new WmsDropshipWarehouseError(
      "WMS_SYNC_DROPSHIP_WAREHOUSE_REQUIRED",
      "Dropship order has no accepted warehouse; acceptance must pin one before WMS sync.",
      context,
    );
  }
  if (!facts.warehouse || facts.warehouse.id !== warehouseId || facts.warehouse.isActive !== 1) {
    throw new WmsDropshipWarehouseError(
      "WMS_SYNC_DROPSHIP_WAREHOUSE_INACTIVE",
      "Dropship order's accepted warehouse is missing or inactive.",
      { ...context, warehouseFound: facts.warehouse !== null, isActive: facts.warehouse?.isActive ?? null },
    );
  }
  if (!facts.enabledForChannel) {
    throw new WmsDropshipWarehouseError(
      "WMS_SYNC_DROPSHIP_WAREHOUSE_NOT_ALLOCATED",
      "Dropship order's accepted warehouse is not enabled for the Dropship OMS channel in Channel Allocation.",
      context,
    );
  }
  return { kind: "pinned", warehouseId, warehouseType: facts.warehouse.warehouseType };
}
