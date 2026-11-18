import type { InventoryAvailabilityClaimStore } from "./inventory-availability-claim.port";

export interface OrderClaimVariantReader {
  listClaimedVariantIds(orderIds: readonly number[]): Promise<readonly number[]>;
}
/** Records "this SKU's sellable quantity changed" for the publication worker. */
export type InventoryChangeAnnouncer = (productVariantId: number, triggeredBy: string) => Promise<void>;
type Log = (entry: Readonly<Record<string, unknown>>) => void;

const TRIGGER = "order_claim";

/**
 * An order claiming or releasing stock changes what every channel may sell, so
 * the affected products are marked for the publication worker as soon as the
 * claim commits. Before this, a claim changed nothing on the channels until the
 * order was picked or shipped.
 *
 * The mark runs after the claim's own transaction, like every warehouse
 * operation: channel planning must never fail or slow a claim. A failed mark is
 * therefore logged and NOT thrown. Throwing would tell the caller a committed
 * claim failed, and some callers compensate by releasing it. The next stock
 * change on the product, or the scheduled sweep, republishes the quantity.
 * Idempotent replays mark again on purpose: a replay may be the retry of a call
 * whose mark failed, and an unchanged quantity is never re-sent.
 */
export function withChannelQuantityUpdates(
  store: InventoryAvailabilityClaimStore,
  dependencies: { variants: OrderClaimVariantReader; announce: InventoryChangeAnnouncer; log?: Log },
): InventoryAvailabilityClaimStore {
  const log: Log = dependencies.log ?? (entry => console.error(JSON.stringify(entry)));
  const announceOrders = async (orderIds: readonly number[], action: string): Promise<void> => {
    try {
      const variantIds = await dependencies.variants.listClaimedVariantIds(orderIds);
      for (const variantId of variantIds) await dependencies.announce(variantId, TRIGGER);
    } catch (error) {
      log({ level: "error", action, outcome: "channel_quantity_mark_failed",
        error_code: "ORDER_CLAIM_CHANNEL_QUANTITY_MARK_FAILED", wms_order_ids: [...orderIds],
        error: error instanceof Error ? error.message : String(error) });
    }
  };
  return {
    getReservationStatus: command => store.getReservationStatus(command),
    executePackageOperation: command => store.executePackageOperation(command),
    executeBuildOperation: command => store.executeBuildOperation(command),
    handoffBuildOperation: command => store.handoffBuildOperation(command),
    pickClaimLine: command => store.pickClaimLine(command),
    unpickClaimLine: command => store.unpickClaimLine(command),
    reconcileCycleCount: command => store.reconcileCycleCount(command),
    async claimOrder(command) {
      const result = await store.claimOrder(command);
      if (result.outcome !== "no_claim_required") await announceOrders([result.orderId], "order_claim");
      return result;
    },
    async releaseOrderClaim(command) {
      const result = await store.releaseOrderClaim(command);
      if (result.outcome !== "no_claim_required") await announceOrders([result.orderId], "order_claim_release");
      return result;
    },
    async replaceOrderClaim(command) {
      const result = await store.replaceOrderClaim(command);
      await announceOrders([result.orderId], "order_claim_replace");
      return result;
    },
    async displaceForConfirmedShipment(command) {
      const result = await store.displaceForConfirmedShipment(command);
      await announceOrders([result.orderId, ...result.displacedOrderIds], "order_claim_displace");
      return result;
    },
  };
}
