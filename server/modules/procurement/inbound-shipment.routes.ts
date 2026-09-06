import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { createShipmentLineCommands, shipmentLineCommandScope, SHIPMENT_LINE_COMMAND_PRINCIPAL, type ShipmentLineCommand } from "./shipment-line-commands";
import type { Express, Request, Response } from "express";
import { createShipmentCostCommands, shipmentCostCommandScope, SHIPMENT_COST_COMMAND_PRINCIPAL, type ShipmentCostCommand } from "./shipment-cost-commands";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { z } from "zod";
import { shipmentCostResourceIdSchema } from "@shared/procurement/shipment-cost-command";
import { requirePermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import * as apLedger from "./ap-ledger.service";
import * as notificationService from "../notifications/notifications.service";

function getActorId(req: any): string | undefined {
  return req.user?.id ?? req.session?.user?.id;
}

export function registerInboundShipmentRoutes(app: Express) {
  const { shipmentTracking } = app.locals.services;
  const shipmentCostCommands = createShipmentCostCommands(shipmentTracking);
  const shipmentLineCommands = createShipmentLineCommands(shipmentTracking);

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
      return res.status(result.httpStatus).json(result.body);
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
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.status) filters.status = (req.query.status as string).includes(",") ? (req.query.status as string).split(",") : req.query.status;
      if (req.query.mode) filters.mode = req.query.mode;
      if (req.query.search) filters.search = req.query.search;
      if (req.query.warehouseId) filters.warehouseId = Number(req.query.warehouseId);
      if (req.query.limit) filters.limit = Number(req.query.limit);
      if (req.query.offset) filters.offset = Number(req.query.offset);

      const [shipmentsList, total] = await Promise.all([
        shipmentTracking.getShipments(filters),
        shipmentTracking.getShipmentsCount(filters),
      ]);
      res.json({ shipments: shipmentsList, total });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.getShipment(Number(req.params.id));
      const [lines, costs, history, paymentStatus] = await Promise.all([
        shipmentTracking.getEnrichedLines(shipment.id),
        shipmentTracking.getCosts(shipment.id),
        shipmentTracking.getStatusHistory(shipment.id),
        apLedger.getShipmentCostPaymentStatus(shipment.id),
      ]);
      res.json({ ...shipment, lines, costs, statusHistory: history, paymentStatus });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.createShipment(req.body, req.session.user?.id);
      res.status(201).json(shipment);
    } catch (error: any) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_HEADER_INPUT_INVALID", error: "Invalid shipment fields", details: error.issues });
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
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
      const shipment = await shipmentTracking.cancel(Number(req.params.id), req.session.user?.id, req.body.reason);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Shipment lines

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

  app.post("/api/inbound-shipments/:id/create-invoice", requirePermission("purchasing", "edit"), requireIdempotency(), async (req, res) => {
    try {
      const { vendorId, invoiceNumber, invoiceDate, dueDate, costRowIds, lineOverrides, notes } = req.body;
      if (!vendorId) return res.status(400).json({ error: "vendorId is required" });
      if (!invoiceNumber) return res.status(400).json({ error: "invoiceNumber is required" });
      const invoice = await apLedger.createInvoiceFromShipmentCosts(
        Number(req.params.id),
        {
          vendorId,
          invoiceNumber,
          invoiceDate: invoiceDate ? new Date(invoiceDate) : undefined,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          costRowIds,
          lineOverrides,
          notes,
        },
        getActorId(req),
      );
      res.json(invoice);
    } catch (error: any) {
      if (error instanceof apLedger.ApLedgerError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

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

  app.post("/api/inbound-shipments/costs/:costId/link-invoice", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendorInvoiceId } = req.body;
      if (!vendorInvoiceId) return res.status(400).json({ error: "vendorInvoiceId required" });
      const result = await apLedger.linkCostToInvoice(
        Number(req.params.costId),
        vendorInvoiceId,
        getActorId(req),
      );
      res.json(result);
    } catch (error: any) {
      if (error instanceof apLedger.ApLedgerError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/costs/:costId/unlink-invoice", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const result = await apLedger.unlinkCostFromInvoice(
        Number(req.params.costId),
        getActorId(req),
      );
      res.json({ success: true, ...result });
    } catch (error: any) {
      if (error instanceof apLedger.ApLedgerError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Allocation

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
      const result = await shipmentTracking.pushLandedCostsToLots(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });


}
