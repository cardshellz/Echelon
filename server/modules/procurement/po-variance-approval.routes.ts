import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { createPoVarianceApprovalService } from "./po-variance-approval.service";
import { PoVarianceApprovalError } from "./po-variance-approval.policy";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
export function registerPoVarianceApprovalRoutes(app: Express, service = createPoVarianceApprovalService(db, () => new Date())) {
  const root = "/api/po-exceptions/:id/variance-approval";
  function failure(error: unknown, req: Request, res: Response) {
    const known = error instanceof FinancialCommandError || error instanceof PoVarianceApprovalError || error instanceof PoQuantityAmendmentError || error instanceof InvoiceQuantityCorrectionError;
    logger.warn("procurement.invoice_variance_approval", { exception_id: req.params.id, actor_id: req.session.user?.id,
      outcome: known ? "rejected" : "failed", error_code: known ? error.code : "PO_VARIANCE_FAILED" });
    if (error instanceof FinancialCommandError) res.set(error.responseHeaders ?? {});
    return res.status(known ? error.statusCode : error instanceof z.ZodError ? 400 : 500)
      .json({ error: known ? error.message : "Could not review or approve this variance. Reload or retry the saved confirmation.", code: known ? error.code : "PO_VARIANCE_FAILED" });
  }
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.context(pathId.parse(req.params.id), req.session.user!.id)); } catch (error) { failure(error, req, res); }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const id = pathId.parse(req.params.id), actorId = req.session.user!.id;
      const descriptor = financialCommandFromRequest(req, { actorId, routeTemplate: root, resourceKey: `po_exception:${id}`, commandName: "purchase_order.variance.approve" });
      const result = await service.approve(id, req.body, actorId, descriptor);
      if (result.httpStatus >= 400) logger.warn("procurement.invoice_variance_approval", { exception_id: id, actor_id: actorId, outcome: "rejected", http_status: result.httpStatus, command_key: descriptor.idempotencyKey });
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
