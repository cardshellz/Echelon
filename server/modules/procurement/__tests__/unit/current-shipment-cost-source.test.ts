import { describe, expect, it } from "vitest";
import { currentShipmentCostSourceIssue } from "../../domain/current-shipment-cost-source";
import type { CostSourceRevision } from "@shared/procurement/cost-source-contracts";
const source = (): CostSourceRevision => ({ contractVersion: 1, revision: 1, fingerprint: "a".repeat(64), component: "landed",
  scope: { kind: "shipment_line", purchaseOrderId: 1, purchaseOrderLineId: 2, inboundShipmentId: 10, inboundShipmentLineId: 30 },
  sources: [{ kind: "shipment_cost", documentId: 10, lineId: 20, version: "b".repeat(64) }],
  currency: "USD", totalMills: 100000, basePieces: 80, evidence: "estimated", packagingTreatment: "not_applicable", issue: null, manualOverride: null });
const check = (contract: unknown, currentFingerprint: string | undefined = "a".repeat(64)) => currentShipmentCostSourceIssue({ lineId: 30, shipmentId: 10, contract, currentFingerprint });
describe("current shipment source evidence", () => {
  it.each(["estimated", "confirmed"] as const)("permits current %s evidence without pretending it is confirmed", evidence => {
    const contract = { ...source(), evidence }, before = JSON.stringify(contract);
    expect(check(contract)).toBeNull(); expect(JSON.stringify(contract)).toBe(before);
  });
  it("leaves an unrecorded source pending", () => { expect(check(null)).toBeNull(); });
  it.each([undefined, "c".repeat(64)])("invalidates changed or missing live source identity", fingerprint => {
    expect(currentShipmentCostSourceIssue({ lineId: 30, shipmentId: 10, contract: source(), currentFingerprint: fingerprint })?.code).toBe("COST_UPDATE_OUTDATED");
  });
  it.each([{}, { ...source(), totalMills: 0.5 }, { ...source(), fingerprint: "bad" }, { ...source(), evidence: "unknown" }])("rejects malformed source contracts", contract => {
    expect(check(contract)?.code).toBe("COST_SOURCE_EVIDENCE_INVALID");
  });
  it.each([{ ...source(), component: "product" }, { ...source(), scope: { ...source().scope, inboundShipmentLineId: 31 } },
    { ...source(), scope: { ...source().scope, inboundShipmentId: 11 } }])("rejects a foreign scope", contract => {
    expect(check(contract)?.code).toBe("COST_SOURCE_IDENTITY_MISMATCH");
  });
  it("preserves an actionable source problem", () => {
    const issue = { code: "LANDED_ALLOCATION_STALE", message: "Review the changed allocation." };
    expect(check({ ...source(), evidence: "review_required", issue })).toEqual(issue);
  });
});
