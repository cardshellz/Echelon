import type { Express } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { createPurchasePipelineRepository } from "./purchase-pipeline.repository";
import { projectPurchasePipeline, PurchasePipelineError } from "./purchase-pipeline.service";
import { createSupplierProgressService, pipelineLineIdSchema } from "./supplier-progress.service";

export function registerPurchasePipelineRoutes(app: Express, database = db, clock: () => Date = () => new Date()): void {
  // Factories do not read or initialize storage during unrelated route imports.
  const repository = createPurchasePipelineRepository(database);
  const progress = createSupplierProgressService(database, clock);
  const fail = (res: import("express").Response, error: unknown, operation: string) => {
    if (error instanceof PurchasePipelineError) { res.status(error.statusCode).json({ code: error.code, error: error.message }); return; }
    console.error({ event: "procurement.purchase_pipeline.failed", operation, error });
    res.status(500).json({ code: "PURCHASE_PIPELINE_FAILED", error: "Unable to load or save purchase pipeline evidence. Retry an unchanged progress request with the same key." });
  };
  app.get("/api/purchasing/pipeline", requirePermission("purchasing", "view"), async (req, res) => {
    const horizon = z.enum(["30", "90"]).safeParse(req.query.horizonDays ?? "90");
    if (!horizon.success) { res.status(400).json({ code: "PIPELINE_HORIZON_INVALID", error: "Choose a 30 or 90 day arrival horizon." }); return; }
    try { const asOf = clock(); res.json(projectPurchasePipeline(await repository.read(), asOf, horizon.data === "30" ? 30 : 90)); }
    catch (error) { fail(res, error, "read"); }
  });
  app.get("/api/purchasing/pipeline/lines/:id/progress", requirePermission("purchasing", "view"), async (req, res) => {
    const id = pipelineLineIdSchema.safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ code: "PIPELINE_LINE_INVALID", error: "Select an exact purchase line." }); return; }
    try { res.json(await repository.history(id.data)); } catch (error) { fail(res, error, "history"); }
  });
  app.put("/api/purchasing/pipeline/lines/:id/progress", requirePermission("purchasing", "edit"), async (req, res) => {
    const id = pipelineLineIdSchema.safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ code: "PIPELINE_LINE_INVALID", error: "Select an exact purchase line." }); return; }
    try { res.json(await progress.update(id.data, req.body, req.session?.user?.id)); } catch (error) { fail(res, error, "progress"); }
  });
}
