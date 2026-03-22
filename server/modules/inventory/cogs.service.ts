/**
 * FIFO COGS Engine for Echelon WMS.
 *
 * All costs at the PIECE level. No estimates — lots have "current cost"
 * which updates when landed costs arrive. FIFO is strict: oldest lot
 * consumed first, always. All cost operations are atomic (transactions).
 *
 * Tables: inventory_lots (modified), order_line_costs (new)
 */

import { eq, and, sql, asc, gt, desc, isNull, isNotNull } from "drizzle-orm";
import {
  inventoryLots,
  productVariants,
  products,
  orders,
  orderItems,
} from "@shared/schema";
import type { InventoryLot } from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ─── Types ──────────────────────────────────────────────────────────

export interface CostLotConsumption {
  lotId: number;
  lotNumber: string;
  qty: number;
  unitCostCents: number;
  totalCostCents: number;
}

export interface OrderCOGSResult {
  orderId: number;
  orderNumber: string;
  totalRevenueCents: number;
  totalCogsCents: number;
  grossMarginCents: number;
  marginPercent: number;
  lineItems: OrderLineCOGS[];
}

export interface OrderLineCOGS {
  orderItemId: number;
  sku: string;
  productName: string;
  qty: number;
  revenueCents: number;
  cogsCents: number;
  marginCents: number;
  marginPercent: number;
  lotBreakdown: Array<{
    lotId: number;
    lotNumber: string;
    qty: number;
    unitCostCents: number;
    totalCostCents: number;
  }>;
}

export interface InventoryValuationResult {
  totalValueCents: number;
  totalQty: number;
  landedPendingLots: number;
  landedPendingValueCents: number;
  byProduct: Array<{
    productId: number;
    productName: string;
    baseSku: string;
    totalQty: number;
    avgCostPerPiece: number;
    totalValueCents: number;
    activeLots: number;
    hasLandedPending: boolean;
  }>;
}

export interface CostAdjustmentLog {
  lotId: number;
  lotNumber: string;
  productVariantId: number;
  sku: string;
  oldCostCents: number;
  newCostCents: number;
  deltaCents: number;
  adjustedAt: Date;
  reason: string;
}

// ─── Service ────────────────────────────────────────────────────────

export class COGSService {
  constructor(private readonly db: DrizzleDb) {}

  // ---------------------------------------------------------------------------
  // CREATE LOT (with full cost columns)
  // ---------------------------------------------------------------------------

  async createLot(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyPieces: number;
    poUnitCostCents?: number;
    landedCostCents?: number;
    poLineId?: number;
    inboundShipmentId?: number;
    receivingOrderId?: number;
    purchaseOrderId?: number;
    costSource?: string;
    batchNumber?: string;
    receivedAt?: Date;
    notes?: string;
  }): Promise<InventoryLot> {
    const poUnitCost = params.poUnitCostCents ?? 0;
    const landedCost = params.landedCostCents ?? 0;
    const totalUnitCost = poUnitCost + landedCost;
    const costSource = params.costSource ?? 'manual';

    const lotNumber = await this.generateLotNumber();

    const [lot] = await this.db
      .insert(inventoryLots)
      .values({
        lotNumber,
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
        qtyOnHand: params.qtyPieces,
        qtyReserved: 0,
        qtyPicked: 0,
        receivedAt: params.receivedAt ?? new Date(),
        receivingOrderId: params.receivingOrderId ?? null,
        purchaseOrderId: params.purchaseOrderId ?? null,
        inboundShipmentId: params.inboundShipmentId ?? null,
        // COGS columns
        unitCostCents: totalUnitCost,
        costProvisional: landedCost === 0 && costSource !== 'manual' ? 1 : 0,
        status: "active",
        notes: params.notes ?? null,
      } as any)
      .returning();

    // Update COGS-specific columns via raw SQL (new columns not in drizzle schema yet)
    await this.db.execute(sql`
      UPDATE inventory_lots SET
        po_line_id = ${params.poLineId ?? null},
        po_unit_cost_cents = ${poUnitCost},
        landed_cost_cents = ${landedCost},
        total_unit_cost_cents = ${totalUnitCost},
        qty_received = ${params.qtyPieces},
        qty_consumed = 0,
        cost_source = ${costSource},
        batch_number = ${params.batchNumber ?? null}
      WHERE id = ${lot.id}
    `);

    return lot as InventoryLot;
  }

  // ---------------------------------------------------------------------------
  // CONSUME LOTS FIFO
  // ---------------------------------------------------------------------------

  /**
   * Deplete oldest lots first for a given product variant.
   * Returns array of lot consumptions with cost breakdown.
   * Does NOT modify lots — caller must be in a transaction.
   */
  async consumeLotsFIFO(
    productVariantId: number,
    qty: number,
    tx?: any,
  ): Promise<CostLotConsumption[]> {
    const db = tx || this.db;

    // Get active lots ordered by received_at ASC (FIFO)
    const lots = await db
      .select()
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, productVariantId),
          eq(inventoryLots.status, "active"),
          gt(inventoryLots.qtyOnHand, 0),
        ),
      )
      .orderBy(asc(inventoryLots.receivedAt));

    let remaining = qty;
    const consumptions: CostLotConsumption[] = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
      if (available <= 0) continue;

      const take = Math.min(available, remaining);

      // Get full cost from COGS columns
      const [lotCost] = await db.execute(sql`
        SELECT total_unit_cost_cents FROM inventory_lots WHERE id = ${lot.id}
      `);
      const unitCost = lotCost?.rows?.[0]?.total_unit_cost_cents ?? lot.unitCostCents ?? 0;

      consumptions.push({
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        qty: take,
        unitCostCents: Number(unitCost),
        totalCostCents: take * Number(unitCost),
      });

      remaining -= take;
    }

    return consumptions;
  }

  // ---------------------------------------------------------------------------
  // RECORD SHIPMENT COGS
  // ---------------------------------------------------------------------------

  /**
   * Called when an order ships. Consumes from FIFO lots and records
   * order_line_costs entries. All within a transaction.
   */
  async recordShipmentCOGS(params: {
    orderId: number;
    orderItemId?: number;
    productVariantId: number;
    qty: number;
  }): Promise<CostLotConsumption[]> {
    return this.db.transaction(async (tx: any) => {
      const consumptions = await this.consumeLotsFIFO(
        params.productVariantId,
        params.qty,
        tx,
      );

      // Record each consumption as an order_line_cost
      for (const c of consumptions) {
        await tx.execute(sql`
          INSERT INTO order_line_costs (order_id, order_item_id, product_variant_id, lot_id, qty_consumed, unit_cost_cents, total_cost_cents, shipped_at, created_at)
          VALUES (${params.orderId}, ${params.orderItemId ?? null}, ${params.productVariantId}, ${c.lotId}, ${c.qty}, ${c.unitCostCents}, ${c.totalCostCents}, NOW(), NOW())
        `);

        // Update lot qty_consumed
        await tx.execute(sql`
          UPDATE inventory_lots SET qty_consumed = COALESCE(qty_consumed, 0) + ${c.qty} WHERE id = ${c.lotId}
        `);
      }

      return consumptions;
    });
  }

  // ---------------------------------------------------------------------------
  // UPDATE LOT LANDED COST
  // ---------------------------------------------------------------------------

  async updateLotLandedCost(
    lotId: number,
    landedCostCents: number,
  ): Promise<CostAdjustmentLog | null> {
    // Get current state
    const result = await this.db.execute(sql`
      SELECT il.id, il.lot_number, il.product_variant_id,
             il.po_unit_cost_cents, il.landed_cost_cents, il.total_unit_cost_cents,
             pv.sku
      FROM inventory_lots il
      LEFT JOIN product_variants pv ON pv.id = il.product_variant_id
      WHERE il.id = ${lotId}
    `);
    const lot = result.rows?.[0];
    if (!lot) return null;

    const oldTotal = Number(lot.total_unit_cost_cents) || 0;
    const poUnit = Number(lot.po_unit_cost_cents) || 0;
    const newTotal = poUnit + landedCostCents;

    await this.db.execute(sql`
      UPDATE inventory_lots SET
        landed_cost_cents = ${landedCostCents},
        total_unit_cost_cents = ${newTotal},
        unit_cost_cents = ${newTotal},
        cost_provisional = 0,
        cost_source = CASE
          WHEN cost_source = 'po' THEN 'po_landed'
          ELSE cost_source
        END
      WHERE id = ${lotId}
    `);

    // Log the adjustment
    await this.db.execute(sql`
      INSERT INTO cost_adjustment_log (lot_id, lot_number, product_variant_id, sku, old_cost_cents, new_cost_cents, delta_cents, reason, created_at)
      VALUES (${lotId}, ${lot.lot_number}, ${lot.product_variant_id}, ${lot.sku || ''}, ${oldTotal}, ${newTotal}, ${newTotal - oldTotal}, 'landed_cost_finalized', NOW())
    `);

    return {
      lotId,
      lotNumber: lot.lot_number,
      productVariantId: lot.product_variant_id,
      sku: lot.sku || '',
      oldCostCents: oldTotal,
      newCostCents: newTotal,
      deltaCents: newTotal - oldTotal,
      adjustedAt: new Date(),
      reason: 'landed_cost_finalized',
    };
  }

  // ---------------------------------------------------------------------------
  // GET PRODUCT COST LOTS
  // ---------------------------------------------------------------------------

  async getProductCostLots(productVariantId: number): Promise<any[]> {
    const result = await this.db.execute(sql`
      SELECT il.*,
             il.po_unit_cost_cents,
             il.landed_cost_cents,
             il.total_unit_cost_cents,
             il.qty_received,
             il.qty_consumed,
             il.cost_source,
             il.batch_number,
             il.po_line_id,
             pv.sku,
             po.po_number,
             ish.shipment_number
      FROM inventory_lots il
      LEFT JOIN product_variants pv ON pv.id = il.product_variant_id
      LEFT JOIN purchase_orders po ON po.id = il.purchase_order_id
      LEFT JOIN inbound_shipments ish ON ish.id = il.inbound_shipment_id
      WHERE il.product_variant_id = ${productVariantId}
        AND il.status = 'active'
      ORDER BY il.received_at ASC
    `);
    return result.rows || [];
  }

  // ---------------------------------------------------------------------------
  // GET ORDER COGS
  // ---------------------------------------------------------------------------

  async getOrderCOGS(orderId: number): Promise<OrderCOGSResult | null> {
    // Get order details
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return null;

    // Get order items
    const items = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    // Get COGS entries from order_line_costs
    const cogsResult = await this.db.execute(sql`
      SELECT olc.*, pv.sku, p.name as product_name, il.lot_number
      FROM order_line_costs olc
      LEFT JOIN product_variants pv ON pv.id = olc.product_variant_id
      LEFT JOIN products p ON p.id = pv.product_id
      LEFT JOIN inventory_lots il ON il.id = olc.lot_id
      WHERE olc.order_id = ${orderId}
      ORDER BY olc.id ASC
    `);
    const cogsRows = cogsResult.rows || [];

    let totalCogsCents = 0;
    const lineItems: OrderLineCOGS[] = [];

    for (const item of items) {
      const itemCogs = cogsRows.filter((r: any) =>
        r.order_item_id === item.id || r.product_variant_id === item.productVariantId,
      );
      const cogsCents = itemCogs.reduce((sum: number, r: any) => sum + Number(r.total_cost_cents || 0), 0);
      const revenueCents = Number(item.priceCents || 0) * (item.quantity || 1);
      totalCogsCents += cogsCents;

      lineItems.push({
        orderItemId: item.id,
        sku: (item as any).sku || '',
        productName: itemCogs[0]?.product_name || '',
        qty: item.quantity || 1,
        revenueCents,
        cogsCents,
        marginCents: revenueCents - cogsCents,
        marginPercent: revenueCents > 0 ? Math.round(((revenueCents - cogsCents) / revenueCents) * 10000) / 100 : 0,
        lotBreakdown: itemCogs.map((r: any) => ({
          lotId: r.lot_id,
          lotNumber: r.lot_number || '',
          qty: r.qty_consumed,
          unitCostCents: Number(r.unit_cost_cents),
          totalCostCents: Number(r.total_cost_cents),
        })),
      });
    }

    const totalRevenueCents = Number(order.totalAmount || 0) * 100;

    return {
      orderId,
      orderNumber: order.orderNumber,
      totalRevenueCents,
      totalCogsCents,
      grossMarginCents: totalRevenueCents - totalCogsCents,
      marginPercent: totalRevenueCents > 0
        ? Math.round(((totalRevenueCents - totalCogsCents) / totalRevenueCents) * 10000) / 100
        : 0,
      lineItems,
    };
  }

  // ---------------------------------------------------------------------------
  // GET ORDER COGS BY ORDER NUMBER
  // ---------------------------------------------------------------------------

  async getOrderCOGSByNumber(orderNumber: string): Promise<OrderCOGSResult | null> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.orderNumber, orderNumber))
      .limit(1);

    if (!order) return null;
    return this.getOrderCOGS(order.id);
  }

  // ---------------------------------------------------------------------------
  // INVENTORY VALUATION
  // ---------------------------------------------------------------------------

  async getInventoryValuation(): Promise<InventoryValuationResult> {
    const result = await this.db.execute(sql`
      SELECT
        p.id as product_id,
        p.name as product_name,
        p.base_sku,
        SUM(il.qty_on_hand) as total_qty,
        CASE WHEN SUM(il.qty_on_hand) > 0
          THEN SUM(il.qty_on_hand * COALESCE(il.total_unit_cost_cents, il.unit_cost_cents, 0)) / SUM(il.qty_on_hand)
          ELSE 0
        END as avg_cost_per_piece,
        SUM(il.qty_on_hand * COALESCE(il.total_unit_cost_cents, il.unit_cost_cents, 0)) as total_value_cents,
        COUNT(il.id) as active_lots,
        BOOL_OR(COALESCE(il.landed_cost_cents, 0) = 0 AND il.inbound_shipment_id IS NOT NULL) as has_landed_pending
      FROM inventory_lots il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE il.status = 'active' AND il.qty_on_hand > 0
      GROUP BY p.id, p.name, p.base_sku
      ORDER BY total_value_cents DESC
    `);

    const byProduct = (result.rows || []).map((r: any) => ({
      productId: r.product_id,
      productName: r.product_name,
      baseSku: r.base_sku || '',
      totalQty: Number(r.total_qty) || 0,
      avgCostPerPiece: Number(r.avg_cost_per_piece) || 0,
      totalValueCents: Number(r.total_value_cents) || 0,
      activeLots: Number(r.active_lots) || 0,
      hasLandedPending: r.has_landed_pending || false,
    }));

    const totalValueCents = byProduct.reduce((s: number, p: any) => s + p.totalValueCents, 0);
    const totalQty = byProduct.reduce((s: number, p: any) => s + p.totalQty, 0);

    // Landed cost pending summary
    const pendingResult = await this.db.execute(sql`
      SELECT COUNT(*) as lot_count,
             SUM(il.qty_on_hand * COALESCE(il.total_unit_cost_cents, il.unit_cost_cents, 0)) as pending_value
      FROM inventory_lots il
      WHERE il.status = 'active'
        AND il.qty_on_hand > 0
        AND COALESCE(il.landed_cost_cents, 0) = 0
        AND il.inbound_shipment_id IS NOT NULL
    `);
    const pending = pendingResult.rows?.[0] || {};

    return {
      totalValueCents,
      totalQty,
      landedPendingLots: Number(pending.lot_count) || 0,
      landedPendingValueCents: Number(pending.pending_value) || 0,
      byProduct,
    };
  }

  // ---------------------------------------------------------------------------
  // MANUAL COST ENTRY (retroactive load)
  // ---------------------------------------------------------------------------

  async manualCostEntry(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    unitCostCents: number;
    landedCostCents?: number;
    batchNumber?: string;
    receivedAt?: string | Date;
    notes?: string;
  }): Promise<InventoryLot> {
    return this.createLot({
      productVariantId: params.productVariantId,
      warehouseLocationId: params.warehouseLocationId,
      qtyPieces: params.qty,
      poUnitCostCents: params.unitCostCents,
      landedCostCents: params.landedCostCents ?? 0,
      costSource: 'manual',
      batchNumber: params.batchNumber,
      receivedAt: params.receivedAt ? new Date(params.receivedAt) : undefined,
      notes: params.notes ?? 'Manual cost entry',
    });
  }

  // ---------------------------------------------------------------------------
  // BULK MANUAL IMPORT
  // ---------------------------------------------------------------------------

  async bulkManualImport(entries: Array<{
    sku: string;
    qty: number;
    unitCostCents: number;
    batchNumber?: string;
  }>): Promise<{ imported: number; errors: Array<{ sku: string; error: string }> }> {
    let imported = 0;
    const errors: Array<{ sku: string; error: string }> = [];

    for (const entry of entries) {
      try {
        // Look up variant by SKU
        const [variant] = await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.sku, entry.sku))
          .limit(1);

        if (!variant) {
          errors.push({ sku: entry.sku, error: 'SKU not found' });
          continue;
        }

        // Get default location for this variant
        const locResult = await this.db.execute(sql`
          SELECT warehouse_location_id FROM inventory_levels
          WHERE product_variant_id = ${variant.id}
          ORDER BY variant_qty DESC
          LIMIT 1
        `);
        const locationId = locResult.rows?.[0]?.warehouse_location_id;
        if (!locationId) {
          errors.push({ sku: entry.sku, error: 'No inventory location found' });
          continue;
        }

        await this.manualCostEntry({
          productVariantId: variant.id,
          warehouseLocationId: locationId,
          qty: entry.qty,
          unitCostCents: entry.unitCostCents,
          batchNumber: entry.batchNumber,
          notes: 'Bulk import',
        });

        imported++;
      } catch (err: any) {
        errors.push({ sku: entry.sku, error: err.message });
      }
    }

    return { imported, errors };
  }

  // ---------------------------------------------------------------------------
  // COST ADJUSTMENTS LOG
  // ---------------------------------------------------------------------------

  async getCostAdjustments(limit: number = 50): Promise<CostAdjustmentLog[]> {
    const result = await this.db.execute(sql`
      SELECT * FROM cost_adjustment_log
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return (result.rows || []).map((r: any) => ({
      lotId: r.lot_id,
      lotNumber: r.lot_number,
      productVariantId: r.product_variant_id,
      sku: r.sku,
      oldCostCents: Number(r.old_cost_cents),
      newCostCents: Number(r.new_cost_cents),
      deltaCents: Number(r.delta_cents),
      adjustedAt: r.created_at,
      reason: r.reason,
    }));
  }

  // ---------------------------------------------------------------------------
  // GET AFFECTED ORDERS FOR LOT (for cost adjustment impact)
  // ---------------------------------------------------------------------------

  async getAffectedOrdersForLot(lotId: number): Promise<any[]> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT o.id, o.order_number, olc.unit_cost_cents, olc.qty_consumed, olc.total_cost_cents
      FROM order_line_costs olc
      JOIN orders o ON o.id = olc.order_id
      WHERE olc.lot_id = ${lotId}
      ORDER BY o.id DESC
    `);
    return result.rows || [];
  }

  // ---------------------------------------------------------------------------
  // GET ALL LOTS WITH COST DETAILS (for explorer view)
  // ---------------------------------------------------------------------------

  async getAllCostLots(params?: {
    productId?: number;
    search?: string;
    onlyPending?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ lots: any[]; total: number }> {
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;

    let whereClause = sql`il.status = 'active' AND il.qty_on_hand > 0`;

    if (params?.productId) {
      whereClause = sql`${whereClause} AND pv.product_id = ${params.productId}`;
    }
    if (params?.onlyPending) {
      whereClause = sql`${whereClause} AND COALESCE(il.landed_cost_cents, 0) = 0 AND il.inbound_shipment_id IS NOT NULL`;
    }
    if (params?.search) {
      const pattern = `%${params.search}%`;
      whereClause = sql`${whereClause} AND (pv.sku ILIKE ${pattern} OR p.name ILIKE ${pattern} OR il.lot_number ILIKE ${pattern})`;
    }

    const countResult = await this.db.execute(sql`
      SELECT COUNT(*) as total
      FROM inventory_lots il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE ${whereClause}
    `);

    const result = await this.db.execute(sql`
      SELECT il.*,
             il.po_unit_cost_cents,
             il.landed_cost_cents,
             il.total_unit_cost_cents,
             il.qty_received,
             il.qty_consumed,
             il.cost_source,
             il.batch_number,
             pv.sku,
             pv.id as variant_id,
             p.name as product_name,
             p.id as product_id,
             p.base_sku,
             po.po_number,
             ish.shipment_number,
             wl.code as location_code,
             EXTRACT(DAY FROM NOW() - il.received_at) as age_days
      FROM inventory_lots il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN purchase_orders po ON po.id = il.purchase_order_id
      LEFT JOIN inbound_shipments ish ON ish.id = il.inbound_shipment_id
      LEFT JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE ${whereClause}
      ORDER BY il.received_at ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return {
      lots: result.rows || [],
      total: Number(countResult.rows?.[0]?.total) || 0,
    };
  }

  // ---------------------------------------------------------------------------
  // UPDATE MANUAL LOT
  // ---------------------------------------------------------------------------

  async updateManualLot(lotId: number, updates: {
    unitCostCents?: number;
    batchNumber?: string;
    notes?: string;
  }): Promise<boolean> {
    // Verify it's a manual lot
    const result = await this.db.execute(sql`
      SELECT cost_source FROM inventory_lots WHERE id = ${lotId}
    `);
    if (!result.rows?.[0] || result.rows[0].cost_source !== 'manual') {
      return false;
    }

    const sets: string[] = [];
    if (updates.unitCostCents !== undefined) {
      await this.db.execute(sql`
        UPDATE inventory_lots SET
          po_unit_cost_cents = ${updates.unitCostCents},
          total_unit_cost_cents = ${updates.unitCostCents},
          unit_cost_cents = ${updates.unitCostCents}
        WHERE id = ${lotId}
      `);
    }
    if (updates.batchNumber !== undefined) {
      await this.db.execute(sql`
        UPDATE inventory_lots SET batch_number = ${updates.batchNumber} WHERE id = ${lotId}
      `);
    }
    if (updates.notes !== undefined) {
      await this.db.execute(sql`
        UPDATE inventory_lots SET notes = ${updates.notes} WHERE id = ${lotId}
      `);
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // DELETE MANUAL LOT
  // ---------------------------------------------------------------------------

  async deleteManualLot(lotId: number): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT cost_source, qty_consumed FROM inventory_lots WHERE id = ${lotId}
    `);
    const lot = result.rows?.[0];
    if (!lot || lot.cost_source !== 'manual') return false;
    if (Number(lot.qty_consumed) > 0) return false; // Can't delete consumed lots

    await this.db.execute(sql`
      UPDATE inventory_lots SET status = 'depleted' WHERE id = ${lotId}
    `);
    return true;
  }

  // ---------------------------------------------------------------------------
  // GET MANUAL LOTS
  // ---------------------------------------------------------------------------

  async getManualLots(): Promise<any[]> {
    const result = await this.db.execute(sql`
      SELECT il.*,
             il.po_unit_cost_cents,
             il.landed_cost_cents,
             il.total_unit_cost_cents,
             il.qty_received,
             il.qty_consumed,
             il.cost_source,
             il.batch_number,
             pv.sku,
             p.name as product_name
      FROM inventory_lots il
      JOIN product_variants pv ON pv.id = il.product_variant_id
      JOIN products p ON p.id = pv.product_id
      WHERE il.cost_source = 'manual' AND il.status = 'active'
      ORDER BY il.created_at DESC
    `);
    return result.rows || [];
  }

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  private async generateLotNumber(): Promise<string> {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `LOT-${datePart}-`;

    const result = await this.db.execute(sql`
      SELECT lot_number FROM inventory_lots
      WHERE lot_number LIKE ${prefix + '%'}
      ORDER BY lot_number DESC
      LIMIT 1
    `);

    let seq = 1;
    if (result.rows?.length) {
      const parts = result.rows[0].lot_number.split("-");
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }

    return `${prefix}${String(seq).padStart(3, "0")}`;
  }

  withTx(tx: any): COGSService {
    return new COGSService(tx);
  }
}

// ─── Factory ────────────────────────────────────────────────────────

export function createCOGSService(db: any) {
  return new COGSService(db);
}
