import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource(
  "migrations",
  "157_procurement_usd_financial_authority.sql",
);
const schema = readNormalizedSource("shared", "schema", "procurement.schema.ts");

describe("procurement USD financial authority migration", () => {
  it("fails closed instead of converting or relabeling existing financial rows", () => {
    expect(migration).toContain("currency IS DISTINCT FROM 'USD'");
    expect(migration).toContain("Cannot enforce USD purchasing authority");
    expect(migration).not.toMatch(/UPDATE\s+procurement\.(purchase_orders|vendor_invoices|ap_payments)/i);
  });

  it.each([
    ["purchase_orders", "purchase_orders_currency_usd_chk"],
    ["vendor_invoices", "vendor_invoices_currency_usd_chk"],
    ["ap_payments", "ap_payments_currency_usd_chk"],
  ])("requires non-null USD currency on %s", (table, constraint) => {
    expect(migration).toContain(`ALTER TABLE procurement.${table}`);
    expect(migration).toContain("ALTER COLUMN currency SET NOT NULL");
    expect(migration).toContain(`ADD CONSTRAINT ${constraint} CHECK (currency = 'USD')`);
    expect(schema).toContain(`check("${constraint}", sql\`\${table.currency} = 'USD'\`)`);
  });

  it("leaves foreign-currency inbound freight under its explicit exchange-rate model", () => {
    expect(migration).not.toContain("ALTER TABLE procurement.inbound_freight_costs");
    expect(schema).toContain(
      'currency: varchar("currency", { length: 3 }).default("USD"),\n' +
      '  exchangeRate: numeric("exchange_rate", { precision: 10, scale: 4 }).default("1")',
    );
  });
});
