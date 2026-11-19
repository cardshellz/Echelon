import type { Express, Request, Response } from "express";
import { z } from "zod";
import { MoneyInputError } from "@shared/money-read";
import { freightInvoiceIdSchema } from "@shared/procurement/freight-invoice-costs";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { FreightInvoiceCostError } from "./domain/freight-invoice-costs";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { ApLedgerError } from "./ap-ledger.service";
import { createFreightInvoiceCostService, freightInvoiceCommandScope } from "./freight-invoice-costs.service";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";

const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(freightInvoiceIdSchema);
export function registerFreightInvoiceCostRoutes(app: Express, service: ReturnType<typeof createFreightInvoiceCostService>) {
  function failure(error: unknown, req: Request, res: Response) {
    let status = 500, code = "FREIGHT_INVOICE_RETRY", message = "The cost update was not confirmed. Retry the same saved approval.";
    if (error instanceof FinancialCommandError) {
      status = error.statusCode; code = error.code; message = error.message;
      for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    } else if (error instanceof FreightInvoiceCostError || error instanceof InvoiceQuantityCorrectionError || error instanceof CostEvidenceError || error instanceof PoQuantityAmendmentError) {
      status = error instanceof CostEvidenceError ? 409 : error.statusCode; code = error.code; message = error.message;
    } else if (error instanceof ShipmentTrackingError || error instanceof ApLedgerError) {
      if (error.statusCode < 500) { status = error.statusCode; code = String(error.details?.code ?? "FREIGHT_INVOICE_REVIEW_REQUIRED"); message = error.message; }
    } else if (error instanceof MoneyInputError) {
      status = 409; code = "FREIGHT_INVOICE_EVIDENCE_INVALID"; message = "Review the recorded invoice and charge amounts.";
    } else if (error instanceof z.ZodError) {
      status = 400; code = "FREIGHT_INVOICE_INPUT_INVALID"; message = "Reload the invoice and review its current source and cost changes.";
    }
    const context = { actor_id: req.session.user?.id, resource_id: req.params.id, route: req.route?.path, error_code: code,
      error_class: error instanceof Error ? error.name : "UnknownError" };
    if (status < 500) logger.warn("procurement.freight_invoice_costs.rejected", context);
    else logger.error("procurement.freight_invoice_costs.failed", context);
    return res.status(status).json({ code, error: message });
  }
  const route = "/api/vendor-invoices/:id/shipment-cost-review";
  app.get("/api/purchase-orders/:id/freight-invoice-cost-approvals", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.history(pathId.parse(req.params.id))); }
    catch (error) { failure(error, req, res); }
  });
  app.get(route, requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.context(pathId.parse(req.params.id), req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(`${route}/preview`, requirePermission("purchasing", "approve"), async (req, res) => {
    try { res.json(await service.preview(pathId.parse(req.params.id), req.body, req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(`${route}/approve`, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const invoiceId = pathId.parse(req.params.id), actorId = req.session.user!.id;
      const result = await service.approve(invoiceId, req.body, actorId,
        financialCommandFromRequest(req, { actorId, ...freightInvoiceCommandScope(invoiceId) }));
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
