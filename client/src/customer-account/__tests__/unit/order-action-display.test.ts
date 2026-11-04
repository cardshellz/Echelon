import { describe, expect, it } from "vitest";
import { customerOrderActionsSchema } from "@shared/customer-account/order-actions";
import { retainedOrderActions } from "../../order-action-display";

const ready = customerOrderActionsSchema.parse({
  externalOrderId: "100",
  orderReference: "#TEST",
  omsOrderId: 1,
  state: "ready",
  verifiedAt: "2026-11-03T20:00:00Z",
  validUntil: "2026-11-03T20:01:00Z",
  snapshot: {
    order: null,
    returnOrder: null,
    orderFailed: false,
    returnFailed: false,
  },
});
describe("last verified order options during background maintenance", () => {
  it("retains an unavailable owner's display but replaces it when new verified rules deny an action", () => {
    const order = {
      omsOrderId: 1,
      connectionId: 4,
      orderNumber: "#TEST",
      customerName: "Fixture",
      customerEmail: null,
      activeOperationId: null,
      currency: "USD" as const,
      revision: "fixture",
      eligibility: { editable: true, reasons: [] },
      lines: [],
      totalCents: 0,
      financialStatus: "Paid",
      warehouseStatus: "Awaiting picking",
    };
    const previous = { ...ready, snapshot: { ...ready.snapshot!, order } };
    const failed = {
      ...ready,
      snapshot: { ...ready.snapshot!, order: null, orderFailed: true },
    };
    expect(retainedOrderActions(failed, previous)?.snapshot).toMatchObject({
      order,
      orderFailed: true,
    });
    const denied = {
      ...ready,
      snapshot: {
        ...ready.snapshot!,
        order: {
          ...order,
          eligibility: { editable: false, reasons: ["Picking started"] },
        },
      },
    };
    expect(retainedOrderActions(denied, previous)).toBe(denied);
  });
  it("keeps presentation while observing refresh and outage, without changing either lookup state", () => {
    for (const state of ["refreshing", "failed"] as const) {
      const current = customerOrderActionsSchema.parse({
        ...ready,
        state,
        snapshot: null,
      });
      expect(retainedOrderActions(current, ready)).toBe(ready);
      expect(current).toMatchObject({ state, snapshot: null });
    }
  });
  it("replaces old capabilities with the new verified result, including an explicit unavailable result", () => {
    const replacement = {
      ...ready,
      snapshot: { ...ready.snapshot!, orderFailed: true },
    };
    expect(retainedOrderActions(replacement, ready)).toBe(replacement);
    expect(
      retainedOrderActions(
        { ...ready, state: "not_managed", omsOrderId: null, snapshot: null },
        ready,
      ),
    ).toBeUndefined();
  });
  it.each([
    { externalOrderId: "101" },
    { orderReference: "#OTHER" },
    { omsOrderId: 2 },
    { omsOrderId: null },
  ])("does not reuse another or unverifiable order's display: %j", (patch) => {
    expect(
      retainedOrderActions(
        { ...ready, state: "refreshing", snapshot: null, ...patch },
        ready,
      ),
    ).toBeUndefined();
  });
  it("has no invented options for a cold refresh", () => {
    expect(
      retainedOrderActions({ ...ready, state: "refreshing", snapshot: null }),
    ).toBeUndefined();
  });
});
