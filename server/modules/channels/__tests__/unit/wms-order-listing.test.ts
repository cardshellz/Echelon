import { describe, expect, it } from "vitest";
import {
  buildWmsOrderBucketCounts,
  orderMatchesBucket,
  orderMatchesScope,
  parsePagination,
  parsePositiveInteger,
  parseWmsOrderBucket,
  type WmsOrderListOrder,
} from "../../wms-order-listing";

function order(overrides: Partial<WmsOrderListOrder>): WmsOrderListOrder {
  return {
    id: 1,
    orderNumber: "#10001",
    customerName: "Test Customer",
    customerEmail: "test@example.com",
    source: "shopify",
    channelId: 36,
    warehouseId: 1,
    warehouseStatus: "ready",
    onHold: 0,
    createdAt: "2026-06-01T12:00:00.000Z",
    items: [],
    ...overrides,
  };
}

describe("WMS order listing bucket rules", () => {
  it("classifies picked-but-unshipped WMS orders as picked, not shipped or needs_pick", () => {
    const completed = order({ warehouseStatus: "completed", orderNumber: "#58391" });

    expect(orderMatchesBucket(completed, "picked")).toBe(true);
    expect(orderMatchesBucket(completed, "needs_pick")).toBe(false);
    expect(orderMatchesBucket(completed, "shipped")).toBe(false);
  });

  it("treats ready_to_ship as picked so it remains visible before carrier shipment", () => {
    const readyToShip = order({ warehouseStatus: "ready_to_ship" });

    expect(orderMatchesBucket(readyToShip, "picked")).toBe(true);
    expect(orderMatchesBucket(readyToShip, "needs_pick")).toBe(false);
  });

  it("puts held orders in issues and removes them from needs_pick", () => {
    const heldReady = order({ warehouseStatus: "ready", onHold: 1 });

    expect(orderMatchesBucket(heldReady, "issues")).toBe(true);
    expect(orderMatchesBucket(heldReady, "needs_pick")).toBe(false);
  });

  it("counts buckets after operational states are normalized", () => {
    const counts = buildWmsOrderBucketCounts([
      order({ id: 1, warehouseStatus: "ready" }),
      order({ id: 2, warehouseStatus: "in_progress" }),
      order({ id: 3, warehouseStatus: "completed" }),
      order({ id: 4, warehouseStatus: "ready_to_ship" }),
      order({ id: 5, warehouseStatus: "exception" }),
      order({ id: 6, warehouseStatus: "shipped" }),
      order({ id: 7, warehouseStatus: "cancelled" }),
      order({ id: 8, warehouseStatus: "ready", onHold: 1 }),
    ]);

    expect(counts).toEqual({
      needsPick: 2,
      picked: 2,
      issues: 2,
      shipped: 1,
      cancelled: 1,
      all: 8,
    });
  });
});

describe("WMS order listing scope rules", () => {
  it("searches order numbers, customers, external IDs, and item SKUs before pagination", () => {
    const candidate = order({
      orderNumber: "#58391",
      customerName: "Pat Picker",
      customerEmail: "pat@example.com",
      externalOrderId: "12000000000000",
      items: [{ sku: "ARM-ENV-SGL-C700", name: "Case of 700" }],
    });

    expect(orderMatchesScope(candidate, { search: "58391" })).toBe(true);
    expect(orderMatchesScope(candidate, { search: "picker" })).toBe(true);
    expect(orderMatchesScope(candidate, { search: "12000000000000" })).toBe(true);
    expect(orderMatchesScope(candidate, { search: "c700" })).toBe(true);
    expect(orderMatchesScope(candidate, { search: "not-present" })).toBe(false);
  });

  it("applies channel and warehouse scopes together", () => {
    const candidate = order({ channelId: 36, warehouseId: 2 });

    expect(orderMatchesScope(candidate, { channelId: 36, warehouseId: 2 })).toBe(true);
    expect(orderMatchesScope(candidate, { channelId: 36, warehouseId: 1 })).toBe(false);
    expect(orderMatchesScope(candidate, { channelId: 37, warehouseId: 2 })).toBe(false);
  });
});

describe("WMS order listing query parsing", () => {
  it("defaults unknown buckets to needs_pick", () => {
    expect(parseWmsOrderBucket(undefined)).toBe("needs_pick");
    expect(parseWmsOrderBucket("not-a-bucket")).toBe("needs_pick");
  });

  it("accepts only positive integer IDs", () => {
    expect(parsePositiveInteger("1")).toBe(1);
    expect(parsePositiveInteger("0")).toBeUndefined();
    expect(parsePositiveInteger("-1")).toBeUndefined();
    expect(parsePositiveInteger("1.5")).toBeUndefined();
  });

  it("clamps pagination limits", () => {
    expect(parsePagination("25", 100, 250)).toBe(25);
    expect(parsePagination("500", 100, 250)).toBe(250);
    expect(parsePagination("-1", 100, 250)).toBe(100);
    expect(parsePagination("nope", 100, 250)).toBe(100);
  });
});
