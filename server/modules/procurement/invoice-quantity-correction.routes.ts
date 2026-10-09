import type { Express, Request, Response } from "express";
import { z } from "zod";
import { invoiceQuantityIdSchema } from "@shared/procurement/invoice-quantity-correction";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { createInvoiceQuantityCorrectionService } from "./invoice-quantity-correction.service";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";

const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(invoiceQuantityIdSchema);
function id(value: string): number {
  const parsed = pathId.safeParse(value);
  if (!parsed.success) throw new InvoiceQuantityCorrectionError("Invoice line ID is invalid.", "INVOICE_QUANTITY_INPUT_INVALID", 400);
  return parsed.data;
}
export function registerInvoiceQuantityCorrectionRoutes(app: Express, service = createInvoiceQuantityCorrectionService(db, () => new Date())) {
  const root = "/api/vendor-invoice-lines/:lineId/quantity-correction";
  function failure(error: unknown, req: Request, res: Response) {
    if (error instanceof FinancialCommandError || error instanceof InvoiceQuantityCorrectionError) {
      logger.warn("procurement.invoice_quantity_correction", { outcome: "rejected", invoice_line_id: req.params.lineId,
        actor_id: req.session.user?.id, error_code: error.code, http_status: error.statusCode });
      if (error instanceof FinancialCommandError) res.set(error.responseHeaders ?? {});
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    logger.error("procurement.invoice_quantity_correction", { outcome: "failed", invoice_line_id: req.params.lineId,
      actor_id: req.session.user?.id, error_class: error instanceof Error ? error.name : "UnknownError" });
    if (error instanceof z.ZodError) return res.status(409).json({ error: "Recorded invoice evidence is invalid. Review the source records.", code: "INVOICE_QUANTITY_SOURCE_INVALID" });
    return res.status(500).json({ error: "Could not complete the correction. Retry the saved confirmation.", code: "INVOICE_QUANTITY_FAILED" });
  }
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.context(id(req.params.lineId), req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(`${root}/preview`, requirePermission("purchasing", "approve"), async (req, res) => {
    try { res.json(await service.preview(id(req.params.lineId), req.body, req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const lineId = id(req.params.lineId), actorId = req.session.user!.id;
      const descriptor = financialCommandFromRequest(req, { actorId, routeTemplate: root,
        resourceKey: `vendor_invoice_line:${lineId}`, commandName: "ap.invoice.quantity_correction" });
      const result = await service.approve(lineId, req.body, actorId, descriptor);
      if (result.httpStatus >= 400) logger.warn("procurement.invoice_quantity_correction", { outcome: "rejected", invoice_line_id: lineId,
        actor_id: actorId, http_status: result.httpStatus, command_key: descriptor.idempotencyKey, replayed: result.replayed });
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      return res.status(result.httpStatus).json(result.body);
    } catch (error) { return failure(error, req, res); }
  });
}
