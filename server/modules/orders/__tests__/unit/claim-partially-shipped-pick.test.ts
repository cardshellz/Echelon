import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ORDERS_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf-8",
);

describe("claimOrder partially shipped queue entries", () => {
  it("allows unassigned partially_shipped orders to be claimed", () => {
    expect(ORDERS_STORAGE_SRC).toMatch(/async claimOrder/);
    expect(ORDERS_STORAGE_SRC).toMatch(/eq\(orders\.warehouseStatus, "ready"\)/);
    expect(ORDERS_STORAGE_SRC).toMatch(/eq\(orders\.warehouseStatus, "partially_shipped"\)/);
    expect(ORDERS_STORAGE_SRC).toMatch(/isNull\(orders\.assignedPickerId\)/);
  });
});
