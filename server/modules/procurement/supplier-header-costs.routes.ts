import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { logger } from "../../platform/observability/logger";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { supplierHeaderTargetSchema } from "@shared/procurement/supplier-header-costs";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { createSupplierHeaderCostService, supplierHeaderCommandScope } from "./supplier-header-cost-review.service";

export function registerSupplierHeaderCostRoutes(app: Express, service: ReturnType<typeof createSupplierHeaderCostService>) {
  const endpoint = "/api/purchasing/supplier-header-costs";
  function failure(error: unknown, req: Request, res: Response) {
    let status = 503, code = "SUPPLIER_HEADER_RETRY", message = "The approval was not confirmed. Retry the same saved approval.";
    if (error instanceof FinancialCommandError) {
      status = error.statusCode; code = error.code; message = error.message;
      for (const [key, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(key, value);
    } else if (error instanceof CostEvidenceError || error instanceof InvoiceQuantityCorrectionError) {
      status = error instanceof CostEvidenceError ? 409 : error.statusCode; code = error.code; message = error.message;
    } else if (error instanceof z.ZodError) { status = 400; code = "SUPPLIER_HEADER_INVALID"; message = "Review the supplier amounts and their exact line allocations."; }
    const context = { actor_id: req.session.user?.id, route: req.route?.path, error_code: code, error_class: error instanceof Error ? error.name : "UnknownError" };
    if (status < 500) logger.warn("procurement.supplier_header.rejected", context);
    else logger.error("procurement.supplier_header.failed", context);
    res.status(status).json({ code, error: message });
  }
  app.get(endpoint, requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = z.string().regex(/^[1-9]\d*$/).transform(Number).parse(req.query.id);
      const target = supplierHeaderTargetSchema.parse({ kind: req.query.kind, id });
      res.json(await service.context(target, req.session.user!.id));
    } catch (error) { failure(error, req, res); }
  });
  app.post(`${endpoint}/preview`, requirePermission("purchasing", "approve"), async (req, res) => {
    try { res.json(await service.preview(req.body, req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(`${endpoint}/approve`, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const actorId = req.session.user!.id, target = supplierHeaderTargetSchema.parse(req.body?.target);
      const result = await service.approve(req.body, actorId, financialCommandFromRequest(req, { actorId, ...supplierHeaderCommandScope(target) }));
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
