import type { db as applicationDatabase } from "../../db";
import { readPurchasePlanningSupply } from "./purchase-planning-receipt-supply.repository";
import { emptyPurchasePlanningSupplyPosition, type PurchasePlanningSupplyPosition } from "./purchase-planning-receipt-supply";

export type PurchasePlanningDatabase = Pick<typeof applicationDatabase, "transaction">;
export type PurchasePlanningTransaction = Parameters<Parameters<PurchasePlanningDatabase["transaction"]>[0]>[0];

/** One source snapshot for stock, forecast inputs and receipt-aware open supply.
 * Physical receiving and its later PO mirror reconciliation use separate writer
 * transactions, so read committed is not a coherent purchasing position. */
export async function readPurchasePlanningSnapshot<Row extends { product_id: number | string }>(
  database: PurchasePlanningDatabase,
  loadStockAndDemand: (tx: PurchasePlanningTransaction) => Promise<Row[]>,
): Promise<Array<Row & PurchasePlanningSupplyPosition>> {
  return database.transaction(async (tx) => {
    const rows = await loadStockAndDemand(tx);
    const supply = await readPurchasePlanningSupply(tx);
    return rows.map((row) => ({ ...row, ...(supply.get(Number(row.product_id)) ?? emptyPurchasePlanningSupplyPosition()) }));
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
