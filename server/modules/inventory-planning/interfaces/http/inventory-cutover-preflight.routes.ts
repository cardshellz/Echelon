import type { Express, Request, Response } from "express";
import { inventoryCutoverPreflightSchema } from "@shared/types/inventory-cutover-preflight";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverPreflightError, InventoryCutoverPreflightService } from "../../application/inventory-cutover-preflight.service";
import { PostgresInventoryCutoverPreflightRepository } from "../../infrastructure/inventory-cutover-preflight.repository";
import { WmsCutoverDemandCaptureError } from "../../../wms/inventory-cutover-demand-reader";
import { InventoryCutoverEncumbranceCaptureError } from "../../../inventory/infrastructure/inventory-cutover-encumbrance.repository";

export function registerInventoryCutoverPreflightRoutes(
  app: Express,
  service: Pick<InventoryCutoverPreflightService, "preview"> = new InventoryCutoverPreflightService(new PostgresInventoryCutoverPreflightRepository()),
): void {
  app.get("/api/inventory-planning/admin/cutover-preflight", requirePermission("inventory_planning", "view"),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        if (!req.session?.user?.id) throw new InventoryCutoverPreflightError(401, "INVENTORY_CUTOVER_ACTOR_REQUIRED", "An authenticated operator is required.");
        if (Object.keys(req.query).length > 0 || (req.body && Object.keys(req.body).length > 0)) {
          throw new InventoryCutoverPreflightError(400, "INVENTORY_CUTOVER_INVALID_REQUEST", "This full-scope read does not accept filters, actor overrides or activation commands.");
        }
        const report = inventoryCutoverPreflightSchema.parse(await service.preview(req.session.user.id));
        return res.json(report);
      } catch (error) {
        if (error instanceof InventoryCutoverPreflightError && error.status < 500) {
          return res.status(error.status).json({ error: { code: error.code, message: error.message } });
        }
        if ((error instanceof WmsCutoverDemandCaptureError || error instanceof InventoryCutoverEncumbranceCaptureError)
          && error.code.endsWith("LIMIT_EXCEEDED")) {
          return res.status(422).json({ error: { code: error.code, message: "The full evidence set exceeds the safe capture bound. No partial cutover report was returned." } });
        }
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
        console.error(JSON.stringify({ event: "inventory_cutover_preflight_failed", code,
          errorType: error instanceof Error ? error.name : "UnknownError" }));
        const retryable = ["40001", "40P01", "57014"].includes(code ?? "");
        return res.status(retryable ? 503 : 500).json({ error: {
          code: retryable ? "INVENTORY_CUTOVER_CAPTURE_RETRYABLE" : "INVENTORY_CUTOVER_CAPTURE_FAILED",
          message: retryable ? "The evidence snapshot could not complete. Retry the full read." : "Cutover evidence could not be captured. No partial report is usable.",
        } });
      }
    });
}
