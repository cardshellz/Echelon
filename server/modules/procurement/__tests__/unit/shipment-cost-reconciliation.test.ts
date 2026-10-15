import { describe, expect, it } from "vitest";
import type { CostIssue, CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import {
  reconciliationPreview,
  reconciliationRequestSchema,
  reconciliationPostingSchema,
} from "@shared/procurement/cost-reconciliation";
import { formatShipmentExceptionAmount } from "@shared/procurement/shipment-cost-exception";
import {
  reconciliationEligibility,
  reconciliationBlocker,
  reconciliationState,
  reconciliationDeltas,
  type ReconciliationRecordEvidence,
} from "../../../inventory/domain/cost-reconciliation";
import { shipmentCostReviewResponse } from "@shared/procurement/shipment-cost-review-version";

const source: CostSourceRevision = {
  contractVersion: 1,
  revision: 1,
  fingerprint: "a".repeat(64),
  component: "landed",
  scope: {
    kind: "shipment_line",
    purchaseOrderId: 1,
    purchaseOrderLineId: 2,
    inboundShipmentId: 3,
    inboundShipmentLineId: 4,
  },
  sources: [{ kind: "shipment_cost", documentId: 3, lineId: 5, version: "b".repeat(64) }],
  currency: "USD",
  totalMills: 1000000,
  basePieces: 100,
  evidence: "confirmed",
  packagingTreatment: "not_applicable",
  issue: null,
  manualOverride: null,
};
const gap: CostIssue = {
  code: "COST_UNRESOLVED_QUANTITY_RETAINED",
  message: "Synthetic incomplete history",
  unresolvedQuantity: {
    inventoryLotId: 6,
    allocationId: 7,
    lotNumber: "TEST-LOT",
    originalQuantity: 10,
    onHandQuantityAtReview: 4,
    recordedOutflowQuantityAtReview: 5,
    quantity: 1,
    component: "landed",
    amountMills: 100001,
  },
};
const missing: CostIssue = { code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Synthetic missing origin" };
const record: ReconciliationRecordEvidence = {
  record: {
    lotId: 6,
    lotNumber: "TEST-LOT",
    originalQuantity: 10,
    onHandQuantity: 0,
    receiptId: 8,
    receiptLineId: 9,
    quantityWithoutHistory: null,
    explanation: "Recorded receipt with no subsequent links",
  },
  hasCogs: false,
  hasContribution: false,
  hasLegacyCogs: false,
  hasPhysicalCommitments: false,
  existingLandedMills: 0,
};

describe("shipment cost reconciliation policy", () => {
  it("conserves every sub-cent amount and does not mutate the preview input", () => {
    const input = {
        sourceAmountMills: 1000000,
        historicalAmountMills: 100001,
        balances: { historical_cogs: 0, inventory_variance: 0 },
      },
      copy = structuredClone(input);
    const preview = reconciliationPreview(input, "inventory_variance");
    expect(preview).toEqual({
      assignedMills: 899999,
      before: { historical_cogs: 0, inventory_variance: 0, unassignedMills: 100001 },
      after: { historical_cogs: 0, inventory_variance: 100001, unassignedMills: 0 },
    });
    expect(input).toEqual(copy);
    expect(formatShipmentExceptionAmount(100001, "USD")).toBe("$10.0001");
    expect(formatShipmentExceptionAmount(-1, "USD")).toBe("-$0.0001");
  });
  it("supports maximum safe amounts, zero and signed reversals", () => {
    expect(
      reconciliationPreview(
        {
          sourceAmountMills: Number.MAX_SAFE_INTEGER,
          historicalAmountMills: Number.MAX_SAFE_INTEGER,
          balances: { historical_cogs: 0, inventory_variance: 0 },
        },
        "historical_cogs",
      ).after.historical_cogs,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      reconciliationPreview(
        { sourceAmountMills: 0, historicalAmountMills: 0, balances: { historical_cogs: 5, inventory_variance: 0 } },
        "historical_cogs",
      ).before.unassignedMills,
    ).toBe(-5);
    expect(
      reconciliationDeltas(
        { historical_cogs: 10, inventory_variance: 0 },
        { historical_cogs: 0, inventory_variance: 10 },
      ),
    ).toEqual([
      { destination: "historical_cogs", beforeMills: 10, afterMills: 0, deltaMills: -10 },
      { destination: "inventory_variance", beforeMills: 0, afterMills: 10, deltaMills: 10 },
    ]);
  });
  it.each([NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amount %s", (value) => {
    expect(() =>
      reconciliationPreview(
        { sourceAmountMills: value, historicalAmountMills: 0, balances: { historical_cogs: 0, inventory_variance: 0 } },
        "historical_cogs",
      ),
    ).toThrow();
  });
  it("binds the decision to historical quantities, not the subsequent price", () => {
    const first = reconciliationEligibility(source, [gap]);
    const next = reconciliationEligibility({ ...source, totalMills: 2000000 }, [
      { ...gap, unresolvedQuantity: { ...gap.unresolvedQuantity!, amountMills: 200002 } },
    ]);
    expect(next?.identity).toBe(first?.identity);
    expect(next?.amountMills).toBe(200002);
    expect(
      reconciliationEligibility(source, [
        { ...gap, unresolvedQuantity: { ...gap.unresolvedQuantity!, allocationId: 17 } },
      ])?.identity,
    ).not.toBe(first?.identity);
    expect(reconciliationEligibility(source, [gap, gap])).toBeNull();
    expect(
      reconciliationEligibility({ ...source, totalMills: 0 }, [
        { ...gap, unresolvedQuantity: { ...gap.unresolvedQuantity!, amountMills: 0 } },
      ])?.amountMills,
    ).toBe(0);
  });
  it("requires identified affected records for a missing-origin posting", () => {
    expect(reconciliationEligibility(source, [missing])).toBeNull();
    const first = reconciliationEligibility(source, [missing], [record]);
    expect(first?.amountMills).toBe(source.totalMills);
    expect(
      reconciliationEligibility(source, [missing], [{ ...record, record: { ...record.record, lotId: 16 } }])?.identity,
    ).not.toBe(first?.identity);
  });
  it.each([
    { currency: "EUR" },
    { totalMills: -1 },
    { totalMills: null },
    { component: "product" },
    { evidence: "unknown" },
  ])("rejects unsupported source %j", (patch) => {
    expect(reconciliationEligibility({ ...source, ...patch } as CostSourceRevision, [gap])).toBeNull();
  });
  it.each([
    { hasCogs: true },
    { hasContribution: true },
    { hasPhysicalCommitments: true },
    { existingLandedMills: 1 },
    { record: { ...record.record, onHandQuantity: 1 } },
  ])("blocks double attribution %j", (patch) => {
    expect(reconciliationBlocker(source, [missing], [{ ...record, ...patch }], false)).toContain(
      "stock or existing costs",
    );
  });
  it("blocks mixed known/missing receipts and unknown issue codes", () => {
    expect(reconciliationBlocker(source, [missing], [record], true)).toContain("twice");
    expect(reconciliationBlocker(source, [gap], [{ ...record, hasLegacyCogs: true }], true)).toContain(
      "Older order cost records",
    );
    expect(reconciliationBlocker(source, [{ code: "OTHER", message: "Unhandled" }], [record], false)).toContain(
      "source evidence",
    );
  });
  it("only calls the actual approved balance reconciled", () => {
    const eligible = reconciliationEligibility(source, [gap])!;
    const approval = { fingerprint: eligible.identity, destination: "inventory_variance" as const };
    expect(
      reconciliationState(eligible, { approval, balances: { historical_cogs: 0, inventory_variance: 100001 } }).status,
    ).toBe("posted");
    expect(
      reconciliationState(eligible, { approval, balances: { historical_cogs: 100001, inventory_variance: 0 } }).status,
    ).toBe("review_required");
    expect(
      reconciliationState(eligible, {
        approval: { ...approval, fingerprint: "c".repeat(64) },
        balances: { historical_cogs: 0, inventory_variance: 100001 },
      }).status,
    ).toBe("review_required");
    expect(
      reconciliationState(eligible, { approval: null, balances: { historical_cogs: 0, inventory_variance: 0 } }).status,
    ).toBe("unresolved");
  });
  it("rejects forged posting deltas and arbitrary request amount overrides", () => {
    expect(
      reconciliationPostingSchema.safeParse({
        id: 1,
        approvalId: 2,
        destination: "historical_cogs",
        beforeMills: 1,
        afterMills: 2,
        deltaMills: 4,
      }).success,
    ).toBe(false);
    expect(
      reconciliationRequestSchema.safeParse({
        sourceVersion: "a".repeat(64),
        destination: "inventory_variance",
        reason: "Synthetic reason",
        amountMills: 0,
      }).success,
    ).toBe(false);
  });
  it("negotiates strict older response shapes without altering the source DTO", () => {
    const review = {
      reconciliation: {
        status: "posted" as const,
        postedMills: 1,
        unassignedMills: 0,
        destination: "historical_cogs" as const,
      },
    };
    const response = { lines: [{ lineId: 1, exceptionReview: review as never }] },
      copy = structuredClone(response);
    expect(shipmentCostReviewResponse(response, "3")).toEqual(response);
    expect(shipmentCostReviewResponse(response, "2")).toEqual({ lines: [{ lineId: 1, exceptionReview: {} }] });
    expect(shipmentCostReviewResponse(response, undefined)).toEqual({ lines: [{ lineId: 1 }] });
    expect(response).toEqual(copy);
  });
});
