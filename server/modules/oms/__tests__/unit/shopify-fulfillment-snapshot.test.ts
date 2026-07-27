import { describe, expect, it, vi } from "vitest";

import { ShopifyFulfillmentSnapshotReader } from "../../shopify-fulfillment-snapshot";

function successfulFulfillment(overrides: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Fulfillment/7001",
    status: "SUCCESS",
    trackingInfo: [{ number: " 9400-123 " }],
    fulfillmentLineItems: {
      nodes: [{
        id: "gid://shopify/FulfillmentLineItem/8001",
        quantity: 2,
        lineItem: { id: "gid://shopify/LineItem/9001" },
      }],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

describe("ShopifyFulfillmentSnapshotReader", () => {
  it("returns normalized exact evidence for successful fulfillments only", async () => {
    const request = vi.fn(async () => ({
      order: {
        id: "gid://shopify/Order/12001",
        fulfillmentsCount: { count: 2 },
        fulfillments: [
          successfulFulfillment(),
          successfulFulfillment({
            id: "gid://shopify/Fulfillment/7002",
            status: "CANCELLED",
          }),
        ],
      },
    }));
    const reader = new ShopifyFulfillmentSnapshotReader(
      { request } as any,
      () => new Date("2026-07-27T12:00:00.000Z"),
    );

    const result = await reader.fetch({ external_order_id: "12001" });

    expect(result).toEqual({
      sourceOrderId: "12001",
      observedAt: new Date("2026-07-27T12:00:00.000Z"),
      complete: true,
      packages: [{
        sourceFulfillmentId: "7001",
        trackingNumbers: ["9400123"],
        items: [{
          sourceFulfillmentLineId: "8001",
          channelOrderLineId: "9001",
          quantity: 2,
        }],
      }],
      incompleteReasons: [],
    });
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("fulfillmentEvidenceForOrder"),
      { id: "gid://shopify/Order/12001" },
    );
  });

  it("fails closed when fulfillment lines are truncated or malformed", async () => {
    const request = vi.fn(async () => ({
      order: {
        id: "gid://shopify/Order/12001",
        fulfillmentsCount: { count: 1 },
        fulfillments: [successfulFulfillment({
          fulfillmentLineItems: {
            nodes: [{ id: null, quantity: 0, lineItem: null }],
            pageInfo: { hasNextPage: true },
          },
        })],
      },
    }));
    const reader = new ShopifyFulfillmentSnapshotReader({ request } as any);

    const result = await reader.fetch({ external_order_id: "12001" });

    expect(result.complete).toBe(false);
    expect(result.incompleteReasons).toEqual([
      "shopify_fulfillment_has_no_valid_lines:7001",
      "shopify_fulfillment_line_invalid:7001",
      "shopify_fulfillment_lines_truncated:7001",
    ]);
  });

  it("fails closed when Shopify returns another order or reaches the package cap", async () => {
    const fulfillments = Array.from({ length: 250 }, (_, index) =>
      successfulFulfillment({ id: `gid://shopify/Fulfillment/${7001 + index}` }));
    const request = vi.fn(async () => ({
      order: {
        id: "gid://shopify/Order/99999",
        fulfillmentsCount: { count: 251 },
        fulfillments,
      },
    }));
    const reader = new ShopifyFulfillmentSnapshotReader({ request } as any);

    const result = await reader.fetch({ external_order_id: "12001" });

    expect(result.complete).toBe(false);
    expect(result.incompleteReasons).toContain(
      "shopify_order_not_found_or_identity_mismatch",
    );
    expect(result.incompleteReasons).toContain("shopify_fulfillment_snapshot_truncated_or_count_missing");
  });
});
