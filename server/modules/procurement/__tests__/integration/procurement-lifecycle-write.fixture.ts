import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import * as schema from "@shared/schema";
import type { FlowCostHarness } from "./procurement-flow-cost.fixture";
import { supplierReturnReadFixtureTables, installSupplierReturnCompletionFixture } from "./supplier-return-fixture";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

/** Only the exclusively owned FLOW database may install these write prerequisites.
 * Replace its EMPTY read-only table declarations so production CREATE TABLE checks,
 * foreign keys, indexes and immutable-history triggers are all exercised together.
 * Existing receipts, invoices, costs and RFQ records are never reseeded or rewritten. */
export async function installFlowLifecycleWrites(harness: FlowCostHarness): Promise<void> {
  // Invoice detail always loads attachments, including when none are present.
  // These are empty read prerequisites, with their real schema foreign keys.
  const readTables = [schema.vendorInvoiceAttachments];
  for (const table of readTables) await harness.pool.query(fixtureTable(table));
  for (const statement of fixtureForeignKeys(readTables)) await harness.pool.query(statement);
  const tables = [...supplierReturnReadFixtureTables, schema.supplierCreditApplications,
    schema.supplierCreditApplicationReversals, schema.supplierCreditLines, schema.supplierCredits];
  const names = tables.map(qualifiedTable);
  for (const name of [...names, "procurement.ap_payments", "procurement.ap_payment_allocations"]) {
    const count = await harness.pool.query(`SELECT count(*)::int AS count FROM ${name}`);
    expect(count.rows, `Lifecycle write setup requires empty ${name}`).toEqual([{ count: 0 }]);
  }
  // One DROP lists every dependent empty table; deliberately omit CASCADE so an
  // unexpected external dependency fails setup rather than silently disappearing.
  await harness.pool.query(`DROP TABLE ${names.join(",")}`);
  await harness.pool.query(`CREATE UNIQUE INDEX ap_payments_payment_number_active_uidx
    ON procurement.ap_payments(payment_number) WHERE voided_at IS NULL`);
  for (const migration of [
    "157_procurement_usd_financial_authority.sql",
    "900000016000018570001_ap_payment_balance_completion.sql",
    "900000017000018610001_supplier_credit_completion.sql",
  ]) await harness.pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
  await installSupplierReturnCompletionFixture(harness.pool);
  // The existing RFQ actor already has purchasing:edit. Settlement/collection
  // deliberately exercises real, separate current approval/read grants.
  await harness.pool.query(`INSERT INTO identity.auth_permissions(id,resource,action,category)
    OVERRIDING SYSTEM VALUE VALUES(900001,'purchasing','approve','purchasing'),(900002,'purchasing','view','purchasing');
    INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints)
    VALUES(1,900001,NULL),(1,900002,NULL)`);
}
