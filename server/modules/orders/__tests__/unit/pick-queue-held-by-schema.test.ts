import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ORDERS_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf8",
);
const ORDERS_SCHEMA_SRC = readFileSync(
  resolve(__dirname, "../../../../../shared/schema/orders.schema.ts"),
  "utf8",
);

describe("pick queue hold columns", () => {
  it("does not select the non-existent held_by column", () => {
    const queueStart = ORDERS_STORAGE_SRC.indexOf("async getPickQueueOrders");
    const queueEnd = ORDERS_STORAGE_SRC.indexOf("async getOrderById", queueStart);
    const queueSection = ORDERS_STORAGE_SRC.slice(queueStart, queueEnd);

    expect(ORDERS_SCHEMA_SRC).toMatch(/heldAt: timestamp\("held_at"\)/);
    expect(ORDERS_SCHEMA_SRC).not.toMatch(/heldBy:|held_by/);
    expect(queueSection).toMatch(/o\.held_at/);
    expect(queueSection).not.toMatch(/o\.held_by|heldBy: row\.held_by/);
  });
});
