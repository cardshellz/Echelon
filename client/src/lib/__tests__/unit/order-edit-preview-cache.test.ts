import { describe, expect, it } from "vitest";
import { orderEditOrderSchema } from "@shared/order-edits/order-edit.contract";
import {
  nextOrderEditPreviewInput,
  orderEditPreviewRefreshDelay,
} from "@/lib/order-edit-preview-cache";

const lineId = "gid://shopify/LineItem/1";
const order = orderEditOrderSchema.parse({
  omsOrderId: 1,
  connectionId: 4,
  orderNumber: "#64043",
  customerName: "Fixture",
  customerEmail: null,
  activeOperationId: null,
  currency: "USD",
  revision: "revision-1",
  eligibility: { editable: true, reasons: [] },
  financialStatus: "Paid",
  warehouseStatus: "Not yet picking",
  lines: [
    {
      lineItemId: lineId,
      variantId: "gid://shopify/ProductVariant/10",
      title: "Sleeves",
      variantTitle: null,
      sku: "SLEEVE",
      quantity: 1,
      unitPriceCents: 233,
      totalCents: 233,
    },
  ],
  totalCents: 233,
});
const base = {
  connectionId: 4,
  omsOrderId: 1,
  expectedRevision: "revision-1",
  changes: [],
  additions: [],
};

describe("bounded order edit read-ahead", () => {
  it("warms just the next quantity on a single-line order without mutating the plan", () => {
    const before = structuredClone(base);
    expect(nextOrderEditPreviewInput(order, base, null)).toEqual({
      ...base,
      changes: [{ lineItemId: lineId, quantity: 2 }],
    });
    expect(base).toEqual(before);
    expect(order.lines[0].quantity).toBe(1);
  });
  it("does not guess a target on a multi-line order", () => {
    const multiple = {
      ...order,
      lines: [
        ...order.lines,
        { ...order.lines[0], lineItemId: "gid://shopify/LineItem/2" },
      ],
    };
    expect(nextOrderEditPreviewInput(multiple, base, null)).toBeNull();
  });
  it("changes only the selected line and preserves other quantities", () => {
    const input = {
      ...base,
      changes: [{ lineItemId: lineId, quantity: 4 }],
      additions: [
        { variantId: "gid://shopify/ProductVariant/22", quantity: 2 },
      ],
    };
    const before = structuredClone(input);
    expect(
      nextOrderEditPreviewInput(order, input, { kind: "line", id: lineId }),
    ).toEqual({ ...input, changes: [{ lineItemId: lineId, quantity: 5 }] });
    expect(input).toEqual(before);
  });
  it("warms one additional unit of a newly added SKU", () => {
    const input = {
      ...base,
      additions: [
        { variantId: "gid://shopify/ProductVariant/22", quantity: 1 },
      ],
    };
    expect(
      nextOrderEditPreviewInput(order, input, {
        kind: "addition",
        id: input.additions[0].variantId,
      }),
    ).toEqual({
      ...input,
      additions: [{ ...input.additions[0], quantity: 2 }],
    });
    expect(input.additions[0].quantity).toBe(1);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 10000])(
    "does not submit invalid or out-of-range quantities %s",
    (quantity) => {
      expect(
        nextOrderEditPreviewInput(
          order,
          { ...base, changes: [{ lineItemId: lineId, quantity }] },
          null,
        ),
      ).toBeNull();
    },
  );
  it("does not warm a nonexistent item or an unchanged original cart", () => {
    expect(
      nextOrderEditPreviewInput(order, base, { kind: "line", id: "missing" }),
    ).toBeNull();
    expect(
      nextOrderEditPreviewInput(order, base, {
        kind: "addition",
        id: "missing",
      }),
    ).toBeNull();
    expect(
      nextOrderEditPreviewInput(
        order,
        { ...base, changes: [{ lineItemId: lineId, quantity: 0 }] },
        null,
      ),
    ).toBeNull();
  });
});
describe("preview refresh at server expiry", () => {
  const now = Date.parse("2026-10-13T16:00:00.000Z");
  it("refreshes after server expiry so it cannot receive the same expiring cache entry", () => {
    expect(
      orderEditPreviewRefreshDelay(new Date(now + 1000).toISOString(), now),
    ).toBe(1100);
    expect(
      orderEditPreviewRefreshDelay(new Date(now - 1).toISOString(), now),
    ).toBe(100);
  });
  it("rejects invalid clock and expiry data", () => {
    expect(orderEditPreviewRefreshDelay("invalid", now)).toBe(false);
    expect(
      orderEditPreviewRefreshDelay(new Date(now).toISOString(), Number.NaN),
    ).toBe(false);
  });
});
