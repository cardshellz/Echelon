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
  type ShipmentCost,
  type InsertShipmentCost,
  type InsertShipmentCostAllocation,
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
  shipmentCosts,
  shipmentCostAllocations,
  landedCostSnapshots,
  inboundShipmentStatusHistory,
  eq, and, or, inArray, sql, desc, asc, lte, like,
} from "../../storage/base";

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
  getVendorProductById(id: number): Promise<VendorProduct | undefined>;
  getPreferredVendorProduct(productId: number, productVariantId?: number): Promise<VendorProduct | undefined>;
  createVendorProduct(data: InsertVendorProduct): Promise<VendorProduct>;
  updateVendorProduct(id: number, updates: Partial<InsertVendorProduct>): Promise<VendorProduct | null>;
  deleteVendorProduct(id: number): Promise<boolean>;
  getAllPoApprovalTiers(): Promise<PoApprovalTier[]>;
  getPoApprovalTierById(id: number): Promise<PoApprovalTier | undefined>;
  getMatchingApprovalTier(totalCents: number): Promise<PoApprovalTier | undefined>;
  createPoApprovalTier(data: InsertPoApprovalTier): Promise<PoApprovalTier>;
  updatePoApprovalTier(id: number, updates: Partial<InsertPoApprovalTier>): Promise<PoApprovalTier | null>;
  deletePoApprovalTier(id: number): Promise<boolean>;
  getPurchaseOrders(filters?: { status?: string | string[]; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<PurchaseOrder[]>;
  getPurchaseOrdersCount(filters?: { status?: string | string[]; vendorId?: number; search?: string }): Promise<number>;
  getPurchaseOrderById(id: number): Promise<PurchaseOrder | undefined>;
  getPurchaseOrderByPoNumber(poNumber: string): Promise<PurchaseOrder | undefined>;
  createPurchaseOrder(data: InsertPurchaseOrder): Promise<PurchaseOrder>;
  updatePurchaseOrder(id: number, updates: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder | null>;
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
  createInboundShipmentLine(data: InsertInboundShipmentLine): Promise<InboundShipmentLine>;
  bulkCreateInboundShipmentLines(lines: InsertInboundShipmentLine[]): Promise<InboundShipmentLine[]>;
  updateInboundShipmentLine(id: number, updates: Partial<InsertInboundShipmentLine>): Promise<InboundShipmentLine | null>;
  deleteInboundShipmentLine(id: number): Promise<boolean>;
  getShipmentCosts(inboundShipmentId: number): Promise<ShipmentCost[]>;
  getShipmentCostById(id: number): Promise<ShipmentCost | undefined>;
  createShipmentCost(data: InsertShipmentCost): Promise<ShipmentCost>;
  updateShipmentCost(id: number, updates: Partial<InsertShipmentCost>): Promise<ShipmentCost | null>;
  deleteShipmentCost(id: number): Promise<boolean>;
  getShipmentCostAllocations(shipmentCostId: number): Promise<any[]>;
  getAllocationsForLine(inboundShipmentLineId: number): Promise<any[]>;
  createShipmentCostAllocation(data: InsertShipmentCostAllocation): Promise<any>;
  bulkCreateShipmentCostAllocations(allocations: InsertShipmentCostAllocation[]): Promise<any[]>;
  deleteAllocationsForShipment(inboundShipmentId: number): Promise<void>;
  getLandedCostSnapshots(inboundShipmentLineId: number): Promise<any[]>;
  getLandedCostSnapshotByPoLine(purchaseOrderLineId: number): Promise<any>;
  createLandedCostSnapshot(data: InsertLandedCostSnapshot): Promise<any>;
  bulkCreateLandedCostSnapshots(snapshots: InsertLandedCostSnapshot[]): Promise<any[]>;
  deleteLandedCostSnapshotsForShipment(inboundShipmentId: number): Promise<void>;
  createInboundShipmentStatusHistory(data: any): Promise<InboundShipmentStatusHistory>;
  getInboundShipmentStatusHistory(inboundShipmentId: number): Promise<InboundShipmentStatusHistory[]>;
  getInboundShipmentsByPo(purchaseOrderId: number): Promise<InboundShipment[]>;
  getProvisionalLotsByShipment(inboundShipmentId: number): Promise<InventoryLot[]>;
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
    const result = await db.delete(vendorProducts).where(eq(vendorProducts.id, id)).returning();
    return result.length > 0;
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

  async getPurchaseOrders(filters?: { status?: string | string[]; vendorId?: number; search?: string; limit?: number; offset?: number }): Promise<PurchaseOrder[]> {
    const conditions: any[] = [];
    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(inArray(purchaseOrders.status, filters.status));
      } else {
        conditions.push(eq(purchaseOrders.status, filters.status));
      }
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

  async getPurchaseOrdersCount(filters?: { status?: string | string[]; vendorId?: number; search?: string }): Promise<number> {
    const conditions: any[] = [];
    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(inArray(purchaseOrders.status, filters.status));
      } else {
        conditions.push(eq(purchaseOrders.status, filters.status));
      }
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
    return await db.select().from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrderLines.purchaseOrderId, purchaseOrders.id))
      .where(and(
        eq(purchaseOrderLines.productVariantId, productVariantId),
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
    return await db.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.inboundShipmentId, inboundShipmentId));
  },

  async getInboundShipmentLineById(id: number): Promise<InboundShipmentLine | undefined> {
    const result = await db.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.id, id)).limit(1);
    return result[0];
  },

  async getInboundShipmentLinesByPo(purchaseOrderId: number): Promise<InboundShipmentLine[]> {
    return await db.select().from(inboundShipmentLines).where(eq(inboundShipmentLines.purchaseOrderId, purchaseOrderId));
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

  async getShipmentCosts(inboundShipmentId: number): Promise<ShipmentCost[]> {
    return await db.select().from(shipmentCosts).where(eq(shipmentCosts.inboundShipmentId, inboundShipmentId));
  },

  async getShipmentCostById(id: number): Promise<ShipmentCost | undefined> {
    const result = await db.select().from(shipmentCosts).where(eq(shipmentCosts.id, id)).limit(1);
    return result[0];
  },

  async createShipmentCost(data: InsertShipmentCost): Promise<ShipmentCost> {
    const result = await db.insert(shipmentCosts).values(data as any).returning();
    return result[0];
  },

  async updateShipmentCost(id: number, updates: Partial<InsertShipmentCost>): Promise<ShipmentCost | null> {
    const result = await db.update(shipmentCosts).set({ ...updates, updatedAt: new Date() } as any).where(eq(shipmentCosts.id, id)).returning();
    return result[0] || null;
  },

  async deleteShipmentCost(id: number): Promise<boolean> {
    const result = await db.delete(shipmentCosts).where(eq(shipmentCosts.id, id)).returning();
    return result.length > 0;
  },

  async getShipmentCostAllocations(shipmentCostId: number): Promise<any[]> {
    return await db.select().from(shipmentCostAllocations).where(eq(shipmentCostAllocations.shipmentCostId, shipmentCostId));
  },

  async getAllocationsForLine(inboundShipmentLineId: number): Promise<any[]> {
    return await db.select().from(shipmentCostAllocations).where(eq(shipmentCostAllocations.inboundShipmentLineId, inboundShipmentLineId));
  },

  async createShipmentCostAllocation(data: InsertShipmentCostAllocation): Promise<any> {
    const result = await db.insert(shipmentCostAllocations).values(data as any).returning();
    return result[0];
  },

  async bulkCreateShipmentCostAllocations(allocations: InsertShipmentCostAllocation[]): Promise<any[]> {
    if (allocations.length === 0) return [];
    return await db.insert(shipmentCostAllocations).values(allocations as any).returning();
  },

  async deleteAllocationsForShipment(inboundShipmentId: number): Promise<void> {
    const costs = await this.getShipmentCosts(inboundShipmentId);
    if (costs.length > 0) {
      await db.delete(shipmentCostAllocations).where(inArray(shipmentCostAllocations.shipmentCostId, costs.map(c => c.id)));
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
      .where(eq((inventoryLots as any).inboundShipmentId, inboundShipmentId));
  },
};
