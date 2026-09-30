import { describe, expect, it } from "vitest";
import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";
import { selectClaimPickCaseBreaks } from "../../domain/claim-pick-case-breaks";
import { resolveReplenishmentAutoExecution } from "../../../inventory/domain/replenishment-auto-execution";

const operation = (overrides: Partial<ClaimPlanDto["operations"][number]> = {}): ClaimPlanDto["operations"][number] => ({
  lineKey: "order-item:11", operationKey: "case-pack", parentOperationKey: null, operationType: "break_pack",
  warehouseId: 1, authorityId: 1, destinationVariantId: 101, sourceVariantIds: [102],
  inputs: [{ sourceVariantId: 102, requiredQty: "1" }], plannedExecutions: "1",
  outputQty: "40", committedOutputQty: "2", outputLocationId: 100, ...overrides,
});
const select = (operations = [operation()], overrides: Partial<Parameters<typeof selectClaimPickCaseBreaks>[0]> = {}) =>
  selectClaimPickCaseBreaks({ operations, states: new Map(operations.map(op => [op.operationKey, "pending"])),
    orderItemId: 11, targetVariantId: 101, warehouseId: 1, locationId: 100,
    readyQty: BigInt(0), pickQty: BigInt(2), ...overrides });

describe("claim-backed inline case break selection", () => {
  it("uses finished custody first and opens only the required committed output", () => {
    expect(select(undefined, { readyQty: BigInt(2) })).toEqual([]);
    expect(select([operation(), operation({ operationKey: "second" })])).toHaveLength(1);
    expect(select(undefined, { readyQty: BigInt(1) })).toHaveLength(1);
  });
  it("executes case to inner pack to each in prerequisite order", () => {
    const child = operation({ operationKey: "case-inner", parentOperationKey: "case-pack", destinationVariantId: 102 });
    expect(select([operation(), child]).map(op => op.operationKey)).toEqual(["case-inner", "case-pack"]);
    expect(select([operation(), child], { states: new Map([["case-inner", "completed"], ["case-pack", "pending"]]) })
      .map(op => op.operationKey)).toEqual(["case-pack"]);
  });
  it.each([
    { warehouseId: 2 }, { outputLocationId: 200 }, { lineKey: "order-item:12" },
    { destinationVariantId: 999 }, { operationType: "component_build" as const },
    { operationType: "assemble_pack" as const }, { operationType: "directed_conversion" as const },
  ])("does not select unrelated or non-case-break work: %o", override => {
    expect(select([operation(override)])).toEqual([]);
  });
  it("never silently auto-builds a dependency or re-executes a completed case break", () => {
    expect(() => select([operation(), operation({ operationKey: "build", parentOperationKey: "case-pack", operationType: "component_build" })]))
      .toThrow("requires warehouse work");
    expect(select(undefined, { states: new Map([["case-pack", "completed"]]) })).toEqual([]);
    expect(() => select(undefined, { states: new Map([["case-pack", "released"]]) })).toThrow("requires warehouse work");
    expect(() => select([operation(), operation()])).toThrow("unique and bounded");
  });
});

describe("shared replenishment execution policy", () => {
  it("honors explicit SKU and tier decisions before warehouse defaults", () => {
    expect(resolveReplenishmentAutoExecution(2, 1, { replenMode: "inline", inlineReplenMaxUnits: 50 }, 10).shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(1, 2, null, 1000).shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(null, 2, { replenMode: "inline", inlineReplenMaxUnits: 50 }, 1).shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(null, 1, null, 1000).shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(null, null, null, 1).shouldAutoExecute).toBe(false);
  });
  it("uses base units for hybrid thresholds and never auto-executes transfers", () => {
    const settings = { replenMode: "hybrid", inlineReplenMaxUnits: 50 };
    expect(resolveReplenishmentAutoExecution(0, 0, settings, 50).shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(0, 0, settings, 51).shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(1, 1, settings, 1, "full_case").shouldAutoExecute).toBe(false);
  });
});
