import type { Express, Request, Response } from "express";
import { z } from "zod";
import { shipmentInvoiceIdSchema } from "@shared/procurement/shipment-invoice-command";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import { createShipmentInvoiceCommands, hashShipmentInvoiceCommandIdentity, shipmentInvoiceCommandScope, SHIPMENT_INVOICE_COMMAND_PRINCIPAL } from "./shipment-invoice.commands";

const routeId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentInvoiceIdSchema);
function sendFailure(req: Request, res: Response, error: unknown): Response {
  if (error instanceof FinancialCommandError) {
    if (error.statusCode >= 500) logger.error("procurement.shipment_invoice.request_failed", { shipment_id: req.params.id, actor_id: req.session?.user?.id ?? null, error_code: error.code, error_type: error.name });
    for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    return res.status(error.statusCode).json({ code: error.code, error: error.message, details: error.details });
  }
  logger.error("procurement.shipment_invoice.request_failed", { shipment_id: req.params.id, actor_id: req.session?.user?.id ?? null, error_code: "SHIPMENT_INVOICE_UNAVAILABLE", error_type: error instanceof Error ? error.name : "unknown" });
  return res.status(503).json({ code: "SHIPMENT_INVOICE_UNAVAILABLE", error: "Invoice creation is not confirmed. Retry the saved request with the same command key." });
}
export function registerShipmentInvoiceRoutes(app: Express): void {
  const commands = createShipmentInvoiceCommands();
  app.post("/api/inbound-shipments/:id/create-invoice", requireAuth, requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const actorId = req.session?.user?.id;
      if (!actorId) throw new FinancialCommandError("An authenticated operator is required", 401, "SHIPMENT_INVOICE_ACTOR_REQUIRED");
      const shipment = routeId.safeParse(req.params.id);
      if (!shipment.success) throw new FinancialCommandError("Choose a valid shipment", 400, "SHIPMENT_INVOICE_ID_INVALID");
      if (Object.keys(req.query).length) throw new FinancialCommandError("Invoice creation does not accept query parameters", 400, "SHIPMENT_INVOICE_QUERY_INVALID");
      const descriptor = financialCommandFromRequest(req, { ...shipmentInvoiceCommandScope(), actorType: "service", actorId: SHIPMENT_INVOICE_COMMAND_PRINCIPAL });
      const result = await commands.execute(shipment.data, req.body, actorId, { ...descriptor,
        requestHash: hashShipmentInvoiceCommandIdentity({ shipmentId: shipment.data, body: req.body, actorId }),
      });
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      return res.status(result.httpStatus).json(result.body);
    } catch (error) { return sendFailure(req, res, error); }
  });
}
