import type pg from "pg";
import { quantityAmendmentResetGuard } from "./quantity-amendment-fixture";

/** Only for caller-owned schemas in an explicitly disposable test database.
 * The same connection restores all production guards before committing a reset. */
export async function resetFixtureCostHistory(pool: pg.Pool, statement: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await quantityAmendmentResetGuard(client,false);
    await client.query(`ALTER TABLE inventory.cost_reconciliation_approvals DISABLE TRIGGER cost_reconciliation_approval_no_truncate;
      ALTER TABLE inventory.cost_reconciliation_postings DISABLE TRIGGER cost_reconciliation_posting_no_truncate;
      ALTER TABLE inventory.cost_origin_repairs DISABLE TRIGGER cost_origin_repair_no_truncate`);
    await client.query(statement);
    await client.query(`ALTER TABLE inventory.cost_reconciliation_approvals ENABLE TRIGGER cost_reconciliation_approval_no_truncate;
      ALTER TABLE inventory.cost_reconciliation_postings ENABLE TRIGGER cost_reconciliation_posting_no_truncate;
      ALTER TABLE inventory.cost_origin_repairs ENABLE TRIGGER cost_origin_repair_no_truncate`);
    await quantityAmendmentResetGuard(client,true);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
