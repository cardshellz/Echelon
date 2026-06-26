import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readMigration() {
  return fs.readFileSync(
    path.resolve(process.cwd(), "migrations/108_oms_wms_authority_constraints.sql"),
    "utf8",
  );
}

describe("OMS/WMS authority constraints migration", () => {
  it("adds the Phase 4 lineage constraints and active identity indexes", () => {
    const sql = readMigration();

    expect(sql).toContain("ALTER COLUMN oms_order_line_id TYPE BIGINT");
    expect(sql).toContain("to_regclass('wms.return_items')");
    expect(sql).toContain("wms_order_items_oms_order_line_id_fkey");
    expect(sql).toContain("REFERENCES oms.oms_order_lines(id)");
    expect(sql).toContain("wms_outbound_shipment_items_order_item_id_fkey");
    expect(sql).toContain("REFERENCES wms.order_items(id)");
    expect(sql).toContain("uq_wms_order_items_active_order_oms_line");
    expect(sql).toContain("uq_wms_order_items_active_oms_line");
    expect(sql).toContain("uq_outbound_shipments_active_shipstation_order_id");
    expect(sql).toContain("uq_outbound_shipments_active_shipstation_order_key");
    expect(sql).toContain("uq_outbound_shipments_active_engine_order_ref");
  });

  it("exempts combined-child mirror rows from active external identity uniqueness", () => {
    const sql = readMigration();

    expect(sql).toContain("'echelon_combined_child'");
    expect(sql).toContain("'shipstation_combined_child'");
    expect(sql).toContain("NULLIF(BTRIM(shipstation_order_key), '') IS NOT NULL");
    expect(sql).toContain("NULLIF(BTRIM(engine_order_ref), '') IS NOT NULL");
  });

  it("uses trigger guards for lineage that cannot be expressed as simple checks", () => {
    const sql = readMigration();

    expect(sql).toContain("CREATE OR REPLACE FUNCTION wms.enforce_oms_wms_authority_item()");
    expect(sql).toContain("wms_order_items_oms_line_required_authority_chk");
    expect(sql).toContain("wms_order_items_oms_line_order_match_chk");
    expect(sql).toContain("wms_order_items_oms_line_authority_qty_chk");
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER trg_enforce_oms_wms_authority_item");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION wms.enforce_outbound_shipment_item_lineage()");
    expect(sql).toContain("wms_outbound_shipment_items_order_match_chk");
    expect(sql).toContain("CREATE CONSTRAINT TRIGGER trg_enforce_outbound_shipment_item_lineage");
  });
});
