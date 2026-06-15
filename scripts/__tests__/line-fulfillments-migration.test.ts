/**
 * Phase 0 (fulfillment-state redesign) — static guards for migration 103.
 *
 * These assert the SHAPE of the inert schema (FULFILLMENT_STATE_DESIGN.md §2.1)
 * without a database: the ledger table + idempotency index + CHECKs + FKs, the
 * additive per-line hold columns, the reverse migration, and the server/db.ts
 * startup-fallback parity. Crucially they prove Phase 0 is INERT/ADDITIVE — it
 * alters no existing table beyond ADD COLUMN IF NOT EXISTS.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = readFileSync(resolve(ROOT, "migrations/103_line_fulfillments_ledger.sql"), "utf8");
const REVERSE = readFileSync(resolve(ROOT, "migrations/reverse/103_line_fulfillments_ledger.sql"), "utf8");
const DB_TS = readFileSync(resolve(ROOT, "server/db.ts"), "utf8");

describe("migration 103 — line_fulfillments ledger", () => {
  it("creates the wms.line_fulfillments table", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS\s+wms\.line_fulfillments/i);
  });

  it("has the idempotency UNIQUE index over exactly (order_item_id, shipment_id, kind, external_event_id)", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+uq_line_fulfillments_idempotency[\s\S]*?\(\s*order_item_id\s*,\s*shipment_id\s*,\s*kind\s*,\s*external_event_id\s*\)/i,
    );
  });

  it("enforces qty <> 0 and the kind / source value sets", () => {
    expect(MIGRATION).toMatch(/CHECK\s*\(\s*qty\s*<>\s*0\s*\)/i);
    expect(MIGRATION).toMatch(/kind IN \('shipped', 'void_reversal', 'return', 'manual_correction'\)/);
    expect(MIGRATION).toMatch(/source IN \('warehouse', 'reconcile', 'operator'\)/);
  });

  it("FKs to wms.order_items and wms.outbound_shipments", () => {
    expect(MIGRATION).toMatch(/order_item_id\s+integer\s+NOT NULL REFERENCES wms\.order_items\(id\)/i);
    expect(MIGRATION).toMatch(/shipment_id\s+integer\s+NOT NULL REFERENCES wms\.outbound_shipments\(id\)/i);
  });

  it("indexes order_item_id (the net_shipped_qty SUM key)", () => {
    expect(MIGRATION).toMatch(/idx_line_fulfillments_order_item[\s\S]*?\(order_item_id\)/i);
  });

  it("adds the per-line hold columns additively", () => {
    expect(MIGRATION).toMatch(/ALTER TABLE wms\.order_items\s+ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false/i);
    expect(MIGRATION).toMatch(/ALTER TABLE wms\.order_items\s+ADD COLUMN IF NOT EXISTS hold_reason varchar\(200\)/i);
  });

  it("is INERT/ADDITIVE — no destructive DDL/DML on existing tables", () => {
    // No drops, no row mutations, and no column drops/type changes. The only
    // permitted ALTER is `ADD COLUMN IF NOT EXISTS` on wms.order_items.
    expect(MIGRATION).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(MIGRATION).not.toMatch(/\bUPDATE\s+/i);
    expect(MIGRATION).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(MIGRATION).not.toMatch(/ALTER\s+TABLE[\s\S]*?\bDROP\s+COLUMN\b/i);
    expect(MIGRATION).not.toMatch(/ALTER\s+COLUMN\b/i);
  });
});

describe("reverse migration 103", () => {
  it("drops the table and the two added columns", () => {
    expect(REVERSE).toMatch(/DROP TABLE IF EXISTS wms\.line_fulfillments CASCADE/i);
    expect(REVERSE).toMatch(/ALTER TABLE wms\.order_items DROP COLUMN IF EXISTS on_hold/i);
    expect(REVERSE).toMatch(/ALTER TABLE wms\.order_items DROP COLUMN IF EXISTS hold_reason/i);
  });
});

describe("server/db.ts startup-fallback parity (D2)", () => {
  it("mirrors the line_fulfillments table + indexes + hold columns idempotently", () => {
    expect(DB_TS).toMatch(/CREATE TABLE IF NOT EXISTS wms\.line_fulfillments/i);
    expect(DB_TS).toMatch(/uq_line_fulfillments_idempotency/);
    expect(DB_TS).toMatch(/ALTER TABLE wms\.order_items ADD COLUMN IF NOT EXISTS on_hold BOOLEAN NOT NULL DEFAULT false/i);
    expect(DB_TS).toMatch(/ALTER TABLE wms\.order_items ADD COLUMN IF NOT EXISTS hold_reason VARCHAR\(200\)/i);
  });
});
