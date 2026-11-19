import { relationshipSnapshotSchema, type RelationshipRoot, type RelationshipSnapshot } from "@shared/procurement/document-relationships";
import { projectPurchaseLineShipping } from "@shared/procurement/purchase-line-shipping";

export function createDocumentRelationshipService(repository: { read(root: RelationshipRoot): Promise<RelationshipSnapshot | null> }) {
  return {
    async read(root: RelationshipRoot): Promise<RelationshipSnapshot | null> {
      const recorded = await repository.read(root);
      if (!recorded) return null;
      const data = relationshipSnapshotSchema.parse(recorded);
      if (data.root.id !== root.id || data.root.kind !== root.kind) throw new Error("Relationship scope mismatch");
      for (const collection of [data.purchases, data.purchaseLines, data.shipments, data.shipmentLines, data.receipts, data.receiptLines]) {
        if (new Set(collection.map(row => row.id)).size !== collection.length) throw new Error("Duplicate document relationship identity");
      }
      if (new Set(data.allocations.map(row => `${row.costId}:${row.shipmentLineId}`)).size !== data.allocations.length) throw new Error("Duplicate shipment allocation identity");
      projectPurchaseLineShipping(data);
      return data;
    },
  };
}
