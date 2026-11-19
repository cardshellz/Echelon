import { describe, expect, it } from "vitest";
import {
  proposeCostLinks,
  type CostLinkHistory,
  type CostLinkLot,
  type CostLinkMovement,
} from "../../domain/cost-link-repair";
import { quantityCorrectionApprovalSchema } from "@shared/procurement/receipt-shipment-quantity-correction";

const stamp = (n: number) => `2026-07-23 10:00:${String(n).padStart(2, "0")}`;
const lot = (
  id: number,
  variantId: number,
  received: number,
  locationId: number,
  time: number,
  pieces = 10000,
  onHand = 0,
): CostLinkLot => ({
  id,
  number: `LOT-${id}`,
  variantId,
  productId: 1,
  locationId,
  received,
  onHand,
  createdAt: stamp(time),
  sku: `SKU-${variantId}`,
  catalogPieces: pieces,
});
const move = (
  id: number,
  variantId: number,
  quantity: number,
  from: number | null,
  to: number | null,
  time: number,
  kind = "adjustment",
  countId: number | null = null,
): CostLinkMovement => ({
  id,
  variantId,
  productId: 1,
  quantity,
  from,
  to,
  occurredAt: stamp(time),
  kind,
  countId,
  countApproved: countId !== null,
  lotId: null,
  receiptLineId: null,
  voided: false,
  notes:
    quantity < 0 && countId === null ? "Case break: recorded operation" : "",
});
function history(): CostLinkHistory {
  return {
    lots: [
      lot(1, 10, 20, 1, 0),
      lot(2, 10, 20, 2, 1),
      lot(3, 11, 10, 3, 2, 100),
      lot(4, 12, 19, 2, 3, 10000, 19),
      lot(5, 11, 90, 3, 4, 100),
    ],
    movements: [
      move(1, 10, 20, 1, 2, 1, "transfer"),
      move(2, 10, -1, 2, null, 2),
      move(3, 11, 10, null, 3, 2),
      move(4, 10, -19, 2, null, 3, "adjustment", 1),
      move(5, 12, 19, null, 2, 3, "adjustment", 1),
      move(6, 11, 90, null, 3, 4, "adjustment", 2),
    ],
    edges: [],
    originLotIds: [],
    orderQuantities: [
      { lotId: 3, quantity: 10 },
      { lotId: 5, quantity: 90 },
    ],
  };
}
describe("historical transfer and repacking cost links", () => {
  it("proposes a conserved transfer, count reclassification and split pack output without inventing sales", () => {
    const input = history(),
      before = structuredClone(input);
    const result = proposeCostLinks(input, [
      { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
    ]);
    expect(result.operations.map((row) => row.movementIds)).toEqual([
      [1],
      [2, 3, 6],
      [4, 5],
    ]);
    expect(result.operations[1].outputs.map((row) => row.units)).toEqual([
      10, 90,
    ]);
    expect(result.remainingIssues).toEqual([]);
    expect(input).toEqual(before);
  });
  it("keeps an unexplained quantity separate instead of proposing an expense", () => {
    const input = history();
    input.orderQuantities[1].quantity = 87;
    expect(
      proposeCostLinks(input, [
        { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
      ]).remainingIssues,
    ).toEqual([
      "LOT-5: 3 SKU-11 units have no linked stock or order destination. Their cost stays unassigned; no expense will be created.",
    ]);
  });
  it.each([
    "voided",
    "unapproved",
    "different product",
    "different location",
    "different timestamp",
  ])("does not use %s output evidence", (kind) => {
    const input = history();
    if (kind === "voided") input.movements[5].voided = true;
    if (kind === "unapproved") input.movements[5].countApproved = false;
    if (kind === "different product") input.movements[5].productId = 2;
    if (kind === "different location") input.movements[5].to = 9;
    if (kind === "different timestamp") input.lots[4].createdAt = stamp(5);
    expect(
      proposeCostLinks(input, [
        { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
      ]).operations.some((row) => row.sourceUnits === 1),
    ).toBe(false);
  });
  it("does not attach a pack increase when two approved counts could explain it", () => {
    const input = history();
    input.lots.push(lot(6, 11, 90, 3, 5, 100));
    input.movements.push(move(7, 11, 90, null, 3, 5, "adjustment", 3));
    expect(
      proposeCostLinks(input, [
        { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
      ]).operations.some((row) => row.sourceUnits === 1),
    ).toBe(false);
  });
  it("does not choose between competing source lots", () => {
    const input = history();
    input.lots.push(lot(6, 10, 20, 1, 0));
    const result = proposeCostLinks(input, [
      { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
      { lotId: 6, receiptLineId: 8, piecesPerUnit: 10000 },
    ]);
    expect(result.operations).toEqual([]);
    expect(result.remainingIssues[0]).toContain("more than one source lot");
  });
  it("does not reuse existing output links or origin lots", () => {
    const input = history();
    input.originLotIds = [2];
    expect(
      proposeCostLinks(input, [
        { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
      ]).operations,
    ).toEqual([]);
  });
  it("treats an unrelated unlinked receipt as a competing physical source", () => {
    const input = history();
    input.lots.push(lot(6, 10, 20, 1, 0));
    const result = proposeCostLinks(input, [
      { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
    ]);
    expect(result.operations).toEqual([]);
    expect(result.remainingIssues[0]).toContain("more than one source lot");
  });
  it("requires a separate final confirmation of the reviewed cost links", () => {
    const input = {
      sourceVersion: "a".repeat(64),
      previewVersion: "b".repeat(64),
      shippedPieces: 200000,
      receipts: [{ receiptLineId: 7, receivedPieces: 200000 }],
      repairCostLinks: true,
      evidenceConfirmed: true,
      reason: "Verified the recorded movement history",
    };
    expect(quantityCorrectionApprovalSchema.safeParse(input).success).toBe(
      false,
    );
    expect(
      quantityCorrectionApprovalSchema.safeParse({
        ...input,
        costLinksConfirmed: true,
      }).success,
    ).toBe(true);
  });
  it.each(["multiple sources", "different product", "inconsistent conversion"])(
    "retains financial descendants but never infers a piece basis from %s",
    (kind) => {
      const input: CostLinkHistory = {
        lots: [
          lot(1, 10, 20, 1, 0),
          lot(2, 11, 20, 2, 1),
          lot(3, 11, 20, 3, 2),
        ],
        movements: [move(1, 11, 20, 2, 3, 2, "transfer")],
        edges: [
          {
            source: 1,
            output: 2,
            sourceUnits: 20,
            outputUnits: 20,
            outputStart: 0,
            key: "existing",
          },
        ],
        originLotIds: [1],
        orderQuantities: [],
      };
      if (kind === "different product") input.lots[1].productId = 2;
      if (kind === "multiple sources") {
        input.lots.push(lot(4, 12, 20, 4, 0));
        input.edges.push({
          source: 4,
          output: 2,
          sourceUnits: 20,
          outputUnits: 20,
          outputStart: 0,
          key: "existing",
        });
      }
      if (kind === "inconsistent conversion") {
        input.edges[0].sourceUnits = 10;
        input.edges.push({
          source: 1,
          output: 2,
          sourceUnits: 10,
          outputUnits: 10,
          outputStart: 0,
          key: "second",
        });
      }
      const result = proposeCostLinks(input, [
        { lotId: 1, receiptLineId: 7, piecesPerUnit: 10000 },
      ]);
      expect(result.operations).toEqual([]);
      expect(result.lotIds).toEqual([1, 2]);
    },
  );
});
