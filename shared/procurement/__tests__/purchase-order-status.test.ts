import { describe, expect, it } from "vitest";
import { purchaseOrderStatus, resolveCurrentPhysicalStatus } from "../purchase-order-status";

describe("shared purchase order status", () => {
  it.each(["shipped", "in_transit", "arrived", "receiving", "received"])("uses %s instead of the compatibility acknowledged status", physicalStatus => {
    expect(purchaseOrderStatus({ status: "acknowledged", physicalStatus }).code).toBe(physicalStatus);
  });
  it.each(["draft", "pending_approval", "approved", "closed", "cancelled"])("preserves the %s decision", status => {
    expect(purchaseOrderStatus({ status, physicalStatus: "draft" }).code).toBe(status);
  });
  it("preserves closed short and never reopens a closed purchase", () => {
    expect(purchaseOrderStatus({ status: "closed", physicalStatus: "received" }).label).toBe("Closed");
    expect(purchaseOrderStatus({ status: "closed", physicalStatus: "short_closed" }).label).toBe("Closed short");
  });
  it("shares the lifecycle compatibility fallback for older rows", () => {
    expect(resolveCurrentPhysicalStatus({ status: "partially_received", physicalStatus: "draft" })).toBe("receiving");
    expect(purchaseOrderStatus({ status: "received" }).label).toBe("Received");
    expect(purchaseOrderStatus({ physicalStatus: "unrecognized" }).label).toBe("Status needs review");
  });
});
