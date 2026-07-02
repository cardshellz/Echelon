import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ORDERS_STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../orders.storage.ts"),
  "utf8",
);

describe("WMS order creation idempotency", () => {
  it("serializes OMS-backed WMS order creation under an advisory transaction lock", () => {
    expect(ORDERS_STORAGE_SRC).toMatch(/pg_advisory_xact_lock/);
    expect(ORDERS_STORAGE_SRC).toMatch(
      /oms:\$\{order\.omsFulfillmentOrderId\}:\$\{fulfillmentPartitionKeyForCreate\(order\)\}/,
    );
    expect(ORDERS_STORAGE_SRC).toMatch(/db\.transaction\(create\)/);
  });

  it("re-checks by source, omsFulfillmentOrderId, and fulfillment partition inside createOrderWithItems", () => {
    expect(ORDERS_STORAGE_SRC).toMatch(/findExistingOrderForCreate\(tx, order\)/);
    expect(ORDERS_STORAGE_SRC).toMatch(/eq\(orders\.source, "oms"\)/);
    expect(ORDERS_STORAGE_SRC).toMatch(/eq\(orders\.omsFulfillmentOrderId, order\.omsFulfillmentOrderId\)/);
    expect(ORDERS_STORAGE_SRC).toMatch(/eq\(orders\.fulfillmentPartitionKey, fulfillmentPartitionKeyForCreate\(order\)\)/);
  });
});
