import { describe, expect, it } from "vitest";
import {
  rejectSupplyRefreshBeforePlanning, rejectSupplyRefreshPlan, remainingShortfall, type ClaimLineBalance,
} from "../../domain/claim-supply-refresh";

const line = (overrides: Partial<ClaimLineBalance> = {}): ClaimLineBalance => ({
  lineKey: "order-item:1",
  remainingRequestedQty: BigInt(40),
  remainingPlannedQty: BigInt(0),
  pickedTargetQty: BigInt(0),
  ...overrides,
});

describe("claim supply refresh: before planning", () => {
  it("allows a line claimed at zero (the #63658 shape: 40 requested, 0 planned)", () => {
    expect(rejectSupplyRefreshBeforePlanning([line()])).toBeNull();
    expect(remainingShortfall([line()])).toBe(BigInt(40));
  });

  it("declines a claim with no shortfall", () => {
    expect(rejectSupplyRefreshBeforePlanning([line({ remainingPlannedQty: BigInt(40) })]))
      .toMatchObject({ code: "CLAIM_SUPPLY_REFRESH_NOT_SHORT" });
  });

  it("declines when a line is partly picked, because its custody cannot move to the replacement", () => {
    expect(rejectSupplyRefreshBeforePlanning([
      line({ lineKey: "order-item:2", pickedTargetQty: BigInt(3), remainingRequestedQty: BigInt(2), remainingPlannedQty: BigInt(2) }),
      line(),
    ])).toMatchObject({ code: "CLAIM_SUPPLY_REFRESH_PICK_IN_PROGRESS", lineKey: "order-item:2" });
  });

  it("allows fully picked sibling lines (the F-03 order shape: other lines 5/5 and 10/10)", () => {
    expect(rejectSupplyRefreshBeforePlanning([
      line({ lineKey: "order-item:2", pickedTargetQty: BigInt(5), remainingRequestedQty: BigInt(0), remainingPlannedQty: BigInt(0) }),
      line({ lineKey: "order-item:3", remainingRequestedQty: BigInt(1) }),
    ])).toBeNull();
  });
});

describe("claim supply refresh: after planning", () => {
  const previous = [
    line({ lineKey: "order-item:1", remainingRequestedQty: BigInt(40), remainingPlannedQty: BigInt(0) }),
    line({ lineKey: "order-item:2", remainingRequestedQty: BigInt(5), remainingPlannedQty: BigInt(5) }),
  ];

  it("accepts a plan that reserves the short line and keeps the other", () => {
    expect(rejectSupplyRefreshPlan(previous, [
      { lineKey: "order-item:1", plannedQty: "40", shortfallQty: "0" },
      { lineKey: "order-item:2", plannedQty: "5", shortfallQty: "0" },
    ])).toBeNull();
  });

  it("accepts a partial improvement", () => {
    expect(rejectSupplyRefreshPlan(previous, [
      { lineKey: "order-item:1", plannedQty: "12", shortfallQty: "28" },
      { lineKey: "order-item:2", plannedQty: "5", shortfallQty: "0" },
    ])).toBeNull();
  });

  it("declines when nothing new can be reserved", () => {
    expect(rejectSupplyRefreshPlan(previous, [
      { lineKey: "order-item:1", plannedQty: "0", shortfallQty: "40" },
      { lineKey: "order-item:2", plannedQty: "5", shortfallQty: "0" },
    ])).toMatchObject({ code: "CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT", previousShortfallQty: "40", nextShortfallQty: "40" });
  });

  it("declines a plan that would take stock from another line, even if total shortfall drops", () => {
    expect(rejectSupplyRefreshPlan(previous, [
      { lineKey: "order-item:1", plannedQty: "40", shortfallQty: "0" },
      { lineKey: "order-item:2", plannedQty: "4", shortfallQty: "1" },
    ])).toMatchObject({ code: "CLAIM_SUPPLY_REFRESH_LINE_REGRESSION", lineKey: "order-item:2" });
  });

  it("treats a line missing from the new plan as planned zero", () => {
    expect(rejectSupplyRefreshPlan(previous, [
      { lineKey: "order-item:1", plannedQty: "40", shortfallQty: "0" },
    ])).toMatchObject({ code: "CLAIM_SUPPLY_REFRESH_LINE_REGRESSION", lineKey: "order-item:2" });
  });

  it("ignores fully settled lines that no longer appear in demand", () => {
    expect(rejectSupplyRefreshPlan([
      line({ lineKey: "order-item:9", remainingRequestedQty: BigInt(0), remainingPlannedQty: BigInt(0), pickedTargetQty: BigInt(5) }),
      line({ lineKey: "order-item:1", remainingRequestedQty: BigInt(1) }),
    ], [{ lineKey: "order-item:1", plannedQty: "1", shortfallQty: "0" }])).toBeNull();
  });
});
