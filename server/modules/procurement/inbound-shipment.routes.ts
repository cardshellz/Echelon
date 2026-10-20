import { readShipmentPackingUnitOptions, ShipmentUnitOptionsError } from "./shipment-unit-options.service";
import { registerReceiptShipmentQuantityCorrectionRoutes } from "./receipt-shipment-quantity-correction.routes";
import { createReceiptShipmentQuantityCorrectionService } from "./receipt-shipment-quantity-correction.service";
import { db } from "../../db";
import { registerShipmentInvoiceRoutes } from "./shipment-invoice.routes";
import { createShipmentCreateCommands, shipmentCreateCommandScope, SHIPMENT_CREATE_COMMAND_PRINCIPAL } from "./shipment-create.commands";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { createShipmentLineCommands, shipmentLineCommandScope, SHIPMENT_LINE_COMMAND_PRINCIPAL, type ShipmentLineCommand } from "./shipment-line-commands";
import type { Express, Request, Response } from "express";
import { createShipmentCostCommands, shipmentCostCommandScope, SHIPMENT_COST_COMMAND_PRINCIPAL, type ShipmentCostCommand } from "./shipment-cost-commands";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { z } from "zod";
import { shipmentCostResourceIdSchema } from "@shared/procurement/shipment-cost-command";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import * as apLedger from "./ap-ledger.service";
import * as notificationService from "../notifications/notifications.service";
import { shipmentCostWorkflowIdSchema } from "@shared/procurement/shipment-cost-workflow";
import { createShipmentCostUpdateCommands, shipmentCostUpdateScope, SHIPMENT_COST_UPDATE_PRINCIPAL } from "./shipment-cost-update.commands";
import { registerShipmentCostExceptionRoutes } from "./shipment-cost-exception.routes";

function getActorId(req: any): string | undefined {
  return req.user?.id ?? req.session?.user?.id;
}

export function registerInboundShipmentRoutes(app: Express) {
  registerShipmentCostExceptionRoutes(app);
  registerShipmentInvoiceRoutes(app);
  const { shipmentTracking } = app.locals.services;
  registerReceiptShipmentQuantityCorrectionRoutes(app, createReceiptShipmentQuantityCorrectionService(db, shipmentTracking, () => new Date()));
  registerReceiptShipmentQuantityCorrectionRoutes(app, createReceiptShipmentQuantityCorrectionService(db, shipmentTracking, () => new Date(), "shipment"), "shipment");
  const shipmentCostCommands = createShipmentCostCommands(shipmentTracking);
  const shipmentCreateCommands = createShipmentCreateCommands(shipmentTracking);
  const shipmentLineCommands = createShipmentLineCommands(shipmentTracking);
  const shipmentCostUpdates = createShipmentCostUpdateCommands(shipmentTracking);

  async function handleCostCommand(req: Request, res: Response, operation: ShipmentCostCommand["operation"]) {
    try {
      const rawId = operation === "create" ? req.params.id : req.params.costId;
      const resourceId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentCostResourceIdSchema).parse(rawId);
      const actorId = getActorId(req);
      if (!actorId) throw new FinancialCommandError("An authenticated actor is required", 401, "SHIPMENT_COST_ACTOR_REQUIRED");
      const descriptor = financialCommandFromRequest(req, {
        actorType: "service", actorId: SHIPMENT_COST_COMMAND_PRINCIPAL,
        ...shipmentCostCommandScope({ operation, resourceId }),
      });
      const result = await shipmentCostCommands.execute({ operation, resourceId, body: req.body }, actorId, descriptor);
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      if (error instanceof FinancialCommandError) {
        for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
        return res.status(error.statusCode).json({ code: error.code, error: error.message, details: error.details });
      }
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_COST_ID_INVALID", error: "Charge resource ID must be a positive PostgreSQL integer." });
      const cause = error instanceof Error ? error.cause ?? error : error;
      const databaseCode = cause && typeof cause === "object" && "code" in cause
        && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code) ? cause.code : null;
      console.error(JSON.stringify({
        event: "procurement.shipment_cost.command_failed", operation,
        resourceId: operation === "create" ? req.params.id : req.params.costId,
        actorId: getActorId(req) ?? null, code: "SHIPMENT_COST_TRANSIENT_FAILURE",
        databaseCode, errorType: error instanceof Error ? error.name : typeof error,
      }));
      return res.status(500).json({ code: "SHIPMENT_COST_TRANSIENT_FAILURE", error: "The charge command could not be completed. Retry with the same command key." });
    }
  }

  async function handleLineCommand(req: Request, res: Response, operation: ShipmentLineCommand["operation"]) {
    try {
      const rawId = (operation === "update" || operation === "delete") ? req.params.lineId : req.params.id;
      const resourceId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentLineResourceIdSchema).parse(rawId);
      const actorId = getActorId(req);
      if (!actorId) throw new FinancialCommandError("An authenticated actor is required", 401, "SHIPMENT_LINE_ACTOR_REQUIRED");
      const descriptor = financialCommandFromRequest(req, {
        actorType: "service", actorId: SHIPMENT_LINE_COMMAND_PRINCIPAL,
        ...shipmentLineCommandScope({ operation, resourceId }),
      });
      const result = await shipmentLineCommands.execute({ operation, resourceId, body: req.body }, actorId, descriptor);
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      // Only the command ledger's terminal rejection proves that an earlier
      // attempt cannot have applied. Authentication, proxy and key errors do not.
      const rejected = result.body as { details?: Record<string, unknown> };
      const body = result.terminalState === "rejected"
        ? { ...(result.body as Record<string, unknown>), details: { ...rejected.details,
          shipmentLineOutcome: "rejected", idempotencyKey: descriptor.idempotencyKey } }
        : result.body;
      return res.status(result.httpStatus).json(body);
    } catch (error) {
      if (error instanceof FinancialCommandError) {
        for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
        return res.status(error.statusCode).json({ code: error.code, error: error.message, details: error.details });
      }
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_LINE_ID_INVALID", error: "Line resource ID must be a positive PostgreSQL integer." });
      const cause = error instanceof Error ? error.cause ?? error : error;
      const databaseCode = cause && typeof cause === "object" && "code" in cause
        && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code) ? cause.code : null;
      console.error(JSON.stringify({
        event: "procurement.shipment_line.command_failed", operation,
        resourceId: (operation === "update" || operation === "delete") ? req.params.lineId : req.params.id,
        actorId: getActorId(req) ?? null, code: "SHIPMENT_LINE_TRANSIENT_FAILURE",
        databaseCode, errorType: error instanceof Error ? error.name : typeof error,
      }));
      return res.status(500).json({ code: "SHIPMENT_LINE_TRANSIENT_FAILURE", error: "The shipment line command could not be completed. Retry with the same command key." });
    }
  }


  // ==========================================================================
  // INBOUND SHIPMENTS - Tracking, Costs, Landed Cost Allocation
  // ==========================================================================

  // Shipment CRUD

  app.get("/api/procurement/landed-cost-health", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const result = await shipmentTracking.getLandedCostHealth({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof ShipmentTrackingError && error.statusCode < 500) return res.status(error.statusCode).json({ error: error.message });
      console.error(JSON.stringify({ event: "procurement.shipment_health.failed", errorType: error instanceof Error ? error.name : typeof error }));
      res.status(500).json({ code: "SHIPMENT_HEALTH_UNAVAILABLE", error: "Shipment cost health could not be verified. Retry the overview." });
    }
  });

  app.get("/api/inbound-shipments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      res.json(await shipmentTracking.getShipmentPage(req.query));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_LIST_QUERY_INVALID", error: "Invalid shipment filters or page." });
      console.error(JSON.stringify({ event: "procurement.shipment_list.failed", errorType: error instanceof Error ? error.name : typeof error }));
      res.status(500).json({ code: "SHIPMENT_LIST_UNAVAILABLE", error: "Shipments could not be verified. Retry the work list." });
    }
  });

  app.get("/api/inbound-shipments/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.getShipment(Number(req.params.id));
      const [lines, costs, history, paymentStatus, purchaseOrders] = await Promise.all([
        shipmentTracking.getEnrichedLines(shipment.id),
        apLedger.enrichCostsWithInvoiceInfo(shipment.id).then((costs) => shipmentTracking.versionCosts(costs)),
        shipmentTracking.getStatusHistory(shipment.id),
        apLedger.getShipmentCostPaymentStatus(shipment.id).catch(error => {
          // Keep original charge/invoice evidence inspectable when only the
          // derived totals require ownership review. Infrastructure errors still
          // fail the read instead of being presented as empty financial data.
          if (error instanceof apLedger.ApLedgerError && error.statusCode === 409
            && error.details?.code === "AP_SHIPMENT_BILLING_REVIEW_REQUIRED") return null;
          throw error;
        }),
        shipmentTracking.getShipmentPurchaseOrders(shipment.id),
      ]);
      res.json({ ...shipment, lines, costs, statusHistory: history, paymentStatus, purchaseOrders });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const actorId = getActorId(req);
      if (!actorId) throw new FinancialCommandError("An authenticated actor is required", 401, "SHIPMENT_CREATE_ACTOR_REQUIRED");
      if (Object.keys(req.query).length) return res.status(400).json({ code: "SHIPMENT_CREATE_QUERY_INVALID", error: "Shipment creation does not accept query parameters." });
      const descriptor = financialCommandFromRequest(req, {
        actorType: "service", actorId: SHIPMENT_CREATE_COMMAND_PRINCIPAL, ...shipmentCreateCommandScope(),
      });
      const result = await shipmentCreateCommands.execute(req.body, actorId, descriptor);
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      // Only a durable rejection proves that an earlier attempt cannot have
      // created a shipment. Middleware/auth failures cannot clear recovery.
      const body = result.terminalState === "rejected"
        ? { ...(result.body as Record<string, unknown>), details: { shipmentCreateOutcome: "rejected", idempotencyKey: descriptor.idempotencyKey } }
        : result.body;
      return res.status(result.httpStatus).json(body);
    } catch (error) {
      if (error instanceof FinancialCommandError) {
        for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
        return res.status(error.statusCode).json({ code: error.code, error: error.message, details: error.details });
      }
      console.error(JSON.stringify({ event: "procurement.shipment_create.failed", actorId: getActorId(req) ?? null,
        code: "SHIPMENT_CREATE_TRANSIENT_FAILURE", errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(500).json({ code: "SHIPMENT_CREATE_TRANSIENT_FAILURE", error: "Shipment creation could not be confirmed. Retry the saved request with the same command key." });
    }
  });

  app.patch("/api/inbound-shipments/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.updateShipment(Number(req.params.id), req.body);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_HEADER_INPUT_INVALID", error: "Invalid shipment fields", details: error.issues });
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/inbound-shipments/:id", requirePermission("purchasing", "delete"), async (req, res) => {
    try {
      await shipmentTracking.deleteShipment(Number(req.params.id));
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Status transitions

  app.post("/api/inbound-shipments/:id/book", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.book(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/in-transit", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markInTransit(Number(req.params.id), req.session.user?.id, req.body.notes, req.body.shipDate ? new Date(req.body.shipDate) : undefined);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/at-port", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markAtPort(Number(req.params.id), req.session.user?.id, req.body.notes, req.body.actualArrival ? new Date(req.body.actualArrival) : undefined);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/customs-clearance", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markCustomsClearance(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/delivered", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markDelivered(Number(req.params.id), req.session.user?.id, req.body.notes, req.body.deliveredDate ? new Date(req.body.deliveredDate) : undefined);
      if (shipment) {
        notificationService.notify("shipment_arrived", {
          title: `Shipment Delivered: ${shipment.shipmentNumber || `#${shipment.id}`}`,
          message: shipment.shipperName ? `From ${shipment.shipperName}` : undefined,
          data: { shipmentId: shipment.id },
        }).catch(() => {});
      }
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/start-costing", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.startCosting(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/close", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.close(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/cancel", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipmentId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentCostResourceIdSchema).parse(req.params.id);
      const shipment = await shipmentTracking.cancel(shipmentId, req.session.user?.id, req.body.reason);
      res.json(shipment);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_CANCELLATION_INPUT_INVALID",
        error: "Shipment ID must be a positive PostgreSQL integer." });
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({
        code: error.details?.code, error: error.message, details: error.details,
      });
      console.error(JSON.stringify({ event: "procurement.shipment.cancellation_failed", shipmentId: req.params.id,
        actorId: req.session.user?.id ?? null, code: "SHIPMENT_CANCELLATION_UNAVAILABLE",
        errorType: error instanceof Error ? error.name : typeof error }));
      res.status(503).json({ code: "SHIPMENT_CANCELLATION_UNAVAILABLE",
        error: "Shipment cancellation could not be verified. Reload the shipment before trying again." });
    }
  });

  // Shipment lines

  app.post("/api/inbound-shipments/:id/lines/unit-options", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentLineResourceIdSchema).parse(req.params.id);
      if (Object.keys(req.query).length) return res.status(400).json({ code: "SHIPMENT_UNIT_OPTIONS_INPUT_INVALID", error: "Unit preview does not accept query parameters." });
      return res.json(await readShipmentPackingUnitOptions(db, id, req.body));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_UNIT_OPTIONS_INPUT_INVALID", error: "Provide a valid shipment ID and between 1 and 500 source rows." });
      if (error instanceof ShipmentUnitOptionsError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      console.error(JSON.stringify({ event: "procurement.shipment_unit_options.failed", shipmentId: req.params.id, actorId: getActorId(req) ?? null, errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(503).json({ code: "SHIPMENT_UNIT_OPTIONS_UNAVAILABLE", error: "Receive units could not be verified. Retry the preview." });
    }
  });

  app.post("/api/inbound-shipments/:id/lines/from-po", requirePermission("purchasing", "edit"), (req, res) => handleLineCommand(req, res, "add-from-po"));
  app.post("/api/inbound-shipments/:id/lines/import-packing-list", requirePermission("purchasing", "edit"), (req, res) => handleLineCommand(req, res, "import"));
  app.post("/api/inbound-shipments/:id/lines/resolve-dimensions", requirePermission("purchasing", "edit"), (req, res) => handleLineCommand(req, res, "resolve-dimensions"));
  app.patch("/api/inbound-shipments/lines/:lineId", requirePermission("purchasing", "edit"), (req, res) => handleLineCommand(req, res, "update"));
  app.delete("/api/inbound-shipments/lines/:lineId", requirePermission("purchasing", "edit"), (req, res) => handleLineCommand(req, res, "delete"));

  // Shipment costs

  app.get("/api/inbound-shipments/:id/costs", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const costs = await apLedger.enrichCostsWithInvoiceInfo(Number(req.params.id));
      res.json(await shipmentTracking.versionCosts(costs));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/costs", requirePermission("purchasing", "edit"), (req, res) => handleCostCommand(req, res, "create"));
  app.patch("/api/inbound-shipments/costs/:costId", requirePermission("purchasing", "edit"), (req, res) => handleCostCommand(req, res, "update"));
  app.delete("/api/inbound-shipments/costs/:costId", requirePermission("purchasing", "edit"), (req, res) => handleCostCommand(req, res, "delete"));

  // Shipment cost to AP bridge

  app.get("/api/inbound-shipments/:id/cost-vendors", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const result = await apLedger.getCostVendorsForShipment(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments/:id/cost-vendors/:vendorId/costs", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const costs = await apLedger.listCostsForInvoiceCreation(
        Number(req.params.id),
        Number(req.params.vendorId),
      );
      res.json({ costs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments/:id/payment-status", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const status = await apLedger.getShipmentCostPaymentStatus(Number(req.params.id));
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments/:id/invoices", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const result = await apLedger.getShipmentInvoicesSummary(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const invoiceLinkInput = z.object({ vendorInvoiceId: shipmentCostResourceIdSchema, invoiceLineId: shipmentCostResourceIdSchema.optional() }).strict();
  const invoiceLinkId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentCostResourceIdSchema);
  async function handleInvoiceOwnership(req: Request, res: Response, action: "link" | "unlink") {
    try {
      const costId = invoiceLinkId.parse(req.params.costId);
      const actorId = req.session?.user?.id;
      if (!actorId) throw new FinancialCommandError("An authenticated operator is required", 401, "SHIPMENT_INVOICE_ACTOR_REQUIRED");
      if (Object.keys(req.query).length) throw new FinancialCommandError("Invoice ownership commands do not accept query parameters", 400, "AP_INVOICE_LINK_INPUT_INVALID");
      if (action === "link") {
        const input = invoiceLinkInput.parse(req.body);
        return res.json(await apLedger.linkCostToInvoice(costId, input.vendorInvoiceId, actorId, input.invoiceLineId));
      }
      z.object({}).strict().parse(req.body ?? {});
      return res.json({ success: true, ...await apLedger.unlinkCostFromInvoice(costId, actorId) });
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "AP_INVOICE_LINK_INPUT_INVALID", error: "Choose a valid charge, invoice and explicit invoice line." });
      if (error instanceof apLedger.ApLedgerError) return res.status(error.statusCode).json({ code: error.details?.code, error: error.message, details: error.details });
      if (error instanceof FinancialCommandError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      console.error(JSON.stringify({ event: "procurement.shipment_invoice.ownership_failed", action, costId: req.params.costId,
        actorId: req.session?.user?.id ?? null, code: "AP_INVOICE_OWNERSHIP_UNAVAILABLE", errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(503).json({ code: "AP_INVOICE_OWNERSHIP_UNAVAILABLE", error: "Invoice ownership could not be confirmed. Reload the shipment before retrying." });
    }
  }
  app.post("/api/inbound-shipments/costs/:costId/link-invoice", requireAuth, requirePermission("purchasing", "edit"), (req, res) => handleInvoiceOwnership(req, res, "link"));
  app.post("/api/inbound-shipments/costs/:costId/unlink-invoice", requireAuth, requirePermission("purchasing", "edit"), (req, res) => handleInvoiceOwnership(req, res, "unlink"));

  // Allocation

  const costWorkflowId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentCostWorkflowIdSchema);

  app.get("/api/inbound-shipments/:id/cost-review", requirePermission("purchasing", "view"), async (req, res) => {
    const id = costWorkflowId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ code: "SHIPMENT_COST_UPDATE_ID_INVALID", error: "Choose a valid shipment." });
    try {
      const result = await shipmentTracking.getCostReview(id.data);
      if (!result) return res.status(404).json({ code: "SHIPMENT_NOT_FOUND", error: "This shipment is no longer available." });
      res.vary("X-Shipment-Cost-Review-Version");
      return res.json(shipmentCostReviewResponse(result,req.get("X-Shipment-Cost-Review-Version")));
    } catch (error) {
      console.error(JSON.stringify({ event: "procurement.shipment_cost.review_failed", shipmentId: id.data,
        actorId: getActorId(req) ?? null, code: "SHIPMENT_COST_REVIEW_UNAVAILABLE",
        errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(500).json({ code: "SHIPMENT_COST_REVIEW_UNAVAILABLE", error: "Saved cost results could not be loaded. Reload the cost review." });
    }
  });

  app.post("/api/inbound-shipments/:id/update-costs", requirePermission("purchasing", "approve"), async (req, res) => {
    const id = costWorkflowId.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ code: "SHIPMENT_COST_UPDATE_ID_INVALID", error: "Choose a valid shipment." });
    try {
      const shipmentId = id.data;
      const actorId = getActorId(req);
      if (!actorId) throw new FinancialCommandError("Sign in before updating costs.", 401, "SHIPMENT_COST_UPDATE_ACTOR_REQUIRED");
      const descriptor = financialCommandFromRequest(req, {
        actorType: "service", actorId: SHIPMENT_COST_UPDATE_PRINCIPAL, ...shipmentCostUpdateScope(shipmentId),
      });
      const result = await shipmentCostUpdates.execute(shipmentId, req.body, actorId, descriptor);
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      return res.status(result.httpStatus).json(result.body);
    } catch (error) {
      if (error instanceof FinancialCommandError) {
        for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
        return res.status(error.statusCode).json({ code: error.code, error: error.message, details: error.details });
      }
      const cause = error instanceof Error ? error.cause ?? error : error;
      const databaseCode = cause && typeof cause === "object" && "code" in cause
        && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code) ? cause.code : null;
      console.error(JSON.stringify({ event: "procurement.shipment_cost.update_failed", shipmentId: req.params.id,
        actorId: getActorId(req) ?? null, code: "SHIPMENT_COST_UPDATE_FAILED", databaseCode,
        errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(500).json({ code: "SHIPMENT_COST_UPDATE_FAILED",
        error: "The cost update could not be completed. Reload the saved results and retry." });
    }
  });

  app.get("/api/inbound-shipments/:id/allocation-status", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const result = await shipmentTracking.getAllocationStatus(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/allocate", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const result = await shipmentTracking.runAllocation(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/finalize", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const result = await shipmentTracking.finalizeAllocations(Number(req.params.id), req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Cross-references

  app.get("/api/purchase-orders/:id/shipments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipmentsList = await shipmentTracking.getShipmentsByPo(Number(req.params.id));
      res.json(shipmentsList);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/push-costs-to-lots", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const result = await shipmentTracking.pushLandedCostsToLots(Number(req.params.id), req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });


}
import { shipmentCostReviewResponse } from "@shared/procurement/shipment-cost-review-version";
