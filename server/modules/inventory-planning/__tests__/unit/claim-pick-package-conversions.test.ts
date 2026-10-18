import { describe, expect, it } from "vitest";
import type { ClaimPlanDto } from "@shared/types/inventory-availability-planner";
import { isClaimPickRepackaging, selectClaimPickPackageConversions,
  type ClaimPickPackagingPath } from "../../domain/claim-pick-package-conversions";
import { resolveReplenishmentAutoExecution } from "../../../inventory/domain/replenishment-auto-execution";

const operation = (overrides: Partial<ClaimPlanDto["operations"][number]> = {}): ClaimPlanDto["operations"][number] => ({
  lineKey: "order-item:11", operationKey: "case-pack", parentOperationKey: null, operationType: "break_pack",
  warehouseId: 1, authorityId: 1, destinationVariantId: 101, sourceVariantIds: [102],
  inputs: [{ sourceVariantId: 102, requiredQty: "1" }], plannedExecutions: "1",
  outputQty: "40", committedOutputQty: "2", outputLocationId: 100, ...overrides,
});
const select = (operations = [operation()], overrides: Partial<Parameters<typeof selectClaimPickPackageConversions>[0]> = {}) =>
  selectClaimPickPackageConversions({ operations, states: new Map(operations.map(op => [op.operationKey, "pending"])),
    orderItemId: 11, targetVariantId: 101, warehouseId: 1, locationId: 100,
    readyQty: BigInt(0), pickQty: BigInt(2), ...overrides });

describe("claim-backed inline package conversion selection", () => {
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
    { destinationVariantId: 999 },
  ])("does not select unrelated work: %o", override => {
    expect(select([operation(override)])).toEqual([]);
  });
  it.each(["assemble_pack", "directed_conversion"] as const)("selects approved %s work for policy validation before picking", operationType => {
    expect(select([operation({ operationType })])).toEqual([operation({ operationType })]);
  });
  it("assembles a root component build at pick", () => {
    const build = operation({ operationKey: "build", operationType: "component_build",
      inputs: [{ sourceVariantId: 201, requiredQty: "1" }, { sourceVariantId: 202, requiredQty: "1" }], sourceVariantIds: [201, 202] });
    expect(select([build])).toEqual([build]);
  });
  it("orders the #64366 shape prerequisite-first: component build, then the P5 package conversion", () => {
    const pack = operation({ operationKey: "p5-pack", operationType: "directed_conversion", committedOutputQty: "2", outputQty: "2" });
    const build = operation({ operationKey: "box-build", parentOperationKey: "p5-pack", operationType: "component_build",
      destinationVariantId: 102, outputQty: "10", committedOutputQty: "10", outputLocationId: 300 });
    expect(select([pack, build]).map(op => op.operationKey)).toEqual(["box-build", "p5-pack"]);
    // A completed build is never rebuilt: only the remaining conversion runs.
    expect(select([pack, build], { states: new Map([["box-build", "completed"], ["p5-pack", "pending"]]) })
      .map(op => op.operationKey)).toEqual(["p5-pack"]);
  });
  it("orders nested builds deepest-first under a package conversion", () => {
    const pack = operation({ operationKey: "pack", operationType: "assemble_pack" });
    const outer = operation({ operationKey: "outer-build", parentOperationKey: "pack", operationType: "component_build", destinationVariantId: 102 });
    const inner = operation({ operationKey: "inner-build", parentOperationKey: "outer-build", operationType: "component_build", destinationVariantId: 103 });
    const sibling = operation({ operationKey: "a-sibling", parentOperationKey: "outer-build", operationType: "break_pack", destinationVariantId: 104 });
    expect(select([pack, outer, inner, sibling]).map(op => op.operationKey))
      .toEqual(["a-sibling", "inner-build", "outer-build", "pack"]);
  });
  it("never re-executes a build already sent to assembly work", () => {
    const build = operation({ operationKey: "build", operationType: "component_build" });
    expect(() => select([build], { states: new Map([["build", "executing"]]) })).toThrow("already sent to assembly work");
  });
  it("keeps warehouse, output-location, cycle and bound fences for builds", () => {
    const pack = operation();
    expect(() => select([pack, operation({ operationKey: "build", parentOperationKey: "case-pack", operationType: "component_build", warehouseId: 2 })]))
      .toThrow("requires warehouse work");
    expect(() => select([pack, operation({ operationKey: "build", parentOperationKey: "case-pack", operationType: "component_build", outputLocationId: null })]))
      .toThrow("requires warehouse work");
    // A parent loop with no root is never walked (and never spins).
    const loop = [
      operation({ operationKey: "a", parentOperationKey: "c", operationType: "component_build" }),
      operation({ operationKey: "b", parentOperationKey: "a", operationType: "component_build" }),
      operation({ operationKey: "c", parentOperationKey: "b", operationType: "component_build" }),
    ];
    expect(select(loop)).toEqual([]);
    const bounded = Array.from({ length: 1001 }, (_, index) =>
      operation({ operationKey: `op-${index}`, operationType: "component_build" }));
    expect(() => select(bounded)).toThrow("unique and bounded");
  });
  it("never re-executes a completed case break", () => {
    expect(select(undefined, { states: new Map([["case-pack", "completed"]]) })).toEqual([]);
    expect(() => select(undefined, { states: new Map([["case-pack", "released"]]) })).toThrow("requires warehouse work");
    expect(() => select([operation(), operation()])).toThrow("unique and bounded");
  });
});

describe("inline repackaging evidence", () => {
  const path: ClaimPickPackagingPath = {
    id:241,operationType:"directed_conversion",sourceVariantId:511,destinationVariantId:162,
    sourceProductId:77,destinationProductId:77,inputQty:5,outputQty:1,sourceUnitsPerVariant:1,
    destinationUnitsPerVariant:5,authorityState:"allowed",validationState:"valid",
  };
  const repack = operation({ authorityId:241,operationType:"directed_conversion",sourceVariantIds:[511],
    inputs:[{ sourceVariantId:511,requiredQty:"5" }],destinationVariantId:162,
    outputQty:"1",committedOutputQty:"1" });
  it("recognizes the actual 63662 shape: five eaches become one P5 pack", () => {
    expect(isClaimPickRepackaging(repack,path)).toBe(true);
    expect(isClaimPickRepackaging({ ...repack,plannedExecutions:"2",outputQty:"2",
      inputs:[{ sourceVariantId:511,requiredQty:"10" }] },path)).toBe(true);
    expect(isClaimPickRepackaging({ ...repack,operationType:"assemble_pack" },{ ...path,operationType:"assemble_pack" })).toBe(true);
  });
  it.each([
    { authorityState:"blocked" },{ validationState:"invalid" },{ id:242 },{ operationType:"break_pack" },
    { sourceVariantId:512 },{ destinationVariantId:163 },{ sourceProductId:78 },{ sourceProductId:0,destinationProductId:0 },
    { inputQty:0 },{ inputQty:6 },{ outputQty:2 },{ destinationUnitsPerVariant:10 },
    { sourceUnitsPerVariant:1.5 },{ destinationUnitsPerVariant:Number.MAX_SAFE_INTEGER+1 },
  ])("does not infer packaging authority from invalid or non-conserving evidence: %o", override => {
    expect(isClaimPickRepackaging(repack,{ ...path,...override })).toBe(false);
  });
  it("rejects absent path evidence, mismatched inputs, and component builds", () => {
    expect(isClaimPickRepackaging(repack,null)).toBe(false);
    expect(isClaimPickRepackaging({ ...repack,operationType:"component_build" },path)).toBe(false);
    expect(isClaimPickRepackaging({ ...repack,sourceVariantIds:[511,512] },path)).toBe(false);
    expect(isClaimPickRepackaging({ ...repack,inputs:[{ sourceVariantId:511,requiredQty:"4" }] },path)).toBe(false);
    expect(isClaimPickRepackaging({ ...repack,inputs:[] },path)).toBe(false);
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
  it("uses base units for hybrid thresholds and honors inline for same-SKU full-case replenishment", () => {
    const settings = { replenMode: "hybrid", inlineReplenMaxUnits: 50 };
    expect(resolveReplenishmentAutoExecution(0, 0, settings, 50).shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(0, 0, settings, 51).shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(1, 1, settings, 1, "full_case").shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(1, 1, settings, 1, "pallet_drop").shouldAutoExecute).toBe(false);
  });
  it("applies the same SKU, tier and warehouse controls to proven package conversions, never component builds", () => {
    expect(resolveReplenishmentAutoExecution(2,1,{ replenMode:"inline",inlineReplenMaxUnits:50 },5,"package_conversion").shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(1,2,null,5,"package_conversion").shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(null,1,null,5,"package_conversion").shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(0,0,{ replenMode:"hybrid",inlineReplenMaxUnits:5 },5,"package_conversion").shouldAutoExecute).toBe(true);
    expect(resolveReplenishmentAutoExecution(0,0,{ replenMode:"hybrid",inlineReplenMaxUnits:5 },6,"package_conversion").shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(0,0,{ replenMode:"queue",inlineReplenMaxUnits:50 },5,"package_conversion").shouldAutoExecute).toBe(false);
    expect(resolveReplenishmentAutoExecution(1,1,{ replenMode:"inline",inlineReplenMaxUnits:50 },5,"component_build").shouldAutoExecute).toBe(false);
  });
});
