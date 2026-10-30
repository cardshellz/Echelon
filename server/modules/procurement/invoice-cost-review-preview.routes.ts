import type { Express, Request } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { ApLedgerError } from "./ap-ledger.service";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import type { previewInvoiceCostReview } from "./invoice-cost-review-preview.service";

export function registerInvoiceCostReviewPreviewRoute(app: Express, preview: typeof previewInvoiceCostReview) {
  const id = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
  app.post("/api/vendor-invoice-lines/:lineId/cost-components/preview", requirePermission("purchasing", "approve"), async (req, res) => {
    const parsed = id.safeParse(req.params.lineId);
    if (!parsed.success) return res.status(400).json({ error: "Choose a valid invoice line." });
    const actorId = (req as Request & { user?: { id?: string } }).user?.id ?? req.session?.user?.id;
    if (!actorId) return res.status(401).json({ error: "Sign in to review supplier costs." });
    try { return res.json(await preview(parsed.data, req.body, actorId)); }
    catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ error: "Check the supplier amounts and add a review note." });
      if (error instanceof ApLedgerError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      if (error instanceof CostEvidenceError) return res.status(409).json({ error: error.message, details: { code: error.code } });
      console.error(JSON.stringify({ event: "procurement.invoice.cost_preview_failed", lineId: parsed.data, actorId, errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(503).json({ error: "The cost changes could not be loaded. Reload the review and try again." });
    }
  });
}
