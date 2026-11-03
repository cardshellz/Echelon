import type { Express, Request } from "express";
import { requirePermission } from "../../routes/middleware";
import { apInvoiceTransitionActionSchema } from "@shared/procurement/ap-invoice-transition";
import { classifyApInvoiceCommandFailure } from "./ap-invoice-commands";
import { getInvoiceTransitionHistory, invoiceTransitionIdSchema, previewInvoiceTransition } from "./ap-invoice-transition.service";

export function registerInvoiceTransitionPreviewRoutes(app: Express, preview = previewInvoiceTransition, history = getInvoiceTransitionHistory) {
  app.get("/api/vendor-invoices/:id/transition-history", requirePermission("purchasing", "view"), async (req, res) => {
    try { return res.json(await history(invoiceTransitionIdSchema.parse(req.params.id))); }
    catch (error) {
      const failure = classifyApInvoiceCommandFailure(error);
      if (failure.kind === "rejected") return res.status(failure.httpStatus).json(failure.body);
      console.error(JSON.stringify({ event: "procurement.invoice.transition_history_failed", invoiceId: req.params.id,
        errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(503).json({ error: "Invoice approval history is unavailable. Reload and try again." });
    }
  });
  for (const action of apInvoiceTransitionActionSchema.options) {
    app.post(`/api/vendor-invoices/:id/${action}/preview`, requirePermission("purchasing", action === "dispute" ? "edit" : "approve"), async (req, res) => {
      try {
        const invoiceId = invoiceTransitionIdSchema.parse(req.params.id);
        const actorId = (req as Request & { user?: { id?: string } }).user?.id ?? req.session?.user?.id;
        if (!actorId) return res.status(401).json({ error: "Sign in to review this invoice." });
        return res.json(await preview(invoiceId, action, req.body, actorId));
      } catch (error) {
        const failure = classifyApInvoiceCommandFailure(error);
        if (failure.kind === "rejected") return res.status(failure.httpStatus).json(failure.body);
        console.error(JSON.stringify({ event: "procurement.invoice.transition_preview_failed", action, invoiceId: req.params.id,
          errorType: error instanceof Error ? error.name : typeof error }));
        return res.status(503).json({ error: "The invoice changes could not be loaded. Reload and try again." });
      }
    });
  }
}
