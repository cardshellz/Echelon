import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  receiptInvoiceApprovalRequestSchema,
  receiptInvoiceChangeSchema,
} from "@shared/procurement/receipt-invoice-costs";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import {
  createReceiptInvoiceCostService,
  receiptInvoiceCommandScope,
} from "./receipt-invoice-costs.service";

export function registerReceiptInvoiceCostRoutes(
  app: Express,
  service = createReceiptInvoiceCostService(db, () => new Date()),
) {
  function failure(error: unknown, req: Request, res: Response) {
    const classified =
      error instanceof CostEvidenceError ||
      error instanceof FinancialCommandError ||
      error instanceof InvoiceQuantityCorrectionError;
    const context = {
      actor_id: req.session.user?.id,
      error_class: error instanceof Error ? error.name : "UnknownError",
      ...(classified ? { error_code: error.code } : {}),
    };
    if (classified || error instanceof z.ZodError)
      logger.warn("procurement.receipt_invoice_costs.rejected", context);
    else logger.error("procurement.receipt_invoice_costs.failed", context);
    if (error instanceof FinancialCommandError)
      for (const [name, value] of Object.entries(error.responseHeaders ?? {}))
        res.setHeader(name, value);
    if (classified)
      return res
        .status(error instanceof CostEvidenceError ? 409 : error.statusCode)
        .json({ error: error.message, code: error.code });
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: "Check the receipt, invoice and whole-piece quantities.",
        code: "RECEIPT_INVOICE_INPUT_INVALID",
      });
    return res.status(500).json({
      error:
        "The receipt cost assignment could not complete. Retry the saved approval.",
      code: "RECEIPT_INVOICE_RETRY",
    });
  }
  app.get(
    "/api/purchase-orders/:id/receipt-invoice-cost-approvals",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const id = receiptInvoiceChangeSchema.shape.purchaseOrderLineId.parse(
          /^[1-9]\d*$/.test(req.params.id) ? Number(req.params.id) : Number.NaN,
        );
        res.json(await service.history(id));
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
  app.get(
    "/api/purchasing/receipt-invoice-costs/:lineId",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const id = /^[1-9]\d*$/.test(req.params.lineId)
          ? Number(req.params.lineId)
          : Number.NaN;
        const lineId =
          receiptInvoiceChangeSchema.shape.purchaseOrderLineId.parse(id);
        res.json(await service.context(lineId, req.session.user!.id));
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
  app.post(
    "/api/purchasing/receipt-invoice-costs/preview",
    requirePermission("purchasing", "approve"),
    async (req, res) => {
      try {
        res.json(await service.preview(req.body, req.session.user!.id));
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
  app.post(
    "/api/purchasing/receipt-invoice-costs",
    requirePermission("purchasing", "approve"),
    async (req, res) => {
      try {
        const request = receiptInvoiceApprovalRequestSchema.parse(req.body),
          actorId = req.session.user!.id;
        const result = await service.approve(
          request,
          actorId,
          financialCommandFromRequest(req, {
            actorId,
            ...receiptInvoiceCommandScope(request.change.purchaseOrderLineId),
          }),
        );
        res.setHeader(
          "Idempotency-Replayed",
          result.replayed ? "true" : "false",
        );
        res.status(result.httpStatus).json(result.body);
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
}
