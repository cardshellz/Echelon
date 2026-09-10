import { sql } from "drizzle-orm";
import type { QuantityDrizzleTransaction } from "../infrastructure/operational-quantity-posting";
import { InventoryQuantityError } from "../domain/quantity-ledger";

/** Guard retired import entrypoints before provider I/O or partial batch work.
 * The database projection guard independently rejects a concurrent cutover race.
 * Cost-only corrections are not stock receipts and remain with their cost owner.
 */
export async function assertLegacyQuantityImportAllowed(client: QuantityDrizzleTransaction, source: string): Promise<void> {
  const result = await client.execute(sql`SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true`);
  if (!result || typeof result !== "object" || !Array.isArray((result as { rows?: unknown }).rows)) {
    throw new InventoryQuantityError("QUANTITY_AUTHORITY_RESULT_INVALID", "Could not verify the inventory quantity owner");
  }
  if ((result as { rows: unknown[] }).rows.length !== 0) throw new InventoryQuantityError("QUANTITY_LEGACY_WRITER_RETIRED",
    `${source} cannot create stock after the verified opening. Use inventory receiving or an audited inventory adjustment; use cost correction to change only valuation.`);
}
