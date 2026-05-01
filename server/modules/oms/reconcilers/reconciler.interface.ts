import type { OmsOrder } from "@shared/schema";

export type ReconciliationStatus = "fulfilled" | "unfulfilled" | "unknown";

export interface FulfillmentReconciler {
  /**
   * Check the current state of the order on the external channel API.
   * Returns "fulfilled" if the channel considers it shipped.
   * Returns "unfulfilled" if the channel still thinks it's waiting for shipment.
   */
  checkStatus(order: OmsOrder): Promise<ReconciliationStatus>;

  /**
   * Repush the tracking information to the external channel API.
   * Returns true if the push succeeded (or was idempotent).
   */
  repush(order: OmsOrder): Promise<boolean>;
}
