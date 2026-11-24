/**
 * Single-Owner Bin-to-Bin Transfer & Reversal Command Contract (`WH-1` / `CI-03`)
 *
 * Canonical domain entry point for Directed Putaway, Manual Bin Transfers,
 * Replenishment Direct Moves, Cycle-Count Misplacement Transfers, Inter-Warehouse
 * Legs, and Append-Only Reverse Transfers.
 */
import type { InventoryUseCases } from "./application/inventory.use-cases";
import type { ManualInventoryTransferService } from "./application/manual-inventory-transfer.service";
import type { InventoryTransaction } from "@shared/schema";

export type TransferStockParams = Parameters<InventoryUseCases["transfer"]>[0];
export type TransferStockResult = Awaited<ReturnType<InventoryUseCases["transfer"]>>;

export { ManualInventoryTransferService } from "./application/manual-inventory-transfer.service";
export { FreezeViolationError } from "./application/inventory.use-cases";

export async function transferStock(
  owner: Pick<InventoryUseCases, "transfer">,
  params: TransferStockParams,
): Promise<TransferStockResult> {
  return owner.transfer(params);
}

export async function reverseTransferStock(
  owner: Pick<InventoryUseCases, "undoTransfer">,
  transactionId: number,
  userId: string,
): Promise<InventoryTransaction> {
  return owner.undoTransfer(transactionId, userId);
}
