import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ORDERS_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);

describe("pick queue edited shipped order guard", () => {
  it("allows shipped OMS headers back into pick queue when WMS has open shippable work", () => {
    expect(ORDERS_STORAGE_SRC).toMatch(/oms\.status = 'shipped'/);
    expect(ORDERS_STORAGE_SRC).toMatch(/FROM wms\.order_items open_items/);
    expect(ORDERS_STORAGE_SRC).toMatch(/open_items\.order_id = o\.id/);
    expect(ORDERS_STORAGE_SRC).toMatch(/COALESCE\(open_items\.quantity, 0\) > COALESCE\(open_items\.fulfilled_quantity, 0\)/);
    expect(ORDERS_STORAGE_SRC).toMatch(/open_items\.status NOT IN \('cancelled', 'completed', 'short'\)/);
  });
});
