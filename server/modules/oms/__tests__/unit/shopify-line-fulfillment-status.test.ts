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
