import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = path.resolve(
  process.cwd(),
  "migrations/0599_validate_oms_wms_authority_constraints.sql",
);

function readMigration(): string {
  return fs.readFileSync(MIGRATION_PATH, "utf8");
}

describe("OMS/WMS authority constraint validation migration", () => {
  it("validates every active constraint proven by the readiness audit", () => {
    const sql = readMigration();

    expect(sql).toContain(
      "VALIDATE CONSTRAINT wms_order_items_oms_order_line_id_fkey",
    );
    expect(sql).toContain(
      "VALIDATE CONSTRAINT wms_order_items_quantities_nonnegative_chk",
    );
    expect(sql).toContain(
      "VALIDATE CONSTRAINT outbound_shipment_items_purpose_authority_chk",
    );
    expect(sql).toContain(
      "VALIDATE CONSTRAINT wms_outbound_shipment_items_order_item_id_fkey",
    );
    expect(sql).toContain(
      "VALIDATE CONSTRAINT wms_outbound_shipment_items_qty_positive_chk",
    );
  });

  it("does not restore obsolete authority checks or validate unaudited domains", () => {
    const sql = readMigration();

    expect(sql).not.toContain(
      "VALIDATE CONSTRAINT wms_outbound_shipment_items_order_item_required_chk",
    );
    expect(sql).not.toContain(
      "VALIDATE CONSTRAINT chk_oms_fulfillment_order_id_not_null",
    );
    expect(sql).not.toContain("VALIDATE CONSTRAINT wms_returns_status_chk");
    expect(sql).not.toContain(
      "VALIDATE CONSTRAINT wms_return_items_quantity_chk",
    );
    expect(sql).not.toContain("ADD CONSTRAINT");
  });
});
