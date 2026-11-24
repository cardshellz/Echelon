/**
 * Single-Owner Inventory Adjustment & Discrepancy Reconciliation Contract (`WH-1` / `CI-03`)
 *
 * Canonical domain entry point for Cycle-Count Net Adjustments, Picker
 * Found-on-Shelf / Short-Pick Zeroing Discrepancies, and Governed Supervisor
 * Stock Adjustments.
 */
import type { InventoryUseCases } from "./application/inventory.use-cases";
import type { OperationalQuantityPosting } from "./infrastructure/operational-quantity-posting";

export type AdjustOrReconcileStockParams = Parameters<InventoryUseCases["adjustInventory"]>[0];
export type AdjustOrReconcileStockResult = Awaited<ReturnType<InventoryUseCases["adjustInventory"]>>;

export async function adjustOrReconcileStock<TResult = AdjustOrReconcileStockResult>(
  owner: {
    adjustInventory: (
      params: AdjustOrReconcileStockParams,
      sharedPosting?: OperationalQuantityPosting,
    ) => Promise<TResult>;
  },
  params: AdjustOrReconcileStockParams,
  sharedPosting?: OperationalQuantityPosting,
): Promise<TResult> {
  return sharedPosting !== undefined
    ? owner.adjustInventory(params, sharedPosting)
    : owner.adjustInventory(params);
}
