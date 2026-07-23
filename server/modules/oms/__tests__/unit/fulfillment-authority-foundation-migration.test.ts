import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION_SOURCE = readFileSync(
  resolve(
    __dirname,
    "../../../../../migrations/0593_fulfillment_authority_cutover_foundation.sql",
  ),
  "utf8",
);

describe("fulfillment authority cutover foundation migration", () => {
  it("keeps shipped history valid when commercial authority is later refunded", () => {
    const constraint = MIGRATION_SOURCE.match(
      /ADD CONSTRAINT fulfillment_plan_lines_quantity_chk CHECK \(([\s\S]*?)\n  \);/,
    )?.[1] ?? "";

    expect(constraint).toContain("quantity_cancelled <= quantity_planned");
    expect(constraint).toContain("quantity_shipped <= quantity_planned");
    expect(constraint).not.toMatch(/quantity_shipped\s*\+\s*quantity_cancelled/);
  });

  it("allows one provider order to own multiple shipment requests", () => {
    expect(MIGRATION_SOURCE).toContain(
      "CREATE TABLE IF NOT EXISTS wms.shipping_engine_order_requests",
    );
    expect(MIGRATION_SOURCE).toContain(
      "UNIQUE (shipping_engine_order_id, shipment_request_id)",
    );
    expect(MIGRATION_SOURCE).toMatch(
      /ALTER COLUMN shipment_request_id DROP NOT NULL;[\s\S]*CREATE TABLE IF NOT EXISTS wms\.shipping_engine_order_requests/,
    );
    expect(MIGRATION_SOURCE).toContain("ON CONFLICT (shipping_engine_order_id, shipment_request_id) DO NOTHING");
  });

  it("makes physical package ownership item-derived", () => {
    expect(MIGRATION_SOURCE).toMatch(
      /ALTER TABLE wms\.physical_shipments\s+ALTER COLUMN shipment_request_id DROP NOT NULL/,
    );
    expect(MIGRATION_SOURCE).toContain(
      "physical_shipment_item_id BIGINT",
    );
    expect(MIGRATION_SOURCE).toContain(
      "REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT",
    );
  });

  it("keys channel commands by provider, OMS order, physical package, and fulfillment scope", () => {
    expect(MIGRATION_SOURCE).toContain(
      "DROP CONSTRAINT IF EXISTS channel_fulfillment_pushes_unique_physical",
    );
    expect(MIGRATION_SOURCE).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_fulfillment_pushes_command\s+ON oms\.channel_fulfillment_pushes\(\s*channel_provider,\s*oms_order_id,\s*physical_shipment_id,\s*channel_fulfillment_scope_key/,
    );
    expect(MIGRATION_SOURCE).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_fulfillment_pushes_command_key",
    );
  });

  it("adds lease-safe retry state and an append-only attempt ledger", () => {
    expect(MIGRATION_SOURCE).toContain("FOR EACH ROW EXECUTE FUNCTION oms.reject_channel_fulfillment_attempt_mutation()");
    expect(MIGRATION_SOURCE).toContain("CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_push_attempts");
    expect(MIGRATION_SOURCE).toContain("next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(MIGRATION_SOURCE).toContain("lease_expires_at TIMESTAMPTZ");
    expect(MIGRATION_SOURCE).toContain("channel_fulfillment_pushes_lease_chk");
    expect(MIGRATION_SOURCE).toContain("tracking_number VARCHAR(200)");
    expect(MIGRATION_SOURCE).toContain("NEW.tracking_number IS DISTINCT FROM OLD.tracking_number");
    expect(MIGRATION_SOURCE).toContain("Terminal channel fulfillment commands are immutable");
  });

  it("prevents deletes from erasing fulfillment command evidence", () => {
    expect(MIGRATION_SOURCE).toContain("channel_fulfillment_pushes_oms_order_fk");
    expect(MIGRATION_SOURCE).toContain("channel_fulfillment_pushes_physical_shipment_fk");
    expect(MIGRATION_SOURCE).toContain("channel_fulfillment_push_items_command_fk");
    expect(MIGRATION_SOURCE).toMatch(
      /channel_fulfillment_pushes_oms_order_fk[\s\S]*REFERENCES oms\.oms_orders\(id\)[\s\S]*ON DELETE RESTRICT/,
    );
  });

  it("backfills existing rows before enforcing new not-null and completion constraints", () => {
    const scopeBackfill = MIGRATION_SOURCE.indexOf("SET channel_fulfillment_scope_key = 'order'");
    const commandBackfill = MIGRATION_SOURCE.indexOf("SET command_key =", scopeBackfill);
    const completionBackfill = MIGRATION_SOURCE.indexOf("SET completed_at = COALESCE");
    const notNull = MIGRATION_SOURCE.indexOf("ALTER COLUMN channel_fulfillment_scope_key SET NOT NULL");
    const completionConstraint = MIGRATION_SOURCE.indexOf("channel_fulfillment_pushes_completion_chk");

    expect(scopeBackfill).toBeGreaterThan(-1);
    expect(commandBackfill).toBeGreaterThan(scopeBackfill);
    expect(completionBackfill).toBeGreaterThan(commandBackfill);
    expect(notNull).toBeGreaterThan(completionBackfill);
    expect(completionConstraint).toBeGreaterThan(notNull);
  });
});
