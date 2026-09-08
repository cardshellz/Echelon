import type { Express, RequestHandler } from "express";
import { finishInventoryCutoverRequestSchema, finishInventoryCutoverResultSchema,
  inventoryCutoverVerificationRequestSchema, inventoryCutoverVerificationSchema } from "@shared/types/inventory-cutover-completion";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverCommitError } from "../../application/inventory-cutover-commit.service";
import { InventoryCutoverCompletionService } from "../../application/inventory-cutover-completion.service";
import { PostgresInventoryCutoverCompletionRepository } from "../../infrastructure/inventory-cutover-completion.repository";
import { sendInventoryCutoverError } from "./inventory-cutover-commit.routes";

const noStore: RequestHandler = (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };
export function registerInventoryCutoverCompletionRoutes(app: Express,
  service: Pick<InventoryCutoverCompletionService, "verify" | "finish"> = new InventoryCutoverCompletionService(new PostgresInventoryCutoverCompletionRepository()),
): void {
  app.post("/api/inventory-planning/admin/cutover/verification", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = inventoryCutoverVerificationRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError("CUTOVER_VERIFICATION_REQUEST_INVALID", "A valid run is required; query filters and actor overrides are not accepted.", 400);
      return res.json(inventoryCutoverVerificationSchema.parse(await service.verify(request.data, req.session?.user?.id)));
    } catch (error) { return sendInventoryCutoverError(res, error); }
  });
  app.post("/api/inventory-planning/admin/cutover/finish", noStore, requirePermission("inventory_planning", "activate"), async (req, res) => {
    try {
      const request = finishInventoryCutoverRequestSchema.safeParse(req.body);
      if (!request.success || Object.keys(req.query).length > 0) throw new InventoryCutoverCommitError("CUTOVER_FINISH_REQUEST_INVALID", "A reviewed completion command is required; query filters and actor overrides are not accepted.", 400);
      const result = finishInventoryCutoverResultSchema.parse(await service.finish(request.data, req.session?.user?.id));
      return res.status(result.alreadyApplied ? 200 : 201).json(result);
    } catch (error) { return sendInventoryCutoverError(res, error); }
  });
}
