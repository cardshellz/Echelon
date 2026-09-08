import type { Express, Request, Response } from "express";
import { z } from "zod";
import { sourcingId } from "@shared/procurement/supplier-sourcing";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { SupplierSourcingRepository } from "./supplier-sourcing.repository";
import { SupplierSourcingError, SupplierSourcingService } from "./supplier-sourcing.service";

const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(sourcingId);
function actor(req: Request): string | undefined { return (req as Request & { user?: { id?: string } }).user?.id ?? req.session?.user?.id; }
export function registerSupplierSourcingRoutes(app: Express): void {
  const service = new SupplierSourcingService(new SupplierSourcingRepository(db), () => new Date());
  function failure(error: unknown, req: Request, res: Response) {
    const code = error instanceof SupplierSourcingError ? error.code : error instanceof z.ZodError ? "SUPPLIER_SOURCING_INVALID" : "SUPPLIER_SOURCING_UNAVAILABLE";
    console.error(JSON.stringify({ event: "procurement.supplier_sourcing_failed", code, actorId: actor(req) ?? null, vendorProductId: req.params.vendorProductId }));
    return res.status(error instanceof SupplierSourcingError ? error.statusCode : error instanceof z.ZodError ? 400 : 500).json({ code, error: error instanceof SupplierSourcingError ? error.message : error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") : "Supplier sourcing settings could not be loaded or saved. Retry the same request." });
  }
  app.get("/api/vendor-products/:vendorProductId/sourcing", requirePermission("inventory", "view"), async (req, res) => {
    try { res.json(await service.read(pathId.parse(req.params.vendorProductId))); } catch (error) { failure(error, req, res); }
  });
  app.get("/api/vendor-products/:vendorProductId/sourcing/history", requirePermission("inventory", "view"), async (req, res) => {
    try { res.json(await service.history(pathId.parse(req.params.vendorProductId), req.query.beforeRevision === undefined ? null : pathId.parse(req.query.beforeRevision))); } catch (error) { failure(error, req, res); }
  });
  app.put("/api/vendor-products/:vendorProductId/sourcing", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const actorId = actor(req); if (!actorId) throw new SupplierSourcingError("SUPPLIER_SOURCING_ACTOR_REQUIRED", "An authenticated operator is required", 401);
      const result = await service.update(pathId.parse(req.params.vendorProductId), req.body, actorId);
      res.setHeader("Idempotency-Replayed", result.reused ? "true" : "false"); res.json(result.record);
    } catch (error) { failure(error, req, res); }
  });
}
