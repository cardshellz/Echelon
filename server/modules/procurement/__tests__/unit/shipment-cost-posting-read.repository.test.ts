import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { readShipmentCostPostingEvidence } from "../../shipment-cost-posting-read.repository";
import { readCurrentShipmentSourceFingerprints, readShipmentCostExceptions } from "../../shipment-cost-exception.repository";

vi.mock("../../shipment-cost-exception.repository", () => ({
  readCurrentShipmentSourceFingerprints: vi.fn(), readShipmentCostExceptions: vi.fn(),
}));
const source = (shipmentId: number, lineId: number): CostSourceRevision => ({ contractVersion: 1, revision: 1,
  fingerprint: "a".repeat(64), component: "landed",
  scope: { kind: "shipment_line", purchaseOrderId: 1, purchaseOrderLineId: 2, inboundShipmentId: shipmentId, inboundShipmentLineId: lineId },
  sources: [{ kind: "shipment_cost", documentId: shipmentId, lineId: 20, version: "b".repeat(64) }],
  currency: "USD", totalMills: 100000, basePieces: 80, evidence: "estimated", packagingTreatment: "not_applicable", issue: null, manualOverride: null });
const tx = { execute: vi.fn() };
beforeEach(() => {
  vi.mocked(readCurrentShipmentSourceFingerprints).mockReset().mockResolvedValue(new Map([[11, "a".repeat(64)], [12, "a".repeat(64)]]));
  vi.mocked(readShipmentCostExceptions).mockReset().mockResolvedValue(new Map());
});

describe("shipment posting evidence source reads", () => {
  it("does not prepare unused current sources for pending lines, but still reads exception evidence", async () => {
    const lines = [{ shipmentId: 1, lineId: 11, contract: null }, { shipmentId: 2, lineId: 21, contract: undefined }];
    const result = await readShipmentCostPostingEvidence(tx, lines);
    expect(readCurrentShipmentSourceFingerprints).not.toHaveBeenCalled();
    expect(readShipmentCostExceptions).toHaveBeenCalledWith(tx, [11, 21], new Map());
    expect([...result.sourceIssues]).toEqual([[11, null], [21, null]]);
  });
  it("reads current sources once per applicable shipment and passes those exact fingerprints to exception validation", async () => {
    const lines = [{ shipmentId: 1, lineId: 11, contract: null },
      { shipmentId: 1, lineId: 12, contract: source(1, 12) }, { shipmentId: 1, lineId: 11, contract: source(1, 11) },
      { shipmentId: 2, lineId: 21, contract: source(2, 21) }];
    vi.mocked(readCurrentShipmentSourceFingerprints).mockImplementation(async (_tx, id) => id === 1
      ? new Map([[11, "a".repeat(64)], [12, "a".repeat(64)]]) : new Map([[21, "c".repeat(64)]]));
    const result = await readShipmentCostPostingEvidence(tx, lines);
    expect(vi.mocked(readCurrentShipmentSourceFingerprints).mock.calls.map(call => call[1])).toEqual([1, 2]);
    expect(result.sourceIssues.get(11)).toBeNull();
    expect(result.sourceIssues.get(12)).toBeNull();
    expect(result.sourceIssues.get(21)?.code).toBe("COST_UPDATE_OUTDATED");
    expect(readShipmentCostExceptions).toHaveBeenCalledWith(tx, [11, 12, 11, 21], new Map([
      [1, new Map([[11, "a".repeat(64)], [12, "a".repeat(64)]])], [2, new Map([[21, "c".repeat(64)]])],
    ]));
  });
  it("preserves an existing source issue and leaves accepted/reconciled freshness validation to the exception owner", async () => {
    const issue = { code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Review historical receipt source." };
    const reviewed = { ...source(1, 11), issue };
    const result = await readShipmentCostPostingEvidence(tx, [{ shipmentId: 1, lineId: 11, contract: reviewed }]);
    expect(result.sourceIssues.get(11)).toEqual(issue);
    expect(readCurrentShipmentSourceFingerprints).not.toHaveBeenCalled();
    expect(readShipmentCostExceptions).toHaveBeenCalledWith(tx, [11], new Map());
  });
  it("propagates current source and exception read failures rather than returning a healthy result", async () => {
    vi.mocked(readCurrentShipmentSourceFingerprints).mockRejectedValueOnce(new Error("current source unavailable"));
    await expect(readShipmentCostPostingEvidence(tx, [{ shipmentId: 1, lineId: 11, contract: source(1, 11) }])).rejects.toThrow("current source unavailable");
    vi.mocked(readShipmentCostExceptions).mockRejectedValueOnce(new Error("reconciliation unavailable"));
    await expect(readShipmentCostPostingEvidence(tx, [{ shipmentId: 1, lineId: 11, contract: null }])).rejects.toThrow("reconciliation unavailable");
  });
});
