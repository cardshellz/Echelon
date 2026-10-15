import { describe, expect, it } from "vitest";
import { buildShipmentCostException, shipmentExceptionVersion, type ShipmentExceptionFacts } from "../../shipment-cost-exception.policy";
import { formatShipmentExceptionAmount, shipmentExceptionRequestSchema } from "@shared/procurement/shipment-cost-exception";
import type { CostSourceRevision } from "@shared/procurement/cost-source-contracts";

function facts(): ShipmentExceptionFacts {
  const contract: CostSourceRevision = { contractVersion: 1, revision: 1, fingerprint: "a".repeat(64), component: "landed",
    scope: { kind: "shipment_line", purchaseOrderId: 117, purchaseOrderLineId: 10, inboundShipmentId: 92, inboundShipmentLineId: 141 },
    sources: [{ kind: "shipment_cost", documentId: 92, lineId: 1, version: "b".repeat(64) }],
    currency: "USD", totalMills: 28_279_900, basePieces: 2_200_000, evidence: "confirmed", packagingTreatment: "not_applicable", issue: null, manualOverride: null };
  return { lineId: 141, shipmentId: 92, sku: "EG-SLV-STD-5PCK", shipmentStatus: "closed", revisionId: 7, contract,
    applicationId: 8, applicationStatus: "review_required", decision: null,
    result: { status: "review_required", lotsUpdated: 34, cogsRowsUpdated: 326, issues: [
      { code: "COST_UNRESOLVED_QUANTITY_RETAINED", message: "Four units have incomplete history.", unresolvedQuantity: {
        inventoryLotId: 3364, allocationId: 11, lotNumber: "LOT-20260916-030", originalQuantity: 220,
        onHandQuantityAtReview: 157, recordedOutflowQuantityAtReview: 59, quantity: 4, component: "landed", amountMills: 514180 } },
      { code: "COST_UNRESOLVED_QUANTITY_RETAINED", message: "One unit has incomplete history.", unresolvedQuantity: {
        inventoryLotId: 4016, allocationId: 12, lotNumber: "LOT-20260928-034", originalQuantity: 20,
        onHandQuantityAtReview: 0, recordedOutflowQuantityAtReview: 19, quantity: 1, component: "landed", amountMills: 6428 } },
    ] } };
}
type Result = { status: string; lotsUpdated: number; cogsRowsUpdated: number; issues: Array<{ code: string; message: string; unresolvedQuantity?: Record<string, unknown> }> };
describe("shipment historical exception policy", () => {
  it("retains exact unresolved amounts and the successful downstream result", () => {
    const input = facts(), copy = structuredClone(input), review = buildShipmentCostException(input)!;
    expect(review).toMatchObject({ state: "open", amountMills: 520608, allocatedMills: 28279900, lotsUpdated: 34, cogsRowsUpdated: 326 });
    expect(formatShipmentExceptionAmount(review.amountMills, "USD")).toBe("$52.0608");
    expect(input).toEqual(copy);
  });
  it("accepts missing receipt history for the entire blocked line, including an explicit zero", () => {
    const input = facts(); input.result = { status: "review_required", lotsUpdated: 0, cogsRowsUpdated: 0,
      issues: [{ code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Lot 1453 has no receipt origin." }] };
    expect(buildShipmentCostException(input)?.amountMills).toBe(28279900);
    (input.contract as CostSourceRevision).totalMills = 0;
    expect(buildShipmentCostException(input)?.amountMills).toBe(0);
    (input.result as Result).lotsUpdated = 1;
    expect(buildShipmentCostException(input)).toBeNull();
  });
  it("keeps identical retries accepted, but a new source, issue, or reopen decision invalidates acceptance", () => {
    const input = facts(), review = buildShipmentCostException(input)!;
    input.decision = { id: 1, action: "accept", fingerprint: review.fingerprint, actorId: "admin", reason: "Reviewed historical count records.", recordedAt: "2026-10-15T12:00:00Z" };
    input.applicationId = 9; (input.result as Result).lotsUpdated = 1;
    expect(buildShipmentCostException(input)?.state).toBe("accepted");
    input.revisionId = 8;
    expect(buildShipmentCostException(input)?.state).toBe("open");
    input.revisionId = 7; (input.result as Result).issues[0].unresolvedQuantity!.amountMills = 514181;
    expect(buildShipmentCostException(input)?.state).toBe("open");
    (input.result as Result).issues[0].unresolvedQuantity!.amountMills = 514180; input.decision.action = "reopen";
    expect(buildShipmentCostException(input)?.state).toBe("open");
  });
  it("uses a stable issue order and invalidates an uncommitted preview on new application evidence", () => {
    const a = facts(), b = facts(); (b.result as Result).issues.reverse();
    expect(buildShipmentCostException(a)?.fingerprint).toBe(buildShipmentCostException(b)?.fingerprint);
    b.applicationId = 100;
    expect(shipmentExceptionVersion(a, "a".repeat(64))).not.toBe(shipmentExceptionVersion(b, "a".repeat(64)));
  });
  it.each(["COST_CURRENCY_REVIEW", "COST_GRAPH_INCOMPLETE", "COST_APPLICATION_LIMIT", "COST_UPDATE_FAILED"])("cannot waive %s", code => {
    const input = facts(); (input.result as Result).issues.push({ code, message: "Other unresolved issue." });
    expect(buildShipmentCostException(input)).toBeNull();
  });
  it.each(["currency", "identity", "amount", "source", "status", "duplicate", "invalid_quantity", "missing_amount", "wrong_component"])("fails closed on %s", key => {
    const input = facts(), contract = input.contract as CostSourceRevision, result = input.result as Result;
    if (key === "currency") contract.currency = "CAD";
    if (key === "identity") input.lineId = 99;
    if (key === "amount") contract.totalMills = 1;
    if (key === "source") contract.issue = { code: "LANDED_ALLOCATION_STALE", message: "Stale split." };
    if (key === "status") input.shipmentStatus = "costing";
    if (key === "duplicate") result.issues.push(result.issues[0]);
    if (key === "invalid_quantity") result.issues[0].unresolvedQuantity!.quantity = 5;
    if (key === "missing_amount") delete result.issues[0].unresolvedQuantity!.amountMills;
    if (key === "wrong_component") result.issues[0].unresolvedQuantity!.component = "product";
    expect(buildShipmentCostException(input)).toBeNull();
  });
  it("validates reason, immutable intent fields and maximum exact money", () => {
    expect(shipmentExceptionRequestSchema.safeParse({ sourceVersion: "a".repeat(64), action: "accept", reason: "  " }).success).toBe(false);
    expect(shipmentExceptionRequestSchema.safeParse({ sourceVersion: "a".repeat(64), action: "accept", reason: "Valid reason text", amountMills: 0 }).success).toBe(false);
    expect(formatShipmentExceptionAmount(Number.MAX_SAFE_INTEGER, "USD")).toBe("$900,719,925,474.0991");
    expect(() => formatShipmentExceptionAmount(1.1, "USD")).toThrow();
  });
});
