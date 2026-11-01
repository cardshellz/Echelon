import { describe, expect, it } from "vitest";
import { customerOrderProgressSchema, type CustomerReturnProgressStatus } from "@shared/customer-account/order-progress";
import { refundActivityLabel, returnProgressLabel } from "../../customer-order-progress-presentation";

function progress(codes: CustomerReturnProgressStatus["code"][] = []) {
  return customerOrderProgressSchema.parse({ delivery: null, packages: [], refunds: [], returns: codes.map((code, index) => ({
    key: `rma:${index}`, reference: `RMA-${index}`, status: { code, label: code }, refund: { code: "not_started", label: "Refund not started" },
    quantity: 1, receivedQuantity: 0, parcels: [],
  })) });
}
describe("independent compact customer status labels", () => {
  it("hides a genuinely absent return without hiding a failed return read", () => {
    expect(returnProgressLabel(undefined)).toBeNull();
    expect(returnProgressLabel(progress())).toBeNull();
    expect(returnProgressLabel(null)).toBe("Status unavailable");
    expect(returnProgressLabel({ ...progress(), unavailable: ["returns"] })).toBe("Status unavailable");
  });
  it("does not allow another active return to hide a known problem", () => {
    expect(returnProgressLabel(progress(["label_ready", "needs_attention"]))).toBe("Needs attention");
    expect(returnProgressLabel(progress(["received", "delivery_issue"]))).toBe("Delivery issue");
  });
  it("counts active requests once and retains separate completed history", () => {
    expect(returnProgressLabel(progress(["label_ready", "in_transit", "complete"]))).toBe("2 returns in progress");
    expect(returnProgressLabel(progress(["complete", "label_ready"]))).toBe("label_ready");
    expect(returnProgressLabel(progress(["complete", "cancelled"]))).toBe("Closed");
  });
  it("does not treat receiving or opening a return as a refund request", () => {
    expect(refundActivityLabel("Paid", progress(["label_ready"]))).toBeNull();
    expect(refundActivityLabel("Paid", progress(["received"]))).toBeNull();
  });
  it("keeps actual refund progress under Payment and does not infer whole-order Refunded", () => {
    const data = { ...progress(["label_ready"]), refunds: [{ key: "rma:0", reference: "RMA-0", status: { code: "processing" as const, label: "Refund processing" } }] };
    expect(refundActivityLabel("Paid", data)).toBe("Refund processing");
    expect(returnProgressLabel(data)).toBe("label_ready");
    expect(refundActivityLabel("Partially refunded", data)).toBe("Refund processing");
    expect(refundActivityLabel("Refunded", data)).toBeNull();
    expect(refundActivityLabel("Paid", { ...data, refunds: [{ ...data.refunds[0], status: { code: "completed", label: "Refund issued" } }] })).toBe("Refund issued");
    expect(refundActivityLabel("Paid", { ...data, unavailable: ["refunds"], refunds: [] })).toBe("Refund status unavailable");
  });
});
