import type { Express, RequestHandler, Response } from "express";
import { pendingQuantityPublicationRecoveryRequestSchema, pendingQuantityPublicationRecoverySchema,
  quantityPublicationRecoverySchema, quantityPublicationRecoveryResultSchema } from "@shared/types/inventory-publication-recovery";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverCommitError } from "../../application/inventory-cutover-commit.service";
import { QuantityPublicationRecoveryService } from "../../application/quantity-publication-recovery.service";
import { PostgresQuantityPublicationRecoveryRepository } from "../../infrastructure/quantity-publication-recovery.repository";
import { QuantityPublicationAdmissionError } from "../../domain/quantity-publication-admission";
import { sendInventoryCutoverError } from "./inventory-cutover-commit.routes";

const noStore: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };

export function registerQuantityPublicationRecoveryRoutes(app: Express,
  service: Pick<QuantityPublicationRecoveryService, "pending" | "attest"> = new QuantityPublicationRecoveryService(new PostgresQuantityPublicationRecoveryRepository()),
): void {
  app.post("/api/inventory-planning/admin/publication-recovery/pending", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = pendingQuantityPublicationRecoveryRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError(
        "PUBLICATION_RECOVERY_PENDING_REQUEST_INVALID", "A valid run is required; query filters and actor overrides are not accepted.", 400);
      return res.json(pendingQuantityPublicationRecoverySchema.parse(await service.pending(request.data, req.session?.user?.id)));
    } catch (error) { return sendRecoveryError(res, error); }
  });
  app.post("/api/inventory-planning/admin/publication-recovery/attest", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = quantityPublicationRecoverySchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError(
        "PUBLICATION_RECOVERY_REQUEST_INVALID", "Exact retained terminal evidence is required; query filters and actor overrides are not accepted.", 400);
      const result = quantityPublicationRecoveryResultSchema.parse(await service.attest(request.data, req.session?.user?.id));
      return res.status(result.replay ? 200 : 201).json(result);
    } catch (error) { return sendRecoveryError(res, error); }
  });
}

function sendRecoveryError(res: Response, error: unknown): Response {
  if (error instanceof QuantityPublicationAdmissionError) {
    if (["PUBLICATION_RECOVERY_REPLAY_CONFLICT", "PUBLICATION_RECOVERY_STATE_INVALID"].includes(error.code)) {
      return sendInventoryCutoverError(res, new InventoryCutoverCommitError(error.code,
        "This attempt or recovery key no longer accepts the submitted evidence. Refresh recorded owner history; do not clear uncertainty automatically."));
    }
    if (error.code === "PUBLICATION_DRAIN_EVIDENCE_LIMIT") return sendInventoryCutoverError(res, new InventoryCutoverCommitError(
      error.code, "The complete owner history exceeds the supported bound. No partial recovery list is being reported.", 422));
  }
  return sendInventoryCutoverError(res, error);
}
