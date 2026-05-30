/**
 * Structural test: SHIP_NOTIFY legacy paths must use the correct column
 * name (order_id) when updating wms.order_items, not the non-existent
 * wms_order_id column. The wrong column name caused a silent SQL error
 * that left items in 'pending' status after shipping — which in turn
 * prevented OMS fulfillment updates, caused the reconciler to think
 * shipped orders had open demand, and triggered duplicate SS pushes.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SS_SRC = readFileSync(
  resolve(__dirname, "../../shipstation.service.ts"),
  "utf-8",
);

describe("SHIP_NOTIFY item completion :: column name", () => {
  const legacySection = SS_SRC.slice(
    SS_SRC.indexOf("LEGACY PATH: SHIP_NOTIFY carried echelon-oms"),
    SS_SRC.indexOf("Create shipment record for the WMS order"),
  );

  const v2ShipmentSection = SS_SRC.slice(
    SS_SRC.indexOf("Mark all still-in-flight order items completed"),
    SS_SRC.indexOf("Updated WMS shipment"),
  );

  it("legacy path uses order_id (not wms_order_id) when completing items", () => {
    expect(legacySection).toContain("WHERE order_id =");
    expect(legacySection).not.toContain("WHERE wms_order_id =");
  });

  it("V2 shipment path uses order_id (not wms_order_id) when completing items", () => {
    expect(v2ShipmentSection).toContain("WHERE order_id =");
    expect(v2ShipmentSection).not.toContain("WHERE wms_order_id =");
  });
});
