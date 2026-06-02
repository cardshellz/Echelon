/**
 * FIFO COGS Engine for Echelon WMS.
 *
 * All costs at the PIECE level. No estimates — lots have "current cost"
 * which updates when landed costs arrive. FIFO is strict: oldest lot
 * consumed first, always. All cost operations are atomic (transactions).
 *
 * Tables: inventory.inventory_lots (cost layers), oms.order_item_costs
 * (the single live COGS ledger, written at pick time by pickFromLots).
 * The legacy inventory.order_line_costs ledger is retired (COGS Phase 1).
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
  zeroCostQty: number;
  provisionalQty: number;
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
    zeroCostQty: number;
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

      // Get full cost from COGS columns. Use the provided transaction handle;
      // Drizzle execute returns a result object, not an iterable tuple.
      const lotCost = await db.execute(sql`
        SELECT total_unit_cost_cents FROM inventory.inventory_lots WHERE id = ${lot.id}
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

  // NOTE (COGS Phase 1): recordShipmentCOGS was removed. It wrote to the
  // retired inventory.order_line_costs ledger at ship time and re-decremented
  // lot.qty_consumed, duplicating the consumption already booked at pick time
  // by InventoryLotService.pickFromLots → oms.order_item_costs (the single
  // live COGS ledger). consumeLotsFIFO below remains as a read-only FIFO cost
  // simulation for valuation/preview use.

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
      FROM inventory.inventory_lots il
      LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
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

    // Cascade the new cost to any COGS rows written from this lot
    await this.cascadeRecostForLot(lotId, newTotal);

    // Log the adjustment
    await this.db.execute(sql`
      INSERT INTO inventory.cost_adjustment_log (lot_id, lot_number, product_variant_id, sku, old_cost_cents, new_cost_cents, delta_cents, reason, created_at)
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
  // CASCADE RECOST — update COGS rows when a lot's cost changes
  // ---------------------------------------------------------------------------

  /**
   * After a lot's unit cost is updated (e.g. landed cost finalization), cascade
   * the new cost to all order_item_costs rows that reference that lot. This
   * ensures shipped orders reflect the true cost even when freight arrives late.
   *
   * Returns the number of COGS rows updated and the total delta in cents.
   */
  async cascadeRecostForLot(
    lotId: number,
    newUnitCostCents: number,
  ): Promise<{ rowsUpdated: number; totalDeltaCents: number }> {
    // Find all COGS rows referencing this lot with a different cost
    const affected = await this.db.execute(sql`
      SELECT id, qty, unit_cost_cents
      FROM oms.order_item_costs
      WHERE inventory_lot_id = ${lotId}
        AND unit_cost_cents != ${newUnitCostCents}
    `);

    const rows = affected.rows || [];
    if (rows.length === 0) {
      return { rowsUpdated: 0, totalDeltaCents: 0 };
    }

    let totalDeltaCents = 0;
    for (const row of rows) {
      const oldCost = Number(row.unit_cost_cents) || 0;
      const qty = Number(row.qty) || 0;
      totalDeltaCents += (newUnitCostCents - oldCost) * qty;
    }

    // Bulk update: set new unit cost and recalculate total
    await this.db.execute(sql`
      UPDATE oms.order_item_costs
      SET unit_cost_cents = ${newUnitCostCents},
          total_cost_cents = qty * ${newUnitCostCents}
      WHERE inventory_lot_id = ${lotId}
        AND unit_cost_cents != ${newUnitCostCents}
    `);

    return { rowsUpdated: rows.length, totalDeltaCents };
  }

  // ---------------------------------------------------------------------------
  // INVOICE VARIANCE → LOT COST RECONCILIATION
  // ---------------------------------------------------------------------------

  /**
   * When an approved invoice line has a different unit cost than what was
   * originally recorded on the PO, update the affected lots and cascade the
   * corrected cost to COGS rows.
   *
   * Finds lots by (purchaseOrderId, productVariantId) and updates their
   * unitCostCents + total_unit_cost_cents to reflect the invoice-actual cost.
   * Logs each adjustment to cost_adjustment_log.
   *
   * Returns summary of lots updated and total COGS delta.
   */
  async reconcileInvoiceVariance(params: {
    purchaseOrderId: number;
    productVariantId: number;
    invoiceUnitCostCents: number;
    invoiceNumber?: string;
  }): Promise<{ lotsUpdated: number; cogsRowsUpdated: number; totalCogsDeltaCents: number }> {
    const { purchaseOrderId, productVariantId, invoiceUnitCostCents } = params;

    // Find lots linked to this PO + variant
    const affectedLots = await this.db.execute(sql`
      SELECT id, lot_number, unit_cost_cents,
             COALESCE(landed_cost_cents, 0) AS landed_cost_cents,
             COALESCE(total_unit_cost_cents, unit_cost_cents) AS total_unit_cost_cents
      FROM inventory.inventory_lots
      WHERE purchase_order_id = ${purchaseOrderId}
        AND product_variant_id = ${productVariantId}
    `);

    const lots = affectedLots.rows || [];
    if (lots.length === 0) {
      return { lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 };
    }

    let lotsUpdated = 0;
    let cogsRowsUpdated = 0;
    let totalCogsDeltaCents = 0;

    for (const lot of lots) {
      const oldCost = Number(lot.unit_cost_cents) || 0;
      const landedAddon = Number(lot.landed_cost_cents) || 0;
      // New total = invoice base cost + existing landed addon
      const newTotal = invoiceUnitCostCents + landedAddon;

      if (oldCost === invoiceUnitCostCents && Number(lot.total_unit_cost_cents) === newTotal) {
        continue; // Already at the right cost
      }

      // Update the lot
      await this.db.execute(sql`
        UPDATE inventory.inventory_lots
        SET unit_cost_cents = ${invoiceUnitCostCents},
            po_unit_cost_cents = ${invoiceUnitCostCents},
            total_unit_cost_cents = ${newTotal},
            cost_source = 'invoice'
        WHERE id = ${lot.id}
      `);

      // Log the adjustment
      const reason = params.invoiceNumber
        ? `invoice_variance:${params.invoiceNumber}`
        : "invoice_variance";
      await this.db.execute(sql`
        INSERT INTO inventory.cost_adjustment_log
          (lot_id, lot_number, product_variant_id, sku, old_cost_cents, new_cost_cents, delta_cents, reason, created_at)
        SELECT ${lot.id}, ${lot.lot_number}, ${productVariantId}, COALESCE(pv.sku, ''),
               ${Number(lot.total_unit_cost_cents)}, ${newTotal}, ${newTotal - Number(lot.total_unit_cost_cents)},
               ${reason}, NOW()
        FROM catalog.product_variants pv WHERE pv.id = ${productVariantId}
      `);

      // Cascade to COGS
      const cascadeResult = await this.cascadeRecostForLot(lot.id, newTotal);
      cogsRowsUpdated += cascadeResult.rowsUpdated;
      totalCogsDeltaCents += cascadeResult.totalDeltaCents;
      lotsUpdated++;
    }

    return { lotsUpdated, cogsRowsUpdated, totalCogsDeltaCents };
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
      FROM inventory.inventory_lots il
      LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      LEFT JOIN procurement.purchase_orders po ON po.id = il.purchase_order_id
      LEFT JOIN procurement.inbound_shipments ish ON ish.id = il.inbound_shipment_id
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

    // Get COGS entries from the live ledger (oms.order_item_costs, written at
    // pick time by pickFromLots). The legacy inventory.order_line_costs ledger
    // is retired — see recordShipmentCOGS note. Alias columns to the legacy
    // shape (lot_id, qty_consumed) so downstream mapping is unchanged.
    const cogsResult = await this.db.execute(sql`
      SELECT olc.order_id, olc.order_item_id, olc.product_variant_id,
             olc.inventory_lot_id AS lot_id, olc.qty AS qty_consumed,
             olc.unit_cost_cents, olc.total_cost_cents,
             pv.sku, p.name as product_name, il.lot_number
      FROM oms.order_item_costs olc
      LEFT JOIN catalog.product_variants pv ON pv.id = olc.product_variant_id
      LEFT JOIN catalog.products p ON p.id = pv.product_id
      LEFT JOIN inventory.inventory_lots il ON il.id = olc.inventory_lot_id
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
        SUM(CASE WHEN COALESCE(il.total_unit_cost_cents, il.unit_cost_cents, 0) = 0 THEN il.qty_on_hand ELSE 0 END) as zero_cost_qty,
        BOOL_OR(COALESCE(il.landed_cost_cents, 0) = 0 AND il.inbound_shipment_id IS NOT NULL) as has_landed_pending
      FROM inventory.inventory_lots il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      JOIN catalog.products p ON p.id = pv.product_id
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
      zeroCostQty: Number(r.zero_cost_qty) || 0,
      hasLandedPending: r.has_landed_pending || false,
    }));

    const totalValueCents = byProduct.reduce((s: number, p: any) => s + p.totalValueCents, 0);
    const totalQty = byProduct.reduce((s: number, p: any) => s + p.totalQty, 0);
    const zeroCostQty = byProduct.reduce((s: number, p: any) => s + p.zeroCostQty, 0);

    // Provisional + landed pending summary
    const pendingResult = await this.db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE COALESCE(il.landed_cost_cents, 0) = 0 AND il.inbound_shipment_id IS NOT NULL) as landed_pending_count,
        COALESCE(SUM(il.qty_on_hand * COALESCE(il.total_unit_cost_cents, il.unit_cost_cents, 0))
          FILTER (WHERE COALESCE(il.landed_cost_cents, 0) = 0 AND il.inbound_shipment_id IS NOT NULL), 0) as landed_pending_value,
        COALESCE(SUM(il.qty_on_hand) FILTER (WHERE il.cost_provisional = 1), 0) as provisional_qty
      FROM inventory.inventory_lots il
      WHERE il.status = 'active'
        AND il.qty_on_hand > 0
    `);
    const pending = pendingResult.rows?.[0] as any || {};

    return {
      totalValueCents,
      totalQty,
      zeroCostQty,
      provisionalQty: Number(pending.provisional_qty) || 0,
      landedPendingLots: Number(pending.landed_pending_count) || 0,
      landedPendingValueCents: Number(pending.landed_pending_value) || 0,
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
          SELECT warehouse_location_id FROM inventory.inventory_levels
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
      SELECT * FROM inventory.cost_adjustment_log
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
      SELECT DISTINCT o.id, o.order_number, olc.unit_cost_cents,
             olc.qty AS qty_consumed, olc.total_cost_cents
      FROM oms.order_item_costs olc
      JOIN wms.orders o ON o.id = olc.order_id
      WHERE olc.inventory_lot_id = ${lotId}
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
      FROM inventory.inventory_lots il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      JOIN catalog.products p ON p.id = pv.product_id
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
      FROM inventory.inventory_lots il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      JOIN catalog.products p ON p.id = pv.product_id
      LEFT JOIN procurement.purchase_orders po ON po.id = il.purchase_order_id
      LEFT JOIN procurement.inbound_shipments ish ON ish.id = il.inbound_shipment_id
      LEFT JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
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
      SELECT cost_source FROM inventory.inventory_lots WHERE id = ${lotId}
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
      SELECT cost_source, qty_consumed FROM inventory.inventory_lots WHERE id = ${lotId}
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
      FROM inventory.inventory_lots il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      JOIN catalog.products p ON p.id = pv.product_id
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

  // ---------------------------------------------------------------------------
  // BACKFILL LOT COSTS BY SKU (manual upload)
  // ---------------------------------------------------------------------------

  /**
   * Backfill zero-cost lots from a user-provided SKU→cost mapping.
   * For each entry, finds all lots where unitCostCents = 0 for that variant
   * and stamps the provided cost. Cascades to COGS rows.
   *
   * Designed for one-time historical backfill where most inventory was loaded
   * without POs.
   */
  async backfillLotCostsBySku(
    entries: Array<{ sku: string; unitCostCents: number }>,
  ): Promise<{
    processed: number;
    lotsUpdated: number;
    cogsRowsUpdated: number;
    skipped: Array<{ sku: string; reason: string }>;
  }> {
    let processed = 0;
    let lotsUpdated = 0;
    let cogsRowsUpdated = 0;
    const skipped: Array<{ sku: string; reason: string }> = [];

    for (const entry of entries) {
      if (!entry.sku || entry.unitCostCents <= 0) {
        skipped.push({ sku: entry.sku || "(empty)", reason: "invalid_entry" });
        continue;
      }

      const variantResult = await this.db.execute(sql`
        SELECT id FROM catalog.product_variants
        WHERE UPPER(sku) = UPPER(${entry.sku})
        LIMIT 1
      `);
      const variant = variantResult.rows?.[0];
      if (!variant) {
        skipped.push({ sku: entry.sku, reason: "sku_not_found" });
        continue;
      }

      const variantId = variant.id;

      const lotsResult = await this.db.execute(sql`
        SELECT id, lot_number, COALESCE(landed_cost_cents, 0) AS landed_cost_cents
        FROM inventory.inventory_lots
        WHERE product_variant_id = ${variantId}
          AND (unit_cost_cents = 0 OR unit_cost_cents IS NULL)
      `);
      const lots = lotsResult.rows || [];

      if (lots.length === 0) {
        skipped.push({ sku: entry.sku, reason: "no_zero_cost_lots" });
        processed++;
        continue;
      }

      for (const lot of lots) {
        const landedAddon = Number(lot.landed_cost_cents) || 0;
        const newTotal = entry.unitCostCents + landedAddon;

        await this.db.execute(sql`
          UPDATE inventory.inventory_lots
          SET unit_cost_cents = ${entry.unitCostCents},
              po_unit_cost_cents = ${entry.unitCostCents},
              total_unit_cost_cents = ${newTotal},
              cost_provisional = 0,
              cost_source = 'backfill'
          WHERE id = ${lot.id}
        `);

        const cascade = await this.cascadeRecostForLot(lot.id, newTotal);
        cogsRowsUpdated += cascade.rowsUpdated;
        lotsUpdated++;
      }

      // Update variant catalog costs so future lots pick this up via the resolver
      await this.db.execute(sql`
        UPDATE catalog.product_variants
        SET last_cost_cents = ${entry.unitCostCents},
            standard_cost_cents = CASE
              WHEN standard_cost_cents IS NULL OR standard_cost_cents = 0
              THEN ${entry.unitCostCents}
              ELSE standard_cost_cents
            END,
            updated_at = NOW()
        WHERE id = ${variantId}
      `);

      processed++;
    }

    return { processed, lotsUpdated, cogsRowsUpdated, skipped };
  }

  withTx(tx: any): COGSService {
    return new COGSService(tx);
  }
}

// ─── Factory ────────────────────────────────────────────────────────

export function createCOGSService(db: any) {
  return new COGSService(db);
}
