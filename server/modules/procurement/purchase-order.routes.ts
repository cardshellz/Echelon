import { registerPurchaseOrderEntryRoutes } from "./purchase-order-entry.routes";
import { parseNullableDateInput } from "./purchase-order-entry-input";
import { getPurchaseOrderWorkList } from "./purchase-order-work-list.service";
import { purchaseApprovalCommandScope } from "./purchase-approval.commands";
import { purchaseApprovalLinesFingerprint } from "./purchase-approval-review";
import { getPurchaseOrderList, PurchaseOrderListQueryError } from "./purchase-order-list.service";
import { procurementSettingsCommands, PROCUREMENT_SETTINGS_COMMAND_SCOPE } from "./procurement-settings.commands";
import type { Express, Request, Response } from "express";
import { registerPoVarianceApprovalRoutes } from './po-variance-approval.routes';
import { registerPoQuantityAmendmentRoutes } from './po-quantity-amendment.routes';
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission, requireAnyPermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import { PurchasingError } from "./purchasing.service";
import { ReceivingUnitError } from "./receiving-unit-contract";
import { DocumentNumberError } from "../../platform/document-numbering/document-number";
import * as poExceptionsService from "./po-exceptions.service";
import { PoExceptionError } from "./po-exceptions.service";
import * as apLedger from "./ap-ledger.service";
import { renderPoHtml } from "./po-document";
import { buildSupplierPoDocument, SupplierPoDocumentError } from "./supplier-po-document";
import { loadSupplierPoDocumentSource } from "./supplier-po-document.repository";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { createPurchaseWorkspaceRepository } from "./purchase-workspace.repository";
import { createPoFinancialEvidenceService } from "./po-financial-evidence.service";
import { poFinancialWorkflowSchema } from "@shared/procurement/po-financial-workflow";
import { logger } from "../../platform/observability/logger";
import { getShippablePurchaseOrderLines, ShipmentSourceCapacityError } from "./shipment-source-capacity";
import { shipmentLineResourceIdSchema } from "@shared/procurement/shipment-line-command";
import { createPurchaseWorkspaceService, PurchaseWorkspaceError } from "./purchase-workspace.service";
import { z } from "zod";
import { shipmentReceiptPlanRequestSchema } from "@shared/procurement/shipment-receipt-plan";
import { users as identityUsers } from "../../storage/base";
import {
  buildPoAutoDraftActionPlan,
  buildPoLifecycleSummary,
  type PoLifecycleCommand,
} from "./purchase-order-lifecycle.service";
import { purchaseOrderDraftHeaderPatchSchema } from "./purchase-order-draft-header";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import {
  FinancialCommandError,
  type FinancialCommandResult,
} from "../../platform/commands/transactional-command.service";
import {
  enqueuePurchaseOrderEmail,
  listPurchaseOrderEmailDeliveries,
  PoEmailOutboxError,
  replayDeadLetterPurchaseOrderEmail,
} from "./po-email-outbox.service";

const poEmailRequestSchema = z.object({
  toEmail: z.string().trim().email().max(320),
  ccEmail: z.string().trim().email().max(320).optional(),
  message: z.string().trim().max(10_000).optional(),
}).strict();

function sendShipmentReceiptError(res: Response, error: unknown, shipmentId: unknown, operation: string): Response {
  if (error instanceof PurchasingError || error instanceof ReceivingUnitError) {
    logger.warn("procurement.shipment_receipt.rejected", { shipmentId, operation, code: error.details?.code, message: error.message });
    return res.status(error.statusCode).json({ error: error.message, details: error.details });
  }
  logger.error("procurement.shipment_receipt.failed", { shipmentId, operation, error_class: error instanceof Error ? error.name : typeof error });
  return res.status(500).json({ error: "The shipment receipt could not be prepared. Refresh and try again." });
}

function getRequiredIdempotencyKey(req: Request): string {
  const value = req.get("Idempotency-Key");
  if (!value || value.length < 8 || value.length > 200) {
    throw new PoEmailOutboxError(
      "Idempotency-Key header must be between 8 and 200 characters",
      400,
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  return value;
}

function parsePositivePoEmailId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PoEmailOutboxError(`${label} must be a positive integer`, 400, "INVALID_ID");
  }
  return id;
}

function sendPoEmailOutboxError(res: Response, error: unknown): Response {
  if (error instanceof PoEmailOutboxError || error instanceof SupplierPoDocumentError) {
    return res.status(error.statusCode).json({
      error: error.message,
      details: { code: error.code, ...(error instanceof SupplierPoDocumentError ? { context: error.context } : {}) },
    });
  }
  const message = error instanceof Error ? error.message : "Email delivery request failed";
  return res.status(500).json({ error: message });
}

function sendFinancialCommandResult(res: any, result: FinancialCommandResult): any {
  res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
  return res.status(result.httpStatus).json(result.body);
}

function sendFinancialCommandError(res: any, error: FinancialCommandError): any {
  for (const [name, value] of Object.entries(error.responseHeaders ?? {})) {
    res.setHeader(name, value);
  }
  return res.status(error.statusCode).json({
    error: error.message,
    details: { code: error.code, ...(error.details ?? {}) },
  });
}

export function registerPurchaseOrderRoutes(app: Express, financialEvidence: Pick<ReturnType<typeof createPoFinancialEvidenceService>, "readWorkflow"> = createPoFinancialEvidenceService(db)) {
  registerPurchaseOrderEntryRoutes(app);
  registerPoQuantityAmendmentRoutes(app);
  registerPoVarianceApprovalRoutes(app);
  const { purchasing, shipmentTracking } = app.locals.services;
  const purchaseWorkspace = createPurchaseWorkspaceService(createPurchaseWorkspaceRepository(db));

  const withLifecycle = (po: any) => ({
    ...po,
    lifecycle: buildPoLifecycleSummary(po),
  });

  const buildLifecycleCommandInput = (req: any) => {
    const input: Record<string, unknown> = {};
    if (req.body?.notes !== undefined) input.notes = req.body.notes;
    if (req.body?.confirmedSentExternally !== undefined) input.confirmedSentExternally = req.body.confirmedSentExternally;
    if (req.body?.expectedUpdatedAt !== undefined) input.expectedUpdatedAt = req.body.expectedUpdatedAt;
    if (req.body?.expectedTotalCents !== undefined) input.expectedTotalCents = req.body.expectedTotalCents;
    if (req.body?.expectedLinesFingerprint !== undefined) input.expectedLinesFingerprint = req.body.expectedLinesFingerprint;
    if (req.body?.reason !== undefined) input.reason = req.body.reason;
    if (req.body?.vendorRefNumber !== undefined) input.vendorRefNumber = req.body.vendorRefNumber;
    if (req.body?.confirmedDeliveryDate !== undefined) {
      const confirmedDeliveryDate = parseNullableDateInput(
        req.body.confirmedDeliveryDate,
        "confirmedDeliveryDate",
      );
      if (confirmedDeliveryDate) input.confirmedDeliveryDate = confirmedDeliveryDate;
    }
    return input;
  };

  const handleLifecycleCommand = async (req: any, res: any, command: PoLifecycleCommand) => {
    try {
      const result = await purchasing.executeLifecycleCommand(
        Number(req.params.id),
        command,
        buildLifecycleCommandInput(req),
        req.session.user?.id,
      );
      if (command === "create_receipt") {
        res.status((result as any)?.reusedExisting ? 200 : 201).json(result);
        return;
      }
      res.json(result);
    } catch (error: any) {
      if (error instanceof DocumentNumberError) {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      res.status(500).json({ error: error.message });
    }
  };

  // PO CRUD

  app.get("/api/purchase-orders", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const statusFilter = (value: unknown): string | string[] | undefined => {
        if (value === undefined) return undefined;
        const values = typeof value === "string" ? value.split(",")
          : Array.isArray(value) && value.every(entry => typeof entry === "string") ? value.flatMap(entry => entry.split(","))
            : null;
        if (!values || values.length === 0 || values.some(value => value.length === 0)) throw new PurchaseOrderListQueryError();
        return values.length === 1 ? values[0] : values;
      };
      // Support ?status=sent&status=acknowledged or ?status=sent,acknowledged
      const filters = {
        status: statusFilter(req.query.status),
        physicalStatus: statusFilter(req.query.physical_status),
        financialStatus: statusFilter(req.query.financial_status),
        financialWorkflow: req.query.financial_workflow,
        vendorId: req.query.vendorId ? Number(req.query.vendorId) : undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };
      const [page, allVendors] = await Promise.all([
        getPurchaseOrderList(filters),
        storage.getAllVendors(),
      ]);
      const { purchaseOrders: pos, total: count } = page;
      const vendorMap = new Map(allVendors.map((v: any) => [v.id, v]));

      // Attach open exception counts to each PO (parallel, no N+1).
      const exceptionCounts = await Promise.all(
        pos.map((po: any) => poExceptionsService.countOpenExceptions(po.id)),
      );

      const enriched = pos.map((po: any, i: number) => ({
        ...withLifecycle(po),
        vendor: vendorMap.get(po.vendorId) || null,
        openExceptionCount: exceptionCounts[i].count,
        maxOpenSeverity: exceptionCounts[i].maxSeverity,
      }));
      res.json({ purchaseOrders: enriched, total: count });
    } catch (error: any) {
      if (error instanceof PurchaseOrderListQueryError) return res.status(400).json({ error: "Invalid purchase order list filters or page", code: "PO_LIST_QUERY_INVALID" });
      logger.error("procurement.purchase_order_list", { error_class: error instanceof Error ? error.name : typeof error });
      res.status(503).json({ error: "Purchase order financial evidence could not be verified. Retry the list.", code: "PURCHASE_ORDER_LIST_UNAVAILABLE" });
    }
  });

  app.get("/api/purchase-orders/work-list", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await getPurchaseOrderWorkList(req.query)); }
    catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "PO_WORK_LIST_QUERY_INVALID", error: "Invalid purchase order selection filters or page." });
      console.error(JSON.stringify({ event: "procurement.po_work_list.failed", errorType: error instanceof Error ? error.name : typeof error }));
      res.status(500).json({ code: "PO_WORK_LIST_UNAVAILABLE", error: "Purchase order selection could not be verified. Retry the list." });
    }
  });

  // Spec A: preload endpoint for the new-PO editor. MUST be registered before
  // /api/purchase-orders/:id so Express doesn't match 'new-preload' as an id.
  app.get("/api/purchase-orders/new-preload", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorId = req.query.vendor_id ? Number(req.query.vendor_id) : undefined;
      const duplicateFrom = req.query.duplicate_from ? Number(req.query.duplicate_from) : undefined;
      let variantIds: number[] | undefined;
      if (req.query.variant_ids) {
        const raw = String(req.query.variant_ids);
        variantIds = raw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
      }
      const preload = await purchasing.getNewPoPreload({ vendorId, variantIds, duplicateFrom });
      res.json(preload);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/workspace", requirePermission("purchasing", "view"), async (req, res) => {
    const parsedId = z.string().regex(/^[1-9]\d*$/).transform(Number)
      .refine(Number.isSafeInteger).safeParse(req.params.id);
    if (!parsedId.success) {
      return res.status(400).json({
        code: "PURCHASE_WORKSPACE_ID_INVALID",
        error: "Purchase ID must be a positive safe integer.",
      });
    }
    try {
      res.json(await purchaseWorkspace.getPurchaseWorkspace(parsedId.data));
    } catch (error) {
      const statusCode = error instanceof PurchaseWorkspaceError ? error.statusCode : 500;
      const code = error instanceof PurchaseWorkspaceError ? error.code : "PURCHASE_WORKSPACE_READ_FAILED";
      const databaseError = error instanceof Error ? error.cause ?? error : error;
      const databaseCode = databaseError && typeof databaseError === "object" && "code" in databaseError
        && typeof databaseError.code === "string" && /^[A-Z0-9]{5}$/.test(databaseError.code)
        ? databaseError.code : null;
      console.error(JSON.stringify({
        event: "procurement.purchase_workspace.read_failed",
        code,
        purchaseOrderId: parsedId.data,
        errorType: error instanceof Error ? error.name : typeof error,
        databaseCode,
        message: error instanceof PurchaseWorkspaceError ? error.message : "Unexpected workspace read failure.",
      }));
      res.status(statusCode).json({
        code,
        error: error instanceof PurchaseWorkspaceError ? error.message : "Unable to load the purchase workspace.",
      });
    }
  });

  app.get("/api/purchase-orders/:id/shipment-cost-summary",requirePermission("purchasing","view"),async(req,res)=>{
    const parsed=z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)).safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({error:"Invalid purchase order ID"});
    try {
      const summary=await purchasing.getPoShipmentCostSummary(parsed.data);
      if (!summary) return res.status(404).json({error:"Purchase order not found"});
      res.json(summary);
    } catch (error:unknown) {
      console.error(JSON.stringify({event:"procurement.po_shipment_cost_summary_failed",poId:parsed.data,
        errorType:error instanceof Error?error.name:"unknown"}));
      res.status(500).json({error:"Shipment costs could not be loaded. Retry to load the latest costs."});
    }
  });

  app.get("/api/purchase-orders/:id/shipment-costs", requirePermission("purchasing", "view"), async (req, res) => {
    const parsed = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentLineResourceIdSchema).safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ code: "INVALID_PURCHASE_ORDER_ID", error: "Invalid purchase order ID" });
    try {
      const costs = await purchasing.getPoShipmentCosts(parsed.data);
      if (!costs) return res.status(404).json({ code: "PURCHASE_ORDER_NOT_FOUND", error: "Purchase order not found" });
      res.vary("X-Shipment-Cost-Review-Version");
      res.vary("X-Purchase-Order-Line-Cost-Version");
      res.json(shipmentCostReviewResponse(costs,req.get("X-Shipment-Cost-Review-Version"),req.get("X-Purchase-Order-Line-Cost-Version") === "1"));
    } catch (error: unknown) {
      console.error(JSON.stringify({ event: "procurement.po_shipment_costs_failed", poId: parsed.data,
        errorType: error instanceof Error ? error.name : "unknown" }));
      res.status(500).json({ code: "SHIPMENT_COSTS_UNAVAILABLE", error: "Shipment costs and review details could not be loaded. Retry to load the latest records." });
    }
  });

  app.get("/api/purchase-orders/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const po = await purchasing.getPurchaseOrderById(Number(req.params.id));
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const [lines, vendor, exceptionCount, history, exceptions, workflowResult] = await Promise.all([
        purchasing.getPurchaseOrderLines(po.id),
        storage.getVendorById(po.vendorId),
        poExceptionsService.countOpenExceptions(po.id),
        purchasing.getPoStatusHistory(po.id),
        poExceptionsService.listExceptions(po.id, { includeResolved: true }),
        financialEvidence.readWorkflow(po.id),
      ]);

      if (!workflowResult) return res.status(404).json({ error: "Purchase order not found", code: "PO_NOT_FOUND" });
      const financialWorkflow = poFinancialWorkflowSchema.parse(workflowResult);
      if (financialWorkflow.purchaseOrderId !== po.id) throw new Error("Purchase order financial workflow identity mismatch");

      // Collect all distinct user IDs referenced on this PO for client-side
      // display. Prefixed actor strings (system, cron:*, agent:*) are passed
      // through unchanged by formatActor on the client - exclude them here.
      const NON_UUID_PREFIX = /^(system|cron:|agent:)/;
      const actorIds = new Set<string>();
      const addActor = (id: string | null | undefined) => {
        if (id && !NON_UUID_PREFIX.test(id)) actorIds.add(id);
      };

      // PO-level actor fields
      addActor((po as any).createdBy);
      addActor((po as any).cancelledBy);
      addActor((po as any).approvedBy);
      addActor((po as any).closedBy);
      addActor((po as any).updatedBy);

      // Status history actors
      for (const h of history) {
        addActor((h as any).changedBy);
      }

      // Exception actors
      for (const ex of exceptions) {
        addActor((ex as any).detectedBy);
        addActor((ex as any).acknowledgedBy);
        addActor((ex as any).resolvedBy);
      }

      // Single batch query - no N+1
      let relatedUsers: Record<string, { username: string; displayName: string | null }> = {};
      if (actorIds.size > 0) {
        const rows = await db
          .select({ id: identityUsers.id, username: identityUsers.username, displayName: identityUsers.displayName })
          .from(identityUsers)
          .where(inArray(identityUsers.id, [...actorIds]));
        for (const row of rows) {
          relatedUsers[row.id] = { username: row.username, displayName: row.displayName };
        }
      }

      res.json({
        ...withLifecycle({ ...po, financialWorkflow }),
        lines,
        approvalLinesFingerprint: purchaseApprovalLinesFingerprint(lines),
        vendor,
        openExceptionCount: exceptionCount.count,
        maxOpenSeverity: exceptionCount.maxSeverity,
        financialWorkflow,
        autoDraftActionPlan: buildPoAutoDraftActionPlan(po, {
          financialWorkflow,
          lineCount: lines.length,
          openExceptionCount: exceptionCount.count,
        }),
        relatedUsers,
      });
    } catch (error: unknown) {
      logger.error("procurement.purchase_order_detail", { outcome: "failed", purchase_order_id: req.params.id,
        error_code: "PURCHASE_ORDER_DETAIL_UNAVAILABLE", error_class: error instanceof Error ? error.name : "UnknownError" });
      res.status(503).json({ code: "PURCHASE_ORDER_DETAIL_UNAVAILABLE", error: "Purchase order details and financial review could not be loaded. Retry to load the current records." });
    }
  });

  app.get(
    "/api/settings/procurement",
    requireAnyPermission(["purchasing", "view"], ["settings", "edit"]),
    async (_req, res) => {
      try {
        res.json(await purchasing.getProcurementSettings());
      } catch (error: unknown) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message, details: error.details });
        }
        console.error(JSON.stringify({ event: "procurement.settings.read_failed", errorType: error instanceof Error ? error.name : typeof error }));
        return res.status(500).json({ error: "Procurement settings could not be loaded.", code: "PROCUREMENT_SETTINGS_READ_FAILED" });
      }
    },
  );

  app.patch(
    "/api/settings/procurement",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const descriptor = financialCommandFromRequest(req, {
          ...PROCUREMENT_SETTINGS_COMMAND_SCOPE,
          actorId: req.session.user?.id,
        });
        const result = await procurementSettingsCommands.update(req.body, descriptor.actorId, descriptor);
        return sendFinancialCommandResult(res, result);
      } catch (error: unknown) {
        if (error instanceof FinancialCommandError) return sendFinancialCommandError(res, error);
        console.error(JSON.stringify({ event: "procurement.settings.command_failed", actorId: req.session.user?.id, errorType: error instanceof Error ? error.name : typeof error }));
        return res.status(500).json({ error: "Procurement settings could not be saved. Retry the same command.", code: "PROCUREMENT_SETTINGS_COMMAND_FAILED" });
      }
    },
  );

  app.patch("/api/purchase-orders/:id/delivery-schedule", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const hasExpectedCamel = Object.prototype.hasOwnProperty.call(req.body ?? {}, "expectedDeliveryDate");
      const hasExpectedSnake = Object.prototype.hasOwnProperty.call(req.body ?? {}, "expected_delivery_date");
      const hasConfirmedCamel = Object.prototype.hasOwnProperty.call(req.body ?? {}, "confirmedDeliveryDate");
      const hasConfirmedSnake = Object.prototype.hasOwnProperty.call(req.body ?? {}, "confirmed_delivery_date");
      const expectedRaw = hasExpectedCamel
        ? req.body.expectedDeliveryDate
        : hasExpectedSnake
          ? req.body.expected_delivery_date
          : undefined;
      const confirmedRaw = hasConfirmedCamel
        ? req.body.confirmedDeliveryDate
        : hasConfirmedSnake
          ? req.body.confirmed_delivery_date
          : undefined;
      const po = await purchasing.updateDeliverySchedule(
        Number(req.params.id),
        {
          expectedDeliveryDate: parseNullableDateInput(expectedRaw, "expectedDeliveryDate"),
          confirmedDeliveryDate: parseNullableDateInput(confirmedRaw, "confirmedDeliveryDate"),
          notes: typeof req.body?.notes === "string" ? req.body.notes : undefined,
        },
        req.session.user?.id,
      );
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchase-orders/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new PurchasingError("Purchase order id must be a positive integer", 400, {
          code: "INVALID_PURCHASE_ORDER_ID",
        });
      }

      const parsed = purchaseOrderDraftHeaderPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new PurchasingError("Invalid draft purchase order header update", 400, {
          code: "INVALID_PO_DRAFT_HEADER_PATCH",
          issues: parsed.error.issues,
        });
      }

      const po = await purchasing.updatePO(id, parsed.data, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Incoterms, tolerance, and header charges are approval inputs and are
  // therefore editable only while the PO is a financially clean draft.
  app.patch("/api/purchase-orders/:id/incoterms-charges", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { incoterms, discountCents, taxCents, shippingCostCents, overReceiptTolerancePct } = req.body;
      const po = await purchasing.updateIncotermsAndCharges(
        Number(req.params.id),
        { incoterms, discountCents, taxCents, shippingCostCents, overReceiptTolerancePct },
        req.session.user?.id,
      );
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) {
        return res.status(error.statusCode).json({ error: error.message, details: error.details });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchase-orders/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await purchasing.deletePO(Number(req.params.id));
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      res.status(500).json({ error: error.message });
    }
  });

  // PO Lines

  app.get("/api/purchase-orders/:id/lines", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const lines = await purchasing.getPurchaseOrderLines(Number(req.params.id));
      res.json({ lines });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Indicative source-capacity snapshot. Mutation commands repeat the same
  // calculation under shipment/PO locks before accepting quantities.
  app.get("/api/purchase-orders/:id/shippable-lines", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const poId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentLineResourceIdSchema).parse(req.params.id);
      res.json(await getShippablePurchaseOrderLines(db, poId));
    } catch (error) {
      if (error instanceof z.ZodError) return res.status(400).json({ code: "SHIPMENT_LINE_SOURCE_IDS_INVALID", error: "Purchase order ID must be a positive PostgreSQL integer." });
      if (error instanceof ShipmentSourceCapacityError) return res.status(error.statusCode).json({ code: error.details.code, error: error.message, details: error.details });
      console.error(JSON.stringify({ event: "procurement.shipment_source.read_failed", purchaseOrderId: req.params.id, errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(500).json({ code: "SHIPMENT_LINE_SOURCE_READ_FAILED", error: "Shipment source quantities could not be loaded. Refresh and try again." });
    }
  });

  app.post("/api/purchase-orders/:id/lines", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const purchaseOrderId = Number(req.params.id);
      const descriptor = financialCommandFromRequest(req, {
        actorId: req.session.user?.id,
        routeTemplate: "/api/purchase-orders/:id/lines",
        resourceKey: `purchase_order:${purchaseOrderId}`,
        commandName: "purchase_order.line.add",
      });
      const result = await purchasing.addLineCommand(
        purchaseOrderId,
        req.body,
        req.session.user?.id,
        descriptor,
      );
      return sendFinancialCommandResult(res, result);
    } catch (error: any) {
      if (error instanceof FinancialCommandError) return sendFinancialCommandError(res, error);
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/lines/bulk", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const purchaseOrderId = Number(req.params.id);
      const descriptor = financialCommandFromRequest(req, {
        actorId: req.session.user?.id,
        routeTemplate: "/api/purchase-orders/:id/lines/bulk",
        resourceKey: `purchase_order:${purchaseOrderId}`,
        commandName: "purchase_order.line.bulk_add",
      });
      const result = await purchasing.addBulkLinesCommand(
        purchaseOrderId,
        req.body,
        req.session.user?.id,
        descriptor,
      );
      return sendFinancialCommandResult(res, result);
    } catch (error: any) {
      if (error instanceof FinancialCommandError) return sendFinancialCommandError(res, error);
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      return res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchase-orders/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lineId = Number(req.params.lineId);
      const descriptor = financialCommandFromRequest(req, {
        actorId: req.session.user?.id,
        routeTemplate: "/api/purchase-orders/lines/:lineId",
        resourceKey: `purchase_order_line:${lineId}`,
        commandName: "purchase_order.line.update",
      });
      const result = await purchasing.updateLineCommand(
        lineId,
        req.body,
        req.session.user?.id,
        descriptor,
      );
      return sendFinancialCommandResult(res, result);
    } catch (error: any) {
      if (error instanceof FinancialCommandError) return sendFinancialCommandError(res, error);
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      return res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchase-orders/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lineId = Number(req.params.lineId);
      const descriptor = financialCommandFromRequest(req, {
        actorId: req.session.user?.id,
        routeTemplate: "/api/purchase-orders/lines/:lineId",
        resourceKey: `purchase_order_line:${lineId}`,
        commandName: "purchase_order.line.cancel",
      });
      const result = await purchasing.cancelLineCommand(
        lineId,
        req.body,
        req.session.user?.id,
        descriptor,
      );
      return sendFinancialCommandResult(res, result);
    } catch (error: any) {
      if (error instanceof FinancialCommandError) return sendFinancialCommandError(res, error);
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      return res.status(500).json({ error: error.message });
    }
  });

  // Status Transitions

  app.post("/api/purchase-orders/:id/submit", requirePermission("purchasing", "create"), async (req, res) => {
    await handleLifecycleCommand(req, res, "submit");
  });

  app.post("/api/purchase-orders/:id/return-to-draft", requirePermission("purchasing", "edit"), async (req, res) => {
    await handleLifecycleCommand(req, res, "return_to_draft");
  });

  app.post("/api/purchase-orders/:id/approve", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      if (Object.keys(req.query).length) return res.status(400).json({ code: "PO_APPROVAL_QUERY_INVALID", error: "Purchase approval does not accept query parameters." });
      const id = Number(req.params.id);
      const descriptor = financialCommandFromRequest(req, purchaseApprovalCommandScope(id));
      const result = await purchasing.approveCommand(id, req.body, descriptor.actorId, descriptor);
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      const body = result.terminalState === "rejected"
        ? { ...(result.body as Record<string, unknown>), details: { ...((result.body as any)?.details ?? {}), purchaseApprovalOutcome: "rejected", idempotencyKey: descriptor.idempotencyKey } }
        : result.body;
      return res.status(result.httpStatus).json(body);
    } catch (error) {
      if (error instanceof FinancialCommandError) return sendFinancialCommandError(res, error);
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message, details: error.details });
      console.error(JSON.stringify({ event: "procurement.approval.command_failed", purchaseOrderId: req.params.id, errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(500).json({ code: "PO_APPROVAL_TRANSIENT_FAILURE", error: "Purchase approval could not be confirmed. Recover the saved request." });
    }
  });

  app.post("/api/purchase-orders/:id/send", requirePermission("purchasing", "create"), async (req, res) => {
    await handleLifecycleCommand(req, res, "send");
  });

  // Phase 3 physical-status transitions. Routes delegate through the shared
  // lifecycle command boundary; the service validates the state machine and
  // returns 400/409 on invalid moves. PurchasingError.statusCode is forwarded.

  app.post("/api/purchase-orders/:id/mark-shipped", requirePermission("purchasing", "edit"), async (req, res) => {
    await handleLifecycleCommand(req, res, "mark_shipped");
  });

  app.post("/api/purchase-orders/:id/mark-in-transit", requirePermission("purchasing", "edit"), async (req, res) => {
    await handleLifecycleCommand(req, res, "mark_in_transit");
  });

  app.post("/api/purchase-orders/:id/mark-arrived", requirePermission("purchasing", "edit"), async (req, res) => {
    await handleLifecycleCommand(req, res, "mark_arrived");
  });

  app.post("/api/purchase-orders/:id/acknowledge", requirePermission("purchasing", "edit"), async (req, res) => {
    await handleLifecycleCommand(req, res, "acknowledge");
  });

  app.post("/api/purchase-orders/:id/cancel", requireAnyPermission(["purchasing", "cancel"], ["purchasing", "approve"]), async (req, res) => {
    await handleLifecycleCommand(req, res, "cancel");
  });

  app.post("/api/purchase-orders/:id/void", requireAnyPermission(["purchasing", "cancel"], ["purchasing", "approve"]), async (req, res) => {
    await handleLifecycleCommand(req, res, "cancel");
  });

  app.post("/api/purchase-orders/:id/close", requirePermission("purchasing", "create"), async (req, res) => {
    await handleLifecycleCommand(req, res, "close");
  });

  app.post("/api/purchase-orders/:id/close-short", requirePermission("purchasing", "approve"), async (req, res) => {
    await handleLifecycleCommand(req, res, "close_short");
  });

  // PO / Receiving

  app.post("/api/purchase-orders/:id/create-receipt", requirePermission("inventory", "receive"), requireIdempotency(), async (req, res) => {
    await handleLifecycleCommand(req, res, "create_receipt");
  });

  app.get("/api/purchase-orders/:id/receive-options", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const poId = Number(req.params.id);
      if (!Number.isInteger(poId) || poId <= 0) {
        return res.status(400).json({ error: "Invalid purchase order id" });
      }
      const options = await purchasing.getPurchaseOrderReceiveOptions(poId);
      res.json(options);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json({ error: error?.message || "Failed to load receive options" });
    }
  });

  app.get("/api/inbound-shipments/:id/receipt-pack-resolution", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipmentId = Number(req.params.id);
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        return res.status(400).json({ error: "Invalid shipment id" });
      }
      const rawPurchaseOrderId = req.query.purchaseOrderId ?? req.query.purchase_order_id;
      const purchaseOrderId = rawPurchaseOrderId === undefined ? undefined : Number(rawPurchaseOrderId);
      if (purchaseOrderId !== undefined && (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0)) {
        return res.status(400).json({ error: "Invalid purchase order id" });
      }
      const resolution = await purchasing.getShipmentReceiptPackResolution(shipmentId, { purchaseOrderId });
      res.json(resolution);
    } catch (error: any) {
      sendShipmentReceiptError(res, error, req.params.id, "preview");
    }
  });

  // Preview explicit product configurations without changing cartons, PO terms,
  // inventory or catalog records. Creation revalidates the same choices under locks.
  app.post("/api/inbound-shipments/:id/receipt-pack-resolution", requirePermission("purchasing", "view"), async (req, res) => {
    const shipmentId = shipmentLineResourceIdSchema.safeParse(Number(req.params.id));
    const input = shipmentReceiptPlanRequestSchema.safeParse(req.body);
    if (!shipmentId.success || !input.success) return res.status(400).json({ error: "Invalid shipment receiving configuration request", code: "SHIPMENT_RECEIPT_INPUT_INVALID" });
    try {
      res.json(await purchasing.getShipmentReceiptPackResolution(shipmentId.data, input.data));
    } catch (error: any) {
      sendShipmentReceiptError(res, error, shipmentId.data, "preview");
    }
  });

  // Per-PO receive options for one shipment. Powers the shipment-page PO picker
  // (multi-PO shipments) and the post-close "receive next PO" chaining.
  app.get("/api/inbound-shipments/:id/po-receive-options", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipmentId = Number(req.params.id);
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        return res.status(400).json({ error: "Invalid shipment id" });
      }
      const options = await purchasing.getShipmentPoReceiveOptions(shipmentId);
      res.json(options);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json({ error: error?.message || "Failed to load shipment receive options" });
    }
  });

  // Receive AGAINST an inbound shipment: creates a receiving order linked to the
  // shipment (inbound_shipment_id + source_type='shipment'), lines defaulted from
  // the shipment's qtyShipped, so lots created at close inherit the shipment link
  // and the shipment's finalized freight attaches to exactly these lots.
  app.post("/api/inbound-shipments/:id/create-receipt", requirePermission("inventory", "receive"), requireIdempotency(), async (req, res) => {
    try {
      const shipmentId = Number(req.params.id);
      if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
        return res.status(400).json({ error: "Invalid shipment id" });
      }
      const rawPurchaseOrderId = req.body?.purchaseOrderId ?? req.body?.purchase_order_id ?? req.query.purchaseOrderId;
      const purchaseOrderId = rawPurchaseOrderId === undefined ? undefined : Number(rawPurchaseOrderId);
      if (purchaseOrderId !== undefined && (!Number.isInteger(purchaseOrderId) || purchaseOrderId <= 0)) {
        return res.status(400).json({ error: "Invalid purchase order id" });
      }
      const userId = (req as any).session?.user?.id;
      const input = shipmentReceiptPlanRequestSchema.safeParse({ purchaseOrderId, receiptUnitSelections: req.body?.receiptUnitSelections });
      if (!input.success) return res.status(400).json({ error: "Invalid shipment receiving configuration request", code: "SHIPMENT_RECEIPT_INPUT_INVALID" });
      const receipt = await purchasing.createReceiptFromShipment(shipmentId, userId, input.data);
      res.status(201).json(receipt);
    } catch (error: any) {
      sendShipmentReceiptError(res, error, req.params.id, "create");
    }
  });

  app.get("/api/purchase-orders/:id/receipts", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const receipts = await purchasing.getPoReceipts(Number(req.params.id));
      res.json({ receipts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/history", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const history = await purchasing.getPoStatusHistory(Number(req.params.id));
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // PO Exceptions - Phase 1 (migration 0566)

  // GET /api/purchase-orders/:id/exceptions
  // List exceptions for a PO. Returns open + acknowledged by default.
  // ?include_resolved=true to include resolved + dismissed rows.
  app.get("/api/purchase-orders/:id/exceptions", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const poId = Number(req.params.id);
      const includeResolved = req.query.include_resolved === "true";
      const exceptions = await poExceptionsService.listExceptions(poId, { includeResolved });
      res.json({ exceptions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/purchase-orders/:id/exceptions
  // Manually create an exception (e.g. damaged_on_arrival, wrong_product_received).
  // Requires purchasing:edit permission.
  app.post("/api/purchase-orders/:id/exceptions", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const poId = Number(req.params.id);
      const { kind, severity, title, message, payload } = req.body;

      if (!kind || !severity || !title) {
        return res.status(400).json({ error: "kind, severity, and title are required" });
      }

      const exception = await poExceptionsService.upsertException({
        poId,
        kind,
        severity,
        title,
        message,
        payload: payload ?? {},
        detectedBy: `user:${req.session.user!.id}`,
      });
      res.status(201).json({ exception });
    } catch (error: any) {
      if (error instanceof PoExceptionError) {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/po-exceptions/:id/acknowledge
  // Mark an exception as acknowledged. Requires purchasing:view permission.
  app.post("/api/po-exceptions/:id/acknowledge", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const userId = req.session.user!.id;
      const exception = await poExceptionsService.acknowledgeException(id, userId);
      res.json({ exception });
    } catch (error: any) {
      if (error instanceof PoExceptionError) {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/po-exceptions/:id/resolve
  // Mark an exception as resolved. Requires resolutionNote in body.
  // Requires purchasing:edit permission.
  app.post("/api/po-exceptions/:id/resolve", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const userId = req.session.user!.id;
      const { resolutionNote } = req.body;

      if (!resolutionNote || String(resolutionNote).trim().length === 0) {
        return res.status(400).json({ error: "resolutionNote is required" });
      }

      const exception = await poExceptionsService.resolveException(id, userId, resolutionNote);
      res.json({ exception });
    } catch (error: any) {
      if (error instanceof PoExceptionError) {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/po-exceptions/:id/dismiss
  // Dismiss an exception (false alarm / not actionable).
  // Requires purchasing:edit permission.
  app.post("/api/po-exceptions/:id/dismiss", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const userId = req.session.user!.id;
      const { reason } = req.body;
      const exception = await poExceptionsService.dismissException(id, userId, reason);
      res.json({ exception });
    } catch (error: any) {
      if (error instanceof PoExceptionError) {
        return res.status(error.statusCode).json({ error: error.message, code: error.code });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Phase 2: payments linked to this PO via:
  //   vendor_invoice_po_links -> vendor_invoices -> ap_payment_allocations -> ap_payments
  app.get("/api/purchase-orders/:id/payments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const payments = await apLedger.getPaymentsForPo(Number(req.params.id));
      res.json({ payments });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/revisions", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const revisions = await purchasing.getPoRevisions(Number(req.params.id));
      res.json({ revisions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/document", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const poId = parsePositivePoEmailId(req.params.id, "Purchase order id");
      const document = buildSupplierPoDocument(await loadSupplierPoDocumentSource(db, poId));
      res.json({ html: renderPoHtml(document), purpose: document.purpose, sourceRevision: document.sourceRevision });
    } catch (error) {
      if (error instanceof SupplierPoDocumentError) {
        console.warn(JSON.stringify({ event: "supplier_po_document_rejected", code: error.code,
          purchaseOrderId: req.params.id, actorId: req.session.user?.id ?? null, context: error.context }));
      }
      sendPoEmailOutboxError(res, error);
    }
  });

  app.get(
    "/api/purchase-orders/:id/email-deliveries",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const poId = parsePositivePoEmailId(req.params.id, "Purchase order id");
        const deliveries = await listPurchaseOrderEmailDeliveries(poId);
        res.json({ deliveries });
      } catch (error) {
        sendPoEmailOutboxError(res, error);
      }
    },
  );

  app.post(
    "/api/purchase-orders/:id/send-email",
    requirePermission("purchasing", "edit"),
    async (req, res) => {
      try {
        const poId = parsePositivePoEmailId(req.params.id, "Purchase order id");
        const parsed = poEmailRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid email delivery request",
            details: {
              code: "INVALID_EMAIL_REQUEST",
              fields: parsed.error.flatten().fieldErrors,
            },
          });
        }
        const result = await enqueuePurchaseOrderEmail({
          purchaseOrderId: poId,
          toEmail: parsed.data.toEmail,
          ccEmail: parsed.data.ccEmail,
          message: parsed.data.message,
          idempotencyKey: getRequiredIdempotencyKey(req),
          createdBy: req.session.user?.id ?? null,
        });
        res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
        res.status(202).json({
          ok: true,
          delivery: result.delivery,
          replayed: result.replayed,
        });
      } catch (error) {
        sendPoEmailOutboxError(res, error);
      }
    },
  );

  app.post(
    "/api/purchase-orders/:id/email-deliveries/:deliveryId/replay",
    requirePermission("purchasing", "edit"),
    async (req, res) => {
      try {
        const poId = parsePositivePoEmailId(req.params.id, "Purchase order id");
        const deliveryId = parsePositivePoEmailId(req.params.deliveryId, "Delivery id");
        const result = await replayDeadLetterPurchaseOrderEmail({
          purchaseOrderId: poId,
          deliveryId,
          idempotencyKey: getRequiredIdempotencyKey(req),
          createdBy: req.session.user?.id ?? null,
        });
        res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
        res.status(202).json({
          ok: true,
          delivery: result.delivery,
          replayed: result.replayed,
        });
      } catch (error) {
        sendPoEmailOutboxError(res, error);
      }
    },
  );
}
import { shipmentCostReviewResponse } from "@shared/procurement/shipment-cost-review-version";
