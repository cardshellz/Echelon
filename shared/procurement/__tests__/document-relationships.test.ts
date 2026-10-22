import { describe, expect, it } from "vitest";
import { relationshipFixture } from "../../../test/fixtures/document-relationships";
import { exactRelationshipSum, projectDocumentRelationships, receivedRelationshipPieces, sumRelationshipAmounts } from "../document-relationships";

describe("shared document relationships", () => {
  it("groups duplicate SKUs by PO-line identity, keeps split shipments and partial receipts distinct", () => {
    const source = relationshipFixture({ kind: "purchase", id: 17 }); const before = structuredClone(source);
    const [first, second] = projectDocumentRelationships(source);
    expect(first.groups.map(group => [group.purchaseId, group.shippedPieces, group.costs.amounts])).toEqual([
      [17, 100000, [{ currency: "USD", cents: 6001 }]], [99, 50000, [{ currency: "USD", cents: 4000 }]],
    ]);
    expect(first.groups[0].lines[0].receipts.map(receivedRelationshipPieces)).toEqual([60000, 40000]);
    expect(second.groups[0].lines[0].owner.purchaseLine?.orderedPieces).toBe(200000);
    expect(second.groups[0].shippedPieces).toBe(100000);
    expect(second.groups[0].costs.amounts).toEqual([{ currency: "USD", cents: 500 }]);
    expect(second.groups[0].lines[0].receipts.map(receivedRelationshipPieces)).toEqual([100000]);
    expect(first.charges.amounts).toEqual([{ currency: "USD", cents: 10001 }]);
    expect(second.charges.amounts).toEqual([{ currency: "USD", cents: 500 }]);
    expect(first.allocationIncomplete).toBe(false);
    expect(source).toEqual(before);
  });
  it("uses a recorded PO-line owner when its header link is missing, and quarantines contradictory links", () => {
    const source = relationshipFixture(); source.shipmentLines[0].purchaseId = null;
    expect(projectDocumentRelationships(source)[0].groups[0].purchaseId).toBe(17);
    source.shipmentLines[0].purchaseId = 99;
    const conflicted = projectDocumentRelationships(source)[0].groups.find(group => group.key === "conflicting_po")!;
    expect(conflicted.purchaseId).toBeNull(); expect(conflicted.costs.amounts[0].cents).toBe(6001);
    expect(conflicted.lines[0].owner.issue).toBe("conflicting_po");
  });
  it("does not guess missing receipt links or piece conversions from identical SKUs", () => {
    const source = relationshipFixture(); source.receiptLines[0].shipmentLineId = null;
    source.receiptLines[1].piecesPerUnit = null;
    const line = projectDocumentRelationships(source)[0].groups[0].lines[0];
    expect(line.receipts.map(row => row.id)).toEqual([302]);
    expect(receivedRelationshipPieces(line.receipts[0])).toBeNull();
  });
  it("preserves credits, keeps currencies separate and exposes incomplete allocation", () => {
    const source = relationshipFixture(); source.allocations[0].cents = -1;
    expect(projectDocumentRelationships(source)[0].allocationIncomplete).toBe(true);
    expect(sumRelationshipAmounts([{ currency: "USD", cents: 100 }, { currency: "CAD", cents: 200 }, { currency: "USD", cents: -1 }])).toEqual({
      amounts: [{ currency: "CAD", cents: 200 }, { currency: "USD", cents: 99 }], incomplete: false,
    });
    expect(sumRelationshipAmounts([{ currency: null, cents: 0 }]).incomplete).toBe(true);
  });
  it("handles reversals exactly and rejects unsafe totals", () => {
    const line = relationshipFixture().receiptLines[0];
    expect(receivedRelationshipPieces({ ...line, reversedUnits: 10 })).toBe(50000);
    expect(receivedRelationshipPieces({ ...line, reversedUnits: 61 })).toBeNull();
    expect(() => exactRelationshipSum([Number.MAX_SAFE_INTEGER, 1])).toThrow(/precision/);
  });
});
