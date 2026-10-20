import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as schema from "@shared/schema";

/** Empty read-path prerequisites use the actual schema definitions. Physical
 * return acceptance must install the production migration below instead. */
export const supplierReturnReadFixtureTables = [
  schema.supplierReturns, schema.supplierReturnLines, schema.supplierReturnAllocations,
  schema.supplierReturnCostEntries, schema.supplierReturnCreditEntitlements,
  schema.supplierReturnCreditLinks, schema.supplierReturnReportingEvents,
  schema.supplierReturnCreditReviews, schema.supplierReturnFollowups,
];

export async function installSupplierReturnCompletionFixture(pool: {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<void> {
  // Pre-opening cost fixtures intentionally have no active quantity journal.
  // Install its real command declaration solely for the migration's additive
  // kind constraint; active-ledger acceptance installs all of migration 242.
  const exists = await pool.query("SELECT to_regclass('inventory.quantity_commands') AS relation");
  if (exists.rows[0].relation === null) {
    const ledger = readFileSync(resolve(process.cwd(), "migrations/242_inventory_quantity_ledger.sql"), "utf8");
    const start = ledger.indexOf("CREATE TABLE inventory.quantity_commands (");
    const end = ledger.indexOf("CREATE TABLE inventory.quantity_entries (");
    if (start < 0 || end <= start) throw new Error("Quantity command fixture migration boundaries changed.");
    await pool.query(ledger.slice(start, end));
  }
  const graph = await pool.query("SELECT to_regprocedure('procurement.lock_ap_payment_graph()') AS routine");
  if (graph.rows[0].routine === null) {
    const payment = readFileSync(resolve(process.cwd(), "migrations/900000016000018570001_ap_payment_balance_completion.sql"), "utf8");
    const routine = payment.match(/CREATE OR REPLACE FUNCTION procurement\.lock_ap_payment_graph\(\)[\s\S]*?\$\$;/)?.[0];
    if (!routine) throw new Error("AP graph fixture migration boundary changed.");
    await pool.query(routine);
  }
  await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000019000018680001_supplier_return_completion.sql"), "utf8"));
}

/** Only the owning disposable fixture uses this around its existing reset. */
export async function withSupplierReturnFixtureReset(pool: {
  query(text: string): Promise<unknown>;
}, reset: () => Promise<void>): Promise<void> {
  const tables = ["procurement.supplier_returns", "procurement.supplier_return_lines",
    "inventory.supplier_return_allocations", "inventory.supplier_return_cost_entries",
    "procurement.supplier_return_credit_entitlements", "procurement.supplier_return_credit_links",
    "procurement.supplier_return_reporting_events", "procurement.supplier_return_credit_reviews"];
  for (const table of tables) await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER supplier_return_history_no_truncate`);
  try { await reset(); }
  finally {
    for (const table of tables) await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER supplier_return_history_no_truncate`);
  }
}
