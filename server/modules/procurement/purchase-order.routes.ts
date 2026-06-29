import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import { PurchasingError } from "./purchasing.service";
import * as poExceptionsService from "./po-exceptions.service";
import { PoExceptionError } from "./po-exceptions.service";
import * as apLedger from "./ap-ledger.service";
import { renderPoHtml } from "./po-document";
import * as emailService from "../notifications/email.service";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { users as identityUsers } from "../../storage/base";
import {
  buildPoAutoDraftActionPlan,
  buildPoLifecycleSummary,
  type PoLifecycleCommand,
} from "./purchase-order-lifecycle.service";

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
    if (req.body?.confirmedDeliveryDate) {
      input.confirmedDeliveryDate = new Date(req.body.confirmedDeliveryDate);
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

        // Inline-lines path. Map snake_case wire format to service's
        // camelCase. Per-unit cost supports both cents (legacy) and mills
        // (4-decimal); the service validator rejects disagreeing pairs.
        //
        // Typed lines (migration 0563): forward line_type, client_id,
        // parent_client_id, and description so the service-layer validator
        // can apply per-type rules and resolve parentClientId -> parent_line_id
        // inside the insert transaction. Non-product lines must NOT carry a
        // product_variant_id (service rejects), so we omit it on the wire
        // for any non-product line.
        const lines = (req.body.lines as any[]).map((l) => {
          const rawCents = l.unit_cost_cents ?? l.unitCostCents;
          const rawMills = l.unit_cost_mills ?? l.unitCostMills;
          const lineType = l.line_type ?? l.lineType ?? "product";
          const variantIdRaw = l.product_variant_id ?? l.productVariantId;
          const productIdRaw = l.product_id ?? l.productId;
          const expectedReceiveVariantIdRaw =
            l.expected_receive_variant_id ?? l.expectedReceiveVariantId ?? variantIdRaw;
          const expectedReceiveUnitsPerVariantRaw =
            l.expected_receive_units_per_variant ?? l.expectedReceiveUnitsPerVariant;
          const out: any = {
            // line_type is the dispatch key; default to 'product' for
            // back-compat callers that don't send it (matches column default).
            lineType,
            // Request-time identifier for parent linkage. Service uses this
            // to resolve parent_line_id after insert. Optional.
            clientId: l.client_id ?? l.clientId ?? undefined,
            parentClientId:
              l.parent_client_id ?? l.parentClientId ?? null,
            // Description is required for non-product lines (service-enforced).
            description: l.description ?? null,
            // Product only on product lines. Send null for non-product.
            productId: lineType === "product" ? Number(productIdRaw) : null,
            productVariantId:
              lineType === "product" && variantIdRaw != null
                ? Number(variantIdRaw)
                : null,
            expectedReceiveVariantId:
              lineType === "product" && expectedReceiveVariantIdRaw != null
                ? Number(expectedReceiveVariantIdRaw)
                : null,
            expectedReceiveUnitsPerVariant:
              lineType === "product" && expectedReceiveUnitsPerVariantRaw != null
                ? Number(expectedReceiveUnitsPerVariantRaw)
                : null,
            orderQty: Number(l.quantity_ordered ?? l.orderQty),
            vendorProductId: l.vendor_product_id ?? l.vendorProductId ?? undefined,
          };
          if (rawCents !== undefined && rawCents !== null) {
            out.unitCostCents = Number(rawCents);
          }
          if (rawMills !== undefined && rawMills !== null) {
            out.unitCostMills = Number(rawMills);
          }
          // Spec F Phase 1: totals-based cost (new shape).
          const rawTotalProduct = l.total_product_cost_cents ?? l.totalProductCostCents;
          const rawPackaging = l.packaging_cost_cents ?? l.packagingCostCents;
          if (rawTotalProduct !== undefined && rawTotalProduct !== null) {
            out.totalProductCostCents = Number(rawTotalProduct);
          }
          if (rawPackaging !== undefined && rawPackaging !== null) {
            out.packagingCostCents = Number(rawPackaging);
          }
          return out;
        });
        const created = await purchasing.createPurchaseOrderWithLines(
          {
            vendorId: Number(req.body.vendor_id ?? req.body.vendorId),
            poType: req.body.po_type ?? req.body.poType,
            priority: req.body.priority,
            expectedDeliveryDate: req.body.expected_delivery_date
              ? new Date(req.body.expected_delivery_date)
              : req.body.expectedDeliveryDate
                ? new Date(req.body.expectedDeliveryDate)
                : null,
            incoterms: req.body.incoterms ?? null,
            vendorNotes: req.body.vendor_notes ?? req.body.vendorNotes ?? null,
            internalNotes: req.body.internal_notes ?? req.body.internalNotes ?? null,
            lines,
          },
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
          return res.status(error.statusCode).json({ error: error.message });
        }
        console.error("[POST /api/purchase-orders] error:", error);
        res.status(500).json({ error: error.message });
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

  app.patch("/api/purchase-orders/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const updates = { ...req.body };
      if (updates.expectedDeliveryDate) updates.expectedDeliveryDate = new Date(updates.expectedDeliveryDate);
      if (updates.confirmedDeliveryDate) updates.confirmedDeliveryDate = new Date(updates.confirmedDeliveryDate);
      if (updates.cancelDate) updates.cancelDate = new Date(updates.cancelDate);
      const po = await purchasing.updatePO(Number(req.params.id), updates, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Update incoterms and/or header charges (discount in draft only; shipping/tax any non-cancelled status)
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
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
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
      const shipmentLines = await shipmentTracking.getLinesByPo(poId);

      // Compute alreadyShippedQty per PO line
      const shippedQtyByPoLine = new Map<number, number>();
      for (const sl of shipmentLines) {
        if (sl.purchaseOrderLineId) {
          shippedQtyByPoLine.set(
            sl.purchaseOrderLineId,
            (shippedQtyByPoLine.get(sl.purchaseOrderLineId) ?? 0) + (sl.qtyShipped ?? 0),
          );
        }
      }

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
      const line = await purchasing.addLine(Number(req.params.id), req.body, req.session.user?.id);
      res.status(201).json(line);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/lines/bulk", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lines = await purchasing.addBulkLines(Number(req.params.id), req.body.lines, req.session.user?.id);
      res.status(201).json({ lines });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchase-orders/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await purchasing.updateLine(Number(req.params.lineId), req.body, req.session.user?.id);
      res.json(line);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchase-orders/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await purchasing.deleteLine(Number(req.params.lineId), req.session.user?.id);
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
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
      const userId = (req as any).session?.user?.id;
      const receipt = await purchasing.createReceiptFromShipment(shipmentId, userId);
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

  app.post("/api/purchase-orders/:id/send-email", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      if (!emailService.isSmtpConfigured()) {
        return res.status(503).json({
          error: "Email is not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM to your .env file.",
        });
      }
      const { toEmail, ccEmail, message } = req.body;
      if (!toEmail) return res.status(400).json({ error: "toEmail is required" });

      const poId = Number(req.params.id);
      await emailService.sendPurchaseOrder({ poId, toEmail, ccEmail, message });

      // Record in PO history
      await storage.createPoStatusHistory({
        purchaseOrderId: poId,
        fromStatus: null,
        toStatus: "email_sent",
        changedBy: (req as any).user?.id ?? null,
        notes: `Email sent to ${toEmail}${ccEmail ? `, cc: ${ccEmail}` : ""}`,
      });

      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
