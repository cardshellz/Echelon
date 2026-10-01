import { describe, expect, it } from "vitest";
import {
  buildWmsOrderBucketCounts,
  orderMatchesBucket,
  orderMatchesScope,
  parsePagination,
  parsePositiveInteger,
  parseWmsOrderBucket,
  WMS_ORDER_BUCKETS,
  type WmsOrderListItem,
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

function line(overrides: Partial<WmsOrderListItem>): WmsOrderListItem {
  return { sku: "SKU-1", name: "Sleeves", onHold: false, status: "pending", quantity: 1, ...overrides };
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

  it("puts held orders in hold, not in needs_pick or issues", () => {
    const heldReady = order({ warehouseStatus: "ready", onHold: 1 });

    expect(orderMatchesBucket(heldReady, "hold")).toBe(true);
    expect(orderMatchesBucket(heldReady, "needs_pick")).toBe(false);
    expect(orderMatchesBucket(heldReady, "issues")).toBe(false);
  });

  it("keeps issues for exception orders that are not held", () => {
    expect(orderMatchesBucket(order({ warehouseStatus: "exception" }), "issues")).toBe(true);
    expect(orderMatchesBucket(order({ warehouseStatus: "exception", onHold: 1 }), "issues")).toBe(false);
    expect(orderMatchesBucket(order({ warehouseStatus: "exception", onHold: 1 }), "hold")).toBe(true);
  });

  it("files the legacy on_hold status under hold", () => {
    expect(orderMatchesBucket(order({ warehouseStatus: "on_hold" }), "hold")).toBe(true);
    expect(orderMatchesBucket(order({ warehouseStatus: "on_hold" }), "issues")).toBe(false);
  });

  it("puts an order with an open held line in hold even though the order flag is clear", () => {
    // A line hold never sets wms.orders.on_hold; without this the order shows
    // in no hold view and the held line is forgotten.
    for (const warehouseStatus of ["ready", "in_progress", "completed", "ready_to_ship", "partially_shipped"]) {
      const lineHeld = order({ warehouseStatus, items: [line({ onHold: true })] });
      expect(orderMatchesBucket(lineHeld, "hold")).toBe(true);
      expect(orderMatchesBucket(lineHeld, "needs_pick")).toBe(false);
      expect(orderMatchesBucket(lineHeld, "picked")).toBe(false);
    }
  });

  it("ignores held lines that can no longer ship", () => {
    for (const closed of [line({ onHold: true, status: "cancelled" }), line({ onHold: true, status: "short" }), line({ onHold: true, quantity: 0 })]) {
      const candidate = order({ warehouseStatus: "ready", items: [closed] });
      expect(orderMatchesBucket(candidate, "hold")).toBe(false);
      expect(orderMatchesBucket(candidate, "needs_pick")).toBe(true);
    }
  });

  it("files shipped and cancelled orders by status even with a leftover hold flag or held line", () => {
    const shipped = order({ warehouseStatus: "shipped", onHold: 1, items: [line({ onHold: true })] });
    const cancelled = order({ warehouseStatus: "cancelled", onHold: 1 });

    expect(orderMatchesBucket(shipped, "shipped")).toBe(true);
    expect(orderMatchesBucket(shipped, "hold")).toBe(false);
    expect(orderMatchesBucket(cancelled, "cancelled")).toBe(true);
    expect(orderMatchesBucket(cancelled, "hold")).toBe(false);
    expect(orderMatchesBucket(cancelled, "issues")).toBe(false);
  });

  it("places every order in at most one bucket besides all", () => {
    const statuses = ["ready", "in_progress", "partially_shipped", "completed", "ready_to_ship", "exception", "on_hold", "shipped", "cancelled", "awaiting_3pl", " READY "];
    const variants: Partial<WmsOrderListOrder>[] = [
      {},
      { onHold: 1 },
      { items: [line({ onHold: true })] },
      { items: [line({ onHold: true, status: "cancelled" })] },
      { onHold: 1, items: [line({ onHold: true })] },
    ];
    for (const warehouseStatus of statuses) {
      for (const variant of variants) {
        const candidate = order({ warehouseStatus, ...variant });
        const matches = WMS_ORDER_BUCKETS.filter((bucket) => bucket !== "all" && orderMatchesBucket(candidate, bucket));
        expect(matches.length, `${warehouseStatus} ${JSON.stringify(variant)} matched ${matches.join(",")}`).toBeLessThanOrEqual(1);
      }
    }
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
      order({ id: 9, warehouseStatus: "partially_shipped", items: [line({ onHold: true })] }),
      order({ id: 10, warehouseStatus: "cancelled", onHold: 1 }),
      order({ id: 11, warehouseStatus: "awaiting_3pl" }),
    ]);

    expect(counts).toEqual({
      needsPick: 2,
      picked: 2,
      hold: 2,
      issues: 1,
      shipped: 1,
      cancelled: 2,
      all: 11,
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
