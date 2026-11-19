import type { Express } from "express";
import { relationshipRootSchema, type RelationshipRoot, type RelationshipSnapshot } from "@shared/procurement/document-relationships";
import { requirePermission } from "../../routes/middleware";

export function registerDocumentRelationshipRoutes(app: Express, service: { read(root: RelationshipRoot): Promise<RelationshipSnapshot | null> }) {
  app.get("/api/procurement/relationships/:kind/:id", requirePermission("purchasing", "view"), async (req, res) => {
    const parsed = relationshipRootSchema.safeParse({ kind: req.params.kind,
      id: /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : null });
    if (!parsed.success) return res.status(400).json({ code: "RELATIONSHIP_REQUEST_INVALID", error: "Choose a valid purchase order, shipment or receipt." });
    try {
      const data = await service.read(parsed.data);
      if (!data) return res.status(404).json({ code: "RELATIONSHIP_NOT_FOUND", error: "This document was not found." });
      return res.json(data);
    } catch (error) {
      console.error(JSON.stringify({ event: "procurement.relationships.read_failed", code: "RELATIONSHIP_READ_FAILED", ...parsed.data,
        errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(500).json({ code: "RELATIONSHIP_READ_FAILED", error: "Document links and cost shares could not be loaded. Retry this section." });
    }
  });
}
