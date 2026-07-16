import {
  db,
  type Vendor,
  type InsertVendor,
  type ReceivingOrder,
  type InsertReceivingOrder,
  type ReceivingLine,
  type InsertReceivingLine,
  type VendorProduct,
  type InsertVendorProduct,
  type PoApprovalTier,
  type InsertPoApprovalTier,
  type PurchaseOrder,
  type InsertPurchaseOrder,
  type PurchaseOrderLine,
  type InsertPurchaseOrderLine,
  type PoStatusHistory,
  type InsertPoStatusHistory,
  type PoRevision,
  type InsertPoRevision,
  type PoReceipt,
  type InsertPoReceipt,
  type PurchasingRecommendationPoHandoff,
  type InventoryLot,
  type InsertInventoryLot,
  type OrderItemCost,
  type InsertOrderItemCost,
  type OrderItemFinancial,
  type InsertOrderItemFinancial,
  type InboundShipment,
  type InsertInboundShipment,
  type InboundShipmentLine,
  type InsertInboundShipmentLine,
  type InboundFreightCost,
  type InsertInboundFreightCost,
  type InsertInboundFreightAllocation,
  type InsertLandedCostSnapshot,
  type InboundShipmentStatusHistory,
  vendors,
  receivingOrders,
  receivingLines,
  vendorProducts,
  poApprovalTiers,
  purchaseOrders,
  purchaseOrderLines,
  poStatusHistory,
  poRevisions,
  poReceipts,
  inventoryLots,
  orderItemCosts,
  orderItemFinancials,
  inboundShipments,
  inboundShipmentLines,
  inboundFreightCosts,
  inboundFreightAllocations,
  landedCostSnapshots,
  landedCostAdjustments,
  inboundShipmentStatusHistory,
  reorderExclusionRules,
  autoDraftRuns,
  purchasingRecommendationDecisions,
  purchasingRecommendationPoHandoffs,
  products,
  eq, and, or, inArray, notInArray, sql, desc, asc, lte, like, ilike,
} from "../../storage/base";
import {
  generatePurchasingRecommendations,
  type PurchasingRecommendationProductMeta,
  type PurchasingRecommendationRawRow,
} from "./purchasing-recommendation.engine";

export interface IProcurementStorage {
  getAllVendors(): Promise<Vendor[]>;
  getVendorById(id: number): Promise<Vendor | undefined>;
  getVendorByCode(code: string): Promise<Vendor | undefined>;
  createVendor(data: InsertVendor): Promise<Vendor>;
  updateVendor(id: number, updates: Partial<InsertVendor>): Promise<Vendor | null>;
  deleteVendor(id: number): Promise<boolean>;
  getAllReceivingOrders(): Promise<ReceivingOrder[]>;
  getReceivingOrderById(id: number): Promise<ReceivingOrder | undefined>;
  getReceivingOrderByReceiptNumber(receiptNumber: string): Promise<ReceivingOrder | undefined>;
  getReceivingOrdersForPurchaseOrder(purchaseOrderId: number): Promise<ReceivingOrder[]>;
  getReceivingOrdersByStatus(status: string): Promise<ReceivingOrder[]>;
  createReceivingOrder(data: InsertReceivingOrder): Promise<ReceivingOrder>;
  updateReceivingOrder(id: number, updates: Partial<InsertReceivingOrder>): Promise<ReceivingOrder | null>;
  deleteReceivingOrder(id: number): Promise<boolean>;
  generateReceiptNumber(): Promise<string>;
  getReceivingLines(receivingOrderId: number): Promise<ReceivingLine[]>;
  getReceivingLineById(id: number): Promise<ReceivingLine | undefined>;
  createReceivingLine(data: InsertReceivingLine): Promise<ReceivingLine>;
  updateReceivingLine(id: number, updates: Partial<InsertReceivingLine>): Promise<ReceivingLine | null>;
  deleteReceivingLine(id: number): Promise<boolean>;
  bulkCreateReceivingLines(lines: InsertReceivingLine[]): Promise<ReceivingLine[]>;
  getVendorProducts(filters?: { vendorId?: number; productId?: number; productVariantId?: number; isActive?: number }): Promise<VendorProduct[]>;
  getVendorProductsByProductIds(productIds: number[]): Promise<VendorProduct[]>;
  getVendorProductById(id: number): Promise<VendorProduct | undefined>;
  getPreferredVendorProduct(productId: number, productVariantId?: number): Promise<VendorProduct | undefined>;
  createVendorProduct(data: InsertVendorProduct): Promise<VendorProduct>;
  updateVendorProduct(id: number, updates: Partial<InsertVendorProduct>): Promise<VendorProduct | null>;
  deleteVendorProduct(id: number): Promise<boolean>;

  /**
   * Spec A follow-up: two-layer catalog typeahead.
   * Returns products in a vendor's catalog (top section) plus other products
   * matching the query that aren't yet in this vendor's catalog (bottom section).
   */
  searchVendorCatalog(opts: {
    vendorId: number;
    q: string;
    limit: number;
  }): Promise<{
    inCatalog: Array<{
      vendorProductId: number;
      productId: number;
      productVariantId: number | null;
      receiveUnitsPerVariant: number | null;
      sku: string | null;
      productName: string;
      variantName: string | null;
      vendorSku: string | null;
      vendorProductName: string | null;
      unitCostCents: number;
      // Per-unit cost in mills (4-decimal). Derived from unit_cost_cents
      // when unit_cost_mills is NULL (legacy rows).
      unitCostMills: number;
      pricingBasis: "legacy_unknown" | "per_piece" | "per_purchase_uom";
      purchaseUom: string | null;
      quotedUnitCostMills: number | null;
      piecesPerPurchaseUom: number | null;
      packSize: number | null;
      moq: number | null;
      leadTimeDays: number | null;
      isPreferred: boolean;
    }>;
    outOfCatalog: Array<{
      productId: number;
      productVariantId: number | null;
      sku: string | null;
      productName: string;
      variantName: string | null;
    }>;
  }>;
  getAllPoApprovalTiers(): Promise<PoApprovalTier[]>;
  getPoApprovalTierById(id: number): Promise<PoApprovalTier | undefined>;
  getMatchingApprovalTier(totalCents: number): Promise<PoApprovalTier | undefined>;
  createPoApprovalTier(data: InsertPoApprovalTier): Promise<PoApprovalTier>;
  updatePoApprovalTier(id: number, updates: Partial<InsertPoApprovalTier>): Promise<PoApprovalTier | null>;
  deletePoApprovalTier(id: number): Promise<boolean>;
  getPurchaseOrders(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<PurchaseOrder[]>;
  getPurchaseOrdersCount(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string }): Promise<number>;
  getPurchaseOrderById(id: number): Promise<PurchaseOrder | undefined>;
  getPurchaseOrderByPoNumber(poNumber: string): Promise<PurchaseOrder | undefined>;
  createPurchaseOrder(data: InsertPurchaseOrder): Promise<PurchaseOrder>;
  updatePurchaseOrder(id: number, updates: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder | null>;
  updatePurchaseOrderStatusWithHistory(id: number, updates: Partial<InsertPurchaseOrder>, historyData: Omit<InsertPoStatusHistory, 'purchaseOrderId'>): Promise<PurchaseOrder | null>;
  deletePurchaseOrder(id: number): Promise<boolean>;
  generatePoNumber(): Promise<string>;
  getPurchaseOrderLines(purchaseOrderId: number): Promise<PurchaseOrderLine[]>;
  getPurchaseOrderLineById(id: number): Promise<PurchaseOrderLine | undefined>;
  createPurchaseOrderLine(data: InsertPurchaseOrderLine): Promise<PurchaseOrderLine>;
  bulkCreatePurchaseOrderLines(lines: InsertPurchaseOrderLine[]): Promise<PurchaseOrderLine[]>;
  updatePurchaseOrderLine(id: number, updates: Partial<InsertPurchaseOrderLine>): Promise<PurchaseOrderLine | null>;
  deletePurchaseOrderLine(id: number): Promise<boolean>;
  getOpenPoLinesForVariant(productVariantId: number): Promise<PurchaseOrderLine[]>;
  createPoStatusHistory(data: InsertPoStatusHistory): Promise<PoStatusHistory>;
  getPoStatusHistory(purchaseOrderId: number): Promise<PoStatusHistory[]>;
  createPoRevision(data: InsertPoRevision): Promise<PoRevision>;
  getPoRevisions(purchaseOrderId: number): Promise<PoRevision[]>;
  createPoReceipt(data: InsertPoReceipt): Promise<PoReceipt>;
  getPoReceipts(purchaseOrderId: number): Promise<PoReceipt[]>;
  getPoReceiptsByLine(purchaseOrderLineId: number): Promise<PoReceipt[]>;
  reconcilePoReceiptLine(input: {
    purchaseOrderLineId: number;
    receivingLineId: number;
    lineUpdates: Partial<InsertPurchaseOrderLine>;
    receipt: InsertPoReceipt;
  }): Promise<{ applied: boolean; receipt?: PoReceipt; purchaseOrderLine?: PurchaseOrderLine | null }>;
  getInventoryLots(filters?: { productVariantId?: number; warehouseLocationId?: number; status?: string; limit?: number; offset?: number }): Promise<InventoryLot[]>;
  getInventoryLotById(id: number): Promise<InventoryLot | undefined>;
  createInventoryLot(data: InsertInventoryLot): Promise<InventoryLot>;
  updateInventoryLot(id: number, updates: Partial<InsertInventoryLot>): Promise<InventoryLot | null>;
  getFifoLots(productVariantId: number, warehouseLocationId: number): Promise<InventoryLot[]>;
  generateLotNumber(): Promise<string>;
  createOrderItemCost(data: InsertOrderItemCost): Promise<OrderItemCost>;
  getOrderItemCosts(orderItemId: number): Promise<OrderItemCost[]>;
  getOrderItemCostsByOrder(orderId: number): Promise<OrderItemCost[]>;
  createOrderItemFinancial(data: InsertOrderItemFinancial): Promise<OrderItemFinancial>;
  getOrderItemFinancials(orderId: number): Promise<OrderItemFinancial[]>;
  getInboundShipments(filters?: any): Promise<InboundShipment[]>;
  getInboundShipmentsCount(filters?: any): Promise<number>;
  getInboundShipmentById(id: number): Promise<InboundShipment | undefined>;
  getInboundShipmentByNumber(shipmentNumber: string): Promise<InboundShipment | undefined>;
  createInboundShipment(data: InsertInboundShipment): Promise<InboundShipment>;
  updateInboundShipment(id: number, updates: Partial<InsertInboundShipment>): Promise<InboundShipment | null>;
  deleteInboundShipment(id: number): Promise<boolean>;
  generateShipmentNumber(): Promise<string>;
  getInboundShipmentLines(inboundShipmentId: number): Promise<InboundShipmentLine[]>;
  getInboundShipmentLineById(id: number): Promise<InboundShipmentLine | undefined>;
  getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<InboundShipmentLine[]>;
  getShippedQtyByPoLines(poLineIds: number[], executor?: any): Promise<Map<number, number>>;
  createInboundShipmentLine(data: InsertInboundShipmentLine): Promise<InboundShipmentLine>;
  bulkCreateInboundShipmentLines(lines: InsertInboundShipmentLine[]): Promise<InboundShipmentLine[]>;
  updateInboundShipmentLine(id: number, updates: Partial<InsertInboundShipmentLine>): Promise<InboundShipmentLine | null>;
  deleteInboundShipmentLine(id: number): Promise<boolean>;
  getInboundFreightCosts(inboundShipmentId: number): Promise<InboundFreightCost[]>;
  getInboundFreightCostById(id: number): Promise<InboundFreightCost | undefined>;
  createInboundFreightCost(data: InsertInboundFreightCost): Promise<InboundFreightCost>;
  updateInboundFreightCost(id: number, updates: Partial<InsertInboundFreightCost>): Promise<InboundFreightCost | null>;
  deleteInboundFreightCost(id: number): Promise<boolean>;
  getInboundFreightCostAllocations(inboundFreightCostId: number): Promise<any[]>;
  getAllocationsForLine(inboundShipmentLineId: number): Promise<any[]>;
  createInboundFreightCostAllocation(data: InsertInboundFreightAllocation): Promise<any>;
  bulkCreateInboundFreightCostAllocations(allocations: InsertInboundFreightAllocation[]): Promise<any[]>;
  deleteAllocationsForShipment(inboundShipmentId: number): Promise<void>;
  getLandedCostSnapshots(inboundShipmentLineId: number): Promise<any[]>;
  getLandedCostSnapshotByPoLine(purchaseOrderLineId: number): Promise<any>;
  createLandedCostSnapshot(data: InsertLandedCostSnapshot): Promise<any>;
  bulkCreateLandedCostSnapshots(snapshots: InsertLandedCostSnapshot[]): Promise<any[]>;
  deleteLandedCostSnapshotsForShipment(inboundShipmentId: number): Promise<void>;
  createLandedCostAdjustment(data: any): Promise<any>;
  createInboundShipmentStatusHistory(data: any): Promise<InboundShipmentStatusHistory>;
  getInboundShipmentStatusHistory(inboundShipmentId: number): Promise<InboundShipmentStatusHistory[]>;
  getInboundShipmentsByPo(purchaseOrderId: number): Promise<InboundShipment[]>;
  getProvisionalLotsByShipment(inboundShipmentId: number): Promise<InventoryLot[]>;
  getReorderAnalysisData(lookbackDays: number): Promise<any[]>;
  getOrderProfitabilityReport(limit: number, offset: number): Promise<any[]>;
  getProductProfitabilityReport(limit: number, offset: number): Promise<any[]>;
  getVendorSpendReport(): Promise<any[]>;
  getCostVarianceReport(): Promise<any[]>;
  getOpenPoSummaryReport(): Promise<any[]>;
  getPoAgingReport(): Promise<any[]>;
  getExpectedReceiptsReport(): Promise<any[]>;

  // Purchasing Dashboard
  getReorderExclusionRules(): Promise<any[]>;
  createReorderExclusionRule(data: { field: string; value: string; createdBy?: string }): Promise<any>;
  deleteReorderExclusionRule(id: number): Promise<boolean>;
  getExclusionRuleMatchCount(field: string, value: string): Promise<number>;
  getTotalExcludedProducts(): Promise<number>;
  setProductReorderExcluded(productId: number, excluded: boolean): Promise<void>;
  getLatestAutoDraftRun(): Promise<any | undefined>;
  getRecentAutoDraftRuns(limit?: number): Promise<any[]>;
  getRecentRecommendationDecisions(limit?: number): Promise<any[]>;
  getLatestRecommendationDecisions(recommendationIds: string[], kinds?: string[]): Promise<any[]>;
  getLatestRecommendationDecisionsByDecision(decision: string, limit?: number): Promise<any[]>;
  createRecommendationDecision(data: any): Promise<any>;
  getRecommendationPoHandoffForPo(purchaseOrderId: number): Promise<PurchasingRecommendationPoHandoff | undefined>;
  getRecommendationPoHandoffForLine(purchaseOrderLineId: number): Promise<PurchasingRecommendationPoHandoff | undefined>;
  getDashboardData(lookbackDays: number): Promise<any>;
  getAutoDraftSettings(warehouseId?: number): Promise<any>;
  updateAutoDraftSettings(warehouseId: number | undefined, settings: any): Promise<void>;
}

export const procurementMethods: IProcurementStorage = {
  async getAllVendors(): Promise<Vendor[]> {
    return await db.select().from(vendors).orderBy(asc(vendors.name));
  },

  async getVendorById(id: number): Promise<Vendor | undefined> {
    const result = await db.select().from(vendors).where(eq(vendors.id, id)).limit(1);
    return result[0];
  },

  async getVendorByCode(code: string): Promise<Vendor | undefined> {
    const result = await db.select().from(vendors).where(eq(vendors.code, code.toUpperCase())).limit(1);
    return result[0];
  },

  async createVendor(data: InsertVendor): Promise<Vendor> {
    const result = await db.insert(vendors).values({
      ...data,
      code: data.code.toUpperCase(),
    }).returning();
    return result[0];
  },

  async updateVendor(id: number, updates: Partial<InsertVendor>): Promise<Vendor | null> {
    const updateData: any = { ...updates, updatedAt: new Date() };
    if (updates.code) updateData.code = updates.code.toUpperCase();
    const result = await db.update(vendors)
      .set(updateData)
      .where(eq(vendors.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteVendor(id: number): Promise<boolean> {
    const result = await db.delete(vendors).where(eq(vendors.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getAllReceivingOrders(): Promise<ReceivingOrder[]> {
    return await db.select().from(receivingOrders).orderBy(desc(receivingOrders.createdAt));
  },

  async getReceivingOrderById(id: number): Promise<ReceivingOrder | undefined> {
    const result = await db.select().from(receivingOrders).where(eq(receivingOrders.id, id)).limit(1);
    return result[0];
  },

  async getReceivingOrderByReceiptNumber(receiptNumber: string): Promise<ReceivingOrder | undefined> {
    const result = await db.select().from(receivingOrders).where(eq(receivingOrders.receiptNumber, receiptNumber)).limit(1);
    return result[0];
  },

  async getReceivingOrdersForPurchaseOrder(purchaseOrderId: number): Promise<ReceivingOrder[]> {
    return await db.select().from(receivingOrders)
      .where(eq(receivingOrders.purchaseOrderId, purchaseOrderId))
      .orderBy(desc(receivingOrders.createdAt));
  },

  async getReceivingOrdersByStatus(status: string): Promise<ReceivingOrder[]> {
    return await db.select().from(receivingOrders)
      .where(eq(receivingOrders.status, status))
      .orderBy(desc(receivingOrders.createdAt));
  },

  async createReceivingOrder(data: InsertReceivingOrder): Promise<ReceivingOrder> {
    const result = await db.insert(receivingOrders).values(data).returning();
    return result[0];
  },

  async updateReceivingOrder(id: number, updates: Partial<InsertReceivingOrder>): Promise<ReceivingOrder | null> {
    const result = await db.update(receivingOrders)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(receivingOrders.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteReceivingOrder(id: number): Promise<boolean> {
    const result = await db.delete(receivingOrders).where(eq(receivingOrders.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async generateReceiptNumber(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `RCV-${dateStr}-`;

    const existing = await db.select({ receiptNumber: receivingOrders.receiptNumber })
      .from(receivingOrders)
      .where(like(receivingOrders.receiptNumber, `${prefix}%`))
      .orderBy(desc(receivingOrders.receiptNumber))
      .limit(1);

    let nextNum = 1;
    if (existing.length > 0 && existing[0].receiptNumber) {
      const lastNum = parseInt(existing[0].receiptNumber.replace(prefix, ''), 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }

    return `${prefix}${String(nextNum).padStart(3, '0')}`;
  },

  async getReceivingLines(receivingOrderId: number): Promise<ReceivingLine[]> {
    return await db.select().from(receivingLines)
      .where(eq(receivingLines.receivingOrderId, receivingOrderId))
      .orderBy(asc(receivingLines.id));
  },

  async getReceivingLineById(id: number): Promise<ReceivingLine | undefined> {
    const result = await db.select().from(receivingLines).where(eq(receivingLines.id, id)).limit(1);
    return result[0];
  },

  async createReceivingLine(data: InsertReceivingLine): Promise<ReceivingLine> {
    const result = await db.insert(receivingLines).values(data).returning();
    return result[0];
  },

  async updateReceivingLine(id: number, updates: Partial<InsertReceivingLine>): Promise<ReceivingLine | null> {
    const result = await db.update(receivingLines)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(receivingLines.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteReceivingLine(id: number): Promise<boolean> {
    const result = await db.delete(receivingLines).where(eq(receivingLines.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async bulkCreateReceivingLines(lines: InsertReceivingLine[]): Promise<ReceivingLine[]> {
    if (lines.length === 0) return [];
    return await db.insert(receivingLines).values(lines).returning();
  },

  async getVendorProducts(filters?: { vendorId?: number; productId?: number; productVariantId?: number; isActive?: number }): Promise<VendorProduct[]> {
    const conditions: any[] = [];
    if (filters?.vendorId) conditions.push(eq(vendorProducts.vendorId, filters.vendorId));
    if (filters?.productId) conditions.push(eq(vendorProducts.productId, filters.productId));
    if (filters?.productVariantId) conditions.push(eq(vendorProducts.productVariantId, filters.productVariantId));
    if (filters?.isActive !== undefined) conditions.push(eq(vendorProducts.isActive, filters.isActive));

    let query = db.select().from(vendorProducts).orderBy(desc(vendorProducts.isPreferred), asc(vendorProducts.vendorId));
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    return await query;
  },

  async getVendorProductsByProductIds(productIds: number[]): Promise<VendorProduct[]> {
    const uniqueIds = [...new Set(productIds)]
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .sort((a, b) => a - b);
    if (uniqueIds.length === 0) return [];
    return await db
      .select()
      .from(vendorProducts)
      .where(inArray(vendorProducts.productId, uniqueIds))
      .orderBy(vendorProducts.productId, desc(vendorProducts.isPreferred), asc(vendorProducts.vendorId));
  },

  async getVendorProductById(id: number): Promise<VendorProduct | undefined> {
    const result = await db.select().from(vendorProducts).where(eq(vendorProducts.id, id)).limit(1);
    return result[0];
  },

  async getPreferredVendorProduct(productId: number, productVariantId?: number): Promise<VendorProduct | undefined> {
    const conditions: any[] = [
      eq(vendorProducts.productId, productId),
      eq(vendorProducts.isPreferred, 1),
      eq(vendorProducts.isActive, 1),
    ];
    if (productVariantId) {
      conditions.push(eq(vendorProducts.productVariantId, productVariantId));
    }
    const result = await db.select().from(vendorProducts)
      .where(and(...conditions))
      .limit(1);
    return result[0];
  },

  async createVendorProduct(data: InsertVendorProduct): Promise<VendorProduct> {
    const result = await db.insert(vendorProducts).values(data).returning();
    return result[0];
  },

  async updateVendorProduct(id: number, updates: Partial<InsertVendorProduct>): Promise<VendorProduct | null> {
    const result = await db.update(vendorProducts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(vendorProducts.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteVendorProduct(id: number): Promise<boolean> {
    // Vendor-product ids are retained on historical PO lines as quote
    // provenance. "Delete" therefore means deactivate, never physical erase.
    const result = await db
      .update(vendorProducts)
      .set({ isActive: 0, updatedAt: new Date() })
      .where(eq(vendorProducts.id, id))
      .returning();
    return result.length > 0;
  },

  async searchVendorCatalog(opts: { vendorId: number; q: string; limit: number }) {
    // Rule #1: DB search stays in the storage layer.
    // Rule #12: q is parameterised — never interpolated into raw SQL.
    const vendorId = Number(opts.vendorId);
    const qTrim = (opts.q ?? "").trim().toLowerCase();
    // Typeahead cap. Higher default + ceiling so the un-typed preview covers a
    // realistic catalog without a giant payload; typing narrows via LIKE, so the
    // cap only bounds the browse list (no per-keystroke flood). Bump the ceiling
    // or add pagination if the catalog grows into the thousands.
    const combined = Math.max(1, Math.min(200, Math.floor(opts.limit) || 100));
    const like = qTrim.length > 0 ? `%${qTrim}%` : "%";
    const prefix = qTrim.length > 0 ? `${qTrim}%` : "";
    // rank: 0 SKU prefix, 1 SKU contains, 2 name contains, 3 other.
    // inCatalog gets priority — we fetch up to `combined` rows, then fill
    // outOfCatalog with the remainder.
    const inCatalogRows = await db.execute<{
      vendor_product_id: number;
      product_id: number;
      product_variant_id: number | null;
      receive_units_per_variant: number | string | null;
      sku: string | null;
      product_name: string;
      variant_name: string | null;
      vendor_sku: string | null;
      vendor_product_name: string | null;
      unit_cost_cents: number | string | null;
      unit_cost_mills: number | string | null;
      pricing_basis: "legacy_unknown" | "per_piece" | "per_purchase_uom" | null;
      purchase_uom: string | null;
      quoted_unit_cost_mills: number | string | null;
      pieces_per_purchase_uom: number | null;
      quote_reference: string | null;
      quoted_at: Date | null;
      quote_valid_until: string | null;
      pack_size: number | null;
      moq: number | null;
      lead_time_days: number | null;
      is_preferred: number | null;
    }>(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (vp.product_id, COALESCE(vp.product_variant_id, 0))
          vp.id              AS vendor_product_id,
          vp.product_id      AS product_id,
          vp.product_variant_id AS product_variant_id,
          pv.units_per_variant AS receive_units_per_variant,
          p.sku              AS sku,
          p.name             AS product_name,
          pv.name            AS variant_name,
          vp.vendor_sku      AS vendor_sku,
          vp.vendor_product_name AS vendor_product_name,
          vp.unit_cost_cents AS unit_cost_cents,
          vp.unit_cost_mills AS unit_cost_mills,
          vp.pricing_basis   AS pricing_basis,
          vp.purchase_uom    AS purchase_uom,
          vp.quoted_unit_cost_mills AS quoted_unit_cost_mills,
          vp.pieces_per_purchase_uom AS pieces_per_purchase_uom,
          vp.quote_reference AS quote_reference,
          vp.quoted_at AS quoted_at,
          vp.quote_valid_until AS quote_valid_until,
          vp.pack_size       AS pack_size,
          vp.moq             AS moq,
          vp.lead_time_days  AS lead_time_days,
          vp.is_preferred    AS is_preferred,
          (
            CASE
              WHEN ${qTrim.length === 0 ? sql`true` : sql`LOWER(COALESCE(pv.sku, p.sku, '')) LIKE ${prefix}`} THEN 0
              WHEN LOWER(COALESCE(pv.sku, p.sku, '')) LIKE ${like} THEN 1
              WHEN LOWER(COALESCE(vp.vendor_sku, '')) LIKE ${like} THEN 1
              WHEN LOWER(p.name) LIKE ${like} THEN 2
              WHEN LOWER(COALESCE(vp.vendor_product_name, '')) LIKE ${like} THEN 2
              ELSE 3
            END
          ) AS rank
        FROM procurement.vendor_products vp
        JOIN catalog.products p ON p.id = vp.product_id
        LEFT JOIN catalog.product_variants pv ON pv.id = vp.product_variant_id
        WHERE vp.vendor_id = ${vendorId}
          AND vp.is_active = 1
          ${qTrim.length === 0 ? sql`` : sql`AND (
            LOWER(COALESCE(pv.sku, p.sku, '')) LIKE ${like}
            OR LOWER(COALESCE(vp.vendor_sku, '')) LIKE ${like}
            OR LOWER(p.name) LIKE ${like}
            OR LOWER(COALESCE(pv.name, '')) LIKE ${like}
            OR LOWER(COALESCE(vp.vendor_product_name, '')) LIKE ${like}
          )`}
        ORDER BY vp.product_id, COALESCE(vp.product_variant_id, 0), vp.is_preferred DESC NULLS LAST, vp.id ASC
      ) AS distinct_products
      ORDER BY rank ASC, is_preferred DESC NULLS LAST, product_name ASC
      LIMIT ${combined}
    `);

    const inCatalog = inCatalogRows.rows.map((r) => ({
      vendorProductId: Number(r.vendor_product_id),
      productId: Number(r.product_id),
      productVariantId: r.product_variant_id != null ? Number(r.product_variant_id) : null,
      receiveUnitsPerVariant:
        r.receive_units_per_variant != null ? Number(r.receive_units_per_variant) : null,
      sku: r.sku,
      productName: r.product_name,
      variantName: r.variant_name,
      vendorSku: r.vendor_sku,
      vendorProductName: r.vendor_product_name,
      unitCostCents: Number(r.unit_cost_cents ?? 0),
      // unit_cost_mills is the 4-decimal source of truth when present.
      // If NULL (legacy row), fall back to cents × 100 so the client
      // still gets a usable mills value.
      unitCostMills:
        r.unit_cost_mills != null
          ? Number(r.unit_cost_mills)
          : Number(r.unit_cost_cents ?? 0) * 100,
      pricingBasis:
        r.pricing_basis === "per_piece" || r.pricing_basis === "per_purchase_uom"
          ? r.pricing_basis
          : "legacy_unknown" as const,
      purchaseUom: r.purchase_uom,
      quotedUnitCostMills:
        r.quoted_unit_cost_mills != null ? Number(r.quoted_unit_cost_mills) : null,
      piecesPerPurchaseUom:
        r.pieces_per_purchase_uom != null ? Number(r.pieces_per_purchase_uom) : null,
      quoteReference: r.quote_reference,
      quotedAt: r.quoted_at,
      quoteValidUntil: r.quote_valid_until,
      packSize: r.pack_size != null ? Number(r.pack_size) : null,
      moq: r.moq != null ? Number(r.moq) : null,
      leadTimeDays: r.lead_time_days != null ? Number(r.lead_time_days) : null,
      isPreferred: Number(r.is_preferred ?? 0) === 1,
    }));

    const remaining = combined - inCatalog.length;
    if (remaining <= 0) {
      return { inCatalog, outOfCatalog: [] as Array<{
        productId: number;
        productVariantId: number | null;
        sku: string | null;
        productName: string;
        variantName: string | null;
      }> };
    }

    // Build the "exclude" set. Purchasing is product-SKU based, so any active
    // vendor catalog row for a product means that product is already in catalog,
    // even when the vendor row carries hidden variant metadata.
    const exclusionRows = await db.execute<{ product_id: number; product_variant_id: number | null }>(sql`
      SELECT product_id, product_variant_id
      FROM procurement.vendor_products
      WHERE vendor_id = ${vendorId} AND is_active = 1
    `);
    const excludedVariantIds = new Set<number>();
    const excludedProductIds = new Set<number>();
    for (const row of exclusionRows.rows) {
      excludedProductIds.add(Number(row.product_id));
      if (row.product_variant_id != null) {
        excludedVariantIds.add(Number(row.product_variant_id));
      }
    }

    const outOfCatalogRows = await db.execute<{
      product_id: number;
      product_variant_id: number | null;
      sku: string | null;
      product_name: string;
      variant_name: string | null;
      rank: number;
    }>(sql`
      -- One row per PRODUCT (product-level, variant_id NULL) so non-catalog
      -- products are purchasable at the product level — consistent with catalog
      -- products and the product-level PO model. The LEFT JOIN to variants is
      -- only so typing a VARIANT sku/name still surfaces the parent product.
      SELECT
        p.id AS product_id,
        NULL::int AS product_variant_id,
        p.sku AS sku,
        p.name AS product_name,
        NULL::text AS variant_name,
        MIN(
          CASE
            WHEN ${qTrim.length === 0 ? sql`true` : sql`LOWER(COALESCE(p.sku, '')) LIKE ${prefix}`} THEN 0
            WHEN LOWER(COALESCE(p.sku, '')) LIKE ${like} THEN 1
            WHEN LOWER(p.name) LIKE ${like} THEN 2
            WHEN LOWER(COALESCE(pv.sku, '')) LIKE ${like} THEN 1
            WHEN LOWER(COALESCE(pv.name, '')) LIKE ${like} THEN 2
            ELSE 3
          END
        ) AS rank
      FROM catalog.products p
      LEFT JOIN catalog.product_variants pv ON pv.product_id = p.id AND pv.is_active = true
      WHERE p.is_active = true
        ${qTrim.length === 0 ? sql`` : sql`AND (
          LOWER(COALESCE(p.sku, '')) LIKE ${like}
          OR LOWER(p.name) LIKE ${like}
          OR LOWER(COALESCE(pv.sku, '')) LIKE ${like}
          OR LOWER(COALESCE(pv.name, '')) LIKE ${like}
        )`}
      GROUP BY p.id, p.sku, p.name
      ORDER BY rank ASC, p.name ASC
      LIMIT ${remaining * 3}
    `);

    const outOfCatalog: Array<{
      productId: number;
      productVariantId: number | null;
      sku: string | null;
      productName: string;
      variantName: string | null;
    }> = [];
    const seenKeys = new Set<string>();
    for (const row of outOfCatalogRows.rows) {
      if (outOfCatalog.length >= remaining) break;
      const pid = Number(row.product_id);
      const vid = row.product_variant_id != null ? Number(row.product_variant_id) : null;
      // Skip rows already in this vendor's catalog. In the purchasing UI, the
      // product is the selectable identity; vendor variants are metadata.
      if (vid != null && excludedVariantIds.has(vid)) continue;
      if (excludedProductIds.has(pid)) continue;
      // Dedupe on the (productId, variantId) key — a LEFT JOIN with no
      // variant rows produces a (pid, null) row which shouldn't collide with
      // actual variant rows.
      const key = `${pid}:${vid ?? 'null'}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      outOfCatalog.push({
        productId: pid,
        productVariantId: vid,
        sku: row.sku,
        productName: row.product_name,
        variantName: row.variant_name,
      });
    }

    return { inCatalog, outOfCatalog };
  },

  async getAllPoApprovalTiers(): Promise<PoApprovalTier[]> {
    return await db.select().from(poApprovalTiers).orderBy(asc(poApprovalTiers.sortOrder));
  },

  async getPoApprovalTierById(id: number): Promise<PoApprovalTier | undefined> {
    const result = await db.select().from(poApprovalTiers).where(eq(poApprovalTiers.id, id)).limit(1);
    return result[0];
  },

  async getMatchingApprovalTier(totalCents: number): Promise<PoApprovalTier | undefined> {
    const result = await db.select().from(poApprovalTiers)
      .where(and(
        lte(poApprovalTiers.thresholdCents, totalCents),
        eq(poApprovalTiers.active, 1),
      ))
      .orderBy(desc(poApprovalTiers.thresholdCents))
      .limit(1);
    return result[0];
  },

  async createPoApprovalTier(data: InsertPoApprovalTier): Promise<PoApprovalTier> {
    const result = await db.insert(poApprovalTiers).values(data).returning();
    return result[0];
  },

  async updatePoApprovalTier(id: number, updates: Partial<InsertPoApprovalTier>): Promise<PoApprovalTier | null> {
    const result = await db.update(poApprovalTiers)
      .set(updates)
      .where(eq(poApprovalTiers.id, id))
      .returning();
    return result[0] || null;
  },

  async deletePoApprovalTier(id: number): Promise<boolean> {
    const result = await db.delete(poApprovalTiers).where(eq(poApprovalTiers.id, id)).returning();
    return result.length > 0;
  },

  async getPurchaseOrders(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<PurchaseOrder[]> {
    const conditions: any[] = [];
    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(inArray(purchaseOrders.status, filters.status));
      } else {
        conditions.push(eq(purchaseOrders.status, filters.status));
      }
    }
    // Phase 2: dual-track physical/financial status filters
    if (filters?.physicalStatus) {
      const vals = Array.isArray(filters.physicalStatus) ? filters.physicalStatus : [filters.physicalStatus];
      conditions.push(vals.length === 1 ? eq(purchaseOrders.physicalStatus, vals[0]) : inArray(purchaseOrders.physicalStatus, vals));
    }
    if (filters?.financialStatus) {
      const vals = Array.isArray(filters.financialStatus) ? filters.financialStatus : [filters.financialStatus];
      conditions.push(vals.length === 1 ? eq(purchaseOrders.financialStatus, vals[0]) : inArray(purchaseOrders.financialStatus, vals));
    }
    if (filters?.vendorId) conditions.push(eq(purchaseOrders.vendorId, filters.vendorId));
    if (filters?.search) {
      conditions.push(or(
        like(purchaseOrders.poNumber, `%${filters.search}%`),
        like(purchaseOrders.referenceNumber, `%${filters.search}%`),
      )!);
    }

    let query = db.select().from(purchaseOrders).orderBy(desc(purchaseOrders.createdAt));
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    if (filters?.limit) query = query.limit(filters.limit) as typeof query;
    if (filters?.offset) query = query.offset(filters.offset) as typeof query;
    return await query;
  },

  async getPurchaseOrdersCount(filters?: { status?: string | string[]; physicalStatus?: string | string[]; financialStatus?: string | string[]; vendorId?: number; search?: string }): Promise<number> {
    const conditions: any[] = [];
    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(inArray(purchaseOrders.status, filters.status));
      } else {
        conditions.push(eq(purchaseOrders.status, filters.status));
      }
    }
    // Phase 2: dual-track physical/financial status filters
    if (filters?.physicalStatus) {
      const vals = Array.isArray(filters.physicalStatus) ? filters.physicalStatus : [filters.physicalStatus];
      conditions.push(vals.length === 1 ? eq(purchaseOrders.physicalStatus, vals[0]) : inArray(purchaseOrders.physicalStatus, vals));
    }
    if (filters?.financialStatus) {
      const vals = Array.isArray(filters.financialStatus) ? filters.financialStatus : [filters.financialStatus];
      conditions.push(vals.length === 1 ? eq(purchaseOrders.financialStatus, vals[0]) : inArray(purchaseOrders.financialStatus, vals));
    }
    if (filters?.vendorId) conditions.push(eq(purchaseOrders.vendorId, filters.vendorId));
    if (filters?.search) {
      conditions.push(or(
        like(purchaseOrders.poNumber, `%${filters.search}%`),
        like(purchaseOrders.referenceNumber, `%${filters.search}%`),
      )!);
    }

    let query = db.select({ count: sql<number>`count(*)` }).from(purchaseOrders);
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    const result = await query;
    return Number(result[0]?.count ?? 0);
  },

  async getPurchaseOrderById(id: number): Promise<PurchaseOrder | undefined> {
    const result = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
    return result[0];
  },

  async getPurchaseOrderByPoNumber(poNumber: string): Promise<PurchaseOrder | undefined> {
    const result = await db.select().from(purchaseOrders).where(eq(purchaseOrders.poNumber, poNumber)).limit(1);
    return result[0];
  },

  async createPurchaseOrder(data: InsertPurchaseOrder): Promise<PurchaseOrder> {
    const result = await db.insert(purchaseOrders).values(data).returning();
    return result[0];
  },

  async updatePurchaseOrder(id: number, updates: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder | null> {
    const result = await db.update(purchaseOrders)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, id))
      .returning();
    return result[0] || null;
  },

  async updatePurchaseOrderStatusWithHistory(id: number, updates: Partial<InsertPurchaseOrder>, historyData: Omit<InsertPoStatusHistory, 'purchaseOrderId'>): Promise<PurchaseOrder | null> {
    // Defensive validation: this helper writes to po_status_history, which
    // has to_status NOT NULL. Callers must supply valid historyData with at
    // least `toStatus`. If you just need to update PO fields without a
    // status transition, use updatePurchaseOrder() instead.
    if (!historyData || typeof historyData !== "object") {
      throw new Error(
        "updatePurchaseOrderStatusWithHistory requires historyData. Use updatePurchaseOrder() for non-status updates.",
      );
    }
    if (!historyData.toStatus) {
      throw new Error(
        "updatePurchaseOrderStatusWithHistory requires historyData.toStatus. " +
        "Received keys: " + Object.keys(historyData).join(",") + ". " +
        "Use updatePurchaseOrder() for non-status updates.",
      );
    }

    return await db.transaction(async (tx) => {
      const result = await tx.update(purchaseOrders)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(purchaseOrders.id, id))
        .returning();

      const updatedPo = result[0] || null;
      if (updatedPo) {
        await tx.insert(poStatusHistory).values({
          ...historyData,
          purchaseOrderId: id,
        });
      }
      return updatedPo;
    });
  },

  async deletePurchaseOrder(id: number): Promise<boolean> {
    const result = await db.delete(purchaseOrders).where(eq(purchaseOrders.id, id)).returning();
    return result.length > 0;
  },

  async generatePoNumber(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `PO-${dateStr}-`;

    const existing = await db.select({ poNumber: purchaseOrders.poNumber })
      .from(purchaseOrders)
      .where(like(purchaseOrders.poNumber, `${prefix}%`))
      .orderBy(desc(purchaseOrders.poNumber))
      .limit(1);

    let nextNum = 1;
    if (existing.length > 0 && existing[0].poNumber) {
      const lastNum = parseInt(existing[0].poNumber.replace(prefix, ''), 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }

    return `${prefix}${String(nextNum).padStart(3, '0')}`;
  },

  async getPurchaseOrderLines(purchaseOrderId: number): Promise<PurchaseOrderLine[]> {
    return await db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
      .orderBy(asc(purchaseOrderLines.lineNumber));
  },

  async getPurchaseOrderLineById(id: number): Promise<PurchaseOrderLine | undefined> {
    const result = await db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, id)).limit(1);
    return result[0];
  },

  async createPurchaseOrderLine(data: InsertPurchaseOrderLine): Promise<PurchaseOrderLine> {
    const result = await db.insert(purchaseOrderLines).values(data).returning();
    return result[0];
  },

  async bulkCreatePurchaseOrderLines(lines: InsertPurchaseOrderLine[]): Promise<PurchaseOrderLine[]> {
    if (lines.length === 0) return [];
    return await db.insert(purchaseOrderLines).values(lines).returning();
  },

  async updatePurchaseOrderLine(id: number, updates: Partial<InsertPurchaseOrderLine>): Promise<PurchaseOrderLine | null> {
    const result = await db.update(purchaseOrderLines)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(purchaseOrderLines.id, id))
      .returning();
    return result[0] || null;
  },

  async deletePurchaseOrderLine(id: number): Promise<boolean> {
    const result = await db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.id, id)).returning();
    return result.length > 0;
  },

  async getOpenPoLinesForVariant(productVariantId: number): Promise<PurchaseOrderLine[]> {
    const variantRows = await db.execute<{ product_id: number }>(sql`
      SELECT product_id
      FROM catalog.product_variants
      WHERE id = ${productVariantId}
      LIMIT 1
    `);
    const productId = variantRows.rows[0]?.product_id;
    if (!productId) return [];

    return await db.select().from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
      .where(and(
        eq(purchaseOrderLines.productId, Number(productId)),
        inArray(purchaseOrderLines.status, ['open', 'partially_received']),
        inArray(purchaseOrders.status, ['approved', 'sent', 'acknowledged', 'partially_received']),
      ))
      .then(rows => rows.map(r => r.purchase_order_lines));
  },

  async createPoStatusHistory(data: InsertPoStatusHistory): Promise<PoStatusHistory> {
    const result = await db.insert(poStatusHistory).values(data).returning();
    return result[0];
  },

  async getPoStatusHistory(purchaseOrderId: number): Promise<PoStatusHistory[]> {
    return await db.select().from(poStatusHistory)
      .where(eq(poStatusHistory.purchaseOrderId, purchaseOrderId))
      .orderBy(asc(poStatusHistory.changedAt));
  },

  async createPoRevision(data: InsertPoRevision): Promise<PoRevision> {
    const result = await db.insert(poRevisions).values(data).returning();
    return result[0];
  },

  async getPoRevisions(purchaseOrderId: number): Promise<PoRevision[]> {
    return await db.select().from(poRevisions)
      .where(eq(poRevisions.purchaseOrderId, purchaseOrderId))
      .orderBy(desc(poRevisions.createdAt));
  },

  async createPoReceipt(data: InsertPoReceipt): Promise<PoReceipt> {
    const result = await db.insert(poReceipts).values(data).returning();
    return result[0];
  },

  async getPoReceipts(purchaseOrderId: number): Promise<PoReceipt[]> {
    return await db.select().from(poReceipts)
      .where(eq(poReceipts.purchaseOrderId, purchaseOrderId))
      .orderBy(desc(poReceipts.createdAt));
  },

  async getPoReceiptsByLine(purchaseOrderLineId: number): Promise<PoReceipt[]> {
    return await db.select().from(poReceipts)
      .where(eq(poReceipts.purchaseOrderLineId, purchaseOrderLineId))
      .orderBy(desc(poReceipts.createdAt));
  },

  async reconcilePoReceiptLine(input: {
    purchaseOrderLineId: number;
    receivingLineId: number;
    lineUpdates: Partial<InsertPurchaseOrderLine>;
    receipt: InsertPoReceipt;
  }): Promise<{ applied: boolean; receipt?: PoReceipt; purchaseOrderLine?: PurchaseOrderLine | null }> {
    try {
      return await db.transaction(async (tx) => {
        const existingReceipt = await tx.select()
          .from(poReceipts)
          .where(and(
            eq(poReceipts.purchaseOrderLineId, input.purchaseOrderLineId),
            eq(poReceipts.receivingLineId, input.receivingLineId),
          ))
          .limit(1);

        if (existingReceipt[0]) {
          return { applied: false, receipt: existingReceipt[0] };
        }

        const updatedLines = await tx.update(purchaseOrderLines)
          .set({ ...input.lineUpdates, updatedAt: new Date() })
          .where(eq(purchaseOrderLines.id, input.purchaseOrderLineId))
          .returning();

        const insertedReceipts = await tx.insert(poReceipts)
          .values(input.receipt)
          .returning();

        return {
          applied: true,
          purchaseOrderLine: updatedLines[0] || null,
          receipt: insertedReceipts[0],
        };
      });
    } catch (error: any) {
      if (error?.code === "23505" || error?.cause?.code === "23505") {
        const existingReceipt = await db.select()
          .from(poReceipts)
          .where(and(
            eq(poReceipts.purchaseOrderLineId, input.purchaseOrderLineId),
            eq(poReceipts.receivingLineId, input.receivingLineId),
          ))
          .limit(1);

        if (existingReceipt[0]) {
          return { applied: false, receipt: existingReceipt[0] };
        }
      }

      throw error;
    }
  },

  async getInventoryLots(filters?: { productVariantId?: number; warehouseLocationId?: number; status?: string; limit?: number; offset?: number }): Promise<InventoryLot[]> {
    const conditions: any[] = [];
    if (filters?.productVariantId) conditions.push(eq(inventoryLots.productVariantId, filters.productVariantId));
    if (filters?.warehouseLocationId) conditions.push(eq(inventoryLots.warehouseLocationId, filters.warehouseLocationId));
    if (filters?.status) conditions.push(eq(inventoryLots.status, filters.status));

    let query = db.select().from(inventoryLots).orderBy(asc(inventoryLots.receivedAt));
    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query;
    }
    if (filters?.limit) query = query.limit(filters.limit) as typeof query;
    if (filters?.offset) query = query.offset(filters.offset) as typeof query;
    return await query;
  },

  async getInventoryLotById(id: number): Promise<InventoryLot | undefined> {
    const result = await db.select().from(inventoryLots).where(eq(inventoryLots.id, id)).limit(1);
    return result[0];
  },

  async createInventoryLot(data: InsertInventoryLot): Promise<InventoryLot> {
    const result = await db.insert(inventoryLots).values(data).returning();
    return result[0];
  },

  async updateInventoryLot(id: number, updates: Partial<InsertInventoryLot>): Promise<InventoryLot | null> {
    const result = await db.update(inventoryLots)
      .set(updates)
      .where(eq(inventoryLots.id, id))
      .returning();
    return result[0] || null;
  },

  async getFifoLots(productVariantId: number, warehouseLocationId: number): Promise<InventoryLot[]> {
    return await db.select().from(inventoryLots)
      .where(and(
        eq(inventoryLots.productVariantId, productVariantId),
        eq(inventoryLots.warehouseLocationId, warehouseLocationId),
        eq(inventoryLots.status, 'active'),
      ))
      .orderBy(asc(inventoryLots.receivedAt));
  },

  async generateLotNumber(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `LOT-${dateStr}-`;

    const existing = await db.select({ lotNumber: inventoryLots.lotNumber })
      .from(inventoryLots)
      .where(like(inventoryLots.lotNumber, `${prefix}%`))
      .orderBy(desc(inventoryLots.lotNumber))
      .limit(1);

    let nextNum = 1;
    if (existing.length > 0 && existing[0].lotNumber) {
      const lastNum = parseInt(existing[0].lotNumber.replace(prefix, ''), 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }

    return `${prefix}${String(nextNum).padStart(3, '0')}`;
  },

  async createOrderItemCost(data: InsertOrderItemCost): Promise<OrderItemCost> {
    const result = await db.insert(orderItemCosts).values(data).returning();
    return result[0];
  },

  async getOrderItemCosts(orderItemId: number): Promise<OrderItemCost[]> {
    return await db.select().from(orderItemCosts)
      .where(eq(orderItemCosts.orderItemId, orderItemId));
  },

  async getOrderItemCostsByOrder(orderId: number): Promise<OrderItemCost[]> {
    return await db.select().from(orderItemCosts)
      .where(eq(orderItemCosts.orderId, orderId));
  },

  async createOrderItemFinancial(data: InsertOrderItemFinancial): Promise<OrderItemFinancial> {
    const result = await db.insert(orderItemFinancials).values(data).returning();
    return result[0];
  },

  async getOrderItemFinancials(orderId: number): Promise<OrderItemFinancial[]> {
    return await db.select().from(orderItemFinancials)
      .where(eq(orderItemFinancials.orderId, orderId));
  },

  async getInboundShipments(filters?: any): Promise<InboundShipment[]> {
    const conditions: any[] = [];
    if (filters?.status) {
      if (Array.isArray(filters.status)) conditions.push(inArray(inboundShipments.status, filters.status));
      else conditions.push(eq(inboundShipments.status, filters.status));
    }
    if (filters?.mode) conditions.push(eq(inboundShipments.mode, filters.mode));
    if (filters?.warehouseId) conditions.push(eq(inboundShipments.warehouseId, filters.warehouseId));
    if (filters?.search) {
      conditions.push(or(
        like(inboundShipments.shipmentNumber, `%${filters.search}%`),
        like(inboundShipments.carrierName, `%${filters.search}%`),
        like(inboundShipments.containerNumber, `%${filters.search}%`),
      ));
    }
    let query = db.select().from(inboundShipments).orderBy(desc(inboundShipments.createdAt)) as any;
    if (conditions.length > 0) query = query.where(and(...conditions));
    if (filters?.limit) query = query.limit(filters.limit);
    if (filters?.offset) query = query.offset(filters.offset);
    return await query;
  },

  async getInboundShipmentsCount(filters?: any): Promise<number> {
    const conditions: any[] = [];
    if (filters?.status) {
      if (Array.isArray(filters.status)) conditions.push(inArray(inboundShipments.status, filters.status));
      else conditions.push(eq(inboundShipments.status, filters.status));
    }
    if (filters?.mode) conditions.push(eq(inboundShipments.mode, filters.mode));
    if (filters?.warehouseId) conditions.push(eq(inboundShipments.warehouseId, filters.warehouseId));
    let query = db.select({ count: sql<number>`count(*)` }).from(inboundShipments) as any;
    if (conditions.length > 0) query = query.where(and(...conditions));
    const result = await query;
    return Number(result[0]?.count || 0);
  },

  async getInboundShipmentById(id: number): Promise<InboundShipment | undefined> {
    const result = await db.select().from(inboundShipments).where(eq(inboundShipments.id, id)).limit(1);
    return result[0];
  },

  async getInboundShipmentByNumber(shipmentNumber: string): Promise<InboundShipment | undefined> {
    const result = await db.select().from(inboundShipments).where(eq(inboundShipments.shipmentNumber, shipmentNumber)).limit(1);
    return result[0];
  },

  async createInboundShipment(data: InsertInboundShipment): Promise<InboundShipment> {
    const result = await db.insert(inboundShipments).values(data as any).returning();
    return result[0];
  },

  async updateInboundShipment(id: number, updates: Partial<InsertInboundShipment>): Promise<InboundShipment | null> {
    const result = await db.update(inboundShipments).set({ ...updates, updatedAt: new Date() } as any).where(eq(inboundShipments.id, id)).returning();
    return result[0] || null;
  },

  async deleteInboundShipment(id: number): Promise<boolean> {
    const result = await db.delete(inboundShipments).where(eq(inboundShipments.id, id)).returning();
    return result.length > 0;
  },

  async generateShipmentNumber(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `SHP-${dateStr}-`;
    const existing = await db.select({ shipmentNumber: inboundShipments.shipmentNumber })
      .from(inboundShipments)
      .where(like(inboundShipments.shipmentNumber, `${prefix}%`))
      .orderBy(desc(inboundShipments.shipmentNumber))
      .limit(1);
    let nextNum = 1;
    if (existing.length > 0 && existing[0].shipmentNumber) {
      const lastNum = parseInt(existing[0].shipmentNumber.replace(prefix, ''), 10);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }
    return `${prefix}${String(nextNum).padStart(3, '0')}`;
  },

  async getInboundShipmentLines(inboundShipmentId: number): Promise<InboundShipmentLine[]> {
    return await db
      .select()
      .from(inboundShipmentLines)
      .where(eq(inboundShipmentLines.inboundShipmentId, inboundShipmentId))
      .orderBy(asc(inboundShipmentLines.createdAt), asc(inboundShipmentLines.id));
  },

  async getInboundShipmentLineById(id: number): Promise<InboundShipmentLine | undefined> {
    const result = await db.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.id, id)).limit(1);
    return result[0];
  },

  async getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<InboundShipmentLine[]> {
    return await db.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.purchaseOrderId, purchaseOrderId));
  },

  // SINGLE SOURCE OF TRUTH for "how much of each PO line has already shipped".
  // Both the add-lines write path (validating remaining qty inside its FOR
  // UPDATE transaction — it passes its `tx` as `executor`) and the
  // shippable-lines read path (deciding which lines the Create Shipment modal
  // offers) call this, so the status rule below can never drift between them.
  //
  // Cancelled shipments are excluded: their goods never left the origin. Cancel
  // is a soft status change — the shipment header and its lines are retained for
  // audit — so every "already shipped" calculation MUST filter them out. Statuses
  // that represent real movement (closed, delivered, etc.) still count. Add any
  // future non-counting status to NON_COUNTING_SHIPMENT_STATUSES and every
  // caller inherits it.
  async getShippedQtyByPoLines(poLineIds: number[], executor: any = db): Promise<Map<number, number>> {
    const NON_COUNTING_SHIPMENT_STATUSES = ["cancelled"];
    const map = new Map<number, number>();
    if (poLineIds.length === 0) return map;
    const rows = await executor
      .select({
        poLineId: inboundShipmentLines.purchaseOrderLineId,
        shipped: sql<number>`COALESCE(SUM(${inboundShipmentLines.qtyShipped}), 0)`,
      })
      .from(inboundShipmentLines)
      .innerJoin(inboundShipments, eq(inboundShipments.id, inboundShipmentLines.inboundShipmentId))
      .where(
        and(
          inArray(inboundShipmentLines.purchaseOrderLineId, poLineIds),
          notInArray(inboundShipments.status, NON_COUNTING_SHIPMENT_STATUSES),
        ),
      )
      .groupBy(inboundShipmentLines.purchaseOrderLineId);
    for (const r of rows as any[]) {
      if (r.poLineId != null) map.set(Number(r.poLineId), Number(r.shipped));
    }
    return map;
  },

  async createInboundShipmentLine(data: InsertInboundShipmentLine): Promise<InboundShipmentLine> {
    const result = await db.insert(inboundShipmentLines).values(data as any).returning();
    return result[0];
  },

  async bulkCreateInboundShipmentLines(lines: InsertInboundShipmentLine[]): Promise<InboundShipmentLine[]> {
    if (lines.length === 0) return [];
    return await db.insert(inboundShipmentLines).values(lines as any).returning();
  },

  async updateInboundShipmentLine(id: number, updates: Partial<InsertInboundShipmentLine>): Promise<InboundShipmentLine | null> {
    const result = await db.update(inboundShipmentLines).set({ ...updates, updatedAt: new Date() } as any).where(eq(inboundShipmentLines.id, id)).returning();
    return result[0] || null;
  },

  async deleteInboundShipmentLine(id: number): Promise<boolean> {
    const result = await db.delete(inboundShipmentLines).where(eq(inboundShipmentLines.id, id)).returning();
    return result.length > 0;
  },

  async getInboundFreightCosts(inboundShipmentId: number): Promise<InboundFreightCost[]> {
    return await db.select().from(inboundFreightCosts).where(eq(inboundFreightCosts.inboundShipmentId, inboundShipmentId));
  },

  async getInboundFreightCostById(id: number): Promise<InboundFreightCost | undefined> {
    const result = await db.select().from(inboundFreightCosts).where(eq(inboundFreightCosts.id, id)).limit(1);
    return result[0];
  },

  async createInboundFreightCost(data: InsertInboundFreightCost): Promise<InboundFreightCost> {
    const result = await db.insert(inboundFreightCosts).values(data as any).returning();
    return result[0];
  },

  async updateInboundFreightCost(id: number, updates: Partial<InsertInboundFreightCost>): Promise<InboundFreightCost | null> {
    const result = await db.update(inboundFreightCosts).set({ ...updates, updatedAt: new Date() } as any).where(eq(inboundFreightCosts.id, id)).returning();
    return result[0] || null;
  },

  async deleteInboundFreightCost(id: number): Promise<boolean> {
    const result = await db.delete(inboundFreightCosts).where(eq(inboundFreightCosts.id, id)).returning();
    return result.length > 0;
  },

  async getInboundFreightCostAllocations(inboundFreightCostId: number): Promise<any[]> {
    return await db.select().from(inboundFreightAllocations).where(eq(inboundFreightAllocations.shipmentCostId, inboundFreightCostId));
  },

  async getAllocationsForLine(inboundShipmentLineId: number): Promise<any[]> {
    return await db.select().from(inboundFreightAllocations).where(eq(inboundFreightAllocations.inboundShipmentLineId, inboundShipmentLineId));
  },

  async createInboundFreightCostAllocation(data: InsertInboundFreightAllocation): Promise<any> {
    const result = await db.insert(inboundFreightAllocations).values(data as any).returning();
    return result[0];
  },

  async bulkCreateInboundFreightCostAllocations(allocations: InsertInboundFreightAllocation[]): Promise<any[]> {
    if (allocations.length === 0) return [];
    return await db.insert(inboundFreightAllocations).values(allocations as any).returning();
  },

  async deleteAllocationsForShipment(inboundShipmentId: number): Promise<void> {
    const costs = await this.getInboundFreightCosts(inboundShipmentId);
    if (costs.length > 0) {
      await db.delete(inboundFreightAllocations).where(inArray(inboundFreightAllocations.shipmentCostId, costs.map(c => c.id)));
    }
  },

  async getLandedCostSnapshots(inboundShipmentLineId: number): Promise<any[]> {
    return await db.select().from(landedCostSnapshots).where(eq(landedCostSnapshots.inboundShipmentLineId, inboundShipmentLineId));
  },

  async getLandedCostSnapshotByPoLine(purchaseOrderLineId: number): Promise<any> {
    const result = await db.select().from(landedCostSnapshots).where(eq(landedCostSnapshots.purchaseOrderLineId, purchaseOrderLineId)).limit(1);
    return result[0];
  },

  async createLandedCostSnapshot(data: InsertLandedCostSnapshot): Promise<any> {
    const result = await db.insert(landedCostSnapshots).values(data as any).returning();
    return result[0];
  },

  async createLandedCostAdjustment(data: any): Promise<any> {
    const result = await db.insert(landedCostAdjustments).values(data).returning();
    return result[0];
  },

  async bulkCreateLandedCostSnapshots(snapshots: InsertLandedCostSnapshot[]): Promise<any[]> {
    if (snapshots.length === 0) return [];
    return await db.insert(landedCostSnapshots).values(snapshots as any).returning();
  },

  async deleteLandedCostSnapshotsForShipment(inboundShipmentId: number): Promise<void> {
    const lines = await this.getInboundShipmentLines(inboundShipmentId);
    if (lines.length > 0) {
      await db.delete(landedCostSnapshots).where(inArray(landedCostSnapshots.inboundShipmentLineId, lines.map(l => l.id)));
    }
  },

  async createInboundShipmentStatusHistory(data: any): Promise<InboundShipmentStatusHistory> {
    const result = await db.insert(inboundShipmentStatusHistory).values(data).returning();
    return result[0];
  },

  async getInboundShipmentStatusHistory(inboundShipmentId: number): Promise<InboundShipmentStatusHistory[]> {
    return await db.select().from(inboundShipmentStatusHistory)
      .where(eq(inboundShipmentStatusHistory.inboundShipmentId, inboundShipmentId))
      .orderBy(desc(inboundShipmentStatusHistory.changedAt));
  },

  async getInboundShipmentsByPo(purchaseOrderId: number): Promise<InboundShipment[]> {
    const subIds = await db
      .selectDistinct({ id: inboundShipmentLines.inboundShipmentId })
      .from(inboundShipmentLines)
      .where(eq(inboundShipmentLines.purchaseOrderId, purchaseOrderId));
    if (subIds.length === 0) return [];
    return await db.select().from(inboundShipments)
      .where(inArray(inboundShipments.id, subIds.map(r => r.id)))
      .orderBy(desc(inboundShipments.createdAt));
  },

  async getProvisionalLotsByShipment(inboundShipmentId: number): Promise<InventoryLot[]> {
    return await db.select().from(inventoryLots)
      .where(and(
        eq((inventoryLots as any).inboundShipmentId, inboundShipmentId),
        eq((inventoryLots as any).costProvisional, 1)
      ));
  },

  async getReorderAnalysisData(lookbackDays: number): Promise<any[]> {
    const normalizedLookbackDays = Math.max(1, Math.trunc(Number(lookbackDays) || 30));
    const shortWindowDays = Math.max(1, Math.min(7, normalizedLookbackDays));
    const longWindowDays = Math.max(90, normalizedLookbackDays * 3);
    const seasonalWindowDays = normalizedLookbackDays;
    const seasonalScanWindowDays = 365 + seasonalWindowDays * 2;
    const demandScanWindowDays = Math.max(
      normalizedLookbackDays * 2,
      shortWindowDays * 2,
      longWindowDays * 2,
      seasonalScanWindowDays,
    );
    // Boundary note: reads inventory_levels directly instead of atpService.getAtpPerVariant().
    // This is intentional — the reorder query needs bulk aggregation across ALL products in one
    // query (N+1 atpService calls would be prohibitively slow), and it needs per-location detail
    // (reserved vs on-hand breakdown) that the ATP service doesn't expose. This is a read-only
    // cross-boundary query for procurement decision support.
    const rows = await db.execute(sql`
      SELECT
        p.id AS product_id,
        p.sku AS base_sku,
        p.name AS product_name,
        p.lead_time_days,
        p.safety_stock_days,
        preferred_vendor.vendor_product_id,
        preferred_vendor.vendor_id AS preferred_vendor_id,
        preferred_vendor.vendor_name AS preferred_vendor_name,
        preferred_vendor.unit_cost_cents AS estimated_cost_cents,
        preferred_vendor.unit_cost_mills AS estimated_cost_mills,
        preferred_vendor.pricing_basis AS vendor_pricing_basis,
        preferred_vendor.purchase_uom AS vendor_purchase_uom,
        preferred_vendor.quoted_unit_cost_mills AS vendor_quoted_unit_cost_mills,
        preferred_vendor.pieces_per_purchase_uom AS vendor_pieces_per_purchase_uom,
        preferred_vendor.moq AS vendor_moq,
        preferred_vendor.quote_reference AS vendor_quote_reference,
        preferred_vendor.quoted_at AS vendor_quoted_at,
        preferred_vendor.quoted_at_date AS vendor_quoted_at_date,
        preferred_vendor.quote_valid_until AS vendor_quote_valid_until,
        preferred_vendor.last_cost_mills,
        preferred_vendor.last_cost_cents,
        preferred_vendor.last_purchased_at AS vendor_product_last_purchased_at,
        preferred_vendor.updated_at AS vendor_product_updated_at,
        preferred_vendor.lead_time_days AS vendor_lead_time_days,
        transaction_timestamp() AS recommendation_analysis_as_of,
        current_date::text AS recommendation_analysis_date,
        COALESCE(inv.total_pieces, 0)::bigint AS total_pieces,
        COALESCE(inv.total_reserved_pieces, 0)::bigint AS total_reserved_pieces,
        COALESCE(vel.total_outbound_pieces, 0)::bigint AS total_outbound_pieces,
        COALESCE(vel.previous_outbound_pieces, 0)::bigint AS previous_outbound_pieces,
        COALESCE(vel.demand_order_count, 0)::int AS demand_order_count,
        COALESCE(vel.demand_active_days, 0)::int AS demand_active_days,
        vel.latest_demand_at,
        vel.latest_known_demand_at,
        COALESCE(vel.paid_demand_pieces, 0)::bigint AS paid_demand_pieces,
        COALESCE(vel.zero_revenue_demand_pieces, 0)::bigint AS zero_revenue_demand_pieces,
        COALESCE(vel.coupon_discount_demand_pieces, 0)::bigint AS coupon_discount_demand_pieces,
        ${shortWindowDays}::int AS short_window_days,
        COALESCE(vel.short_outbound_pieces, 0)::bigint AS short_outbound_pieces,
        COALESCE(vel.previous_short_outbound_pieces, 0)::bigint AS previous_short_outbound_pieces,
        COALESCE(vel.short_demand_order_count, 0)::int AS short_demand_order_count,
        COALESCE(vel.short_demand_active_days, 0)::int AS short_demand_active_days,
        vel.short_latest_demand_at,
        ${longWindowDays}::int AS long_window_days,
        COALESCE(vel.long_outbound_pieces, 0)::bigint AS long_outbound_pieces,
        COALESCE(vel.previous_long_outbound_pieces, 0)::bigint AS previous_long_outbound_pieces,
        COALESCE(vel.long_demand_order_count, 0)::int AS long_demand_order_count,
        COALESCE(vel.long_demand_active_days, 0)::int AS long_demand_active_days,
        vel.long_latest_demand_at,
        ${seasonalWindowDays}::int AS seasonal_window_days,
        COALESCE(vel.seasonal_outbound_pieces, 0)::bigint AS seasonal_outbound_pieces,
        COALESCE(vel.previous_seasonal_outbound_pieces, 0)::bigint AS previous_seasonal_outbound_pieces,
        COALESCE(vel.seasonal_demand_order_count, 0)::int AS seasonal_demand_order_count,
        COALESCE(vel.seasonal_demand_active_days, 0)::int AS seasonal_demand_active_days,
        vel.seasonal_latest_demand_at,
        inv.variant_count,
        order_uom.variant_id,
        order_uom.units_per_variant AS order_uom_units,
        order_uom.sku AS order_uom_sku,
        order_uom.hierarchy_level AS order_uom_level,
        COALESCE(on_order.on_order_pieces, 0)::bigint AS on_order_pieces,
        COALESCE(on_order.open_po_count, 0)::int AS open_po_count,
        on_order.earliest_expected,
        (SELECT MAX(it2.created_at)
         FROM inventory.inventory_transactions it2
         JOIN catalog.product_variants pv2 ON pv2.id = it2.product_variant_id
         WHERE pv2.product_id = p.id
           AND it2.transaction_type = 'receipt') AS last_received_at,
        COALESCE(fwd.weighted_pieces, 0)::bigint AS forward_demand_pieces,
        COALESCE(fwd.raw_pieces, 0)::bigint AS forward_demand_raw_pieces,
        COALESCE(fwd.event_count, 0)::int AS forward_demand_event_count
      FROM catalog.products p
      LEFT JOIN (
        SELECT pv.product_id,
               SUM(il.variant_qty * pv.units_per_variant) AS total_pieces,
               SUM(il.reserved_qty * pv.units_per_variant) AS total_reserved_pieces,
               COUNT(DISTINCT pv.id) AS variant_count
        FROM inventory.inventory_levels il
        JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        WHERE pv.is_active = true
        GROUP BY pv.product_id
      ) inv ON inv.product_id = p.id
      LEFT JOIN (
        SELECT pv.product_id,
               SUM(
                 CASE
                   WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                   THEN oi.quantity * pv.units_per_variant
                   ELSE 0
                 END
               ) AS total_outbound_pieces,
               SUM(
                 CASE
                   WHEN o.order_placed_at <= NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                    AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays * 2})
                   THEN oi.quantity * pv.units_per_variant
                   ELSE 0
                 END
               ) AS previous_outbound_pieces,
               COUNT(DISTINCT CASE
                 WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                 THEN oi.order_id
                 ELSE NULL
               END) AS demand_order_count,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                  THEN DATE(o.order_placed_at)
                  ELSE NULL
                END) AS demand_active_days,
                MAX(CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                  THEN o.order_placed_at
                  ELSE NULL
                END) AS latest_demand_at,
                MAX(o.order_placed_at) AS latest_known_demand_at,
                SUM(
                  CASE
                    WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                     AND GREATEST(
                       COALESCE(oi.total_price_cents, 0),
                       COALESCE(ool.total_price_cents, 0),
                       COALESCE(oi.paid_price_cents, 0) * oi.quantity,
                       COALESCE(ool.paid_price_cents, 0) * oi.quantity
                     ) > 0
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS paid_demand_pieces,
                SUM(
                  CASE
                    WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                     AND GREATEST(
                       COALESCE(oi.total_price_cents, 0),
                       COALESCE(ool.total_price_cents, 0),
                       COALESCE(oi.paid_price_cents, 0) * oi.quantity,
                       COALESCE(ool.paid_price_cents, 0) * oi.quantity
                     ) <= 0
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS zero_revenue_demand_pieces,
                SUM(
                  CASE
                    WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${normalizedLookbackDays})
                     AND COALESCE(ool.coupon_discount_cents, 0) > 0
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS coupon_discount_demand_pieces,
                SUM(
                  CASE
                    WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${shortWindowDays})
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS short_outbound_pieces,
                SUM(
                  CASE
                    WHEN o.order_placed_at <= NOW() - MAKE_INTERVAL(days => ${shortWindowDays})
                     AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${shortWindowDays * 2})
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS previous_short_outbound_pieces,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${shortWindowDays})
                  THEN oi.order_id
                  ELSE NULL
                END) AS short_demand_order_count,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${shortWindowDays})
                  THEN DATE(o.order_placed_at)
                  ELSE NULL
                END) AS short_demand_active_days,
                MAX(CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${shortWindowDays})
                  THEN o.order_placed_at
                  ELSE NULL
                END) AS short_latest_demand_at,
                SUM(
                  CASE
                    WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${longWindowDays})
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS long_outbound_pieces,
                SUM(
                  CASE
                    WHEN o.order_placed_at <= NOW() - MAKE_INTERVAL(days => ${longWindowDays})
                     AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${longWindowDays * 2})
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS previous_long_outbound_pieces,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${longWindowDays})
                  THEN oi.order_id
                  ELSE NULL
                END) AS long_demand_order_count,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${longWindowDays})
                  THEN DATE(o.order_placed_at)
                  ELSE NULL
                END) AS long_demand_active_days,
                MAX(CASE
                  WHEN o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${longWindowDays})
                  THEN o.order_placed_at
                  ELSE NULL
                END) AS long_latest_demand_at,
                SUM(
                  CASE
                    WHEN o.order_placed_at <= NOW() - INTERVAL '1 year'
                     AND o.order_placed_at > NOW() - INTERVAL '1 year' - MAKE_INTERVAL(days => ${seasonalWindowDays})
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS seasonal_outbound_pieces,
                SUM(
                  CASE
                    WHEN o.order_placed_at <= NOW() - INTERVAL '1 year' - MAKE_INTERVAL(days => ${seasonalWindowDays})
                     AND o.order_placed_at > NOW() - INTERVAL '1 year' - MAKE_INTERVAL(days => ${seasonalWindowDays * 2})
                    THEN oi.quantity * pv.units_per_variant
                    ELSE 0
                  END
                ) AS previous_seasonal_outbound_pieces,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at <= NOW() - INTERVAL '1 year'
                   AND o.order_placed_at > NOW() - INTERVAL '1 year' - MAKE_INTERVAL(days => ${seasonalWindowDays})
                  THEN oi.order_id
                  ELSE NULL
                END) AS seasonal_demand_order_count,
                COUNT(DISTINCT CASE
                  WHEN o.order_placed_at <= NOW() - INTERVAL '1 year'
                   AND o.order_placed_at > NOW() - INTERVAL '1 year' - MAKE_INTERVAL(days => ${seasonalWindowDays})
                  THEN DATE(o.order_placed_at)
                  ELSE NULL
                END) AS seasonal_demand_active_days,
                MAX(CASE
                  WHEN o.order_placed_at <= NOW() - INTERVAL '1 year'
                   AND o.order_placed_at > NOW() - INTERVAL '1 year' - MAKE_INTERVAL(days => ${seasonalWindowDays})
                  THEN o.order_placed_at
                  ELSE NULL
                END) AS seasonal_latest_demand_at
        FROM wms.order_items oi
        LEFT JOIN oms.oms_order_lines ool ON ool.id = oi.oms_order_line_id
        JOIN wms.orders o ON o.id = oi.order_id
        JOIN catalog.product_variants pv ON pv.sku = oi.sku AND pv.is_active = true
        WHERE o.cancelled_at IS NULL
          AND o.warehouse_status != 'cancelled'
          AND oi.status != 'cancelled'
          AND COALESCE(oi.requires_shipping, 1) = 1
          AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${demandScanWindowDays})
        GROUP BY pv.product_id
      ) vel ON vel.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT pv.id AS variant_id, pv.units_per_variant, pv.sku, pv.hierarchy_level
        FROM catalog.product_variants pv
        WHERE pv.product_id = p.id AND pv.is_active = true
        ORDER BY pv.hierarchy_level DESC
        LIMIT 1
      ) order_uom ON true
      LEFT JOIN LATERAL (
        SELECT
          vp.id AS vendor_product_id,
          vp.vendor_id,
          v.name AS vendor_name,
          vp.unit_cost_cents,
          vp.unit_cost_mills,
          vp.pricing_basis,
          vp.purchase_uom,
          vp.quoted_unit_cost_mills,
          vp.pieces_per_purchase_uom,
          vp.moq,
          vp.quote_reference,
          vp.quoted_at,
          vp.quoted_at::date::text AS quoted_at_date,
          vp.quote_valid_until,
          vp.last_cost_mills,
          vp.last_cost_cents,
          vp.last_purchased_at,
          vp.updated_at,
          vp.lead_time_days,
          vp.product_variant_id
        FROM procurement.vendor_products vp
        JOIN procurement.vendors v ON v.id = vp.vendor_id
        WHERE vp.product_id = p.id
          AND vp.is_preferred = 1
          AND vp.is_active = 1
          AND v.active = 1
          AND (
            vp.product_variant_id = order_uom.variant_id
            OR vp.product_variant_id IS NULL
          )
        ORDER BY
          CASE
            WHEN vp.product_variant_id = order_uom.variant_id THEN 0
            WHEN vp.product_variant_id IS NULL THEN 1
            ELSE 2
          END,
          vp.id
        LIMIT 1
      ) preferred_vendor ON true
      LEFT JOIN (
        SELECT pol.product_id,
               SUM(GREATEST(pol.order_qty - COALESCE(pol.received_qty, 0) - COALESCE(pol.cancelled_qty, 0), 0)) AS on_order_pieces,
               COUNT(DISTINCT po.id) AS open_po_count,
               MIN(COALESCE(pol.expected_delivery_date, po.expected_delivery_date, po.confirmed_delivery_date)) AS earliest_expected
        FROM procurement.purchase_order_lines pol
        JOIN procurement.purchase_orders po ON po.id = pol.purchase_order_id
        WHERE po.status IN ('approved', 'sent', 'acknowledged', 'partially_received')
          AND pol.status IN ('open', 'partially_received')
          AND pol.product_id IS NOT NULL
        GROUP BY pol.product_id
      ) on_order ON on_order.product_id = p.id
      LEFT JOIN (
        SELECT del.product_id,
               SUM(
                 CASE del.confidence
                   WHEN 'high'   THEN del.expected_pieces
                   WHEN 'medium' THEN CEIL(del.expected_pieces * 0.7)
                   WHEN 'low'    THEN CEIL(del.expected_pieces * 0.4)
                   ELSE 0
                 END
               ) AS weighted_pieces,
               SUM(del.expected_pieces) AS raw_pieces,
               COUNT(DISTINCT de.id) AS event_count
        FROM procurement.demand_event_lines del
        JOIN procurement.demand_events de ON de.id = del.demand_event_id
        WHERE de.status IN ('planned', 'active')
          AND de.start_date <= CURRENT_DATE + INTERVAL '90 days'
          AND (de.end_date IS NULL OR de.end_date >= CURRENT_DATE)
        GROUP BY del.product_id
      ) fwd ON fwd.product_id = p.id
      WHERE p.is_active = true
      ORDER BY p.sku, p.name
    `);
    return rows.rows as any[];
  },

  async getOrderProfitabilityReport(limit: number, offset: number): Promise<any[]> {
    // Boundary note: read-only reporting query that intentionally crosses OMS/WMS/Procurement
    // boundaries by joining orders, order_items, order_item_financials, and vendor cost data.
    // This is acceptable for financial reporting — no writes, just aggregation for visibility.
    const rows = await db.execute(sql`
      SELECT
        o.id AS order_id,
        o.order_number,
        o.customer_name,
        o.order_placed_at,
        o.warehouse_status,
        COALESCE(SUM(oi.total_price_cents), 0) AS revenue_cents,
        COALESCE(SUM(oic_agg.cogs_cents), 0) AS cogs_cents,
        COALESCE(SUM(oi.total_price_cents), 0) - COALESCE(SUM(oic_agg.cogs_cents), 0) AS profit_cents,
        CASE WHEN SUM(oi.total_price_cents) > 0
          THEN ROUND((SUM(oi.total_price_cents) - COALESCE(SUM(oic_agg.cogs_cents), 0))::numeric / SUM(oi.total_price_cents) * 100, 2)
          ELSE 0
        END AS margin_percent,
        COUNT(DISTINCT oi.id) AS line_count
      FROM wms.orders o
      JOIN wms.order_items oi ON oi.order_id = o.id
      LEFT JOIN (
        SELECT order_item_id, SUM(total_cost_cents) AS cogs_cents
        FROM oms.order_item_costs
        GROUP BY order_item_id
      ) oic_agg ON oic_agg.order_item_id = oi.id
      WHERE oi.total_price_cents IS NOT NULL
      GROUP BY o.id, o.order_number, o.customer_name, o.order_placed_at, o.warehouse_status
      ORDER BY o.order_placed_at DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows as any[];
  },

  async getProductProfitabilityReport(limit: number, offset: number): Promise<any[]> {
    // Boundary note: read-only reporting query that intentionally crosses OMS/WMS/Procurement
    // boundaries. Joins product_variants, order_items, order_item_financials for margin analysis.
    const rows = await db.execute(sql`
      SELECT
        pv.id AS product_variant_id,
        pv.sku,
        p.title AS product_name,
        SUM(oi.quantity) AS units_sold,
        COALESCE(SUM(oi.total_price_cents), 0) AS revenue_cents,
        COALESCE(SUM(oic_agg.cogs_cents), 0) AS cogs_cents,
        COALESCE(SUM(oi.total_price_cents), 0) - COALESCE(SUM(oic_agg.cogs_cents), 0) AS profit_cents,
        CASE WHEN SUM(oi.total_price_cents) > 0
          THEN ROUND((SUM(oi.total_price_cents) - COALESCE(SUM(oic_agg.cogs_cents), 0))::numeric / SUM(oi.total_price_cents) * 100, 2)
          ELSE 0
        END AS margin_percent,
        pv.last_cost_cents,
        pv.avg_cost_cents
      FROM wms.order_items oi
      JOIN catalog.product_variants pv ON UPPER(pv.sku) = UPPER(oi.sku)
      JOIN catalog.products p ON p.id = pv.product_id
      LEFT JOIN (
        SELECT order_item_id, SUM(total_cost_cents) AS cogs_cents
        FROM oms.order_item_costs
        GROUP BY order_item_id
      ) oic_agg ON oic_agg.order_item_id = oi.id
      WHERE oi.total_price_cents IS NOT NULL
      GROUP BY pv.id, pv.sku, p.title, pv.last_cost_cents, pv.avg_cost_cents
      ORDER BY profit_cents DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    return rows.rows as any[];
  },

  async getVendorSpendReport(): Promise<any[]> {
    const rows = await db.execute(sql`
      SELECT
        v.id AS vendor_id,
        v.name AS vendor_name,
        COUNT(DISTINCT po.id) AS po_count,
        SUM(po.total_cents) AS total_spend_cents,
        SUM(CASE WHEN po.status = 'closed' THEN po.total_cents ELSE 0 END) AS closed_spend_cents,
        SUM(CASE WHEN po.status IN ('sent', 'acknowledged', 'partially_received') THEN po.total_cents ELSE 0 END) AS open_spend_cents,
        MIN(po.order_date) AS first_po_date,
        MAX(po.order_date) AS last_po_date
      FROM procurement.purchase_orders po
      JOIN procurement.vendors v ON v.id = po.vendor_id
      WHERE po.status NOT IN ('cancelled', 'draft')
      GROUP BY v.id, v.name
      ORDER BY total_spend_cents DESC
    `);
    return rows.rows as any[];
  },

  async getCostVarianceReport(): Promise<any[]> {
    const rows = await db.execute(sql`
      SELECT
        pr.id,
        po.po_number,
        v.name AS vendor_name,
        pol.sku,
        pol.product_name,
        pr.po_unit_cost_cents,
        pr.actual_unit_cost_cents,
        pr.variance_cents,
        pr.qty_received,
        CASE WHEN pr.po_unit_cost_cents > 0
          THEN ROUND((pr.variance_cents::numeric / pr.po_unit_cost_cents) * 100, 2)
          ELSE 0
        END AS variance_percent,
        pr.created_at
      FROM procurement.po_receipts pr
      JOIN procurement.purchase_orders po ON po.id = pr.purchase_order_id
      JOIN procurement.purchase_order_lines pol ON pol.id = pr.purchase_order_line_id
      JOIN procurement.vendors v ON v.id = po.vendor_id
      WHERE pr.variance_cents IS NOT NULL AND pr.variance_cents != 0
      ORDER BY ABS(pr.variance_cents) DESC
      LIMIT 100
    `);
    return rows.rows as any[];
  },

  async getOpenPoSummaryReport(): Promise<any[]> {
    const rows = await db.execute(sql`
      SELECT
        po.status,
        COUNT(*) AS po_count,
        SUM(po.total_cents) AS total_value_cents,
        SUM(po.line_count) AS total_lines,
        MIN(po.expected_delivery_date) AS earliest_delivery,
        MAX(po.expected_delivery_date) AS latest_delivery
      FROM procurement.purchase_orders po
      WHERE po.status IN ('draft', 'pending_approval', 'approved', 'sent', 'acknowledged', 'partially_received')
      GROUP BY po.status
      ORDER BY
        CASE po.status
          WHEN 'draft' THEN 1
          WHEN 'pending_approval' THEN 2
          WHEN 'approved' THEN 3
          WHEN 'sent' THEN 4
          WHEN 'acknowledged' THEN 5
          WHEN 'partially_received' THEN 6
        END
    `);
    return rows.rows as any[];
  },

  async getPoAgingReport(): Promise<any[]> {
    const rows = await db.execute(sql`
      SELECT
        po.id,
        po.po_number,
        v.name AS vendor_name,
        po.status,
        po.total_cents,
        po.order_date,
        po.expected_delivery_date,
        EXTRACT(DAY FROM (NOW() - po.order_date))::integer AS days_open,
        CASE
          WHEN po.expected_delivery_date < NOW() THEN 'overdue'
          WHEN po.expected_delivery_date < NOW() + INTERVAL '7 days' THEN 'due_soon'
          ELSE 'on_track'
        END AS delivery_status
      FROM procurement.purchase_orders po
      JOIN procurement.vendors v ON v.id = po.vendor_id
      WHERE po.status IN ('sent', 'acknowledged', 'partially_received')
        AND po.order_date IS NOT NULL
      ORDER BY po.order_date ASC
    `);
    return rows.rows as any[];
  },

  async getExpectedReceiptsReport(): Promise<any[]> {
    const rows = await db.execute(sql`
      SELECT
        po.id AS purchase_order_id,
        po.po_number,
        v.name AS vendor_name,
        po.status,
        po.expected_delivery_date,
        po.confirmed_delivery_date,
        COALESCE(po.confirmed_delivery_date, po.expected_delivery_date) AS eta,
        SUM(GREATEST(pol.order_qty - COALESCE(pol.received_qty, 0) - COALESCE(pol.cancelled_qty, 0), 0)) AS pending_units,
        COUNT(pol.id) AS pending_lines,
        SUM(GREATEST(pol.order_qty - COALESCE(pol.received_qty, 0) - COALESCE(pol.cancelled_qty, 0), 0) * pol.unit_cost_cents) AS pending_value_cents
      FROM procurement.purchase_orders po
      JOIN procurement.vendors v ON v.id = po.vendor_id
      JOIN procurement.purchase_order_lines pol ON pol.purchase_order_id = po.id
        AND pol.status IN ('open', 'partially_received')
      WHERE po.status IN ('sent', 'acknowledged', 'partially_received')
      GROUP BY po.id, po.po_number, v.name, po.status, po.expected_delivery_date, po.confirmed_delivery_date
      ORDER BY COALESCE(po.confirmed_delivery_date, po.expected_delivery_date) ASC NULLS LAST
    `);
    return rows.rows as any[];
  },

  // ===== PURCHASING DASHBOARD METHODS =====

  async getReorderExclusionRules(): Promise<any[]> {
    return await db.select().from(reorderExclusionRules).orderBy(asc(reorderExclusionRules.field));
  },

  async createReorderExclusionRule(data: { field: string; value: string; createdBy?: string }): Promise<any> {
    const [rule] = await db.insert(reorderExclusionRules).values({
      field: data.field,
      value: data.value,
      createdBy: data.createdBy,
    }).returning();
    return rule;
  },

  async deleteReorderExclusionRule(id: number): Promise<boolean> {
    const result = await db.delete(reorderExclusionRules).where(eq(reorderExclusionRules.id, id));
    return (result.rowCount ?? 0) > 0;
  },

  async getExclusionRuleMatchCount(field: string, value: string): Promise<number> {
    let condition: any;
    switch (field) {
      case "category":
        condition = sql`LOWER(${products.category}) = LOWER(${value})`;
        break;
      case "brand":
        condition = sql`LOWER(${products.brand}) = LOWER(${value})`;
        break;
      case "product_type":
        condition = sql`LOWER(${products.productType}) = LOWER(${value})`;
        break;
      case "sku_prefix":
        condition = sql`${products.sku} ILIKE ${value + "%"}`;
        break;
      case "sku_exact":
        condition = sql`LOWER(${products.sku}) = LOWER(${value})`;
        break;
      case "tag":
        condition = sql`${products.tags} @> jsonb_build_array(${value})`;
        break;
      default:
        return 0;
    }
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM ${products}
      WHERE ${products.isActive} = true AND ${condition}
    `);
    return Number((rows.rows as any[])[0]?.cnt || 0);
  },

  async getTotalExcludedProducts(): Promise<number> {
    const rules = await db.select().from(reorderExclusionRules);
    if (rules.length === 0) {
      const rows = await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM ${products}
        WHERE ${products.isActive} = true AND ${products.reorderExcluded} = true
      `);
      return Number((rows.rows as any[])[0]?.cnt || 0);
    }

    // Build exclusion conditions from rules
    const conditions = rules.map((r: any) => {
      switch (r.field) {
        case "category": return sql`LOWER(${products.category}) = LOWER(${r.value})`;
        case "brand": return sql`LOWER(${products.brand}) = LOWER(${r.value})`;
        case "product_type": return sql`LOWER(${products.productType}) = LOWER(${r.value})`;
        case "sku_prefix": return sql`${products.sku} ILIKE ${r.value + "%"}`;
        case "sku_exact": return sql`LOWER(${products.sku}) = LOWER(${r.value})`;
        case "tag": return sql`${products.tags} @> jsonb_build_array(${r.value})`;
        default: return sql`false`;
      }
    });

    const combinedCondition = conditions.length === 1 ? conditions[0] : sql`(${sql.join(conditions, sql` OR `)})`;

    const rows = await db.execute(sql`
      SELECT COUNT(DISTINCT ${products.id})::int AS cnt FROM ${products}
      WHERE ${products.isActive} = true
        AND (${products.reorderExcluded} = true OR ${combinedCondition})
    `);
    return Number((rows.rows as any[])[0]?.cnt || 0);
  },

  async setProductReorderExcluded(productId: number, excluded: boolean): Promise<void> {
    await db.update(products).set({ reorderExcluded: excluded }).where(eq(products.id, productId));
  },

  async getLatestAutoDraftRun(): Promise<any | undefined> {
    const [run] = await db.select().from(autoDraftRuns).orderBy(desc(autoDraftRuns.runAt)).limit(1);
    return run;
  },

  async getRecentAutoDraftRuns(limit: number = 10): Promise<any[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return await db.select()
      .from(autoDraftRuns)
      .orderBy(desc(autoDraftRuns.runAt))
      .limit(safeLimit);
  },

  async getRecentRecommendationDecisions(limit: number = 25): Promise<any[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return await db.select()
      .from(purchasingRecommendationDecisions)
      .orderBy(desc(purchasingRecommendationDecisions.decidedAt))
      .limit(safeLimit);
  },

  async getLatestRecommendationDecisions(recommendationIds: string[], kinds: string[] = []): Promise<any[]> {
    const uniqueIds = Array.from(new Set(recommendationIds.map((id) => String(id).trim()).filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    const conditions = [inArray(purchasingRecommendationDecisions.recommendationId, uniqueIds)];
    const uniqueKinds = Array.from(new Set(kinds.map((kind) => String(kind).trim()).filter(Boolean)));
    if (uniqueKinds.length > 0) {
      conditions.push(inArray(purchasingRecommendationDecisions.kind, uniqueKinds));
    }

    return await db.select()
      .from(purchasingRecommendationDecisions)
      .where(and(...conditions))
      .orderBy(desc(purchasingRecommendationDecisions.decidedAt));
  },

  async getLatestRecommendationDecisionsByDecision(decision: string, limit: number = 25): Promise<any[]> {
    const safeDecision = String(decision ?? "").trim();
    if (!safeDecision) return [];
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));

    const result = await db.execute(sql`
      WITH latest_decisions AS (
        SELECT DISTINCT ON (recommendation_id, kind)
          id,
          recommendation_id AS "recommendationId",
          kind,
          decision,
          status,
          decision_reason AS "decisionReason",
          note,
          source,
          auto_draft_run_id AS "autoDraftRunId",
          product_id AS "productId",
          product_variant_id AS "productVariantId",
          vendor_id AS "vendorId",
          sku,
          product_name AS "productName",
          candidate_score AS "candidateScore",
          candidate_band AS "candidateBand",
          recommendation_snapshot AS "recommendationSnapshot",
          decided_by AS "decidedBy",
          decided_at AS "decidedAt",
          created_at AS "createdAt"
        FROM procurement.purchasing_recommendation_decisions
        WHERE status = 'active'
        ORDER BY recommendation_id, kind, decided_at DESC, id DESC
      )
      SELECT *
      FROM latest_decisions
      WHERE decision = ${safeDecision}
      ORDER BY "decidedAt" DESC, id DESC
      LIMIT ${safeLimit}
    `);

    return result.rows ?? [];
  },

  async createRecommendationDecision(data: any): Promise<any> {
    const [decision] = await db.insert(purchasingRecommendationDecisions).values(data).returning();
    return decision;
  },

  async getRecommendationPoHandoffForPo(purchaseOrderId: number): Promise<PurchasingRecommendationPoHandoff | undefined> {
    const [handoff] = await db.select()
      .from(purchasingRecommendationPoHandoffs)
      .where(eq(purchasingRecommendationPoHandoffs.purchaseOrderId, purchaseOrderId))
      .limit(1);
    return handoff;
  },

  async getRecommendationPoHandoffForLine(purchaseOrderLineId: number): Promise<PurchasingRecommendationPoHandoff | undefined> {
    const [handoff] = await db.select()
      .from(purchasingRecommendationPoHandoffs)
      .where(eq(purchasingRecommendationPoHandoffs.purchaseOrderLineId, purchaseOrderLineId))
      .limit(1);
    return handoff;
  },

  async getAutoDraftSettings(warehouseId?: number): Promise<any> {
    const rows = await db.execute(sql`
      SELECT
        COALESCE(auto_draft_mode, 'draft_po') AS auto_draft_mode,
        COALESCE(auto_draft_approval_policy, 'high_confidence_only') AS auto_draft_approval_policy,
        COALESCE(auto_draft_include_order_soon, false) AS include_order_soon,
        COALESCE(auto_draft_skip_on_open_po, true) AS skip_on_open_po,
        COALESCE(auto_draft_skip_no_vendor, true) AS skip_no_vendor,
        COALESCE(recommendation_candidate_score_strong_threshold, 80) AS candidate_score_strong_threshold,
        COALESCE(recommendation_candidate_score_review_threshold, 60) AS candidate_score_review_threshold,
        COALESCE(auto_draft_po_review_warning_days, 2) AS auto_draft_po_review_warning_days,
        COALESCE(auto_draft_po_review_critical_days, 5) AS auto_draft_po_review_critical_days,
        COALESCE(auto_draft_po_supplier_send_warning_days, 2) AS auto_draft_po_supplier_send_warning_days,
        COALESCE(auto_draft_po_supplier_send_critical_days, 5) AS auto_draft_po_supplier_send_critical_days,
        COALESCE(auto_draft_po_supplier_followup_warning_days, 7) AS auto_draft_po_supplier_followup_warning_days,
        COALESCE(auto_draft_po_supplier_followup_critical_days, 14) AS auto_draft_po_supplier_followup_critical_days,
        COALESCE(auto_draft_po_receiving_warning_days, 3) AS auto_draft_po_receiving_warning_days,
        COALESCE(auto_draft_po_receiving_critical_days, 10) AS auto_draft_po_receiving_critical_days,
        COALESCE(auto_draft_po_ap_closeout_warning_days, 7) AS auto_draft_po_ap_closeout_warning_days,
        COALESCE(auto_draft_po_ap_closeout_critical_days, 21) AS auto_draft_po_ap_closeout_critical_days,
        COALESCE(auto_draft_po_exception_warning_days, 1) AS auto_draft_po_exception_warning_days,
        COALESCE(auto_draft_po_exception_critical_days, 3) AS auto_draft_po_exception_critical_days,
        COALESCE(auto_draft_po_closeout_warning_days, 7) AS auto_draft_po_closeout_warning_days,
        COALESCE(auto_draft_po_closeout_critical_days, 14) AS auto_draft_po_closeout_critical_days
      FROM warehouse_settings
      LIMIT 1
    `);
    const row = (rows.rows as any[])[0];
    return {
      autoDraftMode: row?.auto_draft_mode === "review_only" ? "review_only" : "draft_po",
      approvalPolicy: row?.auto_draft_approval_policy === "high_confidence_and_strong_candidate"
        ? "high_confidence_and_strong_candidate"
        : "high_confidence_only",
      includeOrderSoon: row?.include_order_soon ?? false,
      skipOnOpenPo: row?.skip_on_open_po ?? true,
      skipNoVendor: row?.skip_no_vendor ?? true,
      candidateScoreStrongThreshold: row?.candidate_score_strong_threshold ?? 80,
      candidateScoreReviewThreshold: row?.candidate_score_review_threshold ?? 60,
      stalePoThresholds: {
        reviewPendingWarningDays: row?.auto_draft_po_review_warning_days ?? 2,
        reviewPendingCriticalDays: row?.auto_draft_po_review_critical_days ?? 5,
        supplierSendWarningDays: row?.auto_draft_po_supplier_send_warning_days ?? 2,
        supplierSendCriticalDays: row?.auto_draft_po_supplier_send_critical_days ?? 5,
        supplierFollowupWarningDays: row?.auto_draft_po_supplier_followup_warning_days ?? 7,
        supplierFollowupCriticalDays: row?.auto_draft_po_supplier_followup_critical_days ?? 14,
        receivingWarningDays: row?.auto_draft_po_receiving_warning_days ?? 3,
        receivingCriticalDays: row?.auto_draft_po_receiving_critical_days ?? 10,
        apCloseoutWarningDays: row?.auto_draft_po_ap_closeout_warning_days ?? 7,
        apCloseoutCriticalDays: row?.auto_draft_po_ap_closeout_critical_days ?? 21,
        exceptionBlockedWarningDays: row?.auto_draft_po_exception_warning_days ?? 1,
        exceptionBlockedCriticalDays: row?.auto_draft_po_exception_critical_days ?? 3,
        closeoutWarningDays: row?.auto_draft_po_closeout_warning_days ?? 7,
        closeoutCriticalDays: row?.auto_draft_po_closeout_critical_days ?? 14,
      },
    };
  },

  async updateAutoDraftSettings(warehouseId: number | undefined, settings: any): Promise<void> {
    const autoDraftMode =
      settings.autoDraftMode === "review_only" || settings.autoDraftMode === "draft_po"
        ? settings.autoDraftMode
        : null;
    const approvalPolicy =
      settings.approvalPolicy === "high_confidence_only" || settings.approvalPolicy === "high_confidence_and_strong_candidate"
        ? settings.approvalPolicy
        : null;
    await db.execute(sql`
      UPDATE warehouse_settings SET
        auto_draft_mode = COALESCE(${autoDraftMode}, auto_draft_mode),
        auto_draft_approval_policy = COALESCE(${approvalPolicy}, auto_draft_approval_policy),
        auto_draft_include_order_soon = COALESCE(${settings.includeOrderSoon ?? null}, auto_draft_include_order_soon),
        auto_draft_skip_on_open_po = COALESCE(${settings.skipOnOpenPo ?? null}, auto_draft_skip_on_open_po),
        auto_draft_skip_no_vendor = COALESCE(${settings.skipNoVendor ?? null}, auto_draft_skip_no_vendor),
        recommendation_candidate_score_strong_threshold = COALESCE(${settings.candidateScoreStrongThreshold ?? null}, recommendation_candidate_score_strong_threshold),
        recommendation_candidate_score_review_threshold = COALESCE(${settings.candidateScoreReviewThreshold ?? null}, recommendation_candidate_score_review_threshold),
        auto_draft_po_review_warning_days = COALESCE(${settings.stalePoThresholds?.reviewPendingWarningDays ?? null}, auto_draft_po_review_warning_days),
        auto_draft_po_review_critical_days = COALESCE(${settings.stalePoThresholds?.reviewPendingCriticalDays ?? null}, auto_draft_po_review_critical_days),
        auto_draft_po_supplier_send_warning_days = COALESCE(${settings.stalePoThresholds?.supplierSendWarningDays ?? null}, auto_draft_po_supplier_send_warning_days),
        auto_draft_po_supplier_send_critical_days = COALESCE(${settings.stalePoThresholds?.supplierSendCriticalDays ?? null}, auto_draft_po_supplier_send_critical_days),
        auto_draft_po_supplier_followup_warning_days = COALESCE(${settings.stalePoThresholds?.supplierFollowupWarningDays ?? null}, auto_draft_po_supplier_followup_warning_days),
        auto_draft_po_supplier_followup_critical_days = COALESCE(${settings.stalePoThresholds?.supplierFollowupCriticalDays ?? null}, auto_draft_po_supplier_followup_critical_days),
        auto_draft_po_receiving_warning_days = COALESCE(${settings.stalePoThresholds?.receivingWarningDays ?? null}, auto_draft_po_receiving_warning_days),
        auto_draft_po_receiving_critical_days = COALESCE(${settings.stalePoThresholds?.receivingCriticalDays ?? null}, auto_draft_po_receiving_critical_days),
        auto_draft_po_ap_closeout_warning_days = COALESCE(${settings.stalePoThresholds?.apCloseoutWarningDays ?? null}, auto_draft_po_ap_closeout_warning_days),
        auto_draft_po_ap_closeout_critical_days = COALESCE(${settings.stalePoThresholds?.apCloseoutCriticalDays ?? null}, auto_draft_po_ap_closeout_critical_days),
        auto_draft_po_exception_warning_days = COALESCE(${settings.stalePoThresholds?.exceptionBlockedWarningDays ?? null}, auto_draft_po_exception_warning_days),
        auto_draft_po_exception_critical_days = COALESCE(${settings.stalePoThresholds?.exceptionBlockedCriticalDays ?? null}, auto_draft_po_exception_critical_days),
        auto_draft_po_closeout_warning_days = COALESCE(${settings.stalePoThresholds?.closeoutWarningDays ?? null}, auto_draft_po_closeout_warning_days),
        auto_draft_po_closeout_critical_days = COALESCE(${settings.stalePoThresholds?.closeoutCriticalDays ?? null}, auto_draft_po_closeout_critical_days)
    `);
  },

  async getDashboardData(lookbackDays: number): Promise<any> {
    // Get reorder analysis data with exclusion filtering
    const rawRows = await this.getReorderAnalysisData(lookbackDays);

    // Get exclusion rules to filter out
    const rules = await db.select().from(reorderExclusionRules);

    // Global defaults for lead time / safety stock. Used as a fallback when
    // a product has no explicit per-product value set. Hierarchy:
    //   1. vendor_products.leadTimeDays  (per-vendor-per-product; most specific)
    //   2. products.leadTimeDays          (per-product)
    //   3. echelon_settings.default_lead_time_days   (global fallback)
    //   4. hardcoded 14 / 7 (last resort)
    const defaultsQuery = await db.execute(sql`
      SELECT key, value FROM warehouse.echelon_settings
      WHERE key IN ('default_lead_time_days','default_safety_stock_days')
    `);
    const defaultsMap = new Map<string, string>();
    for (const r of defaultsQuery.rows as any[]) defaultsMap.set(r.key, r.value);
    const defaultLeadTimeDays =
      Number.parseInt(defaultsMap.get("default_lead_time_days") ?? "14", 10) || 14;
    const defaultSafetyStockDays =
      Number.parseInt(defaultsMap.get("default_safety_stock_days") ?? "7", 10) || 7;

    // Enrich raw rows with product fields for exclusion check
    const enrichedRows = await db.execute(sql`
      SELECT p.id, p.category, p.brand, p.product_type, p.sku, p.tags, p.reorder_excluded
      FROM ${products} p
      WHERE p.is_active = true
    `);
    const productMeta = new Map<number, PurchasingRecommendationProductMeta>();
    for (const pm of enrichedRows.rows as any[]) {
      productMeta.set(pm.id, pm);
    }

    const recommendationResult = generatePurchasingRecommendations({
      rows: rawRows as PurchasingRecommendationRawRow[],
      lookbackDays,
      productMetaById: productMeta,
      exclusionRules: rules,
      defaults: {
        leadTimeDays: defaultLeadTimeDays,
        safetyStockDays: defaultSafetyStockDays,
      },
    });

    const activeItems = recommendationResult.items;

    // Categorize
    const stockoutItems = activeItems.filter((i: any) => i.status === "stockout");
    const orderNowItems = activeItems.filter((i: any) => i.status === "order_now");
    const healthBreakdown = {
      stockout: activeItems.filter((i: any) => i.status === "stockout").length,
      order_now: activeItems.filter((i: any) => i.status === "order_now").length,
      order_soon: activeItems.filter((i: any) => i.status === "order_soon").length,
      on_order: activeItems.filter((i: any) => i.status === "on_order").length,
      ok: activeItems.filter((i: any) => i.status === "ok").length,
      no_movement: activeItems.filter((i: any) => i.status === "no_movement").length,
      total: activeItems.length,
    };

    // POs
    const draftPOs = await db.select({
      id: purchaseOrders.id,
      poNumber: purchaseOrders.poNumber,
      vendorId: purchaseOrders.vendorId,
      status: purchaseOrders.status,
      totalCents: purchaseOrders.totalCents,
      lineCount: purchaseOrders.lineCount,
      source: purchaseOrders.source,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      receivedLineCount: purchaseOrders.receivedLineCount,
    }).from(purchaseOrders)
      .where(sql`${purchaseOrders.status} IN ('draft', 'sent', 'acknowledged', 'partially_received')`)
      .orderBy(asc(purchaseOrders.createdAt));

    // Get vendor names for POs
    const allVendors = await db.select().from(vendors);
    const vendorMap = new Map(allVendors.map((v: any) => [v.id, v.name]));

    const draftPos = draftPOs.filter((po: any) => po.status === "draft").map((po: any) => ({
      id: po.id,
      poNumber: po.poNumber,
      vendorName: vendorMap.get(po.vendorId) || "Unknown",
      lineCount: po.lineCount || 0,
      totalCents: po.totalCents,
      source: po.source || "manual",
    }));

    const inFlightPos = draftPOs.filter((po: any) => po.status !== "draft").map((po: any) => ({
      id: po.id,
      poNumber: po.poNumber,
      vendorName: vendorMap.get(po.vendorId) || "Unknown",
      status: po.status,
      lineCount: po.lineCount || 0,
      receivedLineCount: po.receivedLineCount || 0,
      totalCents: po.totalCents,
      expectedDeliveryDate: po.expectedDeliveryDate,
    }));

    // Open PO value
    const openPoRows = await db.execute(sql`
      SELECT COALESCE(SUM(${purchaseOrders.totalCents}), 0)::bigint AS total
      FROM ${purchaseOrders}
      WHERE ${purchaseOrders.status} NOT IN ('closed', 'cancelled')
    `);
    const openPoValueCents = Number((openPoRows.rows as any[])[0]?.total || 0);

    // No vendor items
    const noVendorItems: any[] = [];
    for (const item of [...stockoutItems, ...orderNowItems].slice(0, 10)) {
      if (!item.preferredVendorId) {
        noVendorItems.push({
          productId: item.productId,
          sku: item.sku,
          productName: item.productName,
          totalOnHand: item.totalOnHand,
        });
      }
    }

    // Spend (last 30 days)
    const spendRows = await db.execute(sql`
      SELECT
        COALESCE(SUM(${purchaseOrders.totalCents}), 0)::bigint AS total_received_cents,
        COUNT(DISTINCT ${purchaseOrders.id})::int AS po_count,
        COUNT(DISTINCT ${purchaseOrders.vendorId})::int AS supplier_count
      FROM ${purchaseOrders}
      WHERE ${purchaseOrders.status} = 'received'
        AND ${purchaseOrders.closedAt} > NOW() - INTERVAL '30 days'
    `);
    const spendRow = (spendRows.rows as any[])[0] || {};

    // Top supplier
    const topSupplierRows = await db.execute(sql`
      SELECT ${vendors.name} AS name, COALESCE(SUM(${purchaseOrders.totalCents}), 0)::bigint AS total
      FROM ${purchaseOrders}
      JOIN ${vendors} ON ${vendors.id} = ${purchaseOrders.vendorId}
      WHERE ${purchaseOrders.status} = 'received'
        AND ${purchaseOrders.closedAt} > NOW() - INTERVAL '30 days'
      GROUP BY ${vendors.name}
      ORDER BY total DESC
      LIMIT 1
    `);
    const topSupplier = (topSupplierRows.rows as any[])[0] || {};

    // Latest auto-draft run
    const lastAutoDraftRun = await this.getLatestAutoDraftRun();

    // In-transit count
    const inTransitCount = inFlightPos.filter((po: any) => ["sent", "acknowledged"].includes(po.status)).length;

    return {
      stockouts: healthBreakdown.stockout,
      orderNow: healthBreakdown.order_now,
      draftPoCount: draftPos.length,
      inTransitCount,
      openPoValueCents,
      noVendorCount: noVendorItems.length,

      stockoutItems: stockoutItems.slice(0, 5).map((i: any) => ({
        productId: i.productId,
        sku: i.sku,
        productName: i.productName,
        totalOnHand: i.totalOnHand,
      })),

      draftPos,

      inFlightPos,

      noVendorItems: noVendorItems.slice(0, 5),

      orderNowItems: orderNowItems.slice(0, 10).map((i: any) => ({
        productId: i.productId,
        sku: i.sku,
        productName: i.productName,
        daysOfSupply: i.daysOfSupply,
        suggestedOrderQty: i.suggestedOrderQty,
        orderUomLabel: i.orderUomLabel,
        preferredVendorId: i.preferredVendorId,
      })),

      healthBreakdown,

      spend: {
        totalReceivedCents: Number(spendRow.total_received_cents || 0),
        openPoValueCents,
        avgPoCents: Number(spendRow.po_count) > 0 ? Math.round(Number(spendRow.total_received_cents || 0) / Number(spendRow.po_count)) : 0,
        topSupplierName: topSupplier.name || null,
        topSupplierCents: Number(topSupplier.total || 0),
        activeSupplierCount: Number(spendRow.supplier_count || 0),
      },

      lastAutoDraftRun: lastAutoDraftRun ? {
        runAt: lastAutoDraftRun.runAt || lastAutoDraftRun.run_at,
        status: lastAutoDraftRun.status,
        heartbeatAt: lastAutoDraftRun.heartbeatAt || lastAutoDraftRun.heartbeat_at || null,
        leaseExpiresAt: lastAutoDraftRun.leaseExpiresAt || lastAutoDraftRun.lease_expires_at || null,
        finishedAt: lastAutoDraftRun.finishedAt || lastAutoDraftRun.finished_at || null,
        itemsAnalyzed: lastAutoDraftRun.itemsAnalyzed || lastAutoDraftRun.items_analyzed || 0,
        posCreated: lastAutoDraftRun.posCreated || lastAutoDraftRun.pos_created || 0,
        posUpdated: lastAutoDraftRun.posUpdated || lastAutoDraftRun.pos_updated || 0,
        linesAdded: lastAutoDraftRun.linesAdded || lastAutoDraftRun.lines_added || 0,
        skippedNoVendor: lastAutoDraftRun.skippedNoVendor || lastAutoDraftRun.skipped_no_vendor || 0,
        skippedExcluded: lastAutoDraftRun.skippedExcluded || lastAutoDraftRun.skipped_excluded || 0,
        skippedOnOrder: lastAutoDraftRun.skippedOnOrder || lastAutoDraftRun.skipped_on_order || 0,
        errorMessage: lastAutoDraftRun.errorMessage || lastAutoDraftRun.error_message || null,
        summaryJson: lastAutoDraftRun.summaryJson || lastAutoDraftRun.summary_json || null,
      } : null,
    };
  },
};
