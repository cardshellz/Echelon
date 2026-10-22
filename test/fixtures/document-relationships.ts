import type { RelationshipRoot, RelationshipSnapshot } from "../../shared/procurement/document-relationships";

/** Same SKU on two POs, one PO line split across shipments, partial receipts. */
export function relationshipFixture(root: RelationshipRoot = { kind: "shipment", id: 42 }): RelationshipSnapshot {
  const all: RelationshipSnapshot = {
    root,
    purchases: [{ id: 17, number: "TEST-PO-17" }, { id: 99, number: "TEST-PO-99" }],
    purchaseLines: [
      { id: 101, purchaseId: 17, lineNumber: 1, sku: "SAME-SKU", product: "Sleeves", orderedPieces: 200000 },
      { id: 102, purchaseId: 99, lineNumber: 2, sku: "SAME-SKU", product: "Sleeves", orderedPieces: 50000 },
      { id: 103, purchaseId: 17, lineNumber: 3, sku: "NOT-SHIPPED", product: "Holders", orderedPieces: 100 },
    ],
    shipments: [{ id: 42, number: "TEST-SHIP-42", status: "closed" }, { id: 43, number: "TEST-SHIP-43", status: "booked" }],
    shipmentLines: [
      { id: 201, shipmentId: 42, purchaseId: 17, purchaseLineId: 101, sku: "SAME-SKU", product: "Sleeves", shippedPieces: 100000 },
      { id: 202, shipmentId: 42, purchaseId: 99, purchaseLineId: 102, sku: "SAME-SKU", product: "Sleeves", shippedPieces: 50000 },
      { id: 203, shipmentId: 43, purchaseId: 17, purchaseLineId: 101, sku: "SAME-SKU", product: "Sleeves", shippedPieces: 100000 },
    ],
    receipts: [31, 32, 33].map(id => ({ id, number: `TEST-RECEIPT-${id}`, status: "closed", purchaseId: id === 33 ? 99 : 17, shipmentId: 42 })),
    receiptLines: [
      { id: 301, receiptId: 31, purchaseLineId: 101, shipmentLineId: 201, sku: "SAME-SKU", receivedUnits: 60, reversedUnits: 0, piecesPerUnit: 1000 },
      { id: 302, receiptId: 32, purchaseLineId: 101, shipmentLineId: 201, sku: "SAME-SKU", receivedUnits: 40, reversedUnits: 0, piecesPerUnit: 1000 },
      { id: 303, receiptId: 33, purchaseLineId: 102, shipmentLineId: 202, sku: "SAME-SKU", receivedUnits: 50, reversedUnits: 0, piecesPerUnit: 1000 },
    ],
    allocations: [{ costId: 401, shipmentLineId: 201, currency: "USD", cents: 6001 }, { costId: 401, shipmentLineId: 202, currency: "USD", cents: 4000 }, { costId: 402, shipmentLineId: 203, currency: "USD", cents: 500 }],
    charges: [{ id: 401, shipmentId: 42, currency: "USD", cents: 10001 }, { id: 402, shipmentId: 43, currency: "USD", cents: 500 }], costIssues: [],
  };
  const shipmentIds = root.kind === "purchase" && root.id === 17 ? [42, 43] : root.kind === "shipment" ? [root.id] : [42];
  all.shipments = all.shipments.filter(row => shipmentIds.includes(row.id));
  all.shipmentLines = all.shipmentLines.filter(row => shipmentIds.includes(row.shipmentId));
  all.charges = all.charges.filter(row => shipmentIds.includes(row.shipmentId));
  all.allocations = all.allocations.filter(row => all.shipmentLines.some(line => line.id === row.shipmentLineId));
  return all;
}
