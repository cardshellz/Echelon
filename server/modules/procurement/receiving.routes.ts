import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission, requireAuth } from "../../routes/middleware";
import { requireIdempotency } from "../../middleware/idempotency";
import * as notificationService from "../notifications/notifications.service";
import { millsToCents, centsToMills } from "@shared/utils/money";

/**
 * Resolve an incoming (mills?, cents?) pair on a receiving-line request
 * body into a canonical (cents, mills) pair. Mills is authoritative when
 * provided; cents is derived via `millsToCents` (half-up) if not supplied,
 * or validated to match if it is. Mirrors the contract used for PO lines
 * in `purchasing.service.validateCreateWithLinesInput`.
 *
 * Integer math throughout (coding-standards.md Rule #3). Returns the error
 * message as a string so the caller can emit a 400; we don't throw here
 * because this is a thin request-parsing helper, not a domain boundary.
 */
function resolveUnitCostPair(
  millsIn: number | string | null | undefined,
  centsIn: number | string | null | undefined,
): { cents: number | null; mills: number | null; error?: string } {
  const normInt = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return NaN as any;
    return n;
  };
  const mills = normInt(millsIn);
  const cents = normInt(centsIn);
  if (Number.isNaN(mills as number) || Number.isNaN(cents as number)) {
    return { cents: null, mills: null, error: "unit_cost_mills/unit_cost must be non-negative integers" };
  }
  // Both undefined: nothing to set.
  if ((mills === undefined || mills === null) && (cents === undefined || cents === null)) {
    return { cents: null, mills: null };
  }
  if (typeof mills === "number" && typeof cents === "number") {
    const expected = millsToCents(mills);
    if (expected !== cents) {
      return {
        cents: null,
        mills: null,
        error: `unit_cost_mills (${mills}) and unit_cost (${cents}) disagree; expected cents=${expected}`,
      };
    }
    return { cents, mills };
  }
  if (typeof mills === "number") {
    return { cents: millsToCents(mills), mills };
  }
  // cents-only (legacy caller).
  return { cents: cents as number, mills: centsToMills(cents as number) };
}

export function registerReceivingRoutes(app: Express) {
  // ===== RECEIVING ORDERS API =====
  
  app.get("/api/receiving", requireAuth, async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const orders = status 
        ? await storage.getReceivingOrdersByStatus(status)
        : await storage.getAllReceivingOrders();
      
      // Enrich with vendor info
      const vendors = await storage.getAllVendors();
      const vendorMap = new Map(vendors.map(v => [v.id, v]));
      
      const enriched = orders.map(order => ({
        ...order,
        vendor: order.vendorId ? vendorMap.get(order.vendorId) : null,
      }));
      
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching receiving orders:", error);
      res.status(500).json({ error: "Failed to fetch receiving orders" });
    }
  });
  
  app.get("/api/receiving/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      console.log("[RECEIVING] Fetching order id:", id);
      
      const order = await storage.getReceivingOrderById(id);
      console.log("[RECEIVING] Order found:", order ? "yes" : "no");
      
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      
      const lines = await storage.getReceivingLines(id);
      console.log("[RECEIVING] Lines count:", lines.length);
      
      const vendor = order.vendorId ? await storage.getVendorById(order.vendorId) : null;
      console.log("[RECEIVING] Vendor:", vendor ? vendor.name : "none");
      
      res.json({ ...order, lines, vendor });
    } catch (error: any) {
      console.error("[RECEIVING] Error fetching receiving order:", error?.message || error);
      console.error("[RECEIVING] Stack:", error?.stack);
      res.status(500).json({ error: "Failed to fetch receiving order", details: error?.message });
    }
  });
  
  app.post("/api/receiving", requirePermission("inventory", "adjust"), async (req, res) => {
    let receiptNumber = "(unassigned)";
    try {
      const { sourceType, vendorId, warehouseId, poNumber, asnNumber, expectedDate, notes } = req.body;
      
      receiptNumber = await storage.generateReceiptNumber();
      const userId = req.session.user?.id || null;
      
      const order = await storage.createReceivingOrder({
        receiptNumber,
        sourceType: sourceType || "blind",
        vendorId: vendorId || null,
        warehouseId: warehouseId || null,
        poNumber: poNumber || null,
        asnNumber: asnNumber || null,
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        notes: notes || null,
        status: "draft",
        createdBy: userId,
      });
      
      res.status(201).json(order);
    } catch (error: any) {
      console.error("Error creating receiving order:", error?.message || error);
      if (error?.stack) console.error(error.stack);
      if (error?.code === "23505") {
        return res.status(409).json({ error: `Receipt number '${receiptNumber}' already in use by an active record.` });
      }
      res.status(500).json({ error: "Failed to create receiving order", details: error?.message });
    }
  });
  
  app.patch("/api/receiving/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      
      const order = await storage.updateReceivingOrder(id, updates);
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      res.json(order);
    } catch (error) {
      console.error("Error updating receiving order:", error);
      res.status(500).json({ error: "Failed to update receiving order" });
    }
  });
  
  app.delete("/api/receiving/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReceivingOrder(id);
      if (!deleted) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting receiving order:", error);
      res.status(500).json({ error: "Failed to delete receiving order" });
    }
  });
  
  app.post("/api/receiving/:id/open", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services;
      const result = await rcvService.open(parseInt(req.params.id), req.session.user?.id || null);
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error opening receiving order:", error);
      res.status(500).json({ error: "Failed to open receiving order" });
    }
  });
  
  // Close/complete a receiving order - updates inventory
  app.post("/api/receiving/:id/close", requirePermission("inventory", "adjust"), requireIdempotency(), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services;
      const result = await rcvService.close(parseInt(req.params.id), req.session.user?.id || null);
      notificationService.notify("po_received", {
        title: `Receiving Complete: ${(result.order as any)?.orderNumber || `#${req.params.id}`}`,
        message: result.unitsReceived ? `${result.unitsReceived} units received` : undefined,
        data: { receivingOrderId: parseInt(req.params.id) },
      }).catch(() => {});
      const { replenishment: rcvReplen } = req.app.locals.services;
      if (rcvReplen && result.putawayLocationIds?.length) {
        for (const locId of result.putawayLocationIds) {
          rcvReplen.checkReplenForLocation(locId).catch((err: any) =>
            console.warn(`[Replen] Post-receiving check failed for loc ${locId}:`, err)
          );
        }
      }
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
      console.error("Error closing receiving order:", error);
      res.status(500).json({ error: "Failed to close receiving order" });
    }
  });
  
  // ===== RECEIVING LINES API =====
  
  app.get("/api/receiving/:orderId/lines", requireAuth, async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const lines = await storage.getReceivingLines(orderId);
      res.json(lines);
    } catch (error) {
      console.error("Error fetching receiving lines:", error);
      res.status(500).json({ error: "Failed to fetch receiving lines" });
    }
  });
  
  app.post("/api/receiving/:orderId/lines", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const {
        sku,
        productName,
        expectedQty,
        receivedQty,
        status,
        productVariantId,
        productId,
        barcode,
        unitCost,
        unit_cost_mills,
        unitCostMills,
        putawayLocationId,
      } = req.body;

      // Accept both snake_case (API idiom) and camelCase (internal idiom).
      // Mills is authoritative when provided; cents is either independently
      // provided or derived. Disagreeing pairs are rejected to match the PO
      // contract (purchasing.service.validateCreateWithLinesInput).
      const resolved = resolveUnitCostPair(
        unit_cost_mills ?? unitCostMills,
        unitCost,
      );
      if (resolved.error) {
        return res.status(400).json({ error: resolved.error });
      }

      await storage.createReceivingLine({
        receivingOrderId: orderId,
        sku: sku || null,
        productName: productName || null,
        expectedQty: expectedQty || 0,
        receivedQty: receivedQty || 0,
        damagedQty: 0,
        productVariantId: productVariantId || null,
        productId: productId || null,
        barcode: barcode || null,
        unitCost: resolved.cents,
        unitCostMills: resolved.mills,
        putawayLocationId: putawayLocationId || null,
        status: status || "pending",
      });
      
      // Update order line count
      const lines = await storage.getReceivingLines(orderId);
      await storage.updateReceivingOrder(orderId, {
        expectedLineCount: lines.length,
        expectedTotalUnits: lines.reduce((sum, l) => sum + (l.expectedQty || 0), 0),
      });
      
      // Return updated order with lines and vendor (matching GET pattern)
      const order = await storage.getReceivingOrderById(orderId);
      const vendor = order?.vendorId ? await storage.getVendorById(order.vendorId) : null;
      res.status(201).json({ ...order, lines, vendor });
    } catch (error) {
      console.error("Error creating receiving line:", error);
      res.status(500).json({ error: "Failed to create receiving line" });
    }
  });
  
  app.patch("/api/receiving/lines/:lineId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.lineId);
      const updates = { ...req.body } as Record<string, any>;

      // Mills-aware cost update: if the caller sent unit_cost_mills (snake)
      // or unitCostMills (camel), treat mills as authoritative and stamp
      // the cents mirror. If the caller sent ONLY cents, derive mills. If
      // both are provided and disagree, reject.
      const hasAnyCost =
        updates.unitCost !== undefined ||
        updates.unitCostMills !== undefined ||
        updates.unit_cost_mills !== undefined;
      if (hasAnyCost) {
        const millsIn = updates.unit_cost_mills ?? updates.unitCostMills;
        const resolved = resolveUnitCostPair(millsIn, updates.unitCost);
        if (resolved.error) {
          return res.status(400).json({ error: resolved.error });
        }
        // Delete the snake_case key so Drizzle doesn't see an unknown field,
        // then normalize to camelCase the schema expects.
        delete updates.unit_cost_mills;
        updates.unitCost = resolved.cents ?? null;
        updates.unitCostMills = resolved.mills ?? null;
      }

      // Calculate status based on quantities
      if (updates.receivedQty !== undefined) {
        const line = await storage.getReceivingLineById(lineId);
        if (line) {
          const expectedQty = updates.expectedQty ?? line.expectedQty ?? 0;
          const receivedQty = updates.receivedQty ?? line.receivedQty ?? 0;
          
          if (receivedQty === 0) {
            updates.status = "pending";
          } else if (receivedQty < expectedQty) {
            updates.status = "partial";
          } else if (receivedQty === expectedQty) {
            updates.status = "complete";
          } else if (receivedQty > expectedQty) {
            updates.status = "overage";
            
            // Soft-Flag: Tolerance limits are kept for reporting/financial dashboards 
            // but no longer block operational receiving on the floor.
          }
        }
      }
      
      const line = await storage.updateReceivingLine(lineId, updates);
      if (!line) {
        return res.status(404).json({ error: "Receiving line not found" });
      }
      res.json(line);
    } catch (error) {
      console.error("Error updating receiving line:", error);
      res.status(500).json({ error: "Failed to update receiving line" });
    }
  });
  
  // Create a product variant from a receiving line's SKU and link it
  // Uses the same SKU pattern as Shopify sync: BASE-SKU-[P|B|C]###
  app.post("/api/receiving/lines/:lineId/create-variant", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services;
      const result = await rcvService.createVariantFromLine(parseInt(req.params.lineId));
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error creating variant from receiving line:", error);
      res.status(500).json({ error: "Failed to create variant" });
    }
  });

  // Delete a receiving order (only if not closed)
  app.delete("/api/receiving/:orderId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const order = await storage.getReceivingOrderById(orderId);

      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }

      if (order.status === "closed") {
        return res.status(400).json({ error: "Cannot delete a closed receiving order" });
      }

      await storage.deleteReceivingOrder(orderId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting receiving order:", error);
      res.status(500).json({ error: "Failed to delete receiving order" });
    }
  });
  
  // Bulk complete all lines in a receiving order
  app.post("/api/receiving/:orderId/complete-all", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services;
      const result = await rcvService.completeAllLines(parseInt(req.params.orderId));
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error completing all lines:", error);
      res.status(500).json({ error: "Failed to complete all lines" });
    }
  });
  
  app.delete("/api/receiving/lines/:lineId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.lineId);
      const line = await storage.getReceivingLineById(lineId);
      if (!line) {
        return res.status(404).json({ error: "Receiving line not found" });
      }
      
      const deleted = await storage.deleteReceivingLine(lineId);
      
      // Update order line count
      const lines = await storage.getReceivingLines(line.receivingOrderId);
      await storage.updateReceivingOrder(line.receivingOrderId, {
        expectedLineCount: lines.length,
        expectedTotalUnits: lines.reduce((sum, l) => sum + (l.expectedQty || 0), 0),
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting receiving line:", error);
      res.status(500).json({ error: "Failed to delete receiving line" });
    }
  });
  
  // Bulk add lines from CSV for initial inventory load
  app.post("/api/receiving/:orderId/lines/bulk", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services;
      const result = await rcvService.bulkImportLines(
        parseInt(req.params.orderId),
        req.body.lines,
        req.session?.user?.id || null,
      );
      res.status(201).json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
      console.error("Error bulk creating receiving lines:", error);
      res.status(500).json({ error: "Failed to create receiving lines" });
    }
  });

  // Discard a draft receiving order (no inventory side-effects).
  //
  // Validates status=draft and no received qty before atomically deleting the
  // order + its lines and writing an audit row on the linked PO (Rule #8).
  // Idempotent: calling twice on a non-existent id returns 404 on the second
  // call (the order is already gone).
  app.delete("/api/receiving-orders/:id/discard", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services;
      await rcvService.discardDraftReceivingOrder(
        Number(req.params.id),
        req.session.user?.id,
      );
      res.json({ success: true });
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("[Receiving] Error discarding draft receiving order:", error);
      res.status(500).json({ error: "Failed to discard receiving order" });
    }
  });
}
