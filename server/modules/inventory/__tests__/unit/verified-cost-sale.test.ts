import { describe, expect, it } from "vitest";
import {
  hasVerifiedCostSale,
  type CostSaleEvidence,
} from "../../domain/verified-cost-sale";
const evidence: CostSaleEvidence = {
  orderStatus: "completed",
  cancelled: false,
  itemMatchesOrder: true,
  itemStatus: "completed",
  orderedUnits: 10,
  shipments: [],
};
const shipment = {
  quantity: 10,
  status: "shipped",
  voided: false,
  purpose: "customer_fulfillment",
  membership: "authoritative",
};
describe("COGS authority after historical cost-link repair", () => {
  it("does not treat completed picking as a sale", () =>
    expect(hasVerifiedCostSale(evidence)).toBe(false));
  it("accepts the shipped order rollup", () =>
    expect(hasVerifiedCostSale({ ...evidence, orderStatus: "shipped" })).toBe(
      true,
    ));
  it("accepts complete recorded shipment coverage even when the old order status says completed", () =>
    expect(hasVerifiedCostSale({ ...evidence, shipments: [shipment] })).toBe(
      true,
    ));
  it("does not guess which lot rows shipped when coverage is partial", () =>
    expect(
      hasVerifiedCostSale({
        ...evidence,
        shipments: [{ ...shipment, quantity: 9 }],
      }),
    ).toBe(false));
  it.each([
    { voided: true },
    { status: "queued" },
    { status: "labeled" },
    { purpose: "replacement" },
    { membership: "pending_append" },
  ])("rejects shipment evidence %j", (change) =>
    expect(
      hasVerifiedCostSale({
        ...evidence,
        shipments: [{ ...shipment, ...change }],
      }),
    ).toBe(false),
  );
  it.each([
    { cancelled: true },
    { orderStatus: "cancelled" },
    { itemStatus: "cancelled" },
    { itemMatchesOrder: false },
  ])("preserves existing COGS on unresolved order evidence %j", (change) =>
    expect(
      hasVerifiedCostSale({
        ...evidence,
        orderStatus: "shipped",
        ...change,
        shipments: [shipment],
      }),
    ).toBe(false),
  );
});
