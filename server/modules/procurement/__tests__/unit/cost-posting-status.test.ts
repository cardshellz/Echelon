import { describe, expect, it } from "vitest";
import { isCostReconciliationPosted, resolveCostPostingStatus } from "@shared/procurement/cost-posting-status";
import { isShipmentCostLinePosted } from "@shared/procurement/shipment-cost-workflow";
import { buildPoShipmentCosts, type PoShipmentCostSummaryInput } from "../../domain/po-shipment-cost-summary";
import type { ShipmentCostException } from "@shared/procurement/shipment-cost-exception";

const issue = { code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Historical receipt links are missing." };
const review = (): ShipmentCostException => ({ state: "open", fingerprint: "a".repeat(64), kind: "missing_receipt_history",
  currency: "USD", allocatedMills: 100000, amountMills: 100000, lotsUpdated: 0, cogsRowsUpdated: 0, issues: [issue], decision: null,
  reconciliation: { status: "posted", destination: "historical_cogs", postedMills: 100000, unassignedMills: 0 } });
const input = (): PoShipmentCostSummaryInput => ({ poId: 1, currency: "USD", poAmountCents: 10000, shipmentIds: [10],
  charges: [{ id: 20, shipmentId: 10, costType: "freight", currency: "USD", amountCents: 1000, confirmed: false }],
  allocations: [{ costId: 20, poId: 1, lineId: 30, allocatedCents: 1000 }],
  lines: [{ id: 30, quantity: 80, sourceTotalMills: 100000, sourceQuantity: 80, evidence: "estimated", applicationStatus: "applied", issue: null }] });

describe("one current cost posting decision", () => {
  it.each(["estimated", "confirmed"])("PO and shipment agree for ordinary applied %s evidence", evidence => {
    const source = input(); source.lines[0].evidence = evidence; source.charges[0].confirmed = evidence === "confirmed";
    const application = { id: 40, recordedAt: "2026-10-16T12:00:00.000Z", status: "applied" as const, lotsUpdated: 1, cogsRowsUpdated: 0, issues: [] };
    const result = buildPoShipmentCosts(source, { freightCents: 0, dutyCents: 0 }, [{ lineId: 30, shipmentId: 10,
      shipmentNumber: "TEST-10", shipmentStatus: "closed", sku: "TEST", applicationId: application.id,
      recordedAt: application.recordedAt, sourceIssue: null, applicationIssues: [] }]);
    expect(result.summary).toMatchObject({ inventoryCosting: "applied", appliedLines: 1, pendingLines: 0,
      estimatedCents: evidence === "estimated" ? 1000 : 0 });
    expect(result.lines[0]).toMatchObject({ status: "applied", issues: [] });
    expect(isShipmentCostLinePosted({ lineId: 30, sku: "TEST", sourceIssue: null, exceptionReview: null, application })).toBe(true);
  });
  it.each([
    [false, false, "applied", false, "pending"],
    [true, true, "applied", false, "review_required"],
    [true, false, null, false, "pending"],
    [true, false, "pending", false, "pending"],
    [true, false, "retry_required", false, "review_required"],
    [true, false, "unknown", false, "review_required"],
    [true, false, "unknown", true, "review_required"],
    [true, false, null, true, "review_required"],
    [true, false, "applied", true, "review_required"],
    [true, false, "review_required", false, "review_required"],
    [true, false, "review_required", true, "applied"],
    [false, false, "review_required", true, "review_required"],
    [true, true, "review_required", true, "review_required"],
  ] as const)("requires current complete evidence (%s %s %s %s)", (sourceCurrent, sourceIssue, applicationStatus, reconciled, expected) => {
    expect(resolveCostPostingStatus({ sourceCurrent, sourceIssue, applicationStatus, reconciled })).toBe(expected);
  });
  it("requires an exact balanced reconciliation of the retained issues", () => {
    expect(isCostReconciliationPosted([issue], review())).toBe(true);
    expect(isCostReconciliationPosted([], review())).toBe(false);
    const unsupported = { code: "COST_GRAPH_CONFLICT", message: "Unsupported history needs review." };
    expect(isCostReconciliationPosted([unsupported], { ...review(), issues: [unsupported] })).toBe(false);
    expect(isCostReconciliationPosted([issue], { ...review(), kind: "unexplained_quantity" })).toBe(false);
    expect(isCostReconciliationPosted([issue], { ...review(), allocatedMills: 99999 })).toBe(false);
    expect(isCostReconciliationPosted([issue, issue], review())).toBe(false);
    expect(isCostReconciliationPosted([{ ...issue, message: "New history issue" }], review())).toBe(false);
    expect(isCostReconciliationPosted([issue], { ...review(), issues: [issue, issue] })).toBe(false);
    for (const reconciliation of [undefined, { ...review().reconciliation!, status: "unresolved" as const },
      { ...review().reconciliation!, postedMills: 99999 }, { ...review().reconciliation!, unassignedMills: 1 },
      { ...review().reconciliation!, destination: null }]) {
      expect(isCostReconciliationPosted([issue], { ...review(), reconciliation })).toBe(false);
    }
  });
  it("does not hide current issues or unmatched exceptions behind an applied result", () => {
    const line = { lineId: 30, sku: "TEST", sourceIssue: null, application: { id: 40,
      recordedAt: "2026-10-16T12:00:00.000Z", status: "applied" as const, lotsUpdated: 1, cogsRowsUpdated: 0, issues: [] } };
    expect(isShipmentCostLinePosted({ ...line, sourceIssue: issue })).toBe(false);
    expect(isShipmentCostLinePosted({ ...line, exceptionReview: review() })).toBe(false);
    expect(isShipmentCostLinePosted({ ...line, application: { ...line.application, issues: [issue] } })).toBe(false);
  });
});
