import {
  exactRelationshipSum, projectDocumentRelationships, relationshipSnapshotSchema,
  type RelationshipPurchaseLine, type RelationshipSnapshot,
} from "./document-relationships";

export type ShipmentQuantityStage = "planned" | "shipped" | "cancelled" | "unknown";

/** ShipmentTrackingService.markInTransit records departure. A manifest's
 * qty_shipped also exists before that event, so it is not itself proof of dispatch. */
export function shipmentQuantityStage(status: string): ShipmentQuantityStage {
  switch (status) {
    case "draft": case "booked": return "planned";
    case "in_transit": case "at_port": case "customs_clearance":
    case "delivered": case "costing": case "closed": return "shipped";
    case "cancelled": return "cancelled";
    default: return "unknown";
  }
}

export interface PurchaseLineShipment {
  shipmentId: number;
  shipmentNumber: string;
  shipmentLineId: number;
  status: string;
  stage: ShipmentQuantityStage;
  pieces: number;
  linkIssue: boolean;
}
export interface PurchaseLineShipping {
  line: RelationshipPurchaseLine;
  shippedPieces: number;
  plannedPieces: number;
  stillToShipPieces: number | null;
  overShippedPieces: number;
  quantitiesComplete: boolean;
  shipments: PurchaseLineShipment[];
  issues: string[];
}

/** Read-only PO-line progress, using the same exact identity resolution as the
 * shipment/receipt relationship views. Receipts never multiply manifest counts.
 * Received is the PO's posted receipt tally, not a sum of draft receiving lines. */
export function projectPurchaseLineShipping(snapshot: RelationshipSnapshot): Map<number, PurchaseLineShipping> {
  const data = relationshipSnapshotSchema.parse(snapshot);
  for (const collection of [data.purchaseLines, data.shipments, data.shipmentLines]) {
    if (new Set(collection.map(row => row.id)).size !== collection.length) throw new Error("Duplicate document relationship identity");
  }
  const result = new Map<number, PurchaseLineShipping>(data.purchaseLines.map(line => [line.id, {
    line, shippedPieces: 0, plannedPieces: 0, stillToShipPieces: null, overShippedPieces: 0,
    quantitiesComplete: true, shipments: [], issues: [],
  }]));
  const purchaseIssues = new Map<number, Set<string>>();
  const flagPurchase = (id: number | null, message: string) => {
    if (id === null) return;
    let issues = purchaseIssues.get(id);
    if (!issues) { issues = new Set(); purchaseIssues.set(id, issues); }
    issues.add(message);
  };
  const shipmentIds = new Set(data.shipments.map(shipment => shipment.id));
  for (const line of data.shipmentLines) {
    if (!shipmentIds.has(line.shipmentId)) throw new Error("A shipment line has no shipment record");
  }
  for (const { shipment, groups } of projectDocumentRelationships(data)) {
    const stage = shipmentQuantityStage(shipment.status);
    for (const group of groups) for (const { line, owner } of group.lines) {
      const target = owner.purchaseLine ? result.get(owner.purchaseLine.id) : undefined;
      if (owner.issue && stage !== "cancelled") {
        const message = `${shipment.number} has an unverified PO-line link. Review its lines before using these totals.`;
        // A contradictory header could belong to either PO. No SKU inference.
        flagPurchase(line.purchaseId, message);
        flagPurchase(owner.purchaseLine?.purchaseId ?? null, message);
        // A shipment discovered through a receipt can have neither PO link.
        // Its unassigned pieces could belong to this PO; absence is not zero.
        if (owner.issue === "missing_po" && data.root.kind === "purchase") flagPurchase(data.root.id, message);
      }
      if (!target) continue;
      target.shipments.push({ shipmentId: shipment.id, shipmentNumber: shipment.number,
        shipmentLineId: line.id, status: shipment.status, stage, pieces: line.shippedPieces, linkIssue: owner.issue !== null });
      if (owner.issue) continue;
      if (stage === "unknown") {
        target.quantitiesComplete = false;
        target.issues.push(`${shipment.number} has an unrecognized shipment status. Review its status before using these totals.`);
      }
    }
  }
  for (const progress of result.values()) {
    const linked = progress.shipments.filter(shipment => !shipment.linkIssue);
    progress.shippedPieces = exactRelationshipSum(linked.filter(shipment => shipment.stage === "shipped").map(shipment => shipment.pieces));
    progress.plannedPieces = exactRelationshipSum(linked.filter(shipment => shipment.stage === "planned").map(shipment => shipment.pieces));
    const incompleteLinks = purchaseIssues.get(progress.line.purchaseId);
    if (incompleteLinks) {
      progress.quantitiesComplete = false;
      progress.issues.push(...incompleteLinks);
    }
    const { orderedPieces, cancelledPieces, receivedPieces } = progress.line;
    if (cancelledPieces == null || cancelledPieces > orderedPieces) {
      progress.issues.push("The cancelled quantity is unavailable or exceeds the order. Reload the PO and review its quantities.");
      continue;
    }
    const netOrdered = orderedPieces - cancelledPieces;
    progress.overShippedPieces = Math.max(0, progress.shippedPieces - netOrdered);
    if (!progress.quantitiesComplete) continue;
    // A direct/historical receipt may have no dispatch record. Do not tell the
    // user to ship those pieces again, or invent a shipment to fill the gap.
    if (receivedPieces != null && receivedPieces > progress.shippedPieces) {
      progress.issues.push("Received pieces exceed the linked shipped quantity. Review shipment links in the Shipments tab.");
      continue;
    }
    progress.stillToShipPieces = Math.max(0, netOrdered - progress.shippedPieces);
    if (progress.overShippedPieces > 0) progress.issues.push(`${progress.overShippedPieces.toLocaleString("en-US")} more pieces shipped than ordered after cancellations.`);
    if (progress.plannedPieces > progress.stillToShipPieces) progress.issues.push("Planned shipments exceed the quantity still to ship. Review the linked shipment plans.");
  }
  return result;
}
