import type { Express, Response } from "express";
import { ZodError } from "zod";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { pickCorrectionListSchema, pickCorrectionSchema } from "@shared/pick-corrections";
import { PickCorrectionError } from "../wms/pick-correction.repository";
import type { PickCorrectionService } from "./pick-correction.service";

export function registerPickCorrectionRoutes(app: Express, service: PickCorrectionService): void {
  const failure = (res: Response, error: unknown) => {
    if (error instanceof ZodError) return res.status(400).json({ code: "INVALID_INPUT", error: "Invalid correction command." });
    if (error instanceof PickCorrectionError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
    console.error(JSON.stringify({ event: "pick_correction_failed", code: "CORRECTIVE_PICK_NOT_SAVED",
      message: error instanceof Error ? error.message : "Unknown correction failure" }));
    return res.status(500).json({ code: "CORRECTIVE_PICK_NOT_SAVED", error: "The correction remains open. Refresh it to see the inventory review details." });
  };
  app.get("/api/picking/corrections", requireAuth, requirePermission("picking", "view"), async (_req, res) => {
    try { res.set("Cache-Control", "no-store").json(pickCorrectionListSchema.parse(await service.list())); }
    catch (error) { failure(res, error); }
  });
  for (const action of ["answer", "pick"] as const) {
    app.post(`/api/picking/corrections/:id/${action}`, requireAuth, requirePermission("picking", "perform"), async (req, res) => {
      try {
        const actor = req.session.user?.id;
        if (!actor) return res.status(401).json({ error: "Sign in to resolve picks." });
        const result = action === "answer"
          ? await service.answer(Number(req.params.id), req.body, actor)
          : await service.complete(Number(req.params.id), req.body, actor);
        res.json(pickCorrectionSchema.parse(result));
      } catch (error) { failure(res, error); }
    });
  }
}
