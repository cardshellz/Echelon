import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { createPoQuantityAmendmentService } from "./po-quantity-amendment.service";
import { PoQuantityAmendmentError } from "./po-quantity-amendment.policy";
import { PurchaseApprovalAuthorityError } from "./purchase-order-approval.policy";

export function registerPoQuantityAmendmentRoutes(app: Express, service = createPoQuantityAmendmentService(db, () => new Date())) {
  function failure(error: unknown, req: Request, res: Response) {
    if (error instanceof FinancialCommandError) return res.status(error.statusCode).set(error.responseHeaders ?? {}).json({ error: error.message, code: error.code, details: error.details });
    if (error instanceof PoQuantityAmendmentError) return res.status(error.statusCode).json({ error: error.message, code: error.code });
    if (error instanceof PurchaseApprovalAuthorityError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
    if (error instanceof z.ZodError) return res.status(409).json({ error: "Recorded PO evidence is invalid. Review the source records.", code: "PO_AMENDMENT_SOURCE_INVALID" });
    console.error(JSON.stringify({ event: "po_quantity_amendment_failed", purchaseOrderId: req.params.id, actorId: req.session.user?.id, message: error instanceof Error ? error.message : "Unknown failure" }));
    return res.status(500).json({ error: "Could not complete the quantity correction. Retry the saved request.", code: "PO_AMENDMENT_FAILED" });
  }
  const root = "/api/purchase-orders/:id/quantity-amendment";
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await service.context(Number(req.params.id), req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(`${root}/preview`, requirePermission("purchasing", "approve"), async (req, res) => {
    try { res.json(await service.preview(Number(req.params.id), req.body, req.session.user!.id)); }
    catch (error) { failure(error, req, res); }
  });
  app.post(root, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const poId = Number(req.params.id);
      const actorId = req.session.user!.id;
      const descriptor = financialCommandFromRequest(req, { actorId, routeTemplate: root, resourceKey: `purchase_order:${poId}`, commandName: "purchase_order.quantity_amendment.approve" });
      const result = await service.approve(poId, req.body, actorId, descriptor);
      res.status(result.httpStatus).set("Idempotency-Replayed", result.replayed ? "true" : "false").json(result.body);
    } catch (error) { failure(error, req, res); }
  });
}
