import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ORDERS_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);
const PICK_QUEUE_SRC = ORDERS_STORAGE_SRC.slice(
  ORDERS_STORAGE_SRC.indexOf("async getPickQueueOrders"),
  ORDERS_STORAGE_SRC.indexOf("async createOrderWithItems"),
);

describe("pick queue edited shipped order guard", () => {
  it("allows shipped OMS headers back into pick queue when WMS has open shippable work", () => {
    expect(PICK_QUEUE_SRC).toMatch(/COALESCE\(oms_direct\.status, oms_source\.status\) = 'shipped'/);
    expect(PICK_QUEUE_SRC).toMatch(/FROM wms\.order_items open_items/);
    expect(PICK_QUEUE_SRC).toMatch(/open_items\.order_id = o\.id/);
    expect(PICK_QUEUE_SRC).toMatch(/COALESCE\(open_items\.quantity, 0\) > COALESCE\(open_items\.fulfilled_quantity, 0\)/);
    expect(PICK_QUEUE_SRC).toMatch(/open_items\.status NOT IN \('cancelled', 'completed', 'short'\)/);
  });

  it("keeps the pick queue query scalable", () => {
    expect(PICK_QUEUE_SRC).toMatch(/LEFT JOIN oms\.oms_orders oms_direct/);
    expect(PICK_QUEUE_SRC).toMatch(/LEFT JOIN oms\.oms_orders oms_source/);
    expect(PICK_QUEUE_SRC).not.toContain("SELECT o.*");
    expect(PICK_QUEUE_SRC).not.toContain("SELECT * FROM wms.order_items");
    expect(PICK_QUEUE_SRC).not.toContain("OR (o.source = 'shopify' AND o.source_table_id = oms.id::text)");
    expect(PICK_QUEUE_SRC).toMatch(/SELECT order_id, status\s+FROM wms\.outbound_shipments\s+WHERE order_id IN/);
    expect(PICK_QUEUE_SRC).not.toMatch(/SELECT status FROM wms\.outbound_shipments WHERE order_id =/);
  });
});
