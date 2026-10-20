import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type pg from "pg";

const tables = [
  "procurement.receipt_shipment_quantity_amendments",
  "procurement.receipt_shipment_quantity_results",
  "inventory.lot_cost_origin_amendments",
] as const;
/** Reduced integration databases still install the actual amendment schema and
 * effective origin view. Their reset restores every production guard atomically. */
export async function installQuantityAmendmentFixture(client: {
  query(text: string): Promise<unknown>;
}) {
  await client.query(
    readFileSync(
      resolve(
        process.cwd(),
        "migrations/900000017000018590001_receipt_shipment_quantity_amendments.sql",
      ),
      "utf8",
    ),
  );
}
export async function quantityAmendmentResetGuard(
  client: pg.PoolClient,
  enabled: boolean,
) {
  for (const table of tables) {
    const present = await client.query("SELECT to_regclass($1) AS relation", [
      table,
    ]);
    if (present.rows[0].relation)
      await client.query(
        `ALTER TABLE ${table} ${enabled ? "ENABLE" : "DISABLE"} TRIGGER quantity_amendment_no_truncate`,
      );
  }
}
export async function resetQuantityAmendmentFixture(
  pool: pg.Pool,
  statement: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await quantityAmendmentResetGuard(client, false);
    await client.query(statement);
    await quantityAmendmentResetGuard(client, true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
