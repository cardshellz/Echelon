/**
 * Purchasing service for Echelon WMS.
 *
 * Handles the full PO lifecycle:
 * - PO number generation, CRUD, line management, totals
 * - State machine: draft → pending_approval → approved → sent → acknowledged
 *   → partially_received → received → closed (+ cancelled/void)
 * - Multi-level approval tier checking
 * - Revision tracking for post-send amendments
 * - Receipt-from-PO creation (links to ReceivingService)
 * - Reorder-to-PO generation
 */

import { eq } from "drizzle-orm";
import { inboundShipmentLines, landedCostSnapshots, vendorInvoiceLines } from "@shared/schema";
import { Decimal } from "decimal.js";

// ── Minimal dependency interfaces ───────────────────────────────────

interface Storage {
  // Purchase Orders
  getPurchaseOrders(filters?: { status?: string; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<any[]>;
  getPurchaseOrdersCount(filters?: { status?: string; vendorId?: number; search?: string }): Promise<number>;
  getPurchaseOrderById(id: number): Promise<any>;
  getPurchaseOrderByPoNumber(poNumber: string): Promise<any>;
  createPurchaseOrder(data: any, historyData?: any): Promise<any>;
  updatePurchaseOrder(id: number, updates: any, historyData?: any): Promise<any>;
  updatePurchaseOrderStatusWithHistory(id: number, updates: any, historyData?: any): Promise<any>;
  deletePurchaseOrder(id: number): Promise<boolean>;
  generatePoNumber(): Promise<string>;

  // PO Lines
  getPurchaseOrderLines(purchaseOrderId: number): Promise<any[]>;
  getPurchaseOrderLineById(id: number): Promise<any>;
  createPurchaseOrderLine(data: any): Promise<any>;
  bulkCreatePurchaseOrderLines(lines: any[]): Promise<any[]>;
  updatePurchaseOrderLine(id: number, updates: any): Promise<any>;
  deletePurchaseOrderLine(id: number): Promise<boolean>;
  getOpenPoLinesForVariant(productVariantId: number): Promise<any[]>;

  // PO Status History
  createPoStatusHistory(data: any): Promise<any>;
  getPoStatusHistory(purchaseOrderId: number): Promise<any[]>;

  // PO Revisions
  createPoRevision(data: any): Promise<any>;
  getPoRevisions(purchaseOrderId: number): Promise<any[]>;

  // PO Receipts
  createPoReceipt(data: any): Promise<any>;
  getPoReceipts(purchaseOrderId: number): Promise<any[]>;

  // Approval Tiers
  getAllPoApprovalTiers(): Promise<any[]>;
  getPoApprovalTierById(id: number): Promise<any>;
  getMatchingApprovalTier(totalCents: number): Promise<any>;

  // Vendor Products
  getVendorProducts(filters?: any): Promise<any[]>;
  getVendorProductById(id: number): Promise<any>;
  getPreferredVendorProduct(productId: number, productVariantId?: number): Promise<any>;

  // Vendors
  getVendorById(id: number): Promise<any>;

  // Products
  getProductVariantById(id: number): Promise<any>;
  getProductById(id: number): Promise<any>;

  // Receiving
  createReceivingOrder(data: any): Promise<any>;
  generateReceiptNumber(): Promise<string>;
  bulkCreateReceivingLines(lines: any[]): Promise<any[]>;

  // Settings
  getSetting(key: string): Promise<string | null>;
}

// ── Error class ─────────────────────────────────────────────────────

export class PurchasingError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public details?: any,
  ) {
    super(message);
    this.name = "PurchasingError";
  }
}

// ── Valid state transitions ─────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "approved", "cancelled"],
  pending_approval: ["draft", "approved", "cancelled"],
  approved: ["sent", "cancelled"],
  sent: ["acknowledged", "partially_received", "received", "cancelled"],
  acknowledged: ["partially_received", "received", "cancelled"],
  partially_received: ["received", "closed"],
  received: ["closed"],
};

const EDITABLE_STATUSES = new Set(["draft"]);
// Broader set for amending existing lines (cost corrections, qty adjustments) — any non-terminal state
const LINE_AMENDABLE_STATUSES = new Set(["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"]);
const CANCELLABLE_FROM = new Set(["draft", "pending_approval", "approved"]);
const VOIDABLE_FROM = new Set(["sent", "acknowledged"]);

// ── Service ─────────────────────────────────────────────────────────

export type PurchasingService = ReturnType<typeof createPurchasingService>;

export function createPurchasingService(db: any, storage: Storage) {

  // ── Helpers ─────────────────────────────────────────────────────

  function calculateLineCosts(line: { orderQty: number; unitCostCents: number; discountPercent?: string | number; taxRatePercent?: string | number }) {
    const subtotal = new Decimal(line.orderQty || 0).times(line.unitCostCents || 0);
    const discountPct = new Decimal(line.discountPercent || 0);
    const discount = subtotal.times(discountPct).dividedBy(100).round();
    const taxable = subtotal.minus(discount);
    const taxPct = new Decimal(line.taxRatePercent || 0);
    const tax = taxable.times(taxPct).dividedBy(100).round();
    
    return {
      subtotalCents: subtotal.toNumber(),
      discountCents: discount.toNumber(),
      taxCents: tax.toNumber(),
      lineTotalCents: taxable.plus(tax).toNumber()
    };
  }

  async function recalculateTotals(purchaseOrderId: number, userId?: string): Promise<any> {
    const lines = await storage.getPurchaseOrderLines(purchaseOrderId);
    let subtotalCents = BigInt(0);
    let lineCount = 0;
    let receivedLineCount = 0;

    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const costs = calculateLineCosts(line);
      subtotalCents += BigInt(costs.lineTotalCents);
      lineCount++;
      if (line.status === "received") receivedLineCount++;

      // Update line total if changed
      if (line.lineTotalCents !== costs.lineTotalCents) {
        await storage.updatePurchaseOrderLine(line.id, {
          lineTotalCents: costs.lineTotalCents,
          discountCents: costs.discountCents,
          taxCents: costs.taxCents,
        });
      }
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    const headerDiscount = BigInt(po?.discountCents || 0);
    const headerTax = BigInt(po?.taxCents || 0);
    const headerShipping = BigInt(po?.shippingCostCents || 0);
    
    const totalCents = subtotalCents - headerDiscount + headerTax + headerShipping;

    return await storage.updatePurchaseOrderStatusWithHistory(purchaseOrderId, {
      subtotalCents: Number(subtotalCents),
      totalCents: Number(totalCents),
      lineCount,
      receivedLineCount,
      updatedBy: userId,
    });
  }

  // recordStatusChange removed in favor of storage.updatePurchaseOrderStatusWithHistory

  function assertTransition(currentStatus: string, targetStatus: string) {
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new PurchasingError(
        `Cannot transition from '${currentStatus}' to '${targetStatus}'`,
        400,
      );
    }
  }

  // ── PO CRUD ─────────────────────────────────────────────────────

  async function createPO(data: {
    vendorId: number;
    warehouseId?: number;
    poType?: string;
    priority?: string;
    expectedDeliveryDate?: Date;
    shipToAddress?: string;
    shippingMethod?: string;
    incoterms?: string;
    freightTerms?: string;
    vendorNotes?: string;
    internalNotes?: string;
    createdBy?: string;
  }) {
    // Validate vendor
    const vendor = await storage.getVendorById(data.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    const poNumber = await storage.generatePoNumber();

    const po = await storage.createPurchaseOrder({
      poNumber,
      vendorId: data.vendorId,
      warehouseId: data.warehouseId,
      status: "draft",
      poType: data.poType || "standard",
      priority: data.priority || "normal",
      expectedDeliveryDate: data.expectedDeliveryDate,
      shipToAddress: data.shipToAddress,
      shippingMethod: data.shippingMethod,
      incoterms: data.incoterms,
      freightTerms: data.freightTerms,
      vendorNotes: data.vendorNotes,
      internalNotes: data.internalNotes,
      currency: vendor.currency || "USD",
      paymentTermsDays: vendor.paymentTermsDays,
      paymentTermsType: vendor.paymentTermsType,
      shipFromAddress: vendor.shipFromAddress,
      createdBy: data.createdBy,
      updatedBy: data.createdBy,
    }, {
        oldStatus: null,
        newStatus: "draft",
        changedBy: data.createdBy,
        changeNotes: "PO created"
      });
    return po;
  }

  async function updatePO(id: number, updates: Record<string, any>, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot edit PO in '${po.status}' status`, 400);
    }

    return await storage.updatePurchaseOrderStatusWithHistory(id, { ...updates, updatedBy: userId });
  }

  async function deletePO(id: number) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (po.status !== "draft") {
      throw new PurchasingError("Can only delete POs in draft status", 400);
    }
    return await storage.deletePurchaseOrder(id);
  }

  // ── INCOTERMS & HEADER CHARGES ────────────────────────────────────
  // Allows updating incoterms + shipping/tax charges at any non-cancelled status.
  // Discount is limited to draft. All changes are audit-trailed.

  function fmtCents(cents: number | null | undefined): string {
    return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
  }

    async function updateIncotermsAndCharges(
      id: number,
      updates: {
        incoterms?: string | null;
        discountCents?: number;
        taxCents?: number;
        shippingCostCents?: number;
        overReceiptTolerancePct?: number;
      },
      userId?: string,
    ) {
      const po = await storage.getPurchaseOrderById(id);
      if (!po) throw new PurchasingError("Purchase order not found", 404);
      if (po.status === "cancelled") throw new PurchasingError("Cannot update a cancelled PO", 400);
  
      const changes: string[] = [];
      const patch: Record<string, any> = {};
  
      if (updates.incoterms !== undefined && updates.incoterms !== po.incoterms) {
        changes.push(`Incoterms: ${po.incoterms || "none"} → ${updates.incoterms || "none"}`);
        patch.incoterms = updates.incoterms;
      }
      if (updates.discountCents !== undefined && updates.discountCents !== Number(po.discountCents)) {
        if (po.status !== "draft") throw new PurchasingError("Discount can only be changed in draft status", 400);
        changes.push(`Discount: ${fmtCents(po.discountCents)} → ${fmtCents(updates.discountCents)}`);
        patch.discountCents = updates.discountCents;
      }
      if (updates.taxCents !== undefined && updates.taxCents !== Number(po.taxCents)) {
        changes.push(`Tax: ${fmtCents(po.taxCents)} → ${fmtCents(updates.taxCents)}`);
        patch.taxCents = updates.taxCents;
      }
      if (updates.shippingCostCents !== undefined && updates.shippingCostCents !== Number(po.shippingCostCents)) {
        changes.push(`Shipping: ${fmtCents(po.shippingCostCents)} → ${fmtCents(updates.shippingCostCents)}`);
        patch.shippingCostCents = updates.shippingCostCents;
      }
      if (updates.overReceiptTolerancePct !== undefined && updates.overReceiptTolerancePct !== Number(po.overReceiptTolerancePct)) {
        changes.push(`Over-Receipt Tolerance: ${Number(po.overReceiptTolerancePct || 0)}% → ${updates.overReceiptTolerancePct}%`);
        patch.overReceiptTolerancePct = String(updates.overReceiptTolerancePct);
      }

    if (changes.length === 0) return po;

    patch.updatedBy = userId;
    await storage.updatePurchaseOrderStatusWithHistory(id, patch, {
      oldStatus: null,
      newStatus: po.status,
      changedBy: userId,
      changeNotes: changes.join("; ")
    });
    return await recalculateTotals(id, userId);
  }

  // ── LINE MANAGEMENT ─────────────────────────────────────────────

  async function addLine(purchaseOrderId: number, data: {
    productId: number;
    productVariantId: number;
    vendorProductId?: number;
    orderQty: number;
    unitCostCents: number;
    unitOfMeasure?: string;
    unitsPerUom?: number;
    discountPercent?: number;
    taxRatePercent?: number;
    expectedDeliveryDate?: Date;
    vendorSku?: string;
    description?: string;
    notes?: string;
  }, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot add lines to PO in '${po.status}' status`, 400);
    }

    // Cache product info
    const variant = await storage.getProductVariantById(data.productVariantId);
    if (!variant) throw new PurchasingError("Product variant not found", 404);
    const product = await storage.getProductById(data.productId);
    if (!product) throw new PurchasingError("Product not found", 404);

    // Determine next line number
    const existingLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const nextLineNumber = existingLines.length > 0
      ? Math.max(...existingLines.map((l: any) => l.lineNumber)) + 1
      : 1;

    const costs = calculateLineCosts({
      orderQty: data.orderQty,
      unitCostCents: data.unitCostCents,
      discountPercent: data.discountPercent,
      taxRatePercent: data.taxRatePercent,
    });

    const line = await storage.createPurchaseOrderLine({
      purchaseOrderId,
      lineNumber: nextLineNumber,
      productId: data.productId,
      productVariantId: data.productVariantId,
      vendorProductId: data.vendorProductId,
      sku: variant.sku,
      productName: product.name,
      vendorSku: data.vendorSku,
      description: data.description,
      unitOfMeasure: data.unitOfMeasure || variant.name?.split(" ")[0]?.toLowerCase(),
      unitsPerUom: data.unitsPerUom || variant.unitsPerVariant || 1,
      orderQty: data.orderQty,
      unitCostCents: data.unitCostCents,
      discountPercent: String(data.discountPercent || 0),
      taxRatePercent: String(data.taxRatePercent || 0),
      discountCents: costs.discountCents,
      taxCents: costs.taxCents,
      lineTotalCents: costs.lineTotalCents,
      expectedDeliveryDate: data.expectedDeliveryDate,
      notes: data.notes,
      status: "open",
    });

    await recalculateTotals(purchaseOrderId, userId);
    return line;
  }

  async function addBulkLines(purchaseOrderId: number, lines: Array<{
    productId: number;
    productVariantId: number;
    vendorProductId?: number;
    orderQty: number;
    unitCostCents: number;
    unitOfMeasure?: string;
    vendorSku?: string;
    description?: string;
  }>, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot add lines to PO in '${po.status}' status`, 400);
    }

    const existingLines = await storage.getPurchaseOrderLines(purchaseOrderId);
    let nextLineNumber = existingLines.length > 0
      ? Math.max(...existingLines.map((l: any) => l.lineNumber)) + 1
      : 1;

    const lineData: any[] = [];
    for (const line of lines) {
      const variant = await storage.getProductVariantById(line.productVariantId);
      const product = await storage.getProductById(line.productId);
      if (!variant || !product) continue;

      const costs = calculateLineCosts({
        orderQty: line.orderQty,
        unitCostCents: line.unitCostCents,
      });

      lineData.push({
        purchaseOrderId,
        lineNumber: nextLineNumber++,
        productId: line.productId,
        productVariantId: line.productVariantId,
        vendorProductId: line.vendorProductId,
        sku: variant.sku,
        productName: product.name,
        vendorSku: line.vendorSku,
        description: line.description,
        unitOfMeasure: line.unitOfMeasure || "each",
        unitsPerUom: variant.unitsPerVariant || 1,
        orderQty: line.orderQty,
        unitCostCents: line.unitCostCents,
        lineTotalCents: costs.lineTotalCents,
        discountCents: costs.discountCents,
        taxCents: costs.taxCents,
        status: "open",
      });
    }

    const created = await storage.bulkCreatePurchaseOrderLines(lineData);
    await recalculateTotals(purchaseOrderId, userId);
    return created;
  }

  async function updateLine(lineId: number, updates: Record<string, any>, userId?: string) {
    const line = await storage.getPurchaseOrderLineById(lineId);
    if (!line) throw new PurchasingError("PO line not found", 404);

    const po = await storage.getPurchaseOrderById(line.purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!LINE_AMENDABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot edit lines on PO in '${po.status}' status`, 400);
    }

    const updated = await storage.updatePurchaseOrderLine(lineId, updates);

    // Cascade variant/SKU changes to downstream records
    if (updates.productVariantId || updates.sku) {
      const newVariantId = updates.productVariantId ?? line.productVariantId;
      const newSku = updates.sku ?? line.sku;
      try {
        // Look up the new variant's units-per-case for carton recalc
        const newVariant = await storage.getProductVariantById(newVariantId);
        const newUpc = newVariant?.unitsPerVariant ?? 1;

        // Inbound shipment lines linked to this PO line — update variant, SKU, and recalc cartons
        const affectedShipmentLines = await db.select()
          .from(inboundShipmentLines)
          .where(eq(inboundShipmentLines.purchaseOrderLineId, lineId));
        for (const sl of affectedShipmentLines) {
          const newCartons = newUpc > 1 ? Math.ceil(sl.qtyShipped / newUpc) : null;
          await db.update(inboundShipmentLines)
            .set({ productVariantId: newVariantId, sku: newSku, cartonCount: newCartons, updatedAt: new Date() })
            .where(eq(inboundShipmentLines.id, sl.id));
        }
        // Landed cost snapshots
        await db.update(landedCostSnapshots)
          .set({ productVariantId: newVariantId })
          .where(eq(landedCostSnapshots.purchaseOrderLineId, lineId));
        // Vendor invoice lines
        await db.update(vendorInvoiceLines)
          .set({ productVariantId: newVariantId })
          .where(eq(vendorInvoiceLines.purchaseOrderLineId, lineId));
        console.log(`[Purchasing] Cascaded variant change on PO line ${lineId}: variant=${newVariantId} sku=${newSku} upc=${newUpc}`);
      } catch (err: any) {
        console.warn(`[Purchasing] Failed to cascade variant change for PO line ${lineId}: ${err.message}`);
      }
    }

    await recalculateTotals(line.purchaseOrderId, userId);
    return updated;
  }

  async function deleteLine(lineId: number, userId?: string) {
    const line = await storage.getPurchaseOrderLineById(lineId);
    if (!line) throw new PurchasingError("PO line not found", 404);

    const po = await storage.getPurchaseOrderById(line.purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot delete lines on PO in '${po.status}' status`, 400);
    }

    await storage.deletePurchaseOrderLine(lineId);
    await recalculateTotals(line.purchaseOrderId, userId);
    return true;
  }

  // ── STATUS TRANSITIONS ──────────────────────────────────────────

  async function submit(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    // Validate at least 1 non-cancelled line with qty > 0
    const lines = await storage.getPurchaseOrderLines(id);
    const activeLines = lines.filter((l: any) => l.status !== "cancelled" && l.orderQty > 0);
    if (activeLines.length === 0) {
      throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
    }

    // Recalculate totals before checking approval
    await recalculateTotals(id, userId);
    const updatedPo = await storage.getPurchaseOrderById(id);
    const totalCents = Number(updatedPo.totalCents || 0);

    // Check approval tiers
    const tier = await storage.getMatchingApprovalTier(totalCents);

    if (tier) {
      // Needs approval
      assertTransition(po.status, "pending_approval");
      await storage.updatePurchaseOrder(id, {
        status: "pending_approval",
        approvalTierId: tier.id,
        updatedBy: userId,
      }, {
        oldStatus: po.status,
        newStatus: "pending_approval",
        changedBy: userId,
        changeNotes: `Approval required: ${tier.tierName}`
      });
    } else {
      // Auto-approve (no tier matches)
      assertTransition(po.status, "approved");
      await storage.updatePurchaseOrderStatusWithHistory(id, {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: "Auto-approved (below approval threshold)",
        updatedBy: userId,
      }, {
        oldStatus: po.status,
        newStatus: "approved",
        changedBy: userId,
        changeNotes: "Auto-approved (below threshold)"
      });
    }

    return await storage.getPurchaseOrderById(id);
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "draft");

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "draft",
      approvalTierId: null,
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "draft",
        changedBy: userId,
        changeNotes: notes || "Returned to draft"
      });
    return await storage.getPurchaseOrderById(id);
  }

  async function approve(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "approved");

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "approved",
      approvedBy: userId,
      approvedAt: new Date(),
      approvalNotes: notes,
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "approved",
        changedBy: userId,
        changeNotes: notes || "Approved"
      });
    return await storage.getPurchaseOrderById(id);
  }

  async function send(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "sent");

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "sent",
      orderDate: new Date(),
      sentToVendorAt: new Date(),
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "sent",
        changedBy: userId,
        changeNotes: "Sent to vendor"
      });
    return await storage.getPurchaseOrderById(id);
  }

  /**
   * Combined "Send to Vendor" flow for solo mode (no approval tiers configured).
   * Saves → auto-approves → sets status to "sent" in one operation.
   * Returns the updated PO. Caller can then optionally open the email dialog.
   */
  async function sendToVendor(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    // Only works from draft or approved status
    if (!["draft", "approved"].includes(po.status)) {
      throw new PurchasingError(
        `Cannot send-to-vendor from '${po.status}' status. Use individual steps.`,
        400,
      );
    }

    // Check if we're in solo mode (no approval tiers)
    const tiers = await storage.getAllPoApprovalTiers();
    if (tiers.length > 0) {
      throw new PurchasingError(
        "Approval tiers are configured. Use the individual Submit/Approve/Send steps.",
        400,
      );
    }

    // If draft, validate and auto-approve first
    if (po.status === "draft") {
      const lines = await storage.getPurchaseOrderLines(id);
      const activeLines = lines.filter((l: any) => l.status !== "cancelled" && l.orderQty > 0);
      if (activeLines.length === 0) {
        throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
      }

      // Recalculate totals
      await recalculateTotals(id, userId);

      // Auto-approve
      await storage.updatePurchaseOrderStatusWithHistory(id, {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: "Auto-approved (solo mode — no approval tiers)",
        updatedBy: userId,
      }, {
        oldStatus: "draft",
        newStatus: "approved",
        changedBy: userId,
        changeNotes: "Auto-approved (solo mode)"
      });
    }

    // Now send
    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "sent",
      orderDate: new Date(),
      sentToVendorAt: new Date(),
      updatedBy: userId,
    }, {
        oldStatus: "approved",
        newStatus: "sent",
        changedBy: userId,
        changeNotes: "Sent to vendor (solo mode)"
      });

    return await storage.getPurchaseOrderById(id);
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "acknowledged");

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "acknowledged",
      vendorAckDate: new Date(),
      vendorRefNumber: data.vendorRefNumber,
      confirmedDeliveryDate: data.confirmedDeliveryDate,
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "acknowledged",
        changedBy: userId,
        changeNotes: "Vendor acknowledged"
      });
    return await storage.getPurchaseOrderById(id);
  }

  async function cancel(id: number, reason: string, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!reason) throw new PurchasingError("Cancel reason is required", 400);

    if (!CANCELLABLE_FROM.has(po.status) && !VOIDABLE_FROM.has(po.status)) {
      throw new PurchasingError(`Cannot cancel/void PO in '${po.status}' status`, 400);
    }

    // Cancel all open lines
    const lines = await storage.getPurchaseOrderLines(id);
    for (const line of lines) {
      if (line.status === "open") {
        await storage.updatePurchaseOrderLine(line.id, { status: "cancelled", cancelledQty: line.orderQty });
      }
    }

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: userId,
      cancelReason: reason,
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "cancelled",
        changedBy: userId,
        changeNotes: reason
      });
    return await storage.getPurchaseOrderById(id);
  }

  async function close(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "closed");

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "closed",
      closedAt: new Date(),
      closedBy: userId,
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "closed",
        changedBy: userId,
        changeNotes: notes || "PO closed"
      });
    return await storage.getPurchaseOrderById(id);
  }

  async function closeShort(id: number, reason: string, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (po.status !== "partially_received") {
      throw new PurchasingError("Can only close-short a partially received PO", 400);
    }
    if (!reason) throw new PurchasingError("Close-short reason is required", 400);

    // Close all remaining open lines
    const lines = await storage.getPurchaseOrderLines(id);
    for (const line of lines) {
      if (line.status === "open" || line.status === "partially_received") {
        await storage.updatePurchaseOrderLine(line.id, {
          status: "closed",
          closeShortReason: reason,
        });
      }
    }

    await storage.updatePurchaseOrderStatusWithHistory(id, {
      status: "closed",
      closedAt: new Date(),
      closedBy: userId,
      updatedBy: userId,
    }, {
        oldStatus: po.status,
        newStatus: "closed",
        changedBy: userId,
        changeNotes: `Closed short: ${reason}`
      });
    return await storage.getPurchaseOrderById(id);
  }

  // ── RECEIVING INTEGRATION ───────────────────────────────────────

  async function createReceiptFromPO(purchaseOrderId: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    const openStatuses = ["sent", "acknowledged", "partially_received"];
    if (!openStatuses.includes(po.status)) {
      throw new PurchasingError(`Cannot create receipt for PO in '${po.status}' status`, 400);
    }

    const lines = await storage.getPurchaseOrderLines(purchaseOrderId);
    const receivableLines = lines.filter((l: any) =>
      (l.status === "open" || l.status === "partially_received") &&
      (l.orderQty - (l.receivedQty || 0) - (l.cancelledQty || 0)) > 0
    );

    if (receivableLines.length === 0) {
      throw new PurchasingError("No receivable lines on this PO", 400);
    }

    // Create receiving order
    const receiptNumber = await storage.generateReceiptNumber();
    const receivingOrder = await storage.createReceivingOrder({
      receiptNumber,
      poNumber: po.poNumber,
      purchaseOrderId: po.id,
      sourceType: "po",
      vendorId: po.vendorId,
      warehouseId: po.warehouseId,
      status: "draft",
      expectedDate: po.expectedDeliveryDate || po.confirmedDeliveryDate,
      createdBy: userId,
    });

    // Auto-assign putaway locations from product_locations if available
    let productLocationMap = new Map<number, number>(); // productVariantId → warehouseLocationId
    try {
      const allProductLocations = await (storage as any).getAllProductLocations?.() ?? [];
      for (const pl of allProductLocations) {
        if (pl.productVariantId && pl.warehouseLocationId && pl.status === "active" && pl.isPrimary) {
          // Only use primary active locations
          if (!productLocationMap.has(pl.productVariantId)) {
            productLocationMap.set(pl.productVariantId, pl.warehouseLocationId);
          }
        }
      }
    } catch {
      // Non-critical — if product_locations lookup fails, just skip auto-assign
    }

    // Create receiving lines from PO lines
    const receivingLineData = receivableLines.map((poLine: any) => {
      const autoLocationId = productLocationMap.get(poLine.productVariantId) || null;
      return {
        receivingOrderId: receivingOrder.id,
        productVariantId: poLine.productVariantId,
        productId: poLine.productId,
        sku: poLine.sku,
        productName: poLine.productName,
        expectedQty: Math.ceil(
          (poLine.orderQty - (poLine.receivedQty || 0) - (poLine.cancelledQty || 0)) /
          (poLine.unitsPerUom || 1)
        ),
        receivedQty: 0,
        damagedQty: 0,
        purchaseOrderLineId: poLine.id,
        unitCost: poLine.unitCostCents,
        putawayLocationId: autoLocationId,
        status: "pending",
      };
    });

    await storage.bulkCreateReceivingLines(receivingLineData);
    return receivingOrder;
  }

  /**
   * Called by ReceivingService when a receiving order linked to a PO is closed.
   * Updates PO line received quantities and auto-transitions PO status.
   */
  async function onReceivingOrderClosed(receivingOrderId: number, receivingLines: Array<{
    receivingLineId: number;
    purchaseOrderLineId?: number;
    receivedQty: number;
    damagedQty?: number;
    unitCost?: number;
  }>) {
    // Find the PO
    // We'll look it up through the first line's PO linkage
    const poLineIds = receivingLines
      .map(l => l.purchaseOrderLineId)
      .filter(Boolean);

    if (poLineIds.length === 0) return; // Not a PO-linked receipt

    const firstPoLine = await storage.getPurchaseOrderLineById(poLineIds[0]!);
    if (!firstPoLine) return;

    const poId = firstPoLine.purchaseOrderId;
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) return;

    // Update each PO line's received/damaged quantities
    for (const rl of receivingLines) {
      if (!rl.purchaseOrderLineId) continue;
      const poLine = await storage.getPurchaseOrderLineById(rl.purchaseOrderLineId);
      if (!poLine) continue;

      const unitsPerUom = poLine.unitsPerUom || 1;
      const receivedPieces = rl.receivedQty * unitsPerUom;
      const damagedPieces = (rl.damagedQty || 0) * unitsPerUom;
      const newReceivedQty = (poLine.receivedQty || 0) + receivedPieces;
      const newDamagedQty = (poLine.damagedQty || 0) + damagedPieces;
      const remaining = poLine.orderQty - newReceivedQty - (poLine.cancelledQty || 0);

      const lineUpdates: any = {
        receivedQty: newReceivedQty,
        damagedQty: newDamagedQty,
        lastReceivedAt: new Date(),
      };

      if (!poLine.receivedDate) {
        lineUpdates.receivedDate = new Date();
      }

      if (remaining <= 0) {
        lineUpdates.status = "received";
        lineUpdates.fullyReceivedDate = new Date();
      } else if (newReceivedQty > 0) {
        lineUpdates.status = "partially_received";
      }

      await storage.updatePurchaseOrderLine(poLine.id, lineUpdates);

      // Create PO receipt record (qtyReceived in pieces, matching PO orderQty units)
      await storage.createPoReceipt({
        purchaseOrderId: poId,
        purchaseOrderLineId: poLine.id,
        receivingOrderId: receivingOrderId,
        receivingLineId: rl.receivingLineId,
        qtyReceived: receivedPieces,
        poUnitCostCents: poLine.unitCostCents,
        actualUnitCostCents: rl.unitCost || poLine.unitCostCents,
        varianceCents: (rl.unitCost || poLine.unitCostCents) - poLine.unitCostCents,
      });
    }

    // Recalculate totals
    await recalculateTotals(poId);

    // Auto-transition PO status
    const allLines = await storage.getPurchaseOrderLines(poId);
    const activeLines = allLines.filter((l: any) => l.status !== "cancelled");
    const allReceived = activeLines.every((l: any) => l.status === "received");
    const someReceived = activeLines.some((l: any) =>
      l.status === "received" || l.status === "partially_received"
    );

    if (allReceived) {
      await storage.updatePurchaseOrderStatusWithHistory(poId, {
        status: "received",
        actualDeliveryDate: new Date(),
      }, {
        oldStatus: po.status,
        newStatus: "received",
        changedBy: undefined,
        changeNotes: "All lines fully received"
      });
    } else if (someReceived && po.status !== "partially_received") {
      await storage.updatePurchaseOrderStatusWithHistory(poId, { status: "partially_received" }, {
        oldStatus: po.status,
        newStatus: "partially_received",
        changedBy: undefined,
        changeNotes: "Partial receipt"
      });
    }
  }

  // ── REORDER → PO ───────────────────────────────────────────────

  async function createPOFromReorder(items: Array<{
    productId: number;
    productVariantId: number;
    suggestedQty: number;
    vendorId?: number;
  }>, userId?: string) {
    // Group items by vendor (preferred vendor or specified)
    const vendorGroups = new Map<number, typeof items>();

    for (const item of items) {
      let vendorId = item.vendorId;

      if (!vendorId) {
        // Look up preferred vendor
        const vp = await storage.getPreferredVendorProduct(item.productId, item.productVariantId);
        if (vp) {
          vendorId = vp.vendorId;
        }
      }

      if (!vendorId) {
        throw new PurchasingError(
          `No vendor found for product variant ${item.productVariantId}. Set a preferred vendor first.`,
          400,
        );
      }

      if (!vendorGroups.has(vendorId)) {
        vendorGroups.set(vendorId, []);
      }
      vendorGroups.get(vendorId)!.push(item);
    }

    const createdPOs: any[] = [];

    for (const [vendorId, groupItems] of vendorGroups) {
      // Find existing draft PO for this vendor to append to
      const existingDrafts = await storage.getPurchaseOrders({ vendorId, status: "draft", limit: 1 });
      let po;
      let isNew = false;
      if (existingDrafts && existingDrafts.length > 0) {
        po = existingDrafts[0];
      } else {
        po = await createPO({ vendorId, createdBy: userId });
        isNew = true;
      }

      const existingLines = isNew ? [] : await storage.getPurchaseOrderLines(po.id);
      const lineDataToCreate: any[] = [];
      let linesUpdated = false;

      for (const item of groupItems) {
        const existingLine = existingLines.find((l: any) => l.productId === item.productId && l.productVariantId === item.productVariantId);
        
        if (existingLine) {
          // If the suggested qty is higher than the existing drafted qty, update the line
          if (item.suggestedQty > existingLine.orderQty) {
            await updateLine(existingLine.id, { orderQty: item.suggestedQty }, userId);
            linesUpdated = true;
          }
        } else {
          const vp = await storage.getPreferredVendorProduct(item.productId, item.productVariantId);
          lineDataToCreate.push({
            productId: item.productId,
            productVariantId: item.productVariantId,
            vendorProductId: vp?.id,
            orderQty: item.suggestedQty,
            unitCostCents: vp?.unitCostCents || 0,
            vendorSku: vp?.vendorSku,
          });
        }
      }

      if (lineDataToCreate.length > 0) {
        await addBulkLines(po.id, lineDataToCreate, userId);
      } else if (linesUpdated) {
        await recalculateTotals(po.id, userId);
      }

      const finalPo = await storage.getPurchaseOrderById(po.id);
      createdPOs.push(finalPo);
    }

    return createdPOs;
  }

  // ── ON-ORDER QUERY ──────────────────────────────────────────────

  async function getOnOrderQty(productVariantId: number): Promise<{
    onOrderQty: number;
    openPoCount: number;
    earliestExpectedDate: Date | null;
  }> {
    const openLines = await storage.getOpenPoLinesForVariant(productVariantId);
    let total = 0;
    let earliestDate: Date | null = null;
    const poIds = new Set<number>();

    for (const line of openLines) {
      const remaining = line.orderQty - (line.receivedQty || 0) - (line.cancelledQty || 0);
      if (remaining > 0) {
        total += remaining;
        poIds.add(line.purchaseOrderId);

        const lineDate = line.expectedDeliveryDate || line.promisedDate;
        if (lineDate && (!earliestDate || lineDate < earliestDate)) {
          earliestDate = lineDate;
        }
      }
    }

    return {
      onOrderQty: total,
      openPoCount: poIds.size,
      earliestExpectedDate: earliestDate,
    };
  }

  // ── PUBLIC API ──────────────────────────────────────────────────

  return {
    // PO CRUD
    createPO,
    updatePO,
    deletePO,
    getPurchaseOrders: (filters?: any) => storage.getPurchaseOrders(filters),
    getPurchaseOrdersCount: (filters?: any) => storage.getPurchaseOrdersCount(filters),
    getPurchaseOrderById: (id: number) => storage.getPurchaseOrderById(id),
    getPurchaseOrderByPoNumber: (poNumber: string) => storage.getPurchaseOrderByPoNumber(poNumber),

    // Lines
    addLine,
    updateIncotermsAndCharges,
    addBulkLines,
    updateLine,
    deleteLine,
    getPurchaseOrderLines: (poId: number) => storage.getPurchaseOrderLines(poId),
    getPurchaseOrderLineById: (id: number) => storage.getPurchaseOrderLineById(id),

    // Status transitions
    submit,
    returnToDraft,
    approve,
    send,
    sendToVendor,
    acknowledge,
    cancel,
    close,
    closeShort,

    // Recalculate
    recalculateTotals,

    // Receiving integration
    createReceiptFromPO,
    onReceivingOrderClosed,

    // Reorder → PO
    createPOFromReorder,

    // On-order query
    getOnOrderQty,

    // History / Audit
    getPoStatusHistory: (poId: number) => storage.getPoStatusHistory(poId),
    getPoRevisions: (poId: number) => storage.getPoRevisions(poId),
    getPoReceipts: (poId: number) => storage.getPoReceipts(poId),

    // Approval tiers
    getApprovalTiers: () => storage.getAllPoApprovalTiers(),
    getApprovalTierById: (id: number) => storage.getPoApprovalTierById(id),
    createApprovalTier: (data: any) => (storage as any).createPoApprovalTier(data),
    updateApprovalTier: (id: number, updates: any) => (storage as any).updatePoApprovalTier(id, updates),
    deleteApprovalTier: (id: number) => (storage as any).deletePoApprovalTier(id),

    // Vendor Products
    getVendorProducts: (filters?: any) => storage.getVendorProducts(filters),
    getVendorProductById: (id: number) => storage.getVendorProductById(id),
    getPreferredVendorProduct: (productId: number, variantId?: number) => storage.getPreferredVendorProduct(productId, variantId),
    createVendorProduct: (data: any) => (storage as any).createVendorProduct(data),
    updateVendorProduct: (id: number, updates: any) => (storage as any).updateVendorProduct(id, updates),
    deleteVendorProduct: (id: number) => (storage as any).deleteVendorProduct(id),
  };
}
