import type { Express, Request, Response } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import {
  PurchasingError,
  type CreatePurchaseOrderWithLinesInput,
  type PurchaseOrderLineInput,
} from "./purchasing.service";
import * as poExceptionsService from "./po-exceptions.service";
import { PoExceptionError } from "./po-exceptions.service";
import * as apLedger from "./ap-ledger.service";
import { renderPoHtml } from "./po-document";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { z } from "zod";
import { users as identityUsers } from "../../storage/base";
import {
  buildPoAutoDraftActionPlan,
  buildPoLifecycleSummary,
  type PoLifecycleCommand,
} from "./purchase-order-lifecycle.service";
import { purchaseOrderDraftHeaderPatchSchema } from "./purchase-order-draft-header";
import type { PoLinePricingInput } from "@shared/utils/po-line-pricing";
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
  if (error instanceof PoEmailOutboxError) {
    return res.status(error.statusCode).json({
      error: error.message,
      details: { code: error.code },
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

function parseNullableDateInput(value: unknown, fieldLabel: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new PurchasingError(`${fieldLabel} must be a valid date`, 400, {
      code: "INVALID_DATE_INPUT",
      field: fieldLabel,
    });
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PurchasingError(`${fieldLabel} must be a valid date`, 400, {
      code: "INVALID_DATE_INPUT",
      field: fieldLabel,
    });
  }
  return date;
}

function mapPoLinePricingInput(line: any): PoLinePricingInput | undefined {
  const pricing = line?.pricing;
  if (!pricing || typeof pricing !== "object") return undefined;
  const basis = pricing.basis ?? pricing.pricing_basis;
  if (basis === "per_piece") {
    return {
      basis,
      quantityPieces: Number(pricing.quantityPieces ?? pricing.quantity_pieces),
      unitCostMills: Number(pricing.unitCostMills ?? pricing.unit_cost_mills),
    };
  }
  if (basis === "per_purchase_uom") {
    return {
      basis,
      purchaseUom: String(pricing.purchaseUom ?? pricing.purchase_uom ?? ""),
      uomQuantity: Number(pricing.uomQuantity ?? pricing.uom_quantity),
      piecesPerUom: Number(pricing.piecesPerUom ?? pricing.pieces_per_uom),
      quotedCostMillsPerUom: Number(
        pricing.quotedCostMillsPerUom ?? pricing.quoted_cost_mills_per_uom,
      ),
    };
  }
  if (basis === "extended_total") {
    return {
      basis,
      quantityPieces: Number(pricing.quantityPieces ?? pricing.quantity_pieces),
      quotedTotalCents: Number(pricing.quotedTotalCents ?? pricing.quoted_total_cents),
    };
  }
  return pricing as PoLinePricingInput;
}

function mapCatalogWriteDirective(line: any): PurchaseOrderLineInput["catalogWrite"] {
  const raw = line?.catalog_write ?? line?.catalogWrite;
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PurchasingError("catalog_write must be an object", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "mode" && key !== "set_preferred" && key !== "setPreferred")) {
    throw new PurchasingError("catalog_write contains unsupported fields", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  if (raw.mode !== "upsert") {
    throw new PurchasingError("catalog_write.mode must be 'upsert'", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  const setPreferred = raw.set_preferred ?? raw.setPreferred;
  if (
    raw.set_preferred !== undefined &&
    raw.setPreferred !== undefined &&
    raw.set_preferred !== raw.setPreferred
  ) {
    throw new PurchasingError("catalog_write preferred flags conflict", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  if (setPreferred !== undefined && typeof setPreferred !== "boolean") {
    throw new PurchasingError("catalog_write.set_preferred must be a boolean", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  return {
    mode: "upsert",
    ...(setPreferred === undefined ? {} : { setPreferred }),
  };
}

function mapPurchaseOrderLineInput(line: any, includeLineId: boolean): PurchaseOrderLineInput {
  const rawCents = line?.unit_cost_cents ?? line?.unitCostCents;
  const rawMills = line?.unit_cost_mills ?? line?.unitCostMills;
  const lineType = line?.line_type ?? line?.lineType ?? "product";
  const variantIdRaw = line?.product_variant_id ?? line?.productVariantId;
  const productIdRaw = line?.product_id ?? line?.productId;
  const expectedReceiveVariantIdRaw =
    line?.expected_receive_variant_id ?? line?.expectedReceiveVariantId ?? variantIdRaw;
  const expectedReceiveUnitsPerVariantRaw =
    line?.expected_receive_units_per_variant ?? line?.expectedReceiveUnitsPerVariant;
  const pricing = mapPoLinePricingInput(line);
  const pricingSource = line?.pricing_source ?? line?.pricingSource;
  if (
    !includeLineId &&
    pricingSource !== undefined &&
    pricingSource !== "manual" &&
    pricingSource !== "vendor_catalog"
  ) {
    throw new PurchasingError("New PO lines may only use manual or vendor_catalog pricing", 400, {
      code: "PO_LINE_PRICING_SOURCE_FORBIDDEN",
    });
  }
  const rawOrderQty = line?.quantity_ordered ?? line?.orderQty;
  const pricingOrderQty = pricing?.basis === "per_purchase_uom"
    ? pricing.uomQuantity * pricing.piecesPerUom
    : pricing?.quantityPieces;
  const mapped: PurchaseOrderLineInput = {
    lineType,
    clientId: line?.client_id ?? line?.clientId ?? undefined,
    parentClientId: line?.parent_client_id ?? line?.parentClientId ?? null,
    description: line?.description ?? null,
    productId: lineType === "product" ? Number(productIdRaw) : null,
    productVariantId:
      lineType === "product" && variantIdRaw != null ? Number(variantIdRaw) : null,
    expectedReceiveVariantId:
      lineType === "product" && expectedReceiveVariantIdRaw != null
        ? Number(expectedReceiveVariantIdRaw)
        : null,
    expectedReceiveUnitsPerVariant:
      lineType === "product" && expectedReceiveUnitsPerVariantRaw != null
        ? Number(expectedReceiveUnitsPerVariantRaw)
        : null,
    orderQty: Number(rawOrderQty ?? pricingOrderQty),
    vendorProductId: line?.vendor_product_id ?? line?.vendorProductId ?? undefined,
    vendorSku: line?.vendor_sku ?? line?.vendorSku ?? null,
    notes: line?.notes ?? null,
    pricing,
    pricingSource,
    quoteReference: line?.quote_reference ?? line?.quoteReference ?? null,
    quotedAt: parseNullableDateInput(
      line?.quoted_at ?? line?.quotedAt,
      "quotedAt",
    ) ?? null,
    quoteValidUntil: line?.quote_valid_until ?? line?.quoteValidUntil ?? null,
    catalogWrite: mapCatalogWriteDirective(line),
  };

  if (includeLineId) {
    const rawLineId = line?.line_id ?? line?.lineId;
    if (rawLineId !== undefined && rawLineId !== null) mapped.lineId = Number(rawLineId);
  }
  if (rawCents !== undefined && rawCents !== null) mapped.unitCostCents = Number(rawCents);
  if (rawMills !== undefined && rawMills !== null) mapped.unitCostMills = Number(rawMills);

  const rawTotalProduct = line?.total_product_cost_cents ?? line?.totalProductCostCents;
  const rawPackaging = line?.packaging_cost_cents ?? line?.packagingCostCents;
  if (rawTotalProduct !== undefined && rawTotalProduct !== null) {
    mapped.totalProductCostCents = Number(rawTotalProduct);
  }
  if (rawPackaging !== undefined && rawPackaging !== null) {
    mapped.packagingCostCents = Number(rawPackaging);
  }
  return mapped;
}

function mapPurchaseOrderWithLinesInput(
  body: any,
  includeLineIds: boolean,
): CreatePurchaseOrderWithLinesInput {
  const expectedDeliveryRaw = body?.expected_delivery_date ?? body?.expectedDeliveryDate;
  const hasWarehouseId = body?.warehouse_id !== undefined || body?.warehouseId !== undefined;
  const warehouseIdRaw = body?.warehouse_id !== undefined
    ? body.warehouse_id
    : body?.warehouseId;
  return {
    vendorId: Number(body?.vendor_id ?? body?.vendorId),
    warehouseId: !hasWarehouseId
      ? undefined
      : warehouseIdRaw === null
        ? null
        : Number(warehouseIdRaw),
    poType: body?.po_type ?? body?.poType,
    priority: body?.priority,
    expectedDeliveryDate:
      parseNullableDateInput(expectedDeliveryRaw, "expectedDeliveryDate") ?? null,
    incoterms: body?.incoterms ?? null,
    vendorNotes: body?.vendor_notes ?? body?.vendorNotes ?? null,
    internalNotes: body?.internal_notes ?? body?.internalNotes ?? null,
    lines: Array.isArray(body?.lines)
      ? body.lines.map((line: any) => mapPurchaseOrderLineInput(line, includeLineIds))
      : [],
  };
}

export function registerPurchaseOrderRoutes(app: Express) {
  const { purchasing, shipmentTracking } = app.locals.services;

  const withLifecycle = (po: any) => ({
    ...po,
    lifecycle: buildPoLifecycleSummary(po),
  });

  const buildLifecycleCommandInput = (req: any) => {
    const input: Record<string, unknown> = {};
    if (req.body?.notes !== undefined) input.notes = req.body.notes;
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
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  };

  // PO CRUD

  app.get("/api/purchase-orders", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      // Support ?status=sent&status=acknowledged or ?status=sent,acknowledged
      let statusFilter: string | string[] | undefined;
      if (req.query.status) {
        const raw = Array.isArray(req.query.status) ? req.query.status as string[] : (req.query.status as string).split(",");
        statusFilter = raw.length === 1 ? raw[0] : raw;
      }
      // Phase 2: dual-track physical/financial status filters
      let physicalStatusFilter: string | string[] | undefined;
      if (req.query.physical_status) {
        const raw = Array.isArray(req.query.physical_status) ? req.query.physical_status as string[] : (req.query.physical_status as string).split(",");
        physicalStatusFilter = raw.length === 1 ? raw[0] : raw;
      }
      let financialStatusFilter: string | string[] | undefined;
      if (req.query.financial_status) {
        const raw = Array.isArray(req.query.financial_status) ? req.query.financial_status as string[] : (req.query.financial_status as string).split(",");
        financialStatusFilter = raw.length === 1 ? raw[0] : raw;
      }
      const filters = {
        status: statusFilter,
        physicalStatus: physicalStatusFilter,
        financialStatus: financialStatusFilter,
        vendorId: req.query.vendorId ? Number(req.query.vendorId) : undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };
      const [pos, count, allVendors] = await Promise.all([
        purchasing.getPurchaseOrders(filters),
        purchasing.getPurchaseOrdersCount(filters),
        storage.getAllVendors(),
      ]);
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
      res.status(500).json({ error: error.message });
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

  app.get("/api/purchase-orders/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const po = await purchasing.getPurchaseOrderById(Number(req.params.id));
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const [lines, vendor, exceptionCount, history, exceptions] = await Promise.all([
        purchasing.getPurchaseOrderLines(po.id),
        storage.getVendorById(po.vendorId),
        poExceptionsService.countOpenExceptions(po.id),
        purchasing.getPoStatusHistory(po.id),
        poExceptionsService.listExceptions(po.id, { includeResolved: true }),
      ]);

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
        ...withLifecycle(po),
        lines,
        vendor,
        openExceptionCount: exceptionCount.count,
        maxOpenSeverity: exceptionCount.maxSeverity,
        autoDraftActionPlan: buildPoAutoDraftActionPlan(po, {
          lineCount: lines.length,
          openExceptionCount: exceptionCount.count,
        }),
        relatedUsers,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/purchase-orders
  //
  // Dual-mode to preserve the legacy "create empty PO" flow while enabling the
  // Spec A inline flow:
  //   - If req.body.lines is a non-empty array:
  //       Use createPurchaseOrderWithLines. If req.body.advance_to_sent === true,
  //       immediately call sendPurchaseOrder and return the combined result.
  //       Idempotent: requires an Idempotency-Key header (Rule #6).
  //   - Else:
  //       Fall through to the legacy createPO path (empty PO, lines added later).
  //
  // Idempotency must be enforced for the mutating path. Because the middleware
  // short-circuits only when the key is present, and legacy clients don't send
  // one, we mount idempotency as a conditional guard: present lines => required.
  app.post(
    "/api/purchase-orders",
    requirePermission("purchasing", "create"),
    (req, res, next) => {
      // Spec A: only enforce idempotency when the inline-lines flow is invoked.
      // Legacy empty-create callers continue to work without a key.
      if (Array.isArray(req.body?.lines) && req.body.lines.length > 0) {
        return requireIdempotency()(req, res, next);
      }
      return next();
    },
    async (req, res) => {
      try {
        const userId = req.session.user?.id;
        const hasInlineLines =
          Array.isArray(req.body?.lines) && req.body.lines.length > 0;

        if (!hasInlineLines) {
          // Legacy empty-create path - unchanged behavior.
          const po = await purchasing.createPO({
            ...req.body,
            expectedDeliveryDate: req.body.expectedDeliveryDate
              ? new Date(req.body.expectedDeliveryDate)
              : undefined,
            createdBy: userId,
          });
          return res.status(201).json(po);
        }

        const created = await purchasing.createPurchaseOrderWithLines(
          mapPurchaseOrderWithLinesInput(req.body, false),
          userId,
        );

        const advanceToSent = req.body.advance_to_sent === true;
        if (!advanceToSent) {
          return res.status(201).json({ po: created });
        }

        const sendResult = await purchasing.sendPurchaseOrder(created.id, userId);
        return res.status(201).json({
          po: sendResult.po,
          status: sendResult.status,
          pdf: sendResult.pdf,
          pending_approval: sendResult.pendingApproval,
        });
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message, details: error.details });
        }
        console.error("[POST /api/purchase-orders] error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.put(
    "/api/purchase-orders/:id/draft",
    requirePermission("purchasing", "edit"),
    requireIdempotency(),
    async (req, res) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          throw new PurchasingError("Purchase order id must be a positive integer", 400, {
            code: "INVALID_PURCHASE_ORDER_ID",
          });
        }
        const expectedUpdatedAt = parseNullableDateInput(
          req.body?.expected_updated_at ?? req.body?.expectedUpdatedAt,
          "expectedUpdatedAt",
        );
        if (!expectedUpdatedAt) {
          throw new PurchasingError("expected_updated_at is required", 400, {
            code: "PO_DRAFT_EXPECTED_VERSION_REQUIRED",
          });
        }

        const updated = await purchasing.updateDraftPurchaseOrderWithLines(
          id,
          {
            ...mapPurchaseOrderWithLinesInput(req.body, true),
            expectedUpdatedAt,
          },
          req.session.user?.id,
        );

        if (req.body?.advance_to_sent !== true) {
          return res.json(updated);
        }

        let sendResult: Awaited<ReturnType<typeof purchasing.sendPurchaseOrder>>;
        try {
          sendResult = await purchasing.sendPurchaseOrder(id, req.session.user?.id);
        } catch (sendError: any) {
          console.error("[PUT /api/purchase-orders/:id/draft] draft updated but send failed", {
            purchaseOrderId: id,
            error: sendError?.message,
          });
          return res.json({
            ...updated,
            sendError: sendError?.message || "Failed to send purchase order",
          });
        }
        return res.json({
          po: sendResult.po,
          lines: updated.lines,
          status: sendResult.status,
          pdf: sendResult.pdf,
          pending_approval: sendResult.pendingApproval,
        });
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message, details: error.details });
        }
        console.error("[PUT /api/purchase-orders/:id/draft] error:", error);
        return res.status(500).json({ error: error.message });
      }
    },
  );

  // Spec A: one-click send for an already-saved draft.
  // Returns { po, status, pdf, pending_approval } in the same shape the
  // inline create endpoint uses so the client can handle both uniformly.
  app.post(
    "/api/purchase-orders/:id/send-pdf",
    requirePermission("purchasing", "edit"),
    requireIdempotency(),
    async (req, res) => {
      try {
        const result = await purchasing.sendPurchaseOrder(
          Number(req.params.id),
          req.session.user?.id,
        );
        res.json({
          po: result.po,
          status: result.status,
          pdf: result.pdf,
          pending_approval: result.pendingApproval,
        });
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Spec A: duplicate an existing PO into a new draft.
  app.post(
    "/api/purchase-orders/:id/duplicate",
    requirePermission("purchasing", "create"),
    requireIdempotency(),
    async (req, res) => {
      try {
        const overrides: { vendorId?: number; expectedDeliveryDate?: Date | null } = {};
        if (req.body?.vendor_id !== undefined) overrides.vendorId = Number(req.body.vendor_id);
        if (req.body?.expected_delivery_date) {
          overrides.expectedDeliveryDate = new Date(req.body.expected_delivery_date);
        }
        const created = await purchasing.duplicatePurchaseOrder(
          Number(req.params.id),
          overrides,
          req.session.user?.id,
        );
        res.status(201).json({ id: created.id, po_number: created.poNumber });
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
      }
    },
  );

  // Spec A: procurement settings CRUD.
  app.get(
    "/api/settings/procurement",
    requirePermission("purchasing", "view"),
    async (_req, res) => {
      try {
        const settings = await purchasing.getProcurementSettings();
        res.json(settings);
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.patch(
    "/api/settings/procurement",
    requirePermission("inventory", "adjust"), // admin-scope gate (reuse existing admin perm)
    async (req, res) => {
      try {
        const userId = req.session.user?.id;
        // Accept either { key, value } or { updates: [{ key, value }, ...] }.
        const updates: Array<{ key: string; value: boolean }> = [];
        if (req.body && typeof req.body.key === "string") {
          updates.push({ key: req.body.key, value: req.body.value });
        }
        if (Array.isArray(req.body?.updates)) {
          for (const u of req.body.updates) {
            if (u && typeof u.key === "string") {
              updates.push({ key: u.key, value: u.value });
            }
          }
        }
        if (updates.length === 0) {
          return res.status(400).json({ error: "Request must include { key, value } or { updates: [...] }" });
        }
        let latest: any = null;
        for (const u of updates) {
          latest = await purchasing.updateProcurementSetting(u.key, u.value, userId);
        }
        res.json(latest);
      } catch (error: any) {
        if (error instanceof PurchasingError) {
          return res.status(error.statusCode).json({ error: error.message });
        }
        res.status(500).json({ error: error.message });
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
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
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

  // Returns PO lines eligible for shipping with alreadyShippedQty computed.
  // Filters out non-product lines, closed/cancelled lines, and fully-shipped lines.
  app.get("/api/purchase-orders/:id/shippable-lines", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const poId = Number(req.params.id);
      const poLines = await purchasing.getPurchaseOrderLines(poId);

      // Already-shipped qty per PO line, via the shared status-aware tally.
      // This is the SAME computation the add-lines write path uses, so a
      // cancelled shipment's lines are excluded here too — otherwise they would
      // wrongly zero out the remaining qty and hide every line from the modal.
      const poLineIds = (poLines as any[]).map((l) => l.id);
      const shippedQtyByPoLine = await shipmentTracking.getShippedQtyByPoLines(poLineIds);

      const result = (poLines as any[])
        .filter((line) => {
          // Only product lines
          const isProduct = !line.lineType || line.lineType === "product";
          if (!isProduct) return false;
          // Skip closed/cancelled
          if (line.status === "closed" || line.status === "cancelled") return false;
          // Skip fully shipped
          const orderQty = line.orderQty ?? 0;
          const cancelledQty = line.cancelledQty ?? 0;
          const alreadyShipped = shippedQtyByPoLine.get(line.id) ?? 0;
          const remaining = orderQty - alreadyShipped - cancelledQty;
          if (remaining <= 0) return false;
          return true;
        })
        .map((line) => {
          const orderQty = line.orderQty ?? 0;
          const cancelledQty = line.cancelledQty ?? 0;
          const alreadyShipped = shippedQtyByPoLine.get(line.id) ?? 0;
          return {
            ...line,
            alreadyShippedQty: alreadyShipped,
            remainingQty: orderQty - alreadyShipped - cancelledQty,
          };
        });

      res.json({ lines: result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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
    await handleLifecycleCommand(req, res, "approve");
  });

  app.post("/api/purchase-orders/:id/send", requirePermission("purchasing", "create"), async (req, res) => {
    await handleLifecycleCommand(req, res, "send");
  });

  // Combined send-to-vendor: draft -> approved -> sent in one click (solo mode only)
  app.post("/api/purchase-orders/:id/send-to-vendor", requirePermission("purchasing", "create"), async (req, res) => {
    await handleLifecycleCommand(req, res, "send_to_vendor");
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

  app.post("/api/purchase-orders/:id/cancel", requirePermission("purchasing", "cancel"), async (req, res) => {
    await handleLifecycleCommand(req, res, "cancel");
  });

  app.post("/api/purchase-orders/:id/void", requirePermission("purchasing", "approve"), async (req, res) => {
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
      res.status(error?.statusCode || 500).json({ error: error?.message || "Failed to resolve shipment receipt packs" });
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
      const receipt = await purchasing.createReceiptFromShipment(shipmentId, userId, { purchaseOrderId });
      res.status(201).json(receipt);
    } catch (error: any) {
      res.status(error?.statusCode || 500).json({ error: error?.message || "Failed to create receipt from shipment" });
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
        detectedBy: (req as any).user?.id ? `user:${(req as any).user.id}` : "user",
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
      const userId = (req as any).user?.id ?? "unknown";
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
      const userId = (req as any).user?.id ?? "unknown";
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
      const userId = (req as any).user?.id ?? "unknown";
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
      const poId = Number(req.params.id);
      const po = await purchasing.getPurchaseOrderById(poId);
      if (!po) return res.status(404).json({ error: "PO not found" });

      const [lines, vendor, settings] = await Promise.all([
        purchasing.getPurchaseOrderLines(poId),
        storage.getVendorById(po.vendorId),
        storage.getAllSettings(),
      ]);

      const html = renderPoHtml({
        po,
        lines,
        vendor,
        companyName: settings.company_name ?? undefined,
        companyAddress: settings.company_address ?? undefined,
        companyCity: settings.company_city ?? undefined,
        companyState: settings.company_state ?? undefined,
        companyPostalCode: settings.company_postal_code ?? undefined,
        companyCountry: settings.company_country ?? undefined,
      });

      res.json({ html });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
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
