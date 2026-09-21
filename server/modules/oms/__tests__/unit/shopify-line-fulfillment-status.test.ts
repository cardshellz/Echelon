import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../../../db", () => ({
  db: {
    execute: async () => ({ rows: [] }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

import { __test__ } from "../../oms-webhooks";

const OMS_WEBHOOKS_SRC = readFileSync(
  resolve(__dirname, "../../oms-webhooks.ts"),
  "utf-8",
);

describe("Shopify orders/updated line fulfillment status sync", () => {
  it("maps Shopify fulfilled line status to OMS fulfilled", () => {
    expect(
      __test__.mapShopifyLineFulfillmentStatus(
        { fulfillment_status: "fulfilled", fulfillable_quantity: 0 },
        "fulfilled",
      ),
    ).toBe("fulfilled");
  });

  it("marks zero-fulfillable lines fulfilled when Shopify order is fulfilled", () => {
    expect(
      __test__.mapShopifyLineFulfillmentStatus(
        { fulfillment_status: null, fulfillable_quantity: 0 },
        "fulfilled",
      ),
    ).toBe("fulfilled");
  });

  it("keeps unfulfilled lines unfulfilled when Shopify has remaining quantity", () => {
    expect(
      __test__.mapShopifyLineFulfillmentStatus(
        { fulfillment_status: null, fulfillable_quantity: 1 },
        "partial",
      ),
    ).toBe("unfulfilled");
  });

  it("orders/updated writes line fulfillment_status instead of only the order header", () => {
    expect(OMS_WEBHOOKS_SRC).toContain("mapShopifyLineFulfillmentStatus(");
    expect(OMS_WEBHOOKS_SRC).toContain("fulfillmentStatus,");
    expect(OMS_WEBHOOKS_SRC).toContain("fulfillableQuantity:");
  });
});

describe("Shopify line current_quantity reader", () => {
  it("reads a valid current_quantity", () => {
    expect(__test__.readShopifyLineCurrentQuantity({ current_quantity: 15 })).toBe(15);
    expect(__test__.readShopifyLineCurrentQuantity({ current_quantity: "0" })).toBe(0);
  });

  it("returns null when the field is absent so authority keeps its legacy rule", () => {
    expect(__test__.readShopifyLineCurrentQuantity({})).toBeNull();
    expect(__test__.readShopifyLineCurrentQuantity({ current_quantity: null })).toBeNull();
    expect(__test__.readShopifyLineCurrentQuantity(undefined)).toBeNull();
  });

  it("rejects malformed values instead of trusting them", () => {
    for (const bad of [-1, 1.5, "abc", "", Number.NaN]) {
      expect(__test__.readShopifyLineCurrentQuantity({ current_quantity: bad })).toBeNull();
    }
  });
});
