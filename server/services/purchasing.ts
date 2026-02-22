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

// ── Minimal dependency interfaces ───────────────────────────────────

interface Storage {
  // Purchase Orders
  getPurchaseOrders(filters?: { status?: string; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<any[]>;
  getPurchaseOrdersCount(filters?: { status?: string; vendorId?: number; search?: string }): Promise<number>;
  getPurchaseOrderById(id: number): Promise<any>;
  getPurchaseOrderByPoNumber(poNumber: string): Promise<any>;
  createPurchaseOrder(data: any): Promise<any>;
  updatePurchaseOrder(id: number, updates: any): Promise<any>;
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
  sent: ["acknowledged", "partially_received", "cancelled"],
  acknowledged: ["partially_received", "cancelled"],
  partially_received: ["received", "closed"],
  received: ["closed"],
};

const EDITABLE_STATUSES = new Set(["draft"]);
const CANCELLABLE_FROM = new Set(["draft", "pending_approval", "approved"]);
const VOIDABLE_FROM = new Set(["sent", "acknowledged"]);

// ── Service ─────────────────────────────────────────────────────────

export type PurchasingService = ReturnType<typeof createPurchasingService>;

export function createPurchasingService(db: any, storage: Storage) {

  // ── Helpers ─────────────────────────────────────────────────────

  function calculateLineTotal(line: { orderQty: number; unitCostCents: number; discountPercent?: string | number; taxRatePercent?: string | number }): number {
    const subtotal = line.orderQty * line.unitCostCents;
    const discountPct = Number(line.discountPercent || 0);
    const discount = Math.round(subtotal * discountPct / 100);
    const taxable = subtotal - discount;
    const taxPct = Number(line.taxRatePercent || 0);
    const tax = Math.round(taxable * taxPct / 100);
    return taxable + tax;
  }

  async function recalculateTotals(purchaseOrderId: number, userId?: string): Promise<any> {
    const lines = await storage.getPurchaseOrderLines(purchaseOrderId);
    let subtotal = 0;
    let lineCount = 0;
    let receivedLineCount = 0;

    for (const line of lines) {
      if (line.status === "cancelled") continue;
      const lt = calculateLineTotal(line);
      subtotal += lt;
      lineCount++;
      if (line.status === "received") receivedLineCount++;

      // Update line total if changed
      if (line.lineTotalCents !== lt) {
        await storage.updatePurchaseOrderLine(line.id, {
          lineTotalCents: lt,
          discountCents: Math.round(line.orderQty * line.unitCostCents * Number(line.discountPercent || 0) / 100),
          taxCents: Math.round(
            (line.orderQty * line.unitCostCents - Math.round(line.orderQty * line.unitCostCents * Number(line.discountPercent || 0) / 100))
            * Number(line.taxRatePercent || 0) / 100
          ),
        });
      }
    }

    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    const headerDiscount = Number(po?.discountCents || 0);
    const headerTax = Number(po?.taxCents || 0);
    const headerShipping = Number(po?.shippingCostCents || 0);
    const total = subtotal - headerDiscount + headerTax + headerShipping;

    return await storage.updatePurchaseOrder(purchaseOrderId, {
      subtotalCents: subtotal,
      totalCents: total,
      lineCount,
      receivedLineCount,
      updatedBy: userId,
    });
  }

  async function recordStatusChange(
    purchaseOrderId: number,
    fromStatus: string | null,
    toStatus: string,
    userId?: string,
    notes?: string,
  ) {
    const po = await storage.getPurchaseOrderById(purchaseOrderId);
    await storage.createPoStatusHistory({
      purchaseOrderId,
      fromStatus,
      toStatus,
      changedBy: userId,
      notes,
      revisionNumber: po?.revisionNumber ?? 0,
    });
  }

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
    });

    await recordStatusChange(po.id, null, "draft", data.createdBy, "PO created");
    return po;
  }

  async function updatePO(id: number, updates: Record<string, any>, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);

    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot edit PO in '${po.status}' status`, 400);
    }

    return await storage.updatePurchaseOrder(id, { ...updates, updatedBy: userId });
  }

  async function deletePO(id: number) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    if (po.status !== "draft") {
      throw new PurchasingError("Can only delete POs in draft status", 400);
    }
    return await storage.deletePurchaseOrder(id);
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

    const lineTotal = calculateLineTotal({
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
      discountCents: Math.round(data.orderQty * data.unitCostCents * (data.discountPercent || 0) / 100),
      taxCents: 0,
      lineTotalCents: lineTotal,
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

      const lineTotal = calculateLineTotal({
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
        lineTotalCents: lineTotal,
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

    if (!EDITABLE_STATUSES.has(po.status)) {
      throw new PurchasingError(`Cannot edit lines on PO in '${po.status}' status`, 400);
    }

    const updated = await storage.updatePurchaseOrderLine(lineId, updates);
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
      });
      await recordStatusChange(id, po.status, "pending_approval", userId, `Approval required: ${tier.tierName}`);
    } else {
      // Auto-approve (no tier matches)
      assertTransition(po.status, "approved");
      await storage.updatePurchaseOrder(id, {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: "Auto-approved (below approval threshold)",
        updatedBy: userId,
      });
      await recordStatusChange(id, po.status, "approved", userId, "Auto-approved (below threshold)");
    }

    return await storage.getPurchaseOrderById(id);
  }

  async function returnToDraft(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "draft");

    await storage.updatePurchaseOrder(id, {
      status: "draft",
      approvalTierId: null,
      approvedBy: null,
      approvedAt: null,
      approvalNotes: null,
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "draft", userId, notes || "Returned to draft");
    return await storage.getPurchaseOrderById(id);
  }

  async function approve(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "approved");

    await storage.updatePurchaseOrder(id, {
      status: "approved",
      approvedBy: userId,
      approvedAt: new Date(),
      approvalNotes: notes,
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "approved", userId, notes || "Approved");
    return await storage.getPurchaseOrderById(id);
  }

  async function send(id: number, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "sent");

    await storage.updatePurchaseOrder(id, {
      status: "sent",
      orderDate: new Date(),
      sentToVendorAt: new Date(),
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "sent", userId, "Sent to vendor");
    return await storage.getPurchaseOrderById(id);
  }

  async function acknowledge(id: number, data: { vendorRefNumber?: string; confirmedDeliveryDate?: Date }, userId?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "acknowledged");

    await storage.updatePurchaseOrder(id, {
      status: "acknowledged",
      vendorAckDate: new Date(),
      vendorRefNumber: data.vendorRefNumber,
      confirmedDeliveryDate: data.confirmedDeliveryDate,
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "acknowledged", userId, "Vendor acknowledged");
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

    await storage.updatePurchaseOrder(id, {
      status: "cancelled",
      cancelledAt: new Date(),
      cancelledBy: userId,
      cancelReason: reason,
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "cancelled", userId, reason);
    return await storage.getPurchaseOrderById(id);
  }

  async function close(id: number, userId?: string, notes?: string) {
    const po = await storage.getPurchaseOrderById(id);
    if (!po) throw new PurchasingError("Purchase order not found", 404);
    assertTransition(po.status, "closed");

    await storage.updatePurchaseOrder(id, {
      status: "closed",
      closedAt: new Date(),
      closedBy: userId,
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "closed", userId, notes || "PO closed");
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

    await storage.updatePurchaseOrder(id, {
      status: "closed",
      closedAt: new Date(),
      closedBy: userId,
      updatedBy: userId,
    });
    await recordStatusChange(id, po.status, "closed", userId, `Closed short: ${reason}`);
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

    // Create receiving lines from PO lines
    const receivingLineData = receivableLines.map((poLine: any) => ({
      receivingOrderId: receivingOrder.id,
      productVariantId: poLine.productVariantId,
      productId: poLine.productId,
      sku: poLine.sku,
      productName: poLine.productName,
      expectedQty: poLine.orderQty - (poLine.receivedQty || 0) - (poLine.cancelledQty || 0),
      receivedQty: 0,
      damagedQty: 0,
      purchaseOrderLineId: poLine.id,
      unitCost: poLine.unitCostCents,
      status: "pending",
    }));

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

      const newReceivedQty = (poLine.receivedQty || 0) + rl.receivedQty;
      const newDamagedQty = (poLine.damagedQty || 0) + (rl.damagedQty || 0);
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

      // Create PO receipt record
      await storage.createPoReceipt({
        purchaseOrderId: poId,
        purchaseOrderLineId: poLine.id,
        receivingOrderId: receivingOrderId,
        receivingLineId: rl.receivingLineId,
        qtyReceived: rl.receivedQty,
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
      await storage.updatePurchaseOrder(poId, {
        status: "received",
        actualDeliveryDate: new Date(),
      });
      await recordStatusChange(poId, po.status, "received", undefined, "All lines fully received");
    } else if (someReceived && po.status !== "partially_received") {
      await storage.updatePurchaseOrder(poId, { status: "partially_received" });
      await recordStatusChange(poId, po.status, "partially_received", undefined, "Partial receipt");
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
      const po = await createPO({ vendorId, createdBy: userId });

      const lineData: any[] = [];
      for (const item of groupItems) {
        const vp = await storage.getPreferredVendorProduct(item.productId, item.productVariantId);
        lineData.push({
          productId: item.productId,
          productVariantId: item.productVariantId,
          vendorProductId: vp?.id,
          orderQty: item.suggestedQty,
          unitCostCents: vp?.unitCostCents || 0,
          vendorSku: vp?.vendorSku,
        });
      }

      await addBulkLines(po.id, lineData, userId);
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
    createApprovalTier: (data: any) => storage.createPoApprovalTier(data),
    updateApprovalTier: (id: number, updates: any) => storage.updatePoApprovalTier(id, updates),
    deleteApprovalTier: (id: number) => storage.deletePoApprovalTier(id),

    // Vendor Products
    getVendorProducts: (filters?: any) => storage.getVendorProducts(filters),
    getVendorProductById: (id: number) => storage.getVendorProductById(id),
    getPreferredVendorProduct: (productId: number, variantId?: number) => storage.getPreferredVendorProduct(productId, variantId),
    createVendorProduct: (data: any) => storage.createVendorProduct(data),
    updateVendorProduct: (id: number, updates: any) => storage.updateVendorProduct(id, updates),
    deleteVendorProduct: (id: number) => storage.deleteVendorProduct(id),
  };
}
