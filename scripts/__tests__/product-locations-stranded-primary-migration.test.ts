/**
 * Structural contract for migration 218 (stranded primary pick slots).
 *
 * The migration is exercised for real against a local Postgres in review
 * (fixtures for the P5 / P10 / C60 shapes, run twice for idempotency); this
 * test pins the guards that keep its blast radius narrow so a later edit
 * cannot silently widen them.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = "migrations/218_product_locations_restore_stranded_primary.sql";
const REVERSE = "migrations/reverse/218_product_locations_restore_stranded_primary.sql";

function read(file: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
}

describe("218 product_locations stranded primary repair", () => {
  it("runs as one transaction and reports its counts", () => {
    const sql = read(MIGRATION);
    expect(sql.trim().startsWith("-- 218:")).toBe(true);
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
    expect(sql).toContain("RAISE NOTICE '218 product_locations repair:");
  });

  it("only demotes flagged placeholders that are shadowing a bin-backed row", () => {
    const sql = read(MIGRATION);
    const step1 = sql.slice(sql.indexOf("-- Step 1"), sql.indexOf("-- Step 2"));
    expect(step1).toContain("pl.warehouse_location_id IS NULL");
    expect(step1).toContain("pl.is_primary = 1");
    expect(step1).toContain("real_slot.warehouse_location_id IS NOT NULL");
    expect(step1).toContain("SET is_primary = 0");
  });

  it("only promotes a variant's single unflagged, bin-backed, active slot", () => {
    const sql = read(MIGRATION);
    const step2 = sql.slice(sql.indexOf("-- Step 2"), sql.indexOf("-- Step 3"));
    expect(step2).toContain("pl.status = 'active'");
    expect(step2).toContain("pl.warehouse_location_id IS NOT NULL");
    expect(step2).toContain("HAVING COUNT(*) = 1");
    expect(step2).toContain("COUNT(*) FILTER (WHERE pl.is_primary = 1) = 0");
    expect(step2).toContain("SET is_primary = 1");
    // Never touches rows that are not linked to a variant.
    expect(step2).toContain("pl.product_variant_id IS NOT NULL");
  });

  it("re-stamps order lines with exactly the app backfill's guards", () => {
    const sql = read(MIGRATION);
    const step3 = sql.slice(sql.indexOf("-- Step 3"));
    expect(step3).toContain("(oi.location IS NULL OR oi.location IN ('UNASSIGNED', 'U'))");
    expect(step3).toContain("oi.picked_quantity < oi.quantity");
    expect(step3).toContain("o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')");
    expect(step3).toContain("UPPER(oi.sku) = rs.sku");
    // Scoped to the SKUs promoted in step 2, not every UNASSIGNED line.
    expect(step3).toContain("FROM repaired_slots rs");
  });

  it("keeps the reverse migration an explicit no-op", () => {
    const reverse = read(REVERSE);
    expect(reverse).toContain("Intentionally a no-op");
    expect(reverse).not.toMatch(/\b(UPDATE|DELETE|INSERT|ALTER)\b/);
  });
});
