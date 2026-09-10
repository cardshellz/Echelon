import type { QuantityBalance, QuantityCommand, QuantityIdentity } from "../domain/quantity-ledger";

/** The caller owns BEGIN/COMMIT and all business receipts, costs and outbox writes. */
export interface InventoryQuantityTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface InventoryQuantityPostingResult {
  commandId: string;
  requestHash: string;
  alreadyApplied: boolean;
  balances: readonly (QuantityIdentity & { before: QuantityBalance; after: QuantityBalance })[];
}

export interface InventoryQuantityPostingPort {
  postInsideTransaction(client: InventoryQuantityTransaction, command: QuantityCommand): Promise<InventoryQuantityPostingResult>;
}
