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
const PROJECTION_SRC = readFileSync(
  resolve(__dirname, "../../channel-fulfillment-projection.repository.ts"),
  "utf-8",
);

describe("SHIP_NOTIFY item completion :: canonical projection", () => {
  it("SHIP_NOTIFY does not directly complete WMS item counters", () => {
    expect(SS_SRC).not.toContain("UPDATE wms.order_items");
    expect(SS_SRC).toContain("requireFulfillmentAuthority().recordPhysicalPackage");
  });

  it("the canonical projector updates by exact WMS order-item identity", () => {
    expect(PROJECTION_SRC).toContain("UPDATE wms.order_items order_item");
    expect(PROJECTION_SRC).toContain("WHERE order_item.id = shipped.wms_order_item_id");
    expect(PROJECTION_SRC).not.toContain("WHERE wms_order_id =");
  });
});
