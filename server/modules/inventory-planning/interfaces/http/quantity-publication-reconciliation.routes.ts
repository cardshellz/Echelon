import type { Express, RequestHandler } from "express";
import { publicationReconciliationRequestSchema, publicationReconciliationReviewRequestSchema,
  publicationReconciliationReviewSchema, publicationReconciliationResultSchema } from "@shared/types/inventory-publication-reconciliation";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverCommitError } from "../../application/inventory-cutover-commit.service";
import { PublicationReconciliationEvidenceError } from "../../domain/quantity-publication-reconciliation";
import { QuantityPublicationReconciliationService } from "../../application/quantity-publication-reconciliation.service";
import { PostgresQuantityPublicationReconciliationRepository } from "../../infrastructure/quantity-publication-reconciliation.repository";
import { sendInventoryCutoverError } from "./inventory-cutover-commit.routes";

const noStore: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };
const root = "/api/inventory-planning/admin/publication-recovery";

export function registerQuantityPublicationReconciliationRoutes(app: Express,
  service: Pick<QuantityPublicationReconciliationService, "review" | "reconcile"> = new QuantityPublicationReconciliationService(
    new PostgresQuantityPublicationReconciliationRepository()),
): void {
  app.post(`${root}/review-reconciliation`, noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = publicationReconciliationReviewRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError(
        "PUBLICATION_RECONCILIATION_REQUEST_INVALID", "A prepared run is required; account filters and actor overrides are not accepted.", 400);
      return res.json(publicationReconciliationReviewSchema.parse(await service.review(request.data, req.session?.user?.id)));
    } catch (error) { return sendInventoryCutoverError(res, publicError(error)); }
  });
  app.post(`${root}/reconcile-current`, noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = publicationReconciliationRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError(
        "PUBLICATION_RECONCILIATION_REQUEST_INVALID", "The exact review, explicit unknown-outcome acceptance, reason and retry key are required.", 400);
      const result = publicationReconciliationResultSchema.parse(await service.reconcile(request.data, req.session?.user?.id));
      return res.status(result.replay ? 200 : 201).json(result);
    } catch (error) { return sendInventoryCutoverError(res, publicError(error)); }
  });
}

function publicError(error: unknown): unknown {
  return error instanceof PublicationReconciliationEvidenceError
    ? new InventoryCutoverCommitError(error.code, error.message) : error;
}
