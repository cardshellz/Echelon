import { readLotCostFollowUps } from "./infrastructure/lot-cost-follow-up.repository";
import { readInventoryValuation } from "./application/read-inventory-valuation";
import { normalizeLotCosts, recordedUnitCostMills, moneyToSafeNumber, roundedSignedMillsToCents } from "./domain/lot-cost";
import { costInteger, lockInventoryCostGraph } from "./infrastructure/cost-evidence.repository";
import type { CostComponent } from "@shared/procurement/cost-source-contracts";
/**
 * FIFO COGS Engine for Echelon WMS.
 *
 * Costs are per variant unit and may remain provisional. Source revisions
 * revalue the recorded lineage without replaying physical quantities. FIFO
 * custody belongs to InventoryLotService; this owner applies financial changes.
 *
 * Tables: inventory.inventory_lots (cost layers), oms.order_item_costs
 * (the single live COGS ledger, written by the existing inventory pick owners).
 * The legacy inventory.order_line_costs ledger is retired (COGS Phase 1).
 */

import { eq, and, sql, asc, desc, isNull, isNotNull } from "drizzle-orm";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { millsToCents, centsToMills, dollarsToMills } from "@shared/utils/money";
import {
  inventoryLots,
  productVariants,
  products,
  orders,
  orderItems,
} from "@shared/schema";
import type { InventoryLot } from "@shared/schema";
import { assertLegacyQuantityImportAllowed } from "./application/legacy-quantity-import";
import { parseCostLotsReport, parseInventoryValuationReport } from "@shared/inventory/cost-report-read";
import { buildOrderCOGSReport, type OrderCOGSResult } from "./domain/order-cogs-read";
export type { OrderCOGSResult, OrderLineCOGS } from "./domain/order-cogs-read";

/**
 * Parse one lot-cost CSV row. Pure + exported for unit testing.
 * Columns: sku (required), unit_cost (required, dollars), lot_number (optional).
 * unit_cost is dollars → mills ($1 = 10,000 mills) so sub-cent costs survive.
 */
export function parseLotCostCsvRow(row: Record<string, any>):
  | { ok: true; sku: string; costPerPieceMills: number }
  | { ok: false; error: string } {
  // sku = the variant SKU (as shown on the lots / template). cost_per_piece is dollars per
  // piece → mills ($1 = 10,000 mills) so sub-cent piece costs survive. The lot cost is derived
  // as per_piece × the variant's units_per_variant.
  const sku = String(row.sku ?? "").trim();
  const rawCost = String(row.cost_per_piece ?? "").trim();
  if (!sku) return { ok: false, error: "missing sku" };
  if (!rawCost) return { ok: false, error: "missing cost_per_piece" };
  try {
    const value = rawCost.replace(/[$,\s]/g,"");
    if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new RangeError("Invalid decimal price");
    const costPerPieceMills = dollarsToMills(value);
    return { ok: true,sku,costPerPieceMills };
  } catch {
    return { ok: false, error: `invalid cost_per_piece "${rawCost}"` };
  }
}

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>, config?: PgTransactionConfig) => Promise<T>;
};

// ─── Types ──────────────────────────────────────────────────────────

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

export interface LotCostRevalueResult extends CostAdjustmentLog {
  cogsRowsUpdated: number;
  totalCogsDeltaCents: number;
}

// ─── Service ────────────────────────────────────────────────────────

export class COGSService {
  constructor(private readonly db: DrizzleDb, private readonly clock: () => Date = () => new Date()) {}

  async revalueComponent(lotId: number, component: CostComponent, unitMills: number, reason: string, tx: any) {
    return this.revalueLotCostMills({
      lotId, productCostMills: component === "product" ? unitMills : undefined,
      packagingCostMills: component === "packaging" ? unitMills : undefined,
      landedCostMills: component === "landed" ? unitMills : undefined,
      costSource: "cost_revision", reason, clearProvisional: false,
    }, tx);
  }

  private assertNonNegativeMills(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative safe integer mills value`);
    }
  }

  private async runInTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const transaction = (this.db as any).transaction;
    if (typeof transaction === "function") {
      return transaction.call(this.db, fn);
    }
    return fn(this.db);
  }

  private async cascadeRecostForLotMills(
    lotId: number,
    newUnitCostMills: number,
    tx: any = this.db,
  ): Promise<{ rowsUpdated: number; totalDeltaCents: number }> {
    this.assertNonNegativeMills(newUnitCostMills, "newUnitCostMills");

    const newUnitCostCents = millsToCents(newUnitCostMills);
    const affected = await tx.execute(sql`
      SELECT id,qty,unit_cost_cents,unit_cost_mills,total_cost_cents,total_cost_mills,cost_precision_version
      FROM oms.order_item_costs WHERE inventory_lot_id=${lotId} ORDER BY id FOR UPDATE
    `);

    const rows = (affected.rows || []).filter((row: any) => recordedUnitCostMills(row) !== BigInt(newUnitCostMills));
    if (rows.length === 0) {
      return { rowsUpdated: 0, totalDeltaCents: 0 };
    }

    let deltaCents = BigInt(0);
    for (const row of rows) {
      const oldUnitMills = recordedUnitCostMills(row);
      const qty = BigInt(costInteger(row.qty, "cogs.quantity", -2_147_483_647));
      const nextTotal = BigInt(newUnitCostMills) * qty;
      const priorTotal = oldUnitMills * qty;
      // SQL stores bigint and rounds each extended row, not a rounded unit.
      // Keep that same exact boundary for the audit/export delta.
      const maxStored = BigInt("9223372036854775807");
      if (nextTotal > maxStored || nextTotal < -maxStored || priorTotal > maxStored || priorTotal < -maxStored) {
        throw new Error("COGS extended cost exceeds PostgreSQL bigint range");
      }
      deltaCents += roundedSignedMillsToCents(nextTotal) - roundedSignedMillsToCents(priorTotal);
    }
    const totalDeltaCents = costInteger(deltaCents.toString(), "cogs.totalDeltaCents", -Number.MAX_SAFE_INTEGER);

    await tx.execute(sql`
      UPDATE oms.order_item_costs
      SET unit_cost_mills = ${newUnitCostMills}, total_cost_mills = qty::bigint * ${newUnitCostMills},
          unit_cost_cents = ${newUnitCostCents},
          total_cost_cents = CASE WHEN qty < 0 THEN -(((-qty::bigint * ${newUnitCostMills}) + 50) / 100)
            ELSE ((qty::bigint * ${newUnitCostMills}) + 50) / 100 END,
          cost_precision_version=1
      WHERE id IN (${sql.join(rows.map((row: any) => sql`${costInteger(row.id,"cogs.id",1)}`),sql`, `)})
    `);

    return { rowsUpdated: rows.length, totalDeltaCents };
  }

  private async revalueLotCostMills(params: {
    lotId: number;
    productCostMills?: number;
    packagingCostMills?: number;
    landedCostMills?: number;
    costSource: string;
    reason: string;
    actorId?: string;
    preserveExistingCostSourceUnlessPo?: boolean;
    clearProvisional?: boolean;
    requiredCostSource?: string;
  }, client?: any): Promise<LotCostRevalueResult | null> {
    const revalue = async (tx: any): Promise<LotCostRevalueResult | null> => {
      await lockInventoryCostGraph(tx);
      const now = this.clock();
      if (!Number.isFinite(now.getTime())) throw new Error("Invalid lot cost clock");
      const result = await tx.execute(sql`
        SELECT il.*, pv.sku
        FROM inventory.inventory_lots il
        LEFT JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        WHERE il.id = ${params.lotId}
        FOR UPDATE OF il
      `);
      const lot = result.rows?.[0];
      if (!lot) return null;
      if (params.requiredCostSource && String(lot.cost_source || "") !== params.requiredCostSource) {
        return null;
      }

      const current = normalizeLotCosts(lot);
      const currentProductMills = moneyToSafeNumber(current.poMills,"productCostMills");
      const currentPackagingMills = moneyToSafeNumber(current.packagingMills,"packagingCostMills");
      const currentLandedMills = moneyToSafeNumber(current.landedMills,"landedCostMills");
      const productCostMills = params.productCostMills ?? currentProductMills;
      const packagingCostMills = params.packagingCostMills ?? currentPackagingMills;
      const landedCostMills = params.landedCostMills ?? currentLandedMills;

      this.assertNonNegativeMills(productCostMills, "productCostMills");
      this.assertNonNegativeMills(packagingCostMills, "packagingCostMills");
      this.assertNonNegativeMills(landedCostMills, "landedCostMills");

      const totalUnitCostMills = costInteger((BigInt(productCostMills) + BigInt(packagingCostMills) + BigInt(landedCostMills)).toString(), "totalUnitCostMills");
      this.assertNonNegativeMills(totalUnitCostMills, "totalUnitCostMills");

      const oldTotalMills = moneyToSafeNumber(current.totalMills,"oldTotalMills");
      const oldCostCents = millsToCents(oldTotalMills);
      const newCostCents = millsToCents(totalUnitCostMills);
      const productCostCents = millsToCents(productCostMills);
      const packagingCostCents = millsToCents(packagingCostMills);
      const landedCostCents = millsToCents(landedCostMills);
      const existingCostSource = String(lot.cost_source || "");
      const costSource =
        params.preserveExistingCostSourceUnlessPo && existingCostSource && existingCostSource !== "po"
          ? existingCostSource
          : params.costSource;

      const protectedComponents: CostComponent[] = [];
      if (params.costSource === "manual") {
        if (params.productCostMills !== undefined) protectedComponents.push("product");
        if (params.packagingCostMills !== undefined) protectedComponents.push("packaging");
        if (params.landedCostMills !== undefined) protectedComponents.push("landed");
      } else if (existingCostSource === "manual") {
        protectedComponents.push("product");
      }
      for (const component of protectedComponents) await tx.execute(sql`
        INSERT INTO inventory.cost_component_protections(inventory_lot_id,component,reason,recorded_by,recorded_at)
        VALUES (${params.lotId},${component},${params.costSource === "manual" ? params.reason : "Preserved pre-existing manual product cost"},${params.actorId || "system:inventory-cost"},${now})
        ON CONFLICT (inventory_lot_id,component) DO NOTHING
      `);

      await tx.execute(sql`
        UPDATE inventory.inventory_lots
        SET po_unit_cost_mills = ${productCostMills},
            packaging_cost_mills = ${packagingCostMills},
            landed_cost_mills = ${landedCostMills},
            total_unit_cost_mills = ${totalUnitCostMills},
            unit_cost_mills = ${totalUnitCostMills},
            po_unit_cost_cents = ${productCostCents},
            packaging_cost_cents = ${packagingCostCents},
            landed_cost_cents = ${landedCostCents},
            total_unit_cost_cents = ${newCostCents},
            unit_cost_cents = ${newCostCents},
            cost_provisional = CASE WHEN ${params.clearProvisional === false ? 0 : 1} = 1 THEN 0 ELSE cost_provisional END,
            cost_source = ${costSource}, cost_precision_version=1
        WHERE id = ${params.lotId}
      `);

      const cascade = await this.cascadeRecostForLotMills(params.lotId, totalUnitCostMills, tx);

      await tx.execute(sql`
        INSERT INTO inventory.cost_adjustment_log
          (lot_id, lot_number, product_variant_id, sku, old_cost_cents, new_cost_cents, delta_cents, reason, created_at)
        VALUES (
          ${params.lotId},
          ${lot.lot_number},
          ${lot.product_variant_id},
          ${lot.sku || ""},
          ${oldCostCents},
          ${newCostCents},
          ${newCostCents - oldCostCents},
          ${params.reason},
          ${now}
        )
      `);

      return {
        lotId: params.lotId,
        lotNumber: lot.lot_number,
        productVariantId: lot.product_variant_id,
        sku: lot.sku || "",
        oldCostCents,
        newCostCents,
        deltaCents: newCostCents - oldCostCents,
        adjustedAt: now,
        reason: params.reason,
        cogsRowsUpdated: cascade.rowsUpdated,
        totalCogsDeltaCents: cascade.totalDeltaCents,
      };
    };
    return client ? revalue(client) : this.runInTransaction(revalue);
  }

  // ---------------------------------------------------------------------------
  // CREATE LOT (with full cost columns)
  // ---------------------------------------------------------------------------

  async createLot(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyPieces: number;
    poUnitCostCents?: number;
    packagingCostCents?: number;
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
    await assertLegacyQuantityImportAllowed(this.db, "Legacy cost-lot import");
    const poUnitCost = params.poUnitCostCents ?? 0;
    const packagingCost = params.packagingCostCents ?? 0;
    const landedCost = params.landedCostCents ?? 0;
    const totalUnitCost = poUnitCost + packagingCost + landedCost;
    const poUnitCostMills = centsToMills(poUnitCost);
    const packagingCostMills = centsToMills(packagingCost);
    const landedCostMills = centsToMills(landedCost);
    const totalUnitCostMills = poUnitCostMills + packagingCostMills + landedCostMills;
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
        packagingCostCents: packagingCost,
        costProvisional: landedCost === 0 && costSource !== 'manual' ? 1 : 0,
        status: "active",
        notes: params.notes ?? null,
      } as any)
      .returning();

    // Update COGS-specific columns via raw SQL
    await this.db.execute(sql`
      UPDATE inventory_lots SET
        po_line_id = ${params.poLineId ?? null},
        po_unit_cost_cents = ${poUnitCost},
        packaging_cost_cents = ${packagingCost},
        landed_cost_cents = ${landedCost},
        total_unit_cost_cents = ${totalUnitCost},
        po_unit_cost_mills = ${poUnitCostMills},
        packaging_cost_mills = ${packagingCostMills},
        landed_cost_mills = ${landedCostMills},
        total_unit_cost_mills = ${totalUnitCostMills},
        unit_cost_mills = ${totalUnitCostMills},
        qty_received = ${params.qtyPieces},
        qty_consumed = 0,
        cost_source = ${costSource}, cost_precision_version=1,
        batch_number = ${params.batchNumber ?? null}
      WHERE id = ${lot.id}
    `);

    return lot as InventoryLot;
  }

  // ---------------------------------------------------------------------------
  // UPDATE LOT LANDED COST
  // ---------------------------------------------------------------------------

  async updateLotLandedCost(
    lotId: number,
    landedCostCents: number,
  ): Promise<LotCostRevalueResult | null> {
    return this.updateLotLandedCostMills(lotId, centsToMills(landedCostCents));
  }

  async updateLotLandedCostMills(
    lotId: number,
    landedCostMills: number,
  ): Promise<LotCostRevalueResult | null> {
    return this.revalueLotCostMills({
      lotId,
      landedCostMills,
      costSource: "po_landed",
      reason: "landed_cost_finalized",
      preserveExistingCostSourceUnlessPo: true,
    });
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
    return this.cascadeRecostForLotMills(lotId, centsToMills(newUnitCostCents));
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
    costInteger(orderId, "orderId", 1);
    // Financial snapshots and cost rows can change while this report is read.
    // One repeatable-read snapshot avoids combining old lines with new COGS.
    return this.db.transaction((tx) => this.readOrderCOGS(orderId, tx), {
      isolationLevel: "repeatable read", accessMode: "read only",
    });
  }

  private async readOrderCOGS(orderId: number, reader: Pick<DrizzleDb, "select" | "execute">): Promise<OrderCOGSResult | null> {
    // Get order details
    const [order] = await reader
      .select({ id: orders.id, orderNumber: orders.orderNumber, totalCents: orders.totalCents, currency: orders.currency })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return null;

    // Get order items
    const items = await reader
      .select({ id: orderItems.id, sku: orderItems.sku, name: orderItems.name,
        quantity: orderItems.quantity, totalPriceCents: orderItems.totalPriceCents })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id));

    // Get COGS entries from the live ledger (oms.order_item_costs, written at
    // pick time by pickFromLots). The legacy inventory.order_line_costs ledger
    // is retired — see recordShipmentCOGS note. Alias columns to the legacy
    // shape (lot_id, qty_consumed) so downstream mapping is unchanged.
    const cogsResult = await reader.execute(sql`
      SELECT olc.order_id, olc.order_item_id,
             olc.inventory_lot_id AS lot_id, olc.qty AS qty_consumed,
             olc.unit_cost_cents, olc.total_cost_cents, olc.unit_cost_mills, olc.total_cost_mills,
             il.lot_number
      FROM oms.order_item_costs olc
      LEFT JOIN inventory.inventory_lots il ON il.id = olc.inventory_lot_id
      WHERE olc.order_id = ${orderId}
      ORDER BY olc.id ASC
    `);
    return buildOrderCOGSReport({ order, items, costs: cogsResult.rows });
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

  async getCostFollowUps(input: { afterId?: number; limit?: number } = {}) {
    return readLotCostFollowUps(this.db,input);
  }

  async getInventoryValuation(): Promise<InventoryValuationResult> {
    const valuation = await readInventoryValuation(this.db);
    return parseInventoryValuationReport({
      totalValueCents: valuation.total.valueCents, totalQty: valuation.total.qty,
      zeroCostQty: valuation.total.zeroCostQty, provisionalQty: valuation.total.provisionalQty,
      landedPendingLots: valuation.landedPendingLots, landedPendingValueCents: valuation.landedPendingValueCents,
      byProduct: valuation.byProduct, totalValueMills: valuation.totalValueMills,
      quantityUnit: valuation.quantityUnit, unknownCostQty: valuation.unknownCostQty,
    });

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
      whereClause = sql`${whereClause} AND il.cost_provisional = 1 AND il.inbound_shipment_id IS NOT NULL`;
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
             pv.units_per_variant AS units_per_variant,
             p.name as product_name,
             p.id as product_id,
             p.sku AS base_sku,
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

    return parseCostLotsReport({
      lots: result.rows || [],
      total: Number(countResult.rows?.[0]?.total) || 0,
    });
  }

  // ---------------------------------------------------------------------------
  // LOT-COST CSV UPLOAD (cost legacy / provisional lots in bulk)
  // ---------------------------------------------------------------------------

  /** Distinct variant SKUs that have un-costed lots — the per-piece CSV template source. */
  async getUncostedVariants(): Promise<any[]> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT pv.sku
      FROM inventory.inventory_lots il
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      WHERE il.status = 'active' AND il.qty_on_hand > 0
        AND (il.cost_provisional = 1 OR COALESCE(il.total_unit_cost_mills, 0) = 0)
      ORDER BY pv.sku
    `);
    return result.rows || [];
  }

  /**
   * Set a lot's PRODUCT cost in mills (authoritative): po = product, total = po + packaging
   * + landed, cents mirrors derived, provisional cleared, cost_source → 'manual'. Cascades the
   * new total to any booked COGS rows. Used by the lot-cost CSV upload to cost legacy stock.
   */
  async setLotProductCostMills(
    lotId: number,
    productCostMills: number,
    reason: string = 'csv_cost_upload',
  ): Promise<{ lotId: number; lotNumber: string; sku: string; oldCostCents: number; newCostCents: number } | null> {
    const revalue = await this.revalueLotCostMills({
      lotId,
      productCostMills,
      costSource: "manual",
      reason,
    });
    if (!revalue) return null;
    return {
      lotId: revalue.lotId,
      lotNumber: revalue.lotNumber,
      sku: revalue.sku,
      oldCostCents: revalue.oldCostCents,
      newCostCents: revalue.newCostCents,
    };
  }

  /**
   * Manually recost ANY lot (correction / override) by per-piece cost. Looks up the lot's
   * units_per_variant and sets the lot cost = per_piece × upv (mills) via setLotProductCostMills
   * — cent mirrors, provisional cleared, cost_source → 'manual', cascade to booked COGS, and an
   * audit row in cost_adjustment_log with the given reason. Works on PO/landed/manual lots alike.
   */
  async recostLotPerPiece(
    lotId: number, perPieceMills: number, reason: string, actorId?: string,
  ): Promise<{ lotId: number; lotNumber: string; sku: string; oldCostCents: number; newCostCents: number } | null> {
    this.assertNonNegativeMills(perPieceMills, "perPieceMills");
    if (!reason.trim()) throw new Error("Manual cost correction requires a reason");
    return this.runInTransaction(async (tx) => {
      await lockInventoryCostGraph(tx);
      const result = await tx.execute(sql`
        SELECT COALESCE(origin.units_per_variant_snapshot,pv.units_per_variant) AS upv
        FROM inventory.inventory_lots lot JOIN catalog.product_variants pv ON pv.id=lot.product_variant_id
        LEFT JOIN inventory.lot_cost_origins origin ON origin.inventory_lot_id=lot.id
        WHERE lot.id=${lotId} FOR SHARE OF pv
      `);
      if (!result.rows[0]) return null;
      const upv = costInteger(result.rows[0].upv, "lot.unitsPerVariant", 1);
      return this.revalueLotCostMills({ lotId, productCostMills: costInteger((BigInt(perPieceMills) * BigInt(upv)).toString(), "manual.productMills"),
        costSource: "manual", reason, actorId }, tx);
    });
  }

  /**
   * Apply a parsed per-piece lot-cost CSV. Each row sets one variant SKU's per-PIECE cost; every
   * un-costed (provisional / zero) active lot of that variant is costed as per_piece ×
   * units_per_variant (mills). It never clobbers a real cost layer. preview (apply=false)
   * computes changes without writing.
   */
  async applyLotCostUpload(
    rawRows: Record<string, any>[],
    apply: boolean,
  ): Promise<{ results: any[]; summary: { rows: number; lotsAffected: number; errors: number } }> {
    const results: any[] = [];
    for (const raw of rawRows) {
      const parsed = parseLotCostCsvRow(raw);
      if (!parsed.ok) { results.push({ status: 'error', message: parsed.error, raw }); continue; }

      const perPieceCents = millsToCents(parsed.costPerPieceMills);
      const lotsRes = await this.db.execute(sql`
        SELECT il.id, il.lot_number, pv.sku, pv.units_per_variant AS upv, wl.code AS loc,
               il.qty_on_hand, COALESCE(il.total_unit_cost_cents, 0) AS old_cents
        FROM inventory.inventory_lots il
        JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
        LEFT JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
        WHERE UPPER(pv.sku) = UPPER(${parsed.sku}) AND il.status = 'active' AND il.qty_on_hand > 0
          AND (il.cost_provisional = 1 OR COALESCE(il.total_unit_cost_mills, 0) = 0)`);
      const lots = lotsRes.rows || [];
      if (lots.length === 0) {
        results.push({ status: 'no_match', sku: parsed.sku, message: 'no un-costed lots for SKU' });
        continue;
      }
      for (const lot of lots) {
        const upv = Number(lot.upv) || 1;
        const perVariantMills = parsed.costPerPieceMills * upv; // per-piece × pack size
        if (apply) await this.setLotProductCostMills(Number(lot.id), perVariantMills);
        results.push({
          status: apply ? 'applied' : 'preview',
          sku: lot.sku,
          upv,
          lotNumber: lot.lot_number,
          location: lot.loc,
          qty: Number(lot.qty_on_hand),
          perPieceCents,
          perPieceMills: parsed.costPerPieceMills,
          oldCostCents: Number(lot.old_cents),
          newCostCents: millsToCents(perVariantMills),
          newCostMills: perVariantMills,
        });
      }
    }
    const lotsAffected = results.filter(r => r.status === 'applied' || r.status === 'preview').length;
    const errors = results.filter(r => r.status === 'error' || r.status === 'no_match').length;
    return { results, summary: { rows: rawRows.length, lotsAffected, errors } };
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

    if (updates.unitCostCents !== undefined) {
      const revalue = await this.revalueLotCostMills({
        lotId,
        productCostMills: centsToMills(updates.unitCostCents),
        costSource: "manual",
        reason: "manual_lot_update",
        requiredCostSource: "manual",
      });
      if (!revalue) return false;
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
        SELECT id, lot_number
        FROM inventory.inventory_lots
        WHERE product_variant_id = ${variantId}
          AND (
            COALESCE(total_unit_cost_mills, 0) = 0
            OR unit_cost_cents = 0
            OR unit_cost_cents IS NULL
          )
      `);
      const lots = lotsResult.rows || [];

      if (lots.length === 0) {
        skipped.push({ sku: entry.sku, reason: "no_zero_cost_lots" });
        processed++;
        continue;
      }

      for (const lot of lots) {
        const revalue = await this.revalueLotCostMills({
          lotId: Number(lot.id),
          productCostMills: centsToMills(entry.unitCostCents),
          costSource: "backfill",
          reason: "backfill",
        });
        if (revalue) {
          cogsRowsUpdated += revalue.cogsRowsUpdated;
        }
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
