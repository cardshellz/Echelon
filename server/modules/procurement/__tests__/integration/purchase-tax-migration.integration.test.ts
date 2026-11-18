import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";

const enabled = !!process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(enabled ? describe : describe.skip).sequential("purchase tax actual migration constraints and compatibility", () => {
  let pool: pg.Pool;
  const ownedSchemas: string[] = [];
  beforeAll(async () => {
    validatePostgresTestEnvironment(process.env);
    pool = new pg.Pool({ connectionString: process.env.ECHELON_TEST_DATABASE_URL, ssl: false });
    for (const name of ["identity", "procurement"]) { await pool.query(`CREATE SCHEMA ${name}`); ownedSchemas.push(name); }
    await pool.query(`CREATE TABLE identity.users(id varchar PRIMARY KEY);
      INSERT INTO identity.users VALUES('tax-admin');
      CREATE TABLE procurement.purchase_orders(id integer PRIMARY KEY,total_cents bigint NOT NULL);
      CREATE TABLE procurement.purchase_order_lines(id integer PRIMARY KEY,line_total_cents bigint NOT NULL);
      CREATE TABLE procurement.inbound_freight_costs(id integer PRIMARY KEY,actual_cents bigint NOT NULL);
      CREATE TABLE procurement.vendor_invoice_lines(id integer PRIMARY KEY,line_total_cents bigint NOT NULL);
      CREATE TABLE procurement.landed_cost_snapshots(id integer PRIMARY KEY,total_allocated_cents bigint NOT NULL);
      INSERT INTO procurement.purchase_orders VALUES(1,12000); INSERT INTO procurement.purchase_order_lines VALUES(1,11000);
      INSERT INTO procurement.inbound_freight_costs VALUES(1,1000); INSERT INTO procurement.vendor_invoice_lines VALUES(1,12000);
      INSERT INTO procurement.landed_cost_snapshots VALUES(1,1000)`);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/900000046000019710001_purchase_tax_treatments.sql"), "utf8"));
  });
  afterAll(async () => { try { for (const name of [...ownedSchemas].reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`); } finally { await pool?.end(); } });
  async function fails(statement: string, code: string) {
    await expect(pool.query(statement)).rejects.toMatchObject({ code });
  }
  it("preserves historical money and makes no tax eligibility assumption", async () => {
    expect((await pool.query("SELECT * FROM procurement.purchase_tax_types")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM procurement.purchase_orders")).rows).toEqual([{ id: 1, total_cents: "12000", tax_type_id: null }]);
    expect((await pool.query("SELECT * FROM procurement.landed_cost_snapshots")).rows).toEqual([{ id: 1, total_allocated_cents: "1000", recoverable_tax_allocated_cents: "0" }]);
  });
  it("requires an explicit treatment, unique code and valid approving identity", async () => {
    await fails("INSERT INTO procurement.purchase_tax_types(code,name,treatment,revision,created_at,updated_at,updated_by) VALUES('BAD','Bad','guess',1,'2026-11-01','2026-11-01','tax-admin')", "23514");
    await fails("INSERT INTO procurement.purchase_tax_types(code,name,treatment,revision,created_at,updated_at,updated_by) VALUES('BAD','Bad','inventory',1,'2026-11-01','2026-11-01','missing')", "23503");
    await pool.query("INSERT INTO procurement.purchase_tax_types(code,name,treatment,revision,created_at,updated_at,updated_by) VALUES('VAT','Supplier VAT','recoverable',1,'2026-11-01','2026-11-01','tax-admin')");
    await fails("INSERT INTO procurement.purchase_tax_types(code,name,treatment,revision,created_at,updated_at,updated_by) VALUES('VAT','Duplicate','inventory',1,'2026-11-01','2026-11-01','tax-admin')", "23505");
  });
  it("enforces tax references, one amount per type and nonnegative exact stored money", async () => {
    const id = (await pool.query("SELECT id FROM procurement.purchase_tax_types WHERE code='VAT'")).rows[0].id;
    await fails("UPDATE procurement.purchase_orders SET tax_type_id=2147483647 WHERE id=1", "23503");
    await pool.query("UPDATE procurement.purchase_orders SET tax_type_id=$1 WHERE id=1", [id]);
    await pool.query("INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills) VALUES(1,$1,100000)", [id]);
    await fails(`INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills) VALUES(1,${id},100000)`, "23505");
    await fails(`INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills) VALUES(1,${id},-1)`, "23514");
    await fails(`INSERT INTO procurement.vendor_invoice_line_taxes(vendor_invoice_line_id,tax_type_id,amount_mills) VALUES(1,${id},101)`, "23514");
    await fails("UPDATE procurement.landed_cost_snapshots SET recoverable_tax_allocated_cents=-1 WHERE id=1", "23514");
    await fails(`DELETE FROM procurement.purchase_tax_types WHERE id=${id}`, "23503");
    await fails("DELETE FROM procurement.vendor_invoice_lines WHERE id=1", "23503");
  });
});
