/**
 * Static validation tests for migration 059 (wms.order_items price columns).
 *
 * See migration-058.test.ts for rationale — the integration harness at
 * test/setup-integration.ts does not yet bootstrap wms.* tables, so we
 * validate the migration's structural properties as a SQL lint instead.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const FORWARD = resolve(ROOT, "059_wms_order_items_prices.sql");
const REVERSE = resolve(ROOT, "reverse/059_wms_order_items_prices.sql");

const EXPECTED_COLUMNS = [
  "unit_price_cents",
  "paid_price_cents",
  "total_price_cents",
] as const;

describe("migration 059 — wms.order_items price columns", () => {
  const sql = readFileSync(FORWARD, "utf8");

  it("file exists", () => {
    expect(existsSync(FORWARD)).toBe(true);
  });

  it("reverse pair exists", () => {
    expect(existsSync(REVERSE)).toBe(true);
  });

  it("every ADD COLUMN uses IF NOT EXISTS (idempotent)", () => {
    const addColumnLines = sql
      .split("\n")
      .filter((l) => /ADD COLUMN/i.test(l));
    expect(addColumnLines.length).toBe(EXPECTED_COLUMNS.length);
    for (const line of addColumnLines) {
      expect(line).toMatch(/IF NOT EXISTS/i);
    }
  });

  it("every expected price column is BIGINT NOT NULL DEFAULT 0", () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(
          `ADD COLUMN IF NOT EXISTS\\s+${col}\\s+BIGINT\\s+NOT NULL\\s+DEFAULT\\s+0`,
          "i",
        ),
      );
    }
  });

  it("touches only wms.order_items", () => {
    const alterTargets = Array.from(
      sql.matchAll(/ALTER TABLE\s+([\w.]+)/gi),
    ).map((m) => m[1].toLowerCase());
    expect(alterTargets.length).toBeGreaterThan(0);
    for (const target of alterTargets) {
      expect(target).toBe("wms.order_items");
    }
  });
});

describe("migration 059 — reverse", () => {
  const rev = readFileSync(REVERSE, "utf8");

  it("drops every column 059 adds", () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(rev).toMatch(
        new RegExp(`DROP COLUMN IF EXISTS\\s+${col}\\b`, "i"),
      );
    }
  });

  it("wraps in a transaction (atomic rollback)", () => {
    expect(rev).toMatch(/^\s*BEGIN\s*;/im);
    expect(rev).toMatch(/COMMIT\s*;\s*$/im);
  });

  it("only touches wms.order_items", () => {
    const alterTargets = Array.from(
      rev.matchAll(/ALTER TABLE\s+([\w.]+)/gi),
    ).map((m) => m[1].toLowerCase());
    for (const target of alterTargets) {
      expect(target).toBe("wms.order_items");
    }
  });
});
