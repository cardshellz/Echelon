import { describe, expect, it } from "vitest";
import { poAmendmentImpactSchema } from "@shared/procurement/po-amendment-impact";
import { supplierReturnRecordInputSchema, supplierReturnDetailSchema, supplierReturnPreviewInputSchema, supplierReturnOptionsQuerySchema, supplierReturnListQuerySchema, supplierReturnCostAdjustmentSchema } from "@shared/procurement/supplier-return";
import { projectPoAmendmentReturnedCosts } from "../../po-amendment-return-impact";
import { returnRequest, returnResult } from "../../../../../test/fixtures/supplier-return";

const adjustment = {
  entryId: 101, returnId: 1, returnLineId: 2, returnAllocationId: 3,
  inventoryLotId: 4, costQuantityAllocationId: 5, quantity: 2,
  component: "product" as const, beforeMills: 20001, afterMills: 22002,
  deltaMills: 2001, postingKey: "revision:100:prior:90",
};
const application = {
  purchaseOrderLineId: 11, shipmentId: null, component: "product" as const,
  status: "applied" as const, lotsUpdated: 1, orderCostsUpdated: 0,
  orderCostDeltaCents: 0, issues: [],
};
function impact(extra: Record<string, unknown>) {
  return { quantities: [], shipments: [], lots: [], orderCosts: [], historicalCosts: [],
    applications: [{ ...application, ...extra }] };
}
describe("measured returned value in PO amendment review", () => {
  it("retains stable immutable source identities and exact mills while omitting generated posting IDs", () => {
    const source = { replayed: false, supplierReturnAdjustments: [adjustment] };
    const original = structuredClone(source);
    const projected = projectPoAmendmentReturnedCosts(source);
    expect(projected).toEqual({ returnedCostDeltaMills: 2001, returnedCosts: [{
      returnId: 1, returnLineId: 2, returnAllocationId: 3, inventoryLotId: 4,
      costQuantityAllocationId: 5, quantity: 2, component: "product",
      beforeMills: 20001, afterMills: 22002, deltaMills: 2001,
    }] });
    expect(source).toEqual(original);
    expect(poAmendmentImpactSchema.parse(impact(projected)).applications[0]).toMatchObject(projected);
    expect(projectPoAmendmentReturnedCosts({ replayed: false, supplierReturnAdjustments: [{ ...adjustment, entryId: 999, postingKey: "revision:500:prior:90" }] })).toEqual(projected);
  });
  it("sums signed components exactly without treating replayed historical changes as new work", () => {
    const second = { ...adjustment, entryId: 102, returnAllocationId: 6, costQuantityAllocationId: 7, beforeMills: 9000, afterMills: 6000, deltaMills: -3000 };
    expect(projectPoAmendmentReturnedCosts({ replayed: false, supplierReturnAdjustments: [second, adjustment] }).returnedCostDeltaMills).toBe(-999);
    expect(projectPoAmendmentReturnedCosts({ replayed: true, supplierReturnAdjustments: [adjustment] })).toEqual({});
    expect(projectPoAmendmentReturnedCosts({ replayed: false })).toEqual({});
    expect(poAmendmentImpactSchema.safeParse(impact({})).success).toBe(true);
  });
  it("rejects partial, duplicate, wrong-component and nonconserving preview evidence", () => {
    const projected = projectPoAmendmentReturnedCosts({ replayed: false, supplierReturnAdjustments: [adjustment] });
    for (const extra of [
      { returnedCosts: projected.returnedCosts }, { returnedCostDeltaMills: 2001 },
      { ...projected, returnedCostDeltaMills: 2000 },
      { returnedCosts: [...projected.returnedCosts!, ...projected.returnedCosts!], returnedCostDeltaMills: 4002 },
      { ...projected, returnedCosts: [{ ...projected.returnedCosts![0], component: "landed" }] },
      { ...projected, returnedCosts: [{ ...projected.returnedCosts![0], afterMills: 22003 }] },
    ]) expect(poAmendmentImpactSchema.safeParse(impact(extra)).success).toBe(false);
  });
  it.each([0.1, NaN, Number.MAX_SAFE_INTEGER + 1])("safely refuses malformed delta %s", deltaMills => {
    const projected = projectPoAmendmentReturnedCosts({ replayed: false, supplierReturnAdjustments: [adjustment] });
    expect(poAmendmentImpactSchema.safeParse(impact({ ...projected, returnedCostDeltaMills: deltaMills })).success).toBe(false);
    expect(poAmendmentImpactSchema.safeParse(impact({ ...projected, returnedCosts: [{ ...projected.returnedCosts![0], deltaMills }] })).success).toBe(false);
  });
  it("fails closed when an aggregate exact delta exceeds the supported integer range", () => {
    const largest = { ...adjustment, beforeMills: 0, afterMills: Number.MAX_SAFE_INTEGER, deltaMills: Number.MAX_SAFE_INTEGER };
    expect(() => projectPoAmendmentReturnedCosts({ replayed: false, supplierReturnAdjustments: [largest,
      { ...largest, entryId: 102, returnAllocationId: 6, beforeMills: 0, afterMills: 1, deltaMills: 1 }] })).toThrow();
  });
});
describe("physical return reason admission parity", () => {
  it("uses the active quantity owner's 1000-character limit without rejecting retained historical detail", () => {
    expect(supplierReturnRecordInputSchema.safeParse({ ...returnRequest(), reason: "a".repeat(1000) }).success).toBe(true);
    expect(supplierReturnRecordInputSchema.safeParse({ ...returnRequest(), reason: "a".repeat(1001) }).success).toBe(false);
    const retained = returnResult().return;
    expect(supplierReturnDetailSchema.safeParse({ ...retained, reason: "a".repeat(2000) }).success).toBe(true);
  });
});

describe("incoming physical return SQL integer identities", () => {
  const maximumId = 2_147_483_647;
  it.each([maximumId, maximumId + 1])("validates preview and record identities at %s", candidate => {
    const allowed = candidate === maximumId;
    for (const input of [
      { vendorId: candidate, lines: [{ inventoryLotId: 501, quantity: 1 }] },
      { vendorId: 5, lines: [{ inventoryLotId: candidate, quantity: 1 }] },
    ]) {
      expect(supplierReturnPreviewInputSchema.safeParse(input).success).toBe(allowed);
      expect(supplierReturnRecordInputSchema.safeParse({ ...returnRequest(), ...input }).success).toBe(allowed);
    }
  });
  it.each(["vendorId", "purchaseOrderId", "receivingOrderId", "afterLotId"])("bounds options query %s", field => {
    expect(supplierReturnOptionsQuerySchema.safeParse({ vendorId: "5", [field]: String(maximumId) }).success).toBe(true);
    expect(supplierReturnOptionsQuerySchema.safeParse({ vendorId: "5", [field]: String(maximumId + 1) }).success).toBe(false);
  });
  it.each(["vendorId", "purchaseOrderId", "receivingOrderId", "afterId"])("bounds list query %s", field => {
    expect(supplierReturnListQuerySchema.safeParse({ [field]: String(maximumId) }).success).toBe(true);
    expect(supplierReturnListQuerySchema.safeParse({ [field]: String(maximumId + 1) }).success).toBe(false);
  });
  it("preserves safe bigint allocation and value history identities", () => {
    expect(supplierReturnCostAdjustmentSchema.safeParse({ ...adjustment,
      entryId: Number.MAX_SAFE_INTEGER, returnAllocationId: maximumId + 1,
      costQuantityAllocationId: maximumId + 2 }).success).toBe(true);
  });
});
