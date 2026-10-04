import { describe, expect, it } from "vitest";

import {
  planReplenishmentExecution,
  planReplenishmentDemand,
  ReplenishmentExecutionDomainError,
} from "../../domain/replenishment-execution.domain";

describe("replenishment destination demand", () => {
  it("keeps exact-SKU counts when the source and destination are packages of ten", () => {
    expect(planReplenishmentDemand({ destinationVariantQuantity: 20, destinationUnitsPerVariant: 10,
      sourceUnitsPerVariant: 10, sourceBatchQuantity: 1 }))
      .toEqual({ qtySourceUnits: 20, qtyTargetUnits: 200, qtyPickUnits: 20 });
  });

  it("rounds once to whole authorized source batches and reports whole destination output", () => {
    expect(planReplenishmentDemand({ destinationVariantQuantity: 11, destinationUnitsPerVariant: 5,
      sourceUnitsPerVariant: 25, sourceBatchQuantity: 2 }))
      .toEqual({ qtySourceUnits: 4, qtyTargetUnits: 100, qtyPickUnits: 20 });
  });

  it("rejects unsafe arithmetic and a source batch that cannot produce whole destination units", () => {
    const input = { destinationVariantQuantity: 1, destinationUnitsPerVariant: 5,
      sourceUnitsPerVariant: 12, sourceBatchQuantity: 1 };
    expect(() => planReplenishmentDemand(input)).toThrowError(expect.objectContaining({ code: "REPLENISHMENT_DEMAND_NOT_DIVISIBLE" }));
    expect(() => planReplenishmentDemand({ ...input, destinationVariantQuantity: Number.MAX_SAFE_INTEGER }))
      .toThrowError(expect.objectContaining({ code: "REPLENISHMENT_QUANTITY_OVERFLOW" }));
    expect(() => planReplenishmentDemand({ ...input, destinationVariantQuantity: 0 }))
      .toThrowError(expect.objectContaining({ code: "INVALID_REPLENISHMENT_EXECUTION_INPUT" }));
  });
});

describe("planReplenishmentExecution", () => {
  it("plans a same-variant transfer without changing variant identity", () => {
    expect(planReplenishmentExecution({
      replenMethod: "full_case",
      sourceVariantId: 101,
      sourceProductId: 10,
      sourceUnitsPerVariant: 25,
      pickVariantId: 101,
      pickProductId: 10,
      pickUnitsPerVariant: 25,
      qtySourceUnits: 2,
      qtyTargetUnits: 50,
    })).toEqual({
      method: "direct_transfer",
      sourceVariantId: 101,
      pickVariantId: 101,
      qtySourceUnits: 2,
      qtyPickUnits: 2,
      movedBaseUnits: 50,
    });
  });

  it("plans an exact case break in destination variant units", () => {
    expect(planReplenishmentExecution({
      replenMethod: "case_break",
      sourceVariantId: 100,
      sourceProductId: 10,
      sourceUnitsPerVariant: 1000,
      pickVariantId: 101,
      pickProductId: 10,
      pickUnitsPerVariant: 25,
      qtySourceUnits: 2,
      qtyTargetUnits: 2000,
    })).toEqual({
      method: "case_break",
      sourceVariantId: 100,
      pickVariantId: 101,
      qtySourceUnits: 2,
      qtyPickUnits: 80,
      movedBaseUnits: 2000,
    });
  });

  it("rejects a persisted target quantity that does not conserve base units", () => {
    expect(() => planReplenishmentExecution({
      replenMethod: "case_break",
      sourceVariantId: 100,
      sourceProductId: 10,
      sourceUnitsPerVariant: 1000,
      pickVariantId: 101,
      pickProductId: 10,
      pickUnitsPerVariant: 25,
      qtySourceUnits: 2,
      qtyTargetUnits: 1999,
    })).toThrowError(expect.objectContaining({
      code: "REPLENISHMENT_TASK_QUANTITY_MISMATCH",
    } satisfies Partial<ReplenishmentExecutionDomainError>));
  });

  it("rejects cross-product and indivisible case breaks", () => {
    const base = {
      replenMethod: "case_break",
      sourceVariantId: 100,
      sourceProductId: 10,
      sourceUnitsPerVariant: 12,
      pickVariantId: 101,
      pickProductId: 10,
      pickUnitsPerVariant: 5,
      qtySourceUnits: 1,
      qtyTargetUnits: 12,
    };

    expect(() => planReplenishmentExecution({ ...base, pickProductId: 11 }))
      .toThrowError(expect.objectContaining({ code: "REPLENISHMENT_CASE_BREAK_PRODUCT_MISMATCH" }));
    expect(() => planReplenishmentExecution(base))
      .toThrowError(expect.objectContaining({ code: "INVALID_REPLENISHMENT_CASE_BREAK" }));
  });
});
