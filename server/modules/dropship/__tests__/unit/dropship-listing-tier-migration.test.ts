import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const tierHolds = readFileSync(resolve(process.cwd(), "migrations/0685_dropship_vendor_listing_tier_holds.sql"), "utf8");
const variantHolds = readFileSync(resolve(process.cwd(), "migrations/0684_inventory_publication_target_variant_holds.sql"), "utf8");

describe("0685 dropship vendor listing tier holds migration", () => {
  it("keeps one row per vendor, constrained to the two tiers, with a non-negative revision", () => {
    expect(tierHolds).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_listing_tier_holds");
    expect(tierHolds).toContain("vendor_id integer PRIMARY KEY REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE");
    expect(tierHolds).toContain("CHECK (held_tiers <@ ARRAY['pack', 'case']::text[])");
    expect(tierHolds).toContain("CHECK (revision >= 0)");
    expect(tierHolds).toContain("applied boolean NOT NULL DEFAULT false");
    expect(tierHolds).toContain("evaluated_at timestamptz NOT NULL");
  });

  it("indexes the unapplied rows the hourly tick retries", () => {
    expect(tierHolds).toContain("CREATE INDEX IF NOT EXISTS dropship_vendor_listing_tier_holds_unapplied_idx");
    expect(tierHolds).toContain("WHERE applied = false");
  });

  it("is re-runnable: every statement is guarded", () => {
    for (const statement of statementsOf(tierHolds)) {
      const guarded = /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE INDEX IF NOT EXISTS/i.test(statement)
        || /^COMMENT ON/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

describe("0684 inventory publication target variant holds migration", () => {
  it("keys the SKU-level hold by target and variant, and requires a trimmed reason and actor", () => {
    expect(variantHolds).toContain("CREATE TABLE IF NOT EXISTS inventory.inventory_publication_target_variant_holds");
    expect(variantHolds).toContain("REFERENCES inventory.inventory_publication_targets(id) ON DELETE CASCADE");
    expect(variantHolds).toContain("REFERENCES catalog.product_variants(id) ON DELETE RESTRICT");
    expect(variantHolds).toContain("PRIMARY KEY (publication_target_id, product_variant_id)");
    expect(variantHolds).toContain("CHECK (hold_reason = btrim(hold_reason) AND hold_reason <> '')");
    expect(variantHolds).toContain("CHECK (held_by = btrim(held_by) AND held_by <> '')");
    expect(variantHolds).toContain("held_at TIMESTAMPTZ NOT NULL");
  });

  it("is re-runnable: every statement is guarded", () => {
    for (const statement of statementsOf(variantHolds)) {
      const guarded = /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE INDEX IF NOT EXISTS/i.test(statement)
        || /^COMMENT ON/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

function statementsOf(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
    .filter((statement) => statement.length > 0);
}
