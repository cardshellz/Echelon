import type { Express, Request } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { ApLedgerError } from "./ap-ledger.service";
import type { createInvoiceCostReviewCommands } from "./invoice-cost-review.service";

/** HTTP validates identity and transport only; the command rechecks persisted
 * authority and the complete reviewed effect under transaction-held locks. */
export function registerInvoiceCostReviewRoute(app: Express, commands: ReturnType<typeof createInvoiceCostReviewCommands>) {
  const id = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
  app.post("/api/vendor-invoice-lines/:lineId/cost-components", requirePermission("purchasing", "approve"), async (req, res) => {
    const parsed = id.safeParse(req.params.lineId);
    if (!parsed.success) return res.status(400).json({ error: "Choose a valid invoice line." });
    const actorId = (req as Request & { user?: { id?: string } }).user?.id ?? req.session?.user?.id;
    if (!actorId) return res.status(401).json({ error: "Sign in to approve supplier costs." });
    try {
      const descriptor = financialCommandFromRequest(req, { actorId, routeTemplate: "/api/vendor-invoice-lines/:lineId/cost-components",
        resourceKey: `vendor_invoice_line:${parsed.data}`, commandName: "ap.invoice.cost_components" });
      const result = await commands.review(parsed.data, req.body, actorId, descriptor);
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      if (error instanceof FinancialCommandError) {
        for (const [header, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(header, value);
        return res.status(error.statusCode).json({ error: error.message, details: { code: error.code, ...(error.details ?? {}) } });
      }
      if (error instanceof ApLedgerError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      if (error instanceof CostEvidenceError) return res.status(409).json({ error: error.message, details: { code: error.code } });
      console.error(JSON.stringify({ event: "procurement.invoice.cost_approval_failed", lineId: parsed.data, actorId,
        errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(503).json({ error: "The supplier cost update could not be confirmed. Retry the saved approval to check its result." });
    }
  });
}
