import { describe, expect, it } from "vitest";
import { cutoverReconstructionEvidenceSchema } from "@shared/types/inventory-cutover-reconstruction";
import { selectActiveCutoverWork } from "../../domain/inventory-cutover-active-work";
import { reviewHistoricalWork, historySourceHashes } from "../../domain/inventory-cutover-history-retirement";
import { reconstructionHash } from "../../domain/inventory-cutover-reconstruction";
import { historyFixture } from "../fixtures/inventory-cutover-history.fixture";

describe("shared outstanding cutover work", () => {
  it("excludes only the existing closed lifecycles without mutating the original census", () => {
    const { source } = historyFixture();
    const evidence = source.evidence;
    const originalSource = evidence.sourceItems[0];
    evidence.sourceItems = ["shipped", "queued", "planned", "labeled", "cancelled", "voided", null, "unexpected"]
      .map((shipmentStatus, index) => ({ ...originalSource, id: 100 + index, shipmentId: 200 + index, shipmentStatus }));
    evidence.physicalItems = ["shipped", "review", "voided", "unexpected"].map((packageStatus, index) => ({
      id: String(index + 1), physicalShipmentId: String(index + 10), orderItemId: null,
      replacementForOrderItemId: null, correctionForPhysicalShipmentItemId: null,
      legacySourceShipmentItemId: null, packageAllocationEntryId: null, productVariantId: null,
      sku: "P5", originalQuantity: 1, adjustmentQuantity: 0, effectiveQuantity: "1",
      purpose: "customer_fulfillment", packageStatus,
    }));
    const review = evidence.shipmentReviewEvidence[0];
    evidence.shipmentReviewEvidence = [
      { ...review, id: "1", kind: "channel_fulfillment_receipt", status: "ignored" },
      { ...review, id: "2", kind: "channel_fulfillment_acknowledgment", status: "ignored" },
      { ...review, id: "3", kind: "outbound_shipment_review", status: "shipped" },
      { ...review, id: "4", kind: "channel_fulfillment_receipt", status: "review" },
      { ...review, id: "5", kind: "channel_fulfillment_receipt", status: "processing" },
      { ...review, id: "6", kind: "channel_fulfillment_receipt", status: "failed" },
      { ...review, id: "7", kind: "outbound_shipment_review", status: "cancelled" },
      { ...review, id: "8", kind: "outbound_shipment_review", status: "ignored" },
      { ...review, id: "9", kind: "unknown", status: "ignored" },
    ];
    const parsed = cutoverReconstructionEvidenceSchema.parse(evidence);
    const before = structuredClone(parsed);
    const active = selectActiveCutoverWork(parsed);
    expect(active.sourceItems.map(row => row.id)).toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(active.physicalItems.map(row => row.id)).toEqual(["2", "3", "4"]);
    expect(active.shipmentReviewEvidence.map(row => row.id)).toEqual(["4", "5", "6", "7", "8", "9"]);
    expect(parsed).toEqual(before);
    expect(Object.keys(active).sort()).toEqual(["physicalItems", "shipmentReviewEvidence", "sourceItems"]);
  });

  it("honors exact audited retirements before selecting lifecycle work and rejects changed source evidence", () => {
    const { source, facts } = historyFixture();
    const review = reviewHistoricalWork(source, facts);
    const sourceHashes = historySourceHashes(source.evidence);
    const evidence = { ...source.evidence, retiredHistory: review.decisions.map(row => ({
      ...row, batchId: "1", reviewHash: review.reviewHash,
      sourceItemsHash: row.kind === "receipt" ? reconstructionHash([]) : sourceHashes.get(Number(row.id))!.hash,
    })) };
    expect(selectActiveCutoverWork(evidence)).toEqual({ sourceItems: [], physicalItems: [], shipmentReviewEvidence: [] });
    expect(() => selectActiveCutoverWork({ ...evidence,
      sourceItems: evidence.sourceItems.map(row => ({ ...row, shipmentStatus: "shipped" })) }))
      .toThrow("Retired shipment membership differs");
    expect(() => selectActiveCutoverWork({ ...evidence,
      shipmentReviewEvidence: evidence.shipmentReviewEvidence.map(row => ({ ...row, evidenceHash: "b".repeat(64) })) }))
      .toThrow("Retired work changed");
  });
});
