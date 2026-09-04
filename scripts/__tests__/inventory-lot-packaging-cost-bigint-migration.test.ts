/**
 * Structural contract for migration 219 (packaging_cost_cents -> bigint).
 *
 * The migration is executed for real against Postgres in
 * server/modules/inventory/__tests__/integration/lot-cost-column-types.integration.test.ts.
 * This test pins the guards that keep it safe to re-run and prevent it from
 * quietly becoming a data change.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = "migrations/219_inventory_lot_packaging_cost_bigint.sql";
const REVERSE = "migrations/reverse/219_inventory_lot_packaging_cost_bigint.sql";

function read(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
}

describe("219 inventory lot packaging cost bigint alignment", () => {
  it("runs as one transaction", () => {
    const sql = read(MIGRATION);
    expect(sql.trim().startsWith("-- 219:")).toBe(true);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });

  it("only converts the one column it names, and only on inventory_lots", () => {
    const sql = read(MIGRATION);
    const alteredColumns = [...sql.matchAll(/ALTER COLUMN (\w+)/g)].map((match) => match[1]);
    expect([...new Set(alteredColumns)]).toEqual(["packaging_cost_cents"]);

    const alteredTables = [...sql.matchAll(/ALTER TABLE ([\w.]+)/g)].map((match) => match[1]);
    expect([...new Set(alteredTables)]).toEqual(["inventory.inventory_lots"]);
  });

  it("is a no-op when the column is already bigint or absent", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("FROM information_schema.columns");
    expect(sql).toContain("column_name = 'packaging_cost_cents'");
    expect(sql).toContain("IF current_type IS NULL THEN");
    expect(sql).toContain("IF current_type = 'bigint' THEN");
  });

  it("drops and restores the default explicitly rather than casting it implicitly", () => {
    const sql = read(MIGRATION);
    const dropAt = sql.indexOf("DROP DEFAULT");
    const typeAt = sql.indexOf("TYPE bigint");
    const setAt = sql.indexOf("SET DEFAULT 0");
    expect(dropAt).toBeGreaterThan(-1);
    expect(typeAt).toBeGreaterThan(dropAt);
    expect(setAt).toBeGreaterThan(typeAt);
  });

  it("moves no money: the conversion rounds rather than truncating", () => {
    const sql = read(MIGRATION);
    expect(sql).toContain("USING round(packaging_cost_cents::numeric)");
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
  });

  it("keeps the reverse migration an explicit no-op", () => {
    const reverse = read(REVERSE);
    expect(reverse).toContain("Intentionally a no-op");
    expect(reverse).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER)\b/);
  });
});
