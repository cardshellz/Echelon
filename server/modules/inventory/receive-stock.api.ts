/**
 * Single-Owner Inbound Receipt & Reversal Command Contract (`WH-1` / `CI-03`)
 *
 * Canonical domain entry point for recording physical stock receipts and
 * receipt reversals across PO, Inbound Shipment, Blind Receipt, and governed
 * supervisor stock intake.
 */
import type { InventoryUseCases } from "./application/inventory.use-cases";

export type ReceiveStockParams = Parameters<InventoryUseCases["receiveInventory"]>[0];
export type ReverseReceiptStockParams = Parameters<InventoryUseCases["reverseReceiptInventory"]>[0];
export type ReverseReceiptStockResult = Awaited<ReturnType<InventoryUseCases["reverseReceiptInventory"]>>;

export { InsufficientOnHandForReversalError } from "./application/inventory.use-cases";

export async function receiveStock(
  owner: Pick<InventoryUseCases, "receiveInventory">,
  params: ReceiveStockParams,
  externalTx?: unknown,
): Promise<void> {
  return owner.receiveInventory(params, externalTx);
}

export async function reverseReceiptStock(
  owner: Pick<InventoryUseCases, "reverseReceiptInventory">,
  params: ReverseReceiptStockParams,
  externalTx?: unknown,
): Promise<ReverseReceiptStockResult> {
  return owner.reverseReceiptInventory(params, externalTx);
}
