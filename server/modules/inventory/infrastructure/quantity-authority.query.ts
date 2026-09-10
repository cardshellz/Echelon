import { pool } from "../../../db";

export async function readInventoryQuantityCapabilities(): Promise<{ legacyQuantityImportAllowed: boolean }> {
  const opening = await pool.query("SELECT command_id FROM inventory.quantity_ledger_opening WHERE singleton_key = true");
  return { legacyQuantityImportAllowed: opening.rows.length === 0 };
}
