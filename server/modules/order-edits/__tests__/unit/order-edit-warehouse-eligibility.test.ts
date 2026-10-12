import { describe, expect, it } from "vitest";
import {
  orderEditWarehouseBlockers,
  orderEditWarehouseShipmentBlocker,
  type OrderEditWarehouseOrderState,
  type OrderEditWarehouseShipmentState,
} from "../../domain/order-edit-warehouse-eligibility";

const operationId = "11111111-1111-4111-8111-111111111111";
function ready(
  overrides: Partial<OrderEditWarehouseOrderState> = {},
): OrderEditWarehouseOrderState {
  return {
    warehouse_status: "ready",
    cancelled: false,
    started_at: null,
    assigned_picker_id: null,
    picked_count: 0,
    has_pick_work: false,
    has_label: false,
    combined_group_id: null,
    order_edit_operation_id: null,
    ...overrides,
  };
}
function shipment(
  overrides: Partial<OrderEditWarehouseShipmentState> = {},
): OrderEditWarehouseShipmentState {
  return { status: "planned", requires_review: false, shipping_engine: "shipstation", ...overrides };
}

describe("plain-language warehouse edit cutoff", () => {
  it("says shipped only when every warehouse partition is shipped", () => {
    const orders = [ready({ warehouse_status: "shipped", has_label: true, has_pick_work: true }), ready({ warehouse_status: "shipped" })];
    expect(orderEditWarehouseBlockers(orders)).toEqual([
      "This order has shipped and can no longer be edited.",
    ]);
    expect(orderEditWarehouseShipmentBlocker(orders, [shipment({ status: "shipped", requires_review: true })])).toBe(
      "This order has shipped and can no longer be edited.",
    );
  });

  it.each([
    [ready({ warehouse_status: "shipped" }), ready()],
    [ready({ warehouse_status: "partially_shipped" })],
  ])("explains that shipping started without claiming all partitions shipped: %j", (...orders) => {
    expect(orderEditWarehouseBlockers(orders)).toEqual([
      "This order has already started shipping and can no longer be edited.",
    ]);
  });

  it.each(["shipped", "returned", "lost"])("uses canonical %s shipment semantics even if the order projection still says ready", (status) => {
    expect(orderEditWarehouseShipmentBlocker([ready()], [shipment({ status })])).toBe(
      "This order has already started shipping and can no longer be edited.",
    );
  });

  it.each([
    { started_at: "2026-10-12T12:00:00Z" },
    { assigned_picker_id: "picker" },
    { picked_count: 1 },
    { has_pick_work: true },
    ...["in_progress", "picking", "picked", "packing", "packed", "completed", "ready_to_ship"].map((warehouse_status) => ({ warehouse_status })),
  ])("explains the preparation cutoff, including a prior pick/unpick: %j", (state) => {
    expect(orderEditWarehouseBlockers([ready(state)])).toEqual([
      "We're already preparing this order, so it can no longer be edited.",
    ]);
  });

  it("does not call a created label a shipped order", () => {
    expect(orderEditWarehouseBlockers([ready({ has_label: true })])).toEqual([
      "This order is being prepared for shipping and can no longer be edited.",
    ]);
    expect(orderEditWarehouseShipmentBlocker([ready()], [shipment({ status: "labeled" })])).toBe(
      "This order is being prepared for shipping and can no longer be edited.",
    );
  });

  it.each([
    { requires_review: true },
    { shipping_engine: "other-provider" },
    { status: "unknown" },
  ])("keeps a %j shipment blocked with a neutral explanation", (state) => {
    expect(orderEditWarehouseShipmentBlocker([ready()], [shipment(state)])).toBe(
      "This order can't be edited online right now. Please contact us for help.",
    );
  });

  it.each(["planned", "queued", "on_hold"])("still allows an untouched %s shipment", (status) => {
    for (const shipping_engine of [null, "shipstation"])
      expect(orderEditWarehouseShipmentBlocker([ready()], [shipment({ status, shipping_engine })])).toBeNull();
  });

  it("keeps cancellation, unknown warehouse state, missing order, and competing edits blocked", () => {
    expect(orderEditWarehouseBlockers([ready({ cancelled: true })])).toEqual([
      "This order has been canceled and can no longer be edited.",
    ]);
    expect(orderEditWarehouseBlockers([ready({ warehouse_status: "unexpected" })])).toEqual([
      "This order can't be edited online right now. Please contact us for help.",
    ]);
    expect(orderEditWarehouseBlockers([ready({ started_at: undefined })])).toEqual([
      "This order can't be edited online right now. Please contact us for help.",
    ]);
    expect(orderEditWarehouseBlockers([])).toEqual([
      "This order isn't available to edit yet. Please try again later.",
    ]);
    const held = Object.freeze(ready({ order_edit_operation_id: operationId }));
    expect(orderEditWarehouseBlockers([held])).toEqual([
      "This order already has an edit in progress. Finish or cancel that edit before making more changes.",
    ]);
    expect(orderEditWarehouseBlockers(Object.freeze([held]), operationId)).toEqual([]);
  });
});
