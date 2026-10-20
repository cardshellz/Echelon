import { describe, expect, it } from "vitest";
import { projectExpectedReceipts } from "../../domain/expected-receipts";
const line = {
  purchase_order_id: 1,
  po_number: "PO-1",
  vendor_name: "Supplier",
  status: "partially_received",
  expected_delivery_date: null,
  confirmed_delivery_date: null,
  eta: null,
  order_qty: 200000,
  received_qty: 100000,
  cancelled_qty: 0,
  total_product_cost_cents: "100000",
};
describe("expected receipt value from current PO quantities", () => {
  it("prorates the exact product amount instead of multiplying rounded cents per piece", () => {
    expect(projectExpectedReceipts([line])[0]).toMatchObject({
      pending_units: "100000",
      pending_lines: "1",
      pending_value_cents: "50000",
    });
    expect(
      projectExpectedReceipts([{ ...line, order_qty: 400000 }])[0],
    ).toMatchObject({ pending_units: "300000", pending_value_cents: "75000" });
  });
  it("preserves cancellations and handles zero, full receipts and overreceipts", () => {
    expect(
      projectExpectedReceipts([{ ...line, cancelled_qty: 100000 }])[0]
        .pending_value_cents,
    ).toBe("0");
    expect(
      projectExpectedReceipts([{ ...line, received_qty: 300000 }])[0]
        .pending_units,
    ).toBe("0");
    expect(
      projectExpectedReceipts([{ ...line, total_product_cost_cents: 0 }])[0]
        .pending_value_cents,
    ).toBe("0");
  });
  it("rounds each line once and adds amounts without overflow or floating point", () => {
    const tiny = {
      ...line,
      order_qty: 2,
      received_qty: 1,
      total_product_cost_cents: 1,
    };
    expect(projectExpectedReceipts([tiny, tiny])[0].pending_value_cents).toBe(
      "2",
    );
    expect(
      projectExpectedReceipts([
        {
          ...line,
          order_qty: 2147483647,
          received_qty: 0,
          total_product_cost_cents: Number.MAX_SAFE_INTEGER,
        },
      ])[0].pending_value_cents,
    ).toBe(String(Number.MAX_SAFE_INTEGER));
    expect(() =>
      projectExpectedReceipts([
        {
          ...line,
          received_qty: 0,
          total_product_cost_cents: Number.MAX_SAFE_INTEGER,
        },
        { ...line, received_qty: 0 },
      ]),
    ).toThrow();
  });
  it.each([
    { order_qty: 0 },
    { order_qty: 1.5 },
    { received_qty: -1 },
    { total_product_cost_cents: "12.5" },
  ])("rejects malformed evidence %j", (patch) => {
    expect(() => projectExpectedReceipts([{ ...line, ...patch }])).toThrow();
  });
});
