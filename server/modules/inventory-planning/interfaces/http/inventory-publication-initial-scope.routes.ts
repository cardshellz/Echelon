import type { Express, Response } from "express";
import { ZodError } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { InitialPublicationScopeError, type InventoryPublicationInitialScopeService } from "../../application/inventory-publication-initial-scope.service";

export function registerInventoryPublicationInitialScopeRoutes(app: Express,
  service: Pick<InventoryPublicationInitialScopeService, "review" | "prepare">): void {
  const root = "/api/inventory-planning/admin/publication-initial-scope";
  app.post(root + "/review", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { respond(res, error); }
  });
  app.post(root + "/prepare", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.prepare(req.body, req.session?.user?.id)); } catch (error) { respond(res, error); }
  });
}

function respond(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: "INITIAL_SCOPE_INVALID_REQUEST", message: "A valid destination review and authenticated actor are required." } });
    return;
  }
  if (error instanceof InitialPublicationScopeError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } }); return;
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  if (["40001", "40P01", "55P03", "55000", "57014"].includes(code)) {
    res.status(409).json({ error: { code: "INITIAL_SCOPE_BUSY", message: "Authority, listing work or cutover state changed. Review again before retrying." } }); return;
  }
  console.error(JSON.stringify({ event: "publication_initial_scope_failed", code: /^[A-Z0-9_]{1,100}$/.test(code) ? code : "UNKNOWN" }));
  res.status(500).json({ error: { code: "INITIAL_SCOPE_FAILED", message: "Preparation is not confirmed. Retry using the same command key." } });
}
