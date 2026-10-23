import { describe, expect, it } from "vitest";
import { relationshipFixture } from "../../../test/fixtures/document-relationships";
import { exactRelationshipSum, projectDocumentRelationships, receivedRelationshipPieces, sumRelationshipAmounts } from "../document-relationships";
import { projectPurchaseLineShipping, shipmentQuantityStage } from "../purchase-line-shipping";

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

describe("PO line shipping progress", () => {
  const sample = () => {
    const source = relationshipFixture({ kind: "purchase", id: 17 });
    source.purchaseLines[0].receivedPieces = 60000;
    source.shipments[1].status = "booked";
    return source;
  };
  it("separates a split line's planned and shipped pieces, keeps receipt actuals and does not mix identical SKUs on other POs", () => {
    const source = sample(); const before = structuredClone(source);
    const progress = projectPurchaseLineShipping(source);
    expect(progress.get(101)).toMatchObject({ shippedPieces: 100000, plannedPieces: 100000, stillToShipPieces: 100000,
      line: { receivedPieces: 60000 }, issues: [], quantitiesComplete: true });
    expect(progress.get(101)!.shipments.map(row => row.shipmentLineId)).toEqual([201, 203]);
    expect(progress.get(102)).toMatchObject({ shippedPieces: 50000, plannedPieces: 0, stillToShipPieces: 0 });
    expect(progress.get(103)).toMatchObject({ shippedPieces: 0, plannedPieces: 0, stillToShipPieces: 100, shipments: [] });
    expect(source).toEqual(before);
  });
  it.each(["draft", "booked"])("keeps %s manifests planned until departure", status => {
    const source = sample(); source.shipments[1].status = status;
    expect(projectPurchaseLineShipping(source).get(101)).toMatchObject({ shippedPieces: 100000, plannedPieces: 100000, stillToShipPieces: 100000 });
  });
  it.each(["in_transit", "at_port", "customs_clearance", "delivered", "costing", "closed"])("counts %s shipments once despite multiple receipts", status => {
    const source = sample(); source.shipments[1].status = status;
    expect(projectPurchaseLineShipping(source).get(101)).toMatchObject({ shippedPieces: 200000, plannedPieces: 0, stillToShipPieces: 0 });
  });
  it("excludes cancelled manifests, deducts PO cancellations, and preserves cancelled links", () => {
    const source = sample(); source.shipments[1].status = "cancelled"; source.purchaseLines[0].cancelledPieces = 25000;
    expect(projectPurchaseLineShipping(source).get(101)).toMatchObject({ shippedPieces: 100000, plannedPieces: 0, stillToShipPieces: 75000 });
    expect(projectPurchaseLineShipping(source).get(101)!.shipments[1].stage).toBe("cancelled");
  });
  it("reports overshipments and excessive plans instead of silently producing negative remaining quantities", () => {
    const source = sample(); source.purchaseLines[0].orderedPieces = 90000;
    const progress = projectPurchaseLineShipping(source).get(101)!;
    expect(progress).toMatchObject({ shippedPieces: 100000, stillToShipPieces: 0, overShippedPieces: 10000 });
    expect(progress.issues).toEqual(expect.arrayContaining([expect.stringMatching(/10,000 more/), expect.stringMatching(/Planned shipments exceed/)]));
  });
  it("never converts an unknown status into shipped or still-to-ship certainty", () => {
    const source = sample(); source.shipments[1].status = "historical_import";
    expect(shipmentQuantityStage("historical_import")).toBe("unknown");
    expect(projectPurchaseLineShipping(source).get(101)).toMatchObject({ shippedPieces: 100000, plannedPieces: 0, stillToShipPieces: null, quantitiesComplete: false });
  });
  it("uses exact saved links, and makes missing/conflicting links explicit for both implicated POs", () => {
    const source = sample(); source.shipmentLines[0].purchaseId = null;
    expect(projectPurchaseLineShipping(source).get(101)!.shippedPieces).toBe(100000);
    source.shipmentLines[0].purchaseId = 99;
    const progress = projectPurchaseLineShipping(source);
    expect(progress.get(101)).toMatchObject({ shippedPieces: 0, stillToShipPieces: null, quantitiesComplete: false });
    expect(progress.get(102)).toMatchObject({ shippedPieces: 50000, stillToShipPieces: null, quantitiesComplete: false });
    source.shipmentLines[0].purchaseId = 17; source.shipmentLines[0].purchaseLineId = null;
    expect(projectPurchaseLineShipping(source).get(101)!.shipments.map(row => row.shipmentLineId)).toEqual([203]);
    expect(projectPurchaseLineShipping(source).get(101)!.stillToShipPieces).toBeNull();
    source.shipmentLines[0].purchaseId = null;
    expect(projectPurchaseLineShipping(source).get(101)).toMatchObject({ shippedPieces: 0, stillToShipPieces: null, quantitiesComplete: false });
    expect(projectPurchaseLineShipping(source).get(103)!.stillToShipPieces).toBeNull();
  });
  it("does not tell users to ship directly received goods again or guess absent cancellation counters", () => {
    const source = sample(); source.purchaseLines[0].receivedPieces = 150000;
    expect(projectPurchaseLineShipping(source).get(101)!.stillToShipPieces).toBeNull();
    source.purchaseLines[0].receivedPieces = 0; delete source.purchaseLines[0].cancelledPieces;
    expect(projectPurchaseLineShipping(source).get(101)!.stillToShipPieces).toBeNull();
    source.purchaseLines[0].cancelledPieces = 200001;
    expect(projectPurchaseLineShipping(source).get(101)!.stillToShipPieces).toBeNull();
  });
  it("validates malformed and duplicate identities, missing shipment records and unsafe totals", () => {
    const source = sample(); source.shipmentLines.push({ ...source.shipmentLines[0] });
    expect(() => projectPurchaseLineShipping(source)).toThrow(/Duplicate/);
    source.shipmentLines.pop(); source.shipments.pop();
    expect(() => projectPurchaseLineShipping(source)).toThrow(/no shipment record/);
    const overflow = sample(); overflow.shipments[1].status = "closed";
    overflow.shipmentLines[0].shippedPieces = Number.MAX_SAFE_INTEGER;
    expect(() => projectPurchaseLineShipping(overflow)).toThrow(/precision/);
    overflow.shipmentLines[0].shippedPieces = -1;
    expect(() => projectPurchaseLineShipping(overflow)).toThrow();
  });
});
