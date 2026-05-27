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
  function pickQueueSection(): string {
    const queueStart = ORDERS_STORAGE_SRC.indexOf("async getPickQueueOrders");
    const queueEnd = ORDERS_STORAGE_SRC.indexOf("async getOrderById", queueStart);
    return ORDERS_STORAGE_SRC.slice(queueStart, queueEnd);
  }

  it("does not select the non-existent held_by column", () => {
    const queueSection = pickQueueSection();
    expect(ORDERS_SCHEMA_SRC).toMatch(/heldAt: timestamp\("held_at"\)/);
    expect(ORDERS_SCHEMA_SRC).not.toMatch(/heldBy:|held_by/);
    expect(queueSection).toMatch(/o\.held_at/);
    expect(queueSection).not.toMatch(/o\.held_by|heldBy: row\.held_by/);
  });

  it("maps claimedAt from started_at instead of non-existent claimed_at", () => {
    const queueSection = pickQueueSection();
    expect(ORDERS_SCHEMA_SRC).toMatch(/startedAt: timestamp\("started_at"\)/);
    expect(ORDERS_SCHEMA_SRC).not.toMatch(/claimedAt:|claimed_at/);
    expect(queueSection).toMatch(/o\.started_at AS claimed_at/);
    expect(queueSection).not.toMatch(/o\.claimed_at/);
  });

  it("uses current wms.orders exception and total columns in the pick queue query", () => {
    const queueSection = pickQueueSection();
    expect(queueSection).toMatch(/o\.exception_resolution AS exception_type/);
    expect(queueSection).toMatch(/o\.exception_resolved_at AS resolved_at/);
    expect(queueSection).toMatch(/o\.exception_resolved_by AS resolved_by/);
    expect(queueSection).toMatch(/o\.exception_notes AS resolution_notes/);
    expect(queueSection).toMatch(/o\.total_cents AS total_amount/);
    expect(queueSection).not.toMatch(/o\.exception_type|o\.resolved_at|o\.resolved_by|o\.resolution_notes|o\.total_amount/);
  });
});
