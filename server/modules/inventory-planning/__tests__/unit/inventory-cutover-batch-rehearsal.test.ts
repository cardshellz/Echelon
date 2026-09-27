import { describe, expect, it } from "vitest";
import { rehearseCutoverBatch, type CutoverBatchCapture } from "../../../../../scripts/rehearse-inventory-cutover-batch";
import { reconstructionEvidenceHash } from "../../domain/inventory-cutover-reconstruction";
import { sealClaimSupplySnapshot } from "../../domain/inventory-availability-planner";
import { historyFixture } from "../fixtures/inventory-cutover-history.fixture";
import { reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";

function fixture(): CutoverBatchCapture {
  const { source, facts: history } = historyFixture();
  const { snapshotFingerprint: _old, ...content } = reconstructionSupply(source.evidence);
  return {
    contractVersion: "inventory_cutover_batch_capture_v1", productionWrites: false, deployedCommit: "a".repeat(40), source, history,
    supply: sealClaimSupplySnapshot({ ...content, capturedAt: source.capturedAt })
  };
}
describe("complete conditional cutover rehearsal", () => {
  it("retains the real blockers and original evidence even when the hypothetical current basket is satisfiable", () => {
    const input = fixture(), before = structuredClone(input), result = rehearseCutoverBatch(input);
    expect(result).toMatchObject({ executable: false, productionReady: false, productionWrites: false });
    expect(result.actualOpening.assessment?.ready).toBe(false);
    expect(result.conditional?.opening.assessment?.ready).toBe(true);
    expect(result.conditional?.planning?.orders[0].plan.status).toBe("satisfied");
    expect(result.conditional?.retainedHistory.sourceItems).toEqual(input.source.evidence.sourceItems);
    expect(result.conditional?.retainedHistory.reviewEvidence).toEqual(input.source.evidence.shipmentReviewEvidence);
    expect(input).toEqual(before);
  });
  it("shares stock across the whole batch rather than letting every order reuse the same units", () => {
    const input = fixture(), e = input.source.evidence;
    e.items[0].quantity = 15;
    e.orders.push({ ...e.orders[0], id: 3, externalOrderId: "external-3" });
    e.items.push({ ...e.items[0], id: 31, orderId: 3, omsOrderLineId: "31", sourceItemId: "source-31" });
    input.source.evidenceHash = reconstructionEvidenceHash(e); input.history.sourceEvidenceHash = input.source.evidenceHash;
    const result = rehearseCutoverBatch(input);
    expect(result.conditional?.planning?.orders.map(row => row.plan.status)).toEqual(["satisfied", "partial"]);
    expect(result.conditional?.shortfalls).toEqual([expect.objectContaining({ orderId: 3, lineKey: "order-item:31", shortfallQty: "10" })]);
    expect(result.conditional?.planning?.freshReservationsByLevel).toEqual([{ inventoryLevelId: 10, reservedQty: "20" }]);
  });
  it("stops when history includes current work rather than silently dropping the bad member", () => {
    const input = fixture(); input.history.receipts[0].matchedOrders[0].lines[0].fulfillmentStatus = "pending";
    const result = rehearseCutoverBatch(input);
    expect(result.history.blockers).toHaveLength(1); expect(result.conditional).toBeNull();
  });
  it("unclassified review records remain blockers in the hypothetical assessment", () => {
    const input = fixture(); input.source.evidence.shipmentReviewEvidence.push({ id: "99", kind: "unknown_provider_work", status: "review", evidenceHash: "a".repeat(64) });
    input.source.evidenceHash = reconstructionEvidenceHash(input.source.evidence); input.history.sourceEvidenceHash = input.source.evidenceHash;
    const result = rehearseCutoverBatch(input);
    expect(result.conditional?.opening.assessment?.ready).toBe(false); expect(result.conditional?.planning).toBeNull();
  });
  it.each(["time", "stock", "tamper"])("rejects a different %s capture", kind => {
    const input = fixture(); const { snapshotFingerprint: _old, ...content } = input.supply;
    if (kind === "time") content.capturedAt = "2026-09-01T00:00:00.000Z";
    if (kind === "stock") content.inventoryPositions[0].variantQty = "100";
    input.supply = sealClaimSupplySnapshot(content);
    if (kind === "tamper") input.supply.inventoryPositions[0].variantQty = "200";
    expect(() => rehearseCutoverBatch(input)).toThrow();
  });
});
