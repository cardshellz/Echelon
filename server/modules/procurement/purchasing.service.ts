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

import { eq, and, sql } from "drizzle-orm";
import {
  inboundShipmentLines,
  landedCostSnapshots,
  vendorInvoiceLines,
  purchaseOrders as purchaseOrdersTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  poStatusHistory as poStatusHistoryTable,
  poEvents as poEventsTable,
  vendorProducts as vendorProductsTable,
  warehouseSettings as warehouseSettingsTable,
} from "@shared/schema";
import { Decimal } from "decimal.js";
import {
  centsToMills,
  millsToCents,
  computeLineTotalCentsFromMills,
} from "@shared/utils/money";

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

  // calculateLineCosts
  //
  // Unit cost source-of-truth resolution:
  //   * If `unitCostMills` is provided and > 0, it is authoritative and the
  //     line subtotal is computed via computeLineTotalCentsFromMills (integer
  //     half-up at the sub-cent boundary). `unitCostCents` (if also passed)
  //     is IGNORED here — the caller is responsible for cross-checking
  //     mills vs. cents agreement at the input boundary (e.g.
  //     validateCreateWithLinesInput rejects disagreeing pairs with 400).
  //   * Otherwise (legacy callers, or mills = 0), we fall back to the
  //     cents-based Decimal path. Preserves back-compat with every existing
  //     caller that still passes unit_cost_cents only.
  //
  // Discount and tax continue to apply at the cent-subtotal level — those
  // fields stay in cents per spec ("Everything else stays in CENTS").
  function calculateLineCosts(line: {
    orderQty: number;
    unitCostCents: number;
    unitCostMills?: number | null;
    discountPercent?: string | number;
    taxRatePercent?: string | number;
  }) {
    const qty = Number(line.orderQty) || 0;
    const millsAuthoritative =
      typeof line.unitCostMills === "number" &&
      Number.isInteger(line.unitCostMills) &&
      line.unitCostMills > 0;

    const subtotalCents = millsAuthoritative
      ? computeLineTotalCentsFromMills(line.unitCostMills as number, qty)
      : qty * (Number(line.unitCostCents) || 0);

    const subtotal = new Decimal(subtotalCents);
    const discountPct = new Decimal(line.discountPercent || 0);
    const discount = subtotal.times(discountPct).dividedBy(100).round();
    const taxable = subtotal.minus(discount);
    const taxPct = new Decimal(line.taxRatePercent || 0);
    const tax = taxable.times(taxPct).dividedBy(100).round();

    return {
      subtotalCents: subtotal.toNumber(),
      discountCents: discount.toNumber(),
      taxCents: tax.toNumber(),
      lineTotalCents: taxable.plus(tax).toNumber(),
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

    // recalculateTotals does NOT change PO status; it only refreshes totals.
    // Use the plain update helper so we don't write a spurious po_status_history
    // row (which would violate the to_status NOT NULL constraint when called
    // with no historyData). Regression of commit 4c0a3cc.
    return await storage.updatePurchaseOrder(purchaseOrderId, {
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
      return await storage.updatePurchaseOrder(id, {
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
      return await storage.updatePurchaseOrderStatusWithHistory(id, {
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
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "draft");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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
  }

  async function approve(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "approved");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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
  }

  async function send(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "sent");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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
    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "acknowledged");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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
  }

  async function close(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "closed");

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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

    return await storage.updatePurchaseOrderStatusWithHistory(id, {
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

    // Create receiving lines from PO lines.
    //
    // Stamp BOTH cents and mills on the new receiving_line so receive-time
    // precision matches the PO line. Mills is authoritative when present;
    // otherwise we derive mills from cents via centsToMills (no rounding).
    // Keeps receiving_lines consistent with the (post-0562) contract in
    // receiving.service.ts: mills is the source of truth, cents mirrors.
    const receivingLineData = receivableLines.map((poLine: any) => {
      const autoLocationId = productLocationMap.get(poLine.productVariantId) || null;
      const hasPoMills =
        typeof poLine.unitCostMills === "number" &&
        Number.isInteger(poLine.unitCostMills) &&
        poLine.unitCostMills >= 0;
      const unitCostMills = hasPoMills
        ? (poLine.unitCostMills as number)
        : (typeof poLine.unitCostCents === "number" && poLine.unitCostCents >= 0
            ? centsToMills(poLine.unitCostCents)
            : null);
      const unitCost = hasPoMills
        ? millsToCents(poLine.unitCostMills as number)
        : (typeof poLine.unitCostCents === "number" ? poLine.unitCostCents : null);
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
        unitCost,
        unitCostMills,
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

  // ── PROCUREMENT SETTINGS (Spec A) ───────────────────────────────────────
  //
  // These live on inventory.warehouse_settings (DEFAULT row) per spec §12.
  // Whitelisted here to prevent arbitrary key writes from the PATCH endpoint.
  // Only `requireApproval` and `autoSendOnApprove` affect Spec A directly;
  // the remaining keys are scaffolded for Specs B and C.

  const PROCUREMENT_SETTING_KEYS = [
    "requireApproval",
    "autoSendOnApprove",
    "requireAcknowledgeBeforeReceive",
    "hideIncotermsDomestic",
    "enableShipmentTracking",
    "autoPutawayLocation",
    "autoCloseOnReconcile",
    "oneClickReceiveStart",
    "useNewPoEditor",
  ] as const;
  type ProcurementSettingKey = typeof PROCUREMENT_SETTING_KEYS[number];
  const PROCUREMENT_SETTING_KEY_SET = new Set<string>(PROCUREMENT_SETTING_KEYS);

  // Defaults mirror the NOT NULL DEFAULT clauses in migration 0557. Returned
  // when no DEFAULT row exists yet (new install, test DB).
  const PROCUREMENT_SETTING_DEFAULTS: Record<ProcurementSettingKey, boolean> = {
    requireApproval: false,
    autoSendOnApprove: true,
    requireAcknowledgeBeforeReceive: false,
    hideIncotermsDomestic: true,
    enableShipmentTracking: true,
    autoPutawayLocation: true,
    autoCloseOnReconcile: true,
    oneClickReceiveStart: true,
    useNewPoEditor: false,
  };

  async function getProcurementSettings(): Promise<Record<ProcurementSettingKey, boolean>> {
    const rows = await db
      .select({
        requireApproval: warehouseSettingsTable.requireApproval,
        autoSendOnApprove: warehouseSettingsTable.autoSendOnApprove,
        requireAcknowledgeBeforeReceive: warehouseSettingsTable.requireAcknowledgeBeforeReceive,
        hideIncotermsDomestic: warehouseSettingsTable.hideIncotermsDomestic,
        enableShipmentTracking: warehouseSettingsTable.enableShipmentTracking,
        autoPutawayLocation: warehouseSettingsTable.autoPutawayLocation,
        autoCloseOnReconcile: warehouseSettingsTable.autoCloseOnReconcile,
        oneClickReceiveStart: warehouseSettingsTable.oneClickReceiveStart,
        useNewPoEditor: warehouseSettingsTable.useNewPoEditor,
      })
      .from(warehouseSettingsTable)
      .where(eq(warehouseSettingsTable.warehouseCode, "DEFAULT"))
      .limit(1);

    if (rows.length === 0) {
      // Fallback: first row. Covers edge cases where no DEFAULT code exists.
      const fallback = await db
        .select({
          requireApproval: warehouseSettingsTable.requireApproval,
          autoSendOnApprove: warehouseSettingsTable.autoSendOnApprove,
          requireAcknowledgeBeforeReceive: warehouseSettingsTable.requireAcknowledgeBeforeReceive,
          hideIncotermsDomestic: warehouseSettingsTable.hideIncotermsDomestic,
          enableShipmentTracking: warehouseSettingsTable.enableShipmentTracking,
          autoPutawayLocation: warehouseSettingsTable.autoPutawayLocation,
          autoCloseOnReconcile: warehouseSettingsTable.autoCloseOnReconcile,
          oneClickReceiveStart: warehouseSettingsTable.oneClickReceiveStart,
          useNewPoEditor: warehouseSettingsTable.useNewPoEditor,
        })
        .from(warehouseSettingsTable)
        .limit(1);
      if (fallback.length === 0) return { ...PROCUREMENT_SETTING_DEFAULTS };
      return fallback[0] as Record<ProcurementSettingKey, boolean>;
    }
    return rows[0] as Record<ProcurementSettingKey, boolean>;
  }

  async function updateProcurementSetting(
    key: string,
    value: boolean,
    userId?: string,
  ): Promise<Record<ProcurementSettingKey, boolean>> {
    if (!PROCUREMENT_SETTING_KEY_SET.has(key)) {
      throw new PurchasingError(`Unknown procurement setting: ${key}`, 400);
    }
    if (typeof value !== "boolean") {
      throw new PurchasingError(`Procurement setting '${key}' must be a boolean`, 400);
    }
    // Drizzle column names match the schema keys. Use a dynamic set object.
    const patch: Record<string, any> = { [key]: value, updatedAt: new Date() };
    const result = await db
      .update(warehouseSettingsTable)
      .set(patch)
      .where(eq(warehouseSettingsTable.warehouseCode, "DEFAULT"))
      .returning();
    // If no DEFAULT row yet, apply to first row.
    if (result.length === 0) {
      await db
        .update(warehouseSettingsTable)
        .set(patch);
    }
    console.log(`[Purchasing] procurement setting "${key}" set to ${value} by ${userId ?? "system"}`);
    return getProcurementSettings();
  }

  // ── PO EVENT STREAM (Spec A) ─────────────────────────────────────────────
  //
  // Append-only audit stream. Rule #8 (Auditability): every event captures
  // actor (user_id or 'system:auto') and timestamp. Before/after state goes
  // in payload when meaningful.

  function resolveActor(userId: string | null | undefined): { actorType: "user" | "system"; actorId: string } {
    if (userId && userId.length > 0) {
      return { actorType: "user", actorId: userId };
    }
    return { actorType: "system", actorId: "system:auto" };
  }

  // Emit outside of a caller-owned transaction. Prefer the txn variant inside
  // create/send flows so the event lands atomically with the state change.
  async function emitPoEvent(
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const { actorType, actorId } = resolveActor(userId);
    await db.insert(poEventsTable).values({
      poId,
      eventType,
      actorType,
      actorId,
      payloadJson: payload ?? null,
    });
  }

  async function emitPoEventTx(
    tx: any,
    poId: number,
    eventType: string,
    userId: string | null | undefined,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const { actorType, actorId } = resolveActor(userId);
    await tx.insert(poEventsTable).values({
      poId,
      eventType,
      actorType,
      actorId,
      payloadJson: payload ?? null,
    });
  }

  // ── NEW INLINE-CREATE FLOW (Spec A) ───────────────────────────────────
  //
  // Replaces the two-step "createPO" + "addBulkLines" flow with a single
  // transactional create-with-lines. Rule #3 (Data Integrity): all money
  // arrives in integer cents, validated via zod-style checks at the boundary.
  // Rule #7 (DB Discipline): header + lines + status history + po_events are
  // inserted in one transaction so a partial row can never leak.

  type CreatePurchaseOrderWithLinesInput = {
    vendorId: number;
    warehouseId?: number;
    poType?: string;
    priority?: string;
    expectedDeliveryDate?: Date | null;
    incoterms?: string | null;
    vendorNotes?: string | null;
    internalNotes?: string | null;
    lines: Array<{
      productVariantId: number;
      orderQty: number;
      // Per-unit cost. Either or both may be provided:
      //   * unitCostMills is authoritative (4-decimal precision).
      //   * unitCostCents is accepted for legacy/back-compat callers.
      //   * If both are provided, they MUST agree (cents == round(mills/100)).
      unitCostCents?: number;
      unitCostMills?: number;
      vendorProductId?: number | null;
      description?: string | null;
    }>;
  };

  function validateCreateWithLinesInput(input: CreatePurchaseOrderWithLinesInput): void {
    if (!input || typeof input !== "object") {
      throw new PurchasingError("Request body is required", 400);
    }
    if (!Number.isInteger(input.vendorId) || input.vendorId <= 0) {
      throw new PurchasingError("vendor_id is required", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new PurchasingError("At least one line is required", 400);
    }
    for (const [idx, line] of input.lines.entries()) {
      const label = `lines[${idx}]`;
      if (!line || typeof line !== "object") {
        throw new PurchasingError(`${label} is invalid`, 400);
      }
      if (!Number.isInteger(line.productVariantId) || line.productVariantId <= 0) {
        throw new PurchasingError(`${label}.product_variant_id is required`, 400);
      }
      if (!Number.isInteger(line.orderQty) || line.orderQty <= 0) {
        throw new PurchasingError(`${label}.quantity_ordered must be a positive integer`, 400);
      }

      const hasCents =
        line.unitCostCents !== undefined && line.unitCostCents !== null;
      const hasMills =
        line.unitCostMills !== undefined && line.unitCostMills !== null;

      if (!hasCents && !hasMills) {
        throw new PurchasingError(
          `${label}.unit_cost_cents or unit_cost_mills is required`,
          400,
        );
      }
      if (hasMills) {
        if (!Number.isInteger(line.unitCostMills) || (line.unitCostMills as number) < 0) {
          throw new PurchasingError(
            `${label}.unit_cost_mills must be a non-negative integer`,
            400,
          );
        }
      }
      if (hasCents) {
        if (!Number.isInteger(line.unitCostCents) || (line.unitCostCents as number) < 0) {
          throw new PurchasingError(
            `${label}.unit_cost_cents must be a non-negative integer`,
            400,
          );
        }
      }
      // If both are provided, reject a disagreeing pair up front (Rule #3).
      // The mills precision is authoritative; cents must be the half-up
      // rounding of it. This prevents a client from drifting the two
      // values and silently corrupting the stored cost.
      if (hasMills && hasCents) {
        const expectedCents = millsToCents(line.unitCostMills as number);
        if (expectedCents !== (line.unitCostCents as number)) {
          throw new PurchasingError(
            `${label}: unit_cost_mills (${line.unitCostMills}) and unit_cost_cents (${line.unitCostCents}) disagree; expected cents=${expectedCents}`,
            400,
          );
        }
      }
    }
  }

  async function createPurchaseOrderWithLines(
    input: CreatePurchaseOrderWithLinesInput,
    userId?: string,
  ): Promise<any> {
    validateCreateWithLinesInput(input);

    const vendor = await storage.getVendorById(input.vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    // Resolve product + variant info up-front (outside the txn) so we can
    // cache SKU + product name on each line and fail fast on missing refs.
    // Per-unit cost: mills is authoritative; cents is derived (rounded
    // half-up) for back-compat writes into unit_cost_cents.
    const resolvedLines = await Promise.all(
      input.lines.map(async (line) => {
        const variant = await storage.getProductVariantById(line.productVariantId);
        if (!variant) {
          throw new PurchasingError(`Product variant ${line.productVariantId} not found`, 404);
        }
        const product = await storage.getProductById(variant.productId);
        if (!product) {
          throw new PurchasingError(`Product ${variant.productId} not found`, 404);
        }
        // Normalize to BOTH mills and cents. Whichever the caller sent
        // becomes the anchor; the other is derived.
        const hasMills =
          typeof line.unitCostMills === "number" && line.unitCostMills >= 0;
        const unitCostMills = hasMills
          ? (line.unitCostMills as number)
          : centsToMills(Number(line.unitCostCents) || 0);
        const unitCostCents = hasMills
          ? millsToCents(unitCostMills)
          : Number(line.unitCostCents) || 0;
        const costs = calculateLineCosts({
          orderQty: line.orderQty,
          unitCostCents,
          unitCostMills,
        });
        return { line, variant, product, costs, unitCostMills, unitCostCents };
      }),
    );

    const poNumber = await storage.generatePoNumber();

    const subtotalCents = resolvedLines.reduce(
      (sum, r) => sum + BigInt(r.costs.lineTotalCents),
      BigInt(0),
    );

    // Single transaction: header + lines + status history + po_events['created']
    const created = await db.transaction(async (tx: any) => {
      const [header] = await tx
        .insert(purchaseOrdersTable)
        .values({
          poNumber,
          vendorId: input.vendorId,
          warehouseId: input.warehouseId ?? null,
          status: "draft",
          poType: input.poType ?? "standard",
          priority: input.priority ?? "normal",
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          incoterms: input.incoterms ?? null,
          vendorNotes: input.vendorNotes ?? null,
          internalNotes: input.internalNotes ?? null,
          currency: vendor.currency || "USD",
          paymentTermsDays: vendor.paymentTermsDays,
          paymentTermsType: vendor.paymentTermsType,
          shipFromAddress: vendor.shipFromAddress,
          subtotalCents: Number(subtotalCents),
          totalCents: Number(subtotalCents), // no header discount/tax/shipping on inline create
          lineCount: resolvedLines.length,
          createdBy: userId ?? null,
          updatedBy: userId ?? null,
        })
        .returning();

      const lineRows = resolvedLines.map((r, idx) => ({
        purchaseOrderId: header.id,
        lineNumber: idx + 1,
        productId: r.variant.productId,
        productVariantId: r.variant.id,
        vendorProductId: r.line.vendorProductId ?? null,
        sku: r.variant.sku,
        productName: r.product.name,
        description: r.line.description ?? null,
        unitOfMeasure: r.variant.name?.split(" ")[0]?.toLowerCase() ?? "each",
        unitsPerUom: r.variant.unitsPerVariant || 1,
        orderQty: r.line.orderQty,
        // Write BOTH mills and cents on INSERT (spec): mills is authoritative,
        // cents is the rounded back-compat mirror.
        unitCostCents: r.unitCostCents,
        unitCostMills: r.unitCostMills,
        discountCents: r.costs.discountCents,
        taxCents: r.costs.taxCents,
        lineTotalCents: r.costs.lineTotalCents,
        status: "open" as const,
      }));
      await tx.insert(purchaseOrderLinesTable).values(lineRows);

      // Status history: creation row (from NULL -> 'draft').
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: header.id,
        fromStatus: null,
        toStatus: "draft",
        changedBy: userId ?? null,
        changeNotes: "PO created (inline)",
      });

      // Event stream.
      await emitPoEventTx(tx, header.id, "created", userId, {
        source: "inline_editor",
        line_count: resolvedLines.length,
        subtotal_cents: Number(subtotalCents),
      });

      return header;
    });

    return created;
  }

  // ── NEW SEND FLOW (Spec A) ───────────────────────────────────────────────
  //
  // Replaces Submit -> Approve -> Send with a single call that honors the
  // current procurement settings:
  //  - require_approval=true AND tier matches on total  → pending_approval
  //  - else  → cascade draft→approved→sent in one transaction
  //
  // PDF is STUBBED. Returning { pdf_placeholder: true, reason } keeps the
  // wire contract stable for when real generation lands.

  type SendPurchaseOrderResult = {
    po: any;
    status: string;
    pdf: { pdf_placeholder: true; reason: string } | null;
    pendingApproval: boolean;
  };

  async function sendPurchaseOrder(
    poId: number,
    userId?: string,
  ): Promise<SendPurchaseOrderResult> {
    const po = await storage.getPurchaseOrderById(poId);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (po.status !== "draft" && po.status !== "approved") {
      throw new PurchasingError(
        `Cannot send PO in '${po.status}' status (must be draft or approved)`,
        400,
      );
    }

    // Validate at least one active line.
    const lines = await storage.getPurchaseOrderLines(poId);
    const activeLines = lines.filter((l: any) => l.status !== "cancelled" && l.orderQty > 0);
    if (activeLines.length === 0) {
      throw new PurchasingError("PO must have at least one line with quantity > 0", 400);
    }

    // Refresh totals before the approval check.
    await recalculateTotals(poId, userId);
    const fresh = await storage.getPurchaseOrderById(poId);
    const totalCents = Number(fresh.totalCents || 0);

    const settings = await getProcurementSettings();

    // Approval gate. A matching tier + require_approval routes through
    // pending_approval and does NOT generate a PDF.
    if (settings.requireApproval && po.status === "draft") {
      const tier = await storage.getMatchingApprovalTier(totalCents);
      if (tier) {
        const updated = await db.transaction(async (tx: any) => {
          const [row] = await tx
            .update(purchaseOrdersTable)
            .set({
              status: "pending_approval",
              approvalTierId: tier.id,
              updatedBy: userId ?? null,
              updatedAt: new Date(),
            })
            .where(eq(purchaseOrdersTable.id, poId))
            .returning();
          await tx.insert(poStatusHistoryTable).values({
            purchaseOrderId: poId,
            fromStatus: po.status,
            toStatus: "pending_approval",
            changedBy: userId ?? null,
            changeNotes: `Submitted for approval (tier: ${tier.tierName})`,
          });
          await emitPoEventTx(tx, poId, "submitted", userId, {
            tier_id: tier.id,
            tier_name: tier.tierName,
            total_cents: totalCents,
          });
          return row;
        });
        return {
          po: updated,
          status: "pending_approval",
          pdf: null,
          pendingApproval: true,
        };
      }
    }

    // Cascade draft → approved → sent atomically.
    const updated = await db.transaction(async (tx: any) => {
      let currentStatus = po.status;
      if (currentStatus === "draft") {
        await tx
          .update(purchaseOrdersTable)
          .set({
            status: "approved",
            approvedBy: userId ?? null,
            approvedAt: new Date(),
            approvalNotes: settings.requireApproval
              ? "Auto-approved (no matching tier)"
              : "Auto-approved (approval not required)",
            updatedBy: userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(purchaseOrdersTable.id, poId));
        await tx.insert(poStatusHistoryTable).values({
          purchaseOrderId: poId,
          fromStatus: currentStatus,
          toStatus: "approved",
          changedBy: userId ?? null,
          changeNotes: settings.requireApproval
            ? "Auto-approved (no matching tier)"
            : "Auto-approved (approval not required)",
        });
        await emitPoEventTx(tx, poId, "approved", userId, {
          auto: true,
          require_approval: settings.requireApproval,
          total_cents: totalCents,
        });
        currentStatus = "approved";
      }

      const [row] = await tx
        .update(purchaseOrdersTable)
        .set({
          status: "sent",
          orderDate: new Date(),
          sentToVendorAt: new Date(),
          updatedBy: userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrdersTable.id, poId))
        .returning();
      await tx.insert(poStatusHistoryTable).values({
        purchaseOrderId: poId,
        fromStatus: currentStatus,
        toStatus: "sent",
        changedBy: userId ?? null,
        changeNotes: "Sent to vendor (PDF placeholder)",
      });
      await emitPoEventTx(tx, poId, "sent_to_vendor", userId, {
        method: "pdf_placeholder",
        pdf_placeholder: true,
      });
      return row;
    });

    // PDF STUB. Do not generate a real PDF. The real generator will land in a
    // later pass; callers should branch on `pdf.pdf_placeholder`.
    return {
      po: updated,
      status: "sent",
      pdf: {
        pdf_placeholder: true,
        reason: "PDF generation not yet implemented",
      },
      pendingApproval: false,
    };
  }

  // ── DUPLICATE (Spec A) ──────────────────────────────────────────────────
  //
  // Duplicate an existing PO's lines into a fresh draft. Per spec §11.4 the
  // default behavior is to refresh unit cost from the current vendor catalog
  // when one exists; otherwise we fall back to the source line's cost.

  async function duplicatePurchaseOrder(
    sourceId: number,
    overrides: { vendorId?: number; expectedDeliveryDate?: Date | null } | undefined,
    userId?: string,
  ): Promise<any> {
    const source = await storage.getPurchaseOrderById(sourceId);
    if (!source) throw new PurchasingError("Source purchase order not found", 404);
    const sourceLines = await storage.getPurchaseOrderLines(sourceId);
    if (sourceLines.length === 0) {
      throw new PurchasingError("Source PO has no lines to duplicate", 400);
    }

    const targetVendorId = overrides?.vendorId ?? source.vendorId;

    // Refresh costs from the current vendor catalog when available.
    // Mills-aware: prefer catalog mills → source mills → derive from cents.
    const dupLines: CreatePurchaseOrderWithLinesInput["lines"] = [];
    for (const src of sourceLines) {
      if (src.status === "cancelled") continue;
      // Start from source line's mills when present, else derive from cents.
      let unitCostMills: number =
        typeof src.unitCostMills === "number" && src.unitCostMills >= 0
          ? src.unitCostMills
          : centsToMills(Number(src.unitCostCents || 0));
      let vendorProductId: number | null = null;
      try {
        const vp = await storage.getPreferredVendorProduct(src.productId, src.productVariantId);
        if (vp && vp.vendorId === targetVendorId) {
          if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
            unitCostMills = vp.unitCostMills;
          } else if (typeof vp.unitCostCents === "number") {
            unitCostMills = centsToMills(vp.unitCostCents);
          }
          vendorProductId = vp.id ?? null;
        }
      } catch {
        // Non-fatal: fall back to source cost.
      }
      dupLines.push({
        productVariantId: src.productVariantId,
        orderQty: src.orderQty,
        unitCostMills,
        // Include cents (derived) so downstream validators that still look
        // at cents don't choke. They must agree per validator rule.
        unitCostCents: millsToCents(unitCostMills),
        vendorProductId,
        description: src.description ?? null,
      });
    }

    if (dupLines.length === 0) {
      throw new PurchasingError("Source PO has no active lines to duplicate", 400);
    }

    const created = await createPurchaseOrderWithLines(
      {
        vendorId: targetVendorId,
        poType: source.poType ?? "standard",
        priority: source.priority ?? "normal",
        expectedDeliveryDate: overrides?.expectedDeliveryDate ?? null,
        incoterms: source.incoterms ?? null,
        vendorNotes: source.vendorNotes ?? null,
        internalNotes: source.internalNotes ?? null,
        lines: dupLines,
      },
      userId,
    );

    await emitPoEvent(created.id, "duplicated_from", userId, {
      source_po_id: source.id,
      source_po_number: source.poNumber,
      line_count: dupLines.length,
    });

    return created;
  }

  // ── BULK UPSERT VENDOR CATALOG (Spec A follow-up) ─────────────────
  //
  // Idempotent bulk upsert of entries into procurement.vendor_products for a
  // single vendor. Backs the "Add to catalog?" modal on PO save.
  //
  // Rule #3: unitCostCents is a required integer — no floats.
  // Rule #6: idempotency is enforced at the route layer via Idempotency-Key.
  // Rule #7: the whole batch runs inside one transaction; a failure on any
  //          entry rolls back the batch.
  // Rule #8: every create/update emits a structured audit log line with the
  //          actor and before/after state.

  type BulkCatalogEntry = {
    productId: number;
    productVariantId?: number | null;
    // Per-unit cost. Either or both may be provided:
    //   * unitCostMills is authoritative (4-decimal precision).
    //   * unitCostCents is accepted for legacy/back-compat callers.
    // If both are provided they must agree (cents == millsToCents(mills)).
    unitCostCents?: number;
    unitCostMills?: number;
    packSize?: number;
    moq?: number;
    leadTimeDays?: number;
    vendorSku?: string | null;
    vendorProductName?: string | null;
    isPreferred?: boolean;
  };

  type BulkCatalogResult = {
    created: Array<{
      vendorProductId: number;
      productId: number;
      productVariantId: number | null;
    }>;
    updated: Array<{
      vendorProductId: number;
      productId: number;
      productVariantId: number | null;
    }>;
    skipped: Array<{
      productId: number;
      productVariantId: number | null;
      reason: string;
    }>;
  };

  async function bulkUpsertVendorCatalog(
    vendorId: number,
    entries: BulkCatalogEntry[],
    userId: string | null | undefined,
  ): Promise<BulkCatalogResult> {
    if (!Number.isInteger(vendorId) || vendorId <= 0) {
      throw new PurchasingError("vendorId is required", 400);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new PurchasingError("entries must be a non-empty array", 400);
    }

    // Boundary validation (Rule #4). Reject the whole request on any bad
    // entry so partial writes can't happen.
    for (const [idx, e] of entries.entries()) {
      if (!Number.isInteger(e.productId) || e.productId <= 0) {
        throw new PurchasingError(`entries[${idx}].productId must be a positive integer`, 400);
      }
      if (
        e.productVariantId !== undefined &&
        e.productVariantId !== null &&
        (!Number.isInteger(e.productVariantId) || e.productVariantId <= 0)
      ) {
        throw new PurchasingError(
          `entries[${idx}].productVariantId must be a positive integer or null`,
          400,
        );
      }
      const hasCents = e.unitCostCents !== undefined && e.unitCostCents !== null;
      const hasMills = e.unitCostMills !== undefined && e.unitCostMills !== null;
      if (!hasCents && !hasMills) {
        throw new PurchasingError(
          `entries[${idx}].unitCostCents or unitCostMills is required`,
          400,
        );
      }
      if (hasCents && (!Number.isInteger(e.unitCostCents) || (e.unitCostCents as number) < 0)) {
        // Rule #3: integer cents only.
        throw new PurchasingError(
          `entries[${idx}].unitCostCents must be a non-negative integer (cents)`,
          400,
        );
      }
      if (hasMills && (!Number.isInteger(e.unitCostMills) || (e.unitCostMills as number) < 0)) {
        throw new PurchasingError(
          `entries[${idx}].unitCostMills must be a non-negative integer (mills)`,
          400,
        );
      }
      if (hasCents && hasMills) {
        const expected = millsToCents(e.unitCostMills as number);
        if (expected !== (e.unitCostCents as number)) {
          throw new PurchasingError(
            `entries[${idx}]: unitCostMills (${e.unitCostMills}) and unitCostCents (${e.unitCostCents}) disagree; expected cents=${expected}`,
            400,
          );
        }
      }
      if (e.packSize !== undefined && (!Number.isInteger(e.packSize) || e.packSize <= 0)) {
        throw new PurchasingError(`entries[${idx}].packSize must be a positive integer`, 400);
      }
      if (e.moq !== undefined && (!Number.isInteger(e.moq) || e.moq <= 0)) {
        throw new PurchasingError(`entries[${idx}].moq must be a positive integer`, 400);
      }
      if (
        e.leadTimeDays !== undefined &&
        (!Number.isInteger(e.leadTimeDays) || e.leadTimeDays < 0)
      ) {
        throw new PurchasingError(
          `entries[${idx}].leadTimeDays must be a non-negative integer`,
          400,
        );
      }
    }

    const vendor = await storage.getVendorById(vendorId);
    if (!vendor) throw new PurchasingError("Vendor not found", 404);

    const { actorType, actorId } = resolveActor(userId);
    const timestamp = new Date().toISOString();

    const result: BulkCatalogResult = { created: [], updated: [], skipped: [] };
    const auditLogs: Array<Record<string, unknown>> = [];

    await db.transaction(async (tx: any) => {
      for (const entry of entries) {
        const variantId =
          entry.productVariantId === undefined || entry.productVariantId === null
            ? null
            : entry.productVariantId;

        // Look up existing row by (vendorId, productId, productVariantId).
        // The unique index vendor_products_vendor_product_variant_idx
        // guarantees at most one match.
        const matchConditions = [
          eq(vendorProductsTable.vendorId, vendorId),
          eq(vendorProductsTable.productId, entry.productId),
          variantId === null
            ? sql`${vendorProductsTable.productVariantId} IS NULL`
            : eq(vendorProductsTable.productVariantId, variantId),
        ];
        const existingRows = await tx
          .select()
          .from(vendorProductsTable)
          .where(and(...matchConditions))
          .limit(1);
        const existing = existingRows[0];

        // Normalize to both precisions. Mills is authoritative when
        // provided; cents is derived. If only cents is provided, derive
        // mills exactly (cents × 100).
        const entryHasMills =
          typeof entry.unitCostMills === "number" && entry.unitCostMills >= 0;
        const entryMills = entryHasMills
          ? (entry.unitCostMills as number)
          : centsToMills(Number(entry.unitCostCents) || 0);
        const entryCents = entryHasMills
          ? millsToCents(entryMills)
          : Number(entry.unitCostCents) || 0;

        if (existing) {
          // Don't overwrite non-null fields with null (per spec). Only
          // fields explicitly provided (not undefined) overwrite.
          const patch: Record<string, unknown> = {
            unitCostCents: entryCents,
            unitCostMills: entryMills,
            isActive: 1,
            updatedAt: new Date(),
          };
          if (entry.packSize !== undefined) patch.packSize = entry.packSize;
          if (entry.moq !== undefined) patch.moq = entry.moq;
          if (entry.leadTimeDays !== undefined) patch.leadTimeDays = entry.leadTimeDays;
          if (entry.vendorSku !== undefined && entry.vendorSku !== null) {
            patch.vendorSku = entry.vendorSku;
          }
          if (
            entry.vendorProductName !== undefined &&
            entry.vendorProductName !== null
          ) {
            patch.vendorProductName = entry.vendorProductName;
          }
          if (entry.isPreferred !== undefined) {
            patch.isPreferred = entry.isPreferred ? 1 : 0;
          }

          const updatedRows = await tx
            .update(vendorProductsTable)
            .set(patch)
            .where(eq(vendorProductsTable.id, existing.id))
            .returning();
          const row = updatedRows[0];
          result.updated.push({
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          });
          auditLogs.push({
            event: "vendor_catalog.updated",
            actorType,
            actorId,
            timestamp,
            vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
            before: {
              unitCostCents: existing.unitCostCents,
              packSize: existing.packSize,
              moq: existing.moq,
              leadTimeDays: existing.leadTimeDays,
              isPreferred: existing.isPreferred,
              vendorSku: existing.vendorSku,
            },
            after: {
              unitCostCents: row.unitCostCents,
              packSize: row.packSize,
              moq: row.moq,
              leadTimeDays: row.leadTimeDays,
              isPreferred: row.isPreferred,
              vendorSku: row.vendorSku,
            },
          });
        } else {
          const insertedRows = await tx
            .insert(vendorProductsTable)
            .values({
              vendorId,
              productId: entry.productId,
              productVariantId: variantId,
              vendorSku: entry.vendorSku ?? null,
              vendorProductName: entry.vendorProductName ?? null,
              unitCostCents: entryCents,
              unitCostMills: entryMills,
              packSize: entry.packSize ?? 1,
              moq: entry.moq ?? 1,
              leadTimeDays: entry.leadTimeDays ?? null,
              isPreferred: entry.isPreferred ? 1 : 0,
              isActive: 1,
            })
            .returning();
          const row = insertedRows[0];
          result.created.push({
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
          });
          auditLogs.push({
            event: "vendor_catalog.created",
            actorType,
            actorId,
            timestamp,
            vendorId,
            vendorProductId: row.id,
            productId: row.productId,
            productVariantId: row.productVariantId ?? null,
            unitCostCents: row.unitCostCents,
            packSize: row.packSize,
            moq: row.moq,
            leadTimeDays: row.leadTimeDays,
            isPreferred: row.isPreferred,
          });
        }
      }
    });

    // Emit audit trail AFTER the tx commits. Rule #8: structured JSON.
    for (const line of auditLogs) {
      console.log(JSON.stringify(line));
    }

    return result;
  }

  // ── NEW-PO PRELOAD (Spec A §10.1) ───────────────────────────────────
  //
  // Returns vendor + suggested lines in one round trip so the editor page
  // can render without a cascade of follow-up fetches.

  type PreloadLine = {
    productVariantId: number;
    productName: string;
    sku: string | null;
    variantDescription: string | null;
    uomLabel: string | null;
    suggestedQty: number;
    // Per-unit cost is returned in BOTH units so the editor can use mills
    // directly while legacy readers can continue consuming cents.
    unitCostCents: number;
    unitCostMills: number;
    catalogSource: "vendor_catalog" | "product_default" | "duplicate" | "manual";
  };

  async function getNewPoPreload(params: {
    vendorId?: number;
    variantIds?: number[];
    duplicateFrom?: number;
  }): Promise<{
    vendor: any | null;
    lines: PreloadLine[];
    sourcePo: { poNumber: string; note: string } | null;
  }> {
    const { vendorId, variantIds, duplicateFrom } = params;

    // Duplicate path takes precedence: use source PO's vendor + lines.
    if (duplicateFrom !== undefined) {
      const source = await storage.getPurchaseOrderById(duplicateFrom);
      if (!source) throw new PurchasingError("Source purchase order not found", 404);
      const [vendor, srcLines] = await Promise.all([
        storage.getVendorById(source.vendorId),
        storage.getPurchaseOrderLines(duplicateFrom),
      ]);
      const lines: PreloadLine[] = [];
      for (const src of srcLines) {
        if (src.status === "cancelled") continue;
        // Source priority (duplicate path):
        //   source line.unit_cost_mills → centsToMills(source line.unit_cost_cents)
        //   overridden by matching vendor_products.unit_cost_mills / cents.
        let unitCostMills: number =
          typeof src.unitCostMills === "number" && src.unitCostMills >= 0
            ? src.unitCostMills
            : centsToMills(Number(src.unitCostCents || 0));
        let catalogSource: PreloadLine["catalogSource"] = "duplicate";
        try {
          const vp = await storage.getPreferredVendorProduct(src.productId, src.productVariantId);
          if (vp && vp.vendorId === source.vendorId) {
            if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
              unitCostMills = vp.unitCostMills;
              catalogSource = "vendor_catalog";
            } else if (typeof vp.unitCostCents === "number") {
              unitCostMills = centsToMills(vp.unitCostCents);
              catalogSource = "vendor_catalog";
            }
          }
        } catch {
          // non-fatal
        }
        lines.push({
          productVariantId: src.productVariantId,
          productName: src.productName ?? "",
          sku: src.sku ?? null,
          variantDescription: null,
          uomLabel: src.unitOfMeasure ?? null,
          suggestedQty: src.orderQty,
          unitCostCents: millsToCents(unitCostMills),
          unitCostMills,
          catalogSource,
        });
      }
      return {
        vendor: vendor ?? null,
        lines,
        sourcePo: {
          poNumber: source.poNumber,
          note: `Duplicated from ${source.poNumber}`,
        },
      };
    }

    const vendor = vendorId ? await storage.getVendorById(vendorId) : null;

    const lines: PreloadLine[] = [];
    if (Array.isArray(variantIds) && variantIds.length > 0) {
      for (const vid of variantIds) {
        if (!Number.isInteger(vid) || vid <= 0) continue;
        const variant = await storage.getProductVariantById(vid);
        if (!variant) continue;
        const product = await storage.getProductById(variant.productId);
        if (!product) continue;
        // Source priority (variant path) per spec:
        //   vendor_products.unit_cost_mills
        //   → centsToMills(vendor_products.unit_cost_cents)
        //   → centsToMills(variant.standardCostCents)
        //   → centsToMills(variant.lastCostCents)
        //   → 0
        let unitCostMills: number = centsToMills(
          Number(variant.standardCostCents ?? variant.lastCostCents ?? 0),
        );
        let catalogSource: PreloadLine["catalogSource"] = "product_default";
        if (vendorId) {
          try {
            const vp = await storage.getPreferredVendorProduct(product.id, variant.id);
            if (vp && vp.vendorId === vendorId) {
              if (typeof vp.unitCostMills === "number" && vp.unitCostMills >= 0) {
                unitCostMills = vp.unitCostMills;
                catalogSource = "vendor_catalog";
              } else if (typeof vp.unitCostCents === "number") {
                unitCostMills = centsToMills(vp.unitCostCents);
                catalogSource = "vendor_catalog";
              }
            }
          } catch {
            // non-fatal
          }
        }
        lines.push({
          productVariantId: variant.id,
          productName: product.name ?? "",
          sku: variant.sku ?? null,
          variantDescription: variant.name ?? null,
          uomLabel: variant.name?.split(" ")[0]?.toLowerCase() ?? null,
          // No reorder_quantity column today. Default to 1 so the row is
          // usable; users edit qty in the lines editor.
          suggestedQty: 1,
          unitCostCents: millsToCents(unitCostMills),
          unitCostMills,
          catalogSource,
        });
      }
    }

    return { vendor, lines, sourcePo: null };
  }

  // ── ON-ORDER QUERY ──────────────────────────────────────

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
    bulkUpsertVendorCatalog,

    // Spec A: inline create, one-click send, duplicate, preload, settings.
    createPurchaseOrderWithLines,
    sendPurchaseOrder,
    duplicatePurchaseOrder,
    getNewPoPreload,
    getProcurementSettings,
    updateProcurementSetting,
    emitPoEvent,
  };
}
