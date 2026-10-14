import { describe, expect, it } from "vitest";
import { recordedCostTotalIsValid } from "../../recorded-cost-total";

describe("recorded exact consumption total", () => {
  const cost = {
    quantity: "30000",
    unitCostMills: "649",
    totalCostMills: "19465200",
    exactTotals: {
      quantityAllocationId: "1",
      productMills: "15000000",
      packagingMills: "0",
      landedMills: "4465200",
    },
  };
  it("accepts a conserved exact amount with a rounded unit-rate mirror", () =>
    expect(recordedCostTotalIsValid(cost)).toBe(true));
  it("retains the uniform-price validation without quantity custody", () => {
    expect(recordedCostTotalIsValid({ ...cost, exactTotals: undefined })).toBe(
      false,
    );
    expect(
      recordedCostTotalIsValid({
        ...cost,
        totalCostMills: "19470000",
        exactTotals: undefined,
      }),
    ).toBe(true);
  });
  it("rejects conflicting amounts and invalid source identities", () => {
    expect(
      recordedCostTotalIsValid({ ...cost, totalCostMills: "19465201" }),
    ).toBe(false);
    expect(
      recordedCostTotalIsValid({
        ...cost,
        exactTotals: { ...cost.exactTotals, quantityAllocationId: "0" },
      }),
    ).toBe(false);
    expect(
      recordedCostTotalIsValid({
        ...cost,
        exactTotals: { ...cost.exactTotals, landedMills: "-1" },
      }),
    ).toBe(false);
    expect(recordedCostTotalIsValid({ ...cost, quantity: "0" })).toBe(false);
    expect(recordedCostTotalIsValid({ ...cost, unitCostMills: "0.649" })).toBe(
      false,
    );
  });
});
