import type { InventoryCutoverFenceReceipt, InventoryCutoverFenceRequest } from "../domain/inventory-cutover-admission-fence";

/** Capability held only within the transaction that owns the global barrier. */
export interface InventoryCutoverAdmissionFenceOwner<TTransaction> {
  acquire(transaction: TTransaction, request: InventoryCutoverFenceRequest): Promise<InventoryCutoverFenceReceipt>;
  assertHeld(transaction: TTransaction): Promise<string>;
}
