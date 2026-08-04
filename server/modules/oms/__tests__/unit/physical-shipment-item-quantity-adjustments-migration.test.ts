import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "migrations/182_physical_shipment_item_quantity_adjustments.sql",
  ),
  "utf8",
);

describe("physical shipment item quantity adjustment migration", () => {
  it("records only negative, attributable, one-time corrections", () => {
    expect(migration).toContain("quantity_delta < 0");
    expect(migration).toContain("UNIQUE (physical_shipment_item_id)");
    expect(migration).toContain("repair_run_id UUID NOT NULL");
    expect(migration).toContain("idempotency_key VARCHAR(500) NOT NULL");
    expect(migration).toContain("operator VARCHAR(120) NOT NULL");
    expect(migration).toContain("reason VARCHAR(500) NOT NULL");
  });

  it("locks the immutable base item and rejects negative effective quantity", () => {
    expect(migration).toMatch(
      /FROM wms\.physical_shipment_items AS item[\s\S]*FOR UPDATE/,
    );
    expect(migration).toContain("base_quantity + NEW.quantity_delta < 0");
    expect(migration).toContain("USING ERRCODE = '23514'");
  });

  it("makes correction evidence append-only", () => {
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("append-only correction evidence");
    expect(migration).toContain("USING ERRCODE = '55000'");
  });

  it("publishes only positive effective package quantities", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE VIEW wms.effective_physical_shipment_items",
    );
    expect(migration).toContain(
      "item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0)",
    );
    expect(migration).toContain(
      "WHERE item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) > 0",
    );
  });
});
