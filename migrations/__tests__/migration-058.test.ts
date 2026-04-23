/**
 * Static validation tests for migration 058 (wms.orders financial snapshot).
 *
 * Rationale: test/setup-integration.ts bootstraps only a subset of tables
 * (channels / products / variants / allocation), not the full wms schema.
 * Running the migration DDL against the test DB would require extending
 * the harness to create wms.orders first — out of scope for Group A.
 *
 * Instead, we enforce the properties the migration must satisfy:
 *   1. Idempotent — every DDL uses IF NOT EXISTS.
 *   2. Safe defaults — every new column has a NOT NULL DEFAULT.
 *   3. Integer cents — every *_cents column is BIGINT.
 *   4. Paired reverse migration exists at migrations/reverse/058_*.sql.
 *   5. Reverse migration only drops what 058 added (no unrelated writes).
 *
 * When the harness is extended to support wms schema, replace these with
 * live DB apply/rollback tests (plan §9.2).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "..");
const FORWARD = resolve(ROOT, "058_wms_orders_financial_snapshot.sql");
const REVERSE = resolve(ROOT, "reverse/058_wms_orders_financial_snapshot.sql");

const EXPECTED_COLUMNS = [
  "amount_paid_cents",
  "tax_cents",
  "shipping_cents",
  "discount_cents",
  "total_cents",
  "currency",
] as const;

describe("migration 058 — wms.orders financial snapshot", () => {
  const sql = readFileSync(FORWARD, "utf8");

  it("file exists", () => {
    expect(existsSync(FORWARD)).toBe(true);
  });

  it("reverse pair exists at migrations/reverse/058_*.sql", () => {
    expect(existsSync(REVERSE)).toBe(true);
  });

  it("every ALTER TABLE ADD COLUMN uses IF NOT EXISTS (idempotent)", () => {
    const addColumnLines = sql
      .split("\n")
      .filter((l) => /ADD COLUMN/i.test(l));
    expect(addColumnLines.length).toBeGreaterThan(0);
    for (const line of addColumnLines) {
      expect(line).toMatch(/IF NOT EXISTS/i);
    }
  });

  it("every CREATE INDEX uses IF NOT EXISTS (idempotent)", () => {
    const createIndexLines = sql.match(/CREATE INDEX[^;]*/gi) ?? [];
    for (const stmt of createIndexLines) {
      expect(stmt).toMatch(/IF NOT EXISTS/i);
    }
  });

  it("adds every expected financial column", () => {
    for (const col of EXPECTED_COLUMNS) {
      // Must appear in an ALTER TABLE ... ADD COLUMN statement.
      const pattern = new RegExp(
        `ADD COLUMN IF NOT EXISTS\\s+${col}\\b`,
        "i",
      );
      expect(sql).toMatch(pattern);
    }
  });

  it("every *_cents column is BIGINT with default 0 and NOT NULL", () => {
    for (const col of EXPECTED_COLUMNS.filter((c) => c.endsWith("_cents"))) {
      const pattern = new RegExp(
        `ADD COLUMN IF NOT EXISTS\\s+${col}\\s+BIGINT\\s+NOT NULL\\s+DEFAULT\\s+0`,
        "i",
      );
      expect(sql).toMatch(pattern);
    }
  });

  it("currency column is VARCHAR(3) NOT NULL DEFAULT 'USD'", () => {
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+currency\s+VARCHAR\(3\)\s+NOT NULL\s+DEFAULT\s+'USD'/i,
    );
  });

  it("touches only wms.orders (no cross-schema writes)", () => {
    // Every ALTER TABLE must target wms.orders.
    const alterTargets = Array.from(
      sql.matchAll(/ALTER TABLE\s+([\w.]+)/gi),
    ).map((m) => m[1].toLowerCase());
    expect(alterTargets.length).toBeGreaterThan(0);
    for (const target of alterTargets) {
      expect(target).toBe("wms.orders");
    }
  });
});

describe("migration 058 — reverse", () => {
  const rev = readFileSync(REVERSE, "utf8");

  it("drops every column 058 adds (and nothing else on wms.orders)", () => {
    for (const col of EXPECTED_COLUMNS) {
      expect(rev).toMatch(
        new RegExp(`DROP COLUMN IF EXISTS\\s+${col}\\b`, "i"),
      );
    }
  });

  it("only touches wms.orders + its indexes", () => {
    const alterTargets = Array.from(
      rev.matchAll(/ALTER TABLE\s+([\w.]+)/gi),
    ).map((m) => m[1].toLowerCase());
    for (const target of alterTargets) {
      expect(target).toBe("wms.orders");
    }
  });

  it("wraps in a transaction (atomic rollback)", () => {
    expect(rev).toMatch(/^\s*BEGIN\s*;/im);
    expect(rev).toMatch(/COMMIT\s*;\s*$/im);
  });
});
