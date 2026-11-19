import type { Express, Request, Response } from "express";
import { z } from "zod";
import { purchaseTaxTargetSchema, purchaseTaxApprovalRequestSchema } from "@shared/procurement/purchase-tax";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { PurchaseTaxError } from "./domain/purchase-tax";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { createPurchaseTaxChangeService, purchaseTaxCommandScope } from "./purchase-tax-change.service";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { ApLedgerError } from "./ap-ledger.service";
import { MoneyInputError } from "@shared/money-read";

export function registerPurchaseTaxRoutes(app: Express, service = createPurchaseTaxChangeService(db, app.locals.services.shipmentTracking, () => new Date())) {
  function failure(error: unknown, req: Request, res: Response) {
    const classified = error instanceof PurchaseTaxError || error instanceof InvoiceQuantityCorrectionError || error instanceof FinancialCommandError
      || error instanceof CostEvidenceError || error instanceof ShipmentTrackingError || error instanceof PoQuantityAmendmentError
      || error instanceof ApLedgerError || error instanceof MoneyInputError || error instanceof z.ZodError;
    const context = { actor_id: req.session.user?.id, error_class: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof FinancialCommandError || error instanceof PurchaseTaxError
        || error instanceof InvoiceQuantityCorrectionError || error instanceof MoneyInputError ? { error_code: error.code } : {}),
      ...(error instanceof z.ZodError ? { invalid_fields: error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code })) } : {}) };
    if (classified) logger.warn("procurement.tax.change.rejected", context);
    else logger.error("procurement.tax.change.failed", context);
    if (error instanceof FinancialCommandError) for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    if (error instanceof PurchaseTaxError || error instanceof InvoiceQuantityCorrectionError || error instanceof FinancialCommandError)
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    if (error instanceof ApLedgerError) return res.status(error.statusCode).json({ error: error.message, code: "PURCHASE_TAX_INVOICE_REVIEW" });
    if (error instanceof MoneyInputError) return res.status(422).json({ error: error.message, code: error.code });
    if (error instanceof CostEvidenceError || error instanceof ShipmentTrackingError || error instanceof PoQuantityAmendmentError)
      return res.status(409).json({ error: error.message, code: "PURCHASE_TAX_COST_REVIEW" });
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Review the tax type, source, amounts and approval fields.", code: "PURCHASE_TAX_INPUT_INVALID" });
    return res.status(500).json({ error: "The tax change could not complete. Retry the saved approval.", code: "PURCHASE_TAX_RETRY" });
  }
  app.get("/api/purchasing/tax-types", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.types()); } catch (error) { failure(error, req, res); }
  });
  app.get("/api/purchase-orders/:id/tax-approvals", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : Number.NaN;
      const target = purchaseTaxTargetSchema.parse({ kind: "purchase_order", id });
      res.json(await service.history(target.id!));
    } catch (error) { failure(error, req, res); }
  });
  app.get("/api/purchasing/tax-review/:kind/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = req.params.id === "new" ? null : /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : Number.NaN;
      res.json(await service.context(purchaseTaxTargetSchema.parse({ kind: req.params.kind, id }), req.session.user!.id));
    } catch (error) { failure(error, req, res); }
  });
  app.post("/api/purchasing/tax-changes/preview", requirePermission("purchasing", "approve"), async (req, res) => {
    try { res.json(await service.preview(req.body, req.session.user!.id)); } catch (error) { failure(error, req, res); }
  });
  app.post("/api/purchasing/tax-changes", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const request = purchaseTaxApprovalRequestSchema.parse(req.body), actorId = req.session.user!.id;
      const scope = purchaseTaxCommandScope(purchaseTaxTargetSchema.parse({ kind: request.change.kind, id: request.change.id }));
      const result = await service.approve(req.body, actorId, financialCommandFromRequest(req, { actorId, ...scope }));
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
