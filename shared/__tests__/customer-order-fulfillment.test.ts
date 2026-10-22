import { describe, expect, it } from "vitest";
import {
  presentCustomerOrderFulfillment,
  presentCustomerOrderLifecycle,
  knownCustomerOrderFulfillment,
} from "../customer-account/order-fulfillment";
describe("customer warehouse status presentation", () => {
  it.each([
    ["ready", "Awaiting picking"],
    ["pending", "Awaiting picking"],
    ["picking", "Being picked"],
    ["in_progress", "Being picked"],
    ["picked", "Preparing shipment"],
    ["packing", "Preparing shipment"],
    ["packed", "Ready to ship"],
    ["completed", "Ready to ship"],
    ["ready_to_ship", "Ready to ship"],
    ["shipped", "Shipped"],
    ["partially_shipped", "Partially shipped"],
    ["cancelled", "Cancelled"],
    ["on_hold", "On hold"],
    ["exception", "Needs attention"],
    ["awaiting_3pl", "Preparing shipment"],
  ])(
    "presents canonical %s as %s without treating editing as picking",
    (state, label) =>
      expect(presentCustomerOrderFulfillment([state]).label).toBe(label),
  );
  it("does not invent picking state from missing or unknown evidence", () => {
    expect(presentCustomerOrderFulfillment([]).code).toBe("unavailable");
    expect(
      presentCustomerOrderFulfillment(["future_status", "ready"]).code,
    ).toBe("unavailable");
  });
  it("aggregates partitions independently of input ordering or cancelled history", () => {
    expect(presentCustomerOrderFulfillment(["packed", "packing"]).label).toBe(
      "Preparing shipment",
    );
    expect(presentCustomerOrderFulfillment(["packing", "packed"]).label).toBe(
      "Preparing shipment",
    );
    expect(presentCustomerOrderFulfillment(["shipped", "ready"]).code).toBe(
      "partially_shipped",
    );
    expect(presentCustomerOrderFulfillment(["shipped", "cancelled"]).code).toBe(
      "shipped",
    );
    expect(
      presentCustomerOrderFulfillment(Object.freeze(["packed", "ready"])).code,
    ).toBe("awaiting_picking");
  });
  it("shows dedicated mutation holds and cancellation progress without hiding actual shipment", () => {
    expect(
      presentCustomerOrderFulfillment(["ready"], { held: true }).code,
    ).toBe("on_hold");
    expect(
      presentCustomerOrderLifecycle(
        presentCustomerOrderFulfillment(["ready"]),
        true,
      ).code,
    ).toBe("cancelling");
    expect(
      presentCustomerOrderLifecycle(
        presentCustomerOrderFulfillment(["shipped"]),
        true,
      ).code,
    ).toBe("shipped");
  });
  it("distinguishes stopped warehouse work from an actually cancelled order", () => {
    const warehouse = Object.freeze(presentCustomerOrderFulfillment(["cancelled"]));
    expect(presentCustomerOrderLifecycle(warehouse, false)).toEqual({
      code: "cancelled", label: "Picking stopped",
    });
    expect(presentCustomerOrderLifecycle(warehouse, true)).toEqual({
      code: "cancelled", label: "Cancelled",
    });
    expect(warehouse.label).toBe("Cancelled");
  });
  it("preserves native status fallback when warehouse evidence is absent or unknown", () => {
    expect(knownCustomerOrderFulfillment(undefined)).toBeUndefined();
    expect(knownCustomerOrderFulfillment(presentCustomerOrderFulfillment([]))).toBeUndefined();
    const picking = Object.freeze(presentCustomerOrderFulfillment(["picking"]));
    expect(knownCustomerOrderFulfillment(picking)).toEqual({
      code: "picking", label: "Being picked",
    });
  });
});
