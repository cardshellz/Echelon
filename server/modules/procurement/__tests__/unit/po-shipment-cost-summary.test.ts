import { describe, expect, it } from "vitest";
import { buildPoShipmentCostSummary } from "../../domain/po-shipment-cost-summary";

const input = () => ({
  poId: 1,
  currency: "USD",
  poAmountCents: 10000,
  shipmentIds: [10],
  charges: [
    {
      id: 20,
      shipmentId: 10,
      costType: "freight",
      currency: "USD",
      amountCents: 1000,
      confirmed: true,
    },
  ],
  allocations: [
    { costId: 20, poId: 1, lineId: 30, allocatedCents: 600 },
    { costId: 20, poId: 2, lineId: 31, allocatedCents: 400 },
  ],
  lines: [
    {
      id: 30,
      quantity: 80,
      sourceTotalMills: 60000,
      sourceQuantity: 80,
      evidence: "confirmed",
      applicationStatus: "applied",
      issue: null,
    },
  ],
});

describe("PO shipment cost summary", () => {
  it("adds only this PO's allocated share, preserving the supplier contractual total", () => {
    expect(buildPoShipmentCostSummary(input())).toMatchObject({
      freightCents: 600,
      totalCents: 600,
      poAmountCents: 10000,
      combinedCostCents: 10600,
      appliedLines: 1,
      inventoryCosting: "applied",
    });
  });
  it("reports duties and other fees including signed credits", () => {
    const data = input();
    data.charges = [
      { ...data.charges[0], costType: "duty" },
      { ...data.charges[0], id: 21, costType: "brokerage", amountCents: -50 },
    ];
    data.allocations.push({
      costId: 21,
      poId: 1,
      lineId: 30,
      allocatedCents: -50,
    });
    data.lines[0].sourceTotalMills = 55000;
    expect(buildPoShipmentCostSummary(data)).toMatchObject({
      dutyCents: 600,
      otherCents: -50,
      totalCents: 550,
      combinedCostCents: 10550,
    });
  });
  it("exposes an unallocated charge instead of reporting a complete zero", () => {
    const data = input();
    data.allocations = [];
    expect(buildPoShipmentCostSummary(data)).toMatchObject({
      unallocatedChargeCount: 1,
      combinedCostCents: null,
      inventoryCosting: "pending",
    });
  });
  it("exposes a missing amount and stale allocation", () => {
    expect(
      buildPoShipmentCostSummary({
        ...input(),
        charges: [{ ...input().charges[0], amountCents: null }],
      }),
    ).toMatchObject({ unallocatedChargeCount: 1, combinedCostCents: null });
  });
  it("requires allocation conservation across all POs", () => {
    const data = input();
    data.allocations[1].allocatedCents = 399;
    expect(buildPoShipmentCostSummary(data)).toMatchObject({
      unallocatedChargeCount: 1,
      combinedCostCents: null,
    });
  });
  it("does not add unsupported currency amounts", () => {
    const data = input();
    data.charges[0].currency = "EUR";
    expect(buildPoShipmentCostSummary(data)).toMatchObject({
      totalCents: 0,
      unsupportedCurrencyCount: 1,
      combinedCostCents: null,
      inventoryCosting: "pending",
    });
  });
  it("does not call estimates confirmed inventory costs", () => {
    const data = input();
    data.charges[0].confirmed = false;
    expect(buildPoShipmentCostSummary(data)).toMatchObject({
      estimatedCents: 600,
      appliedLines: 0,
      pendingLines: 1,
      inventoryCosting: "pending",
    });
  });
  it("exposes a rejected application", () => {
    const data = input();
    data.lines[0].applicationStatus = "review_required";
    expect(buildPoShipmentCostSummary(data)).toMatchObject({
      reviewLines: 1,
      inventoryCosting: "review_required",
    });
  });
  it("invalidates an application after the amount or quantity changes", () => {
    for (const line of [
      { ...input().lines[0], sourceTotalMills: 59999 },
      { ...input().lines[0], sourceQuantity: 79 },
    ]) {
      expect(
        buildPoShipmentCostSummary({ ...input(), lines: [line] }),
      ).toMatchObject({ pendingLines: 1, appliedLines: 0 });
    }
  });
  it("keeps conflicting invoice evidence under review", () => {
    const data = input();
    expect(
      buildPoShipmentCostSummary({
        ...data,
        charges: [
          { ...data.charges[0], issue: "LANDED_INVOICE_SOURCE_MISMATCH" },
        ],
      }),
    ).toMatchObject({ inventoryCosting: "review_required", appliedLines: 0 });
  });
  it("validates source identities and integer money", () => {
    expect(() =>
      buildPoShipmentCostSummary({ ...input(), poAmountCents: 0.5 }),
    ).toThrow();
    expect(() =>
      buildPoShipmentCostSummary({
        ...input(),
        charges: [input().charges[0], input().charges[0]],
      }),
    ).toThrow();
    expect(() =>
      buildPoShipmentCostSummary({
        ...input(),
        allocations: [{ costId: 999, poId: 1, lineId: 30, allocatedCents: 1 }],
      }),
    ).toThrow();
    expect(() =>
      buildPoShipmentCostSummary({
        ...input(),
        poAmountCents: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow();
  });
  it("preserves a legitimate empty shipment list", () => {
    expect(
      buildPoShipmentCostSummary({
        ...input(),
        shipmentIds: [],
        charges: [],
        allocations: [],
        lines: [],
      }),
    ).toMatchObject({
      shipmentCount: 0,
      combinedCostCents: 10000,
      inventoryCosting: "no_costs",
    });
  });
});
