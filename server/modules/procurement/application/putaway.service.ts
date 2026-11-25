import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  transferStock,
  type TransferStockParams,
  type TransferStockResult,
} from "../../inventory/transfer-stock.api";

export interface PutawayTransferOwner {
  transfer(params: TransferStockParams): Promise<TransferStockResult>;
}
import { insertAuditEventSql } from "../../../infrastructure/transactional-audit";
import { logger } from "../../../platform/observability/logger";
import type { IProcurementStorage } from "../infrastructure/procurement.storage";

type DrizzleDb = {
  execute: (query: any) => Promise<{ rows: any[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export interface PutawayWakeupChannelSync {
  queueSyncAfterInventoryChange(productVariantId: number): Promise<void>;
}

export interface PutawayWakeupReplenishment {
  reevaluateReplenForProduct(productId: number): Promise<unknown>;
}

export interface PutawayWakeupPicking {
  wakeShortedExceptionOrdersForVariant(
    productVariantId: number,
    triggeredBy?: string,
  ): Promise<unknown>;
}

export class PutawayError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PutawayError";
  }
}

export type PutawaySuggestionReason =
  | "primary_pick_hungry"
  | "primary_pick_slot"
  | "consolidate_reserve"
  | "empty_reserve"
  | "manual_required";

export interface PutawayQueueItem {
  receivingLineId: number;
  receivingOrderId: number;
  receiptNumber: string;
  poNumber: string | null;
  warehouseId: number;
  productId: number | null;
  productVariantId: number;
  sku: string | null;
  barcode: string | null;
  productName: string | null;
  unitsPerVariant: number;
  netReceivedQty: number;
  alreadyPutAwayQty: number;
  remainingQty: number;
  availableOnDockQty: number;
  dockLocationId: number;
  dockLocationCode: string;
  dockLocationType: string | null;
  suggestedLocationId: number | null;
  suggestedLocationCode: string | null;
  suggestedLocationType: string | null;
  suggestionReason: PutawaySuggestionReason;
  closedDate: Date | string | null;
}

export interface ExecuteLinePutawayInput {
  receivingLineId: number;
  toLocationId: number;
  qty?: number;
  method?: "manual" | "scan";
  userId: string | null;
  commandKey?: string;
  reconcileAlreadyMoved?: boolean;
}

const DISALLOWED_PUTAWAY_DEST_TYPES = new Set([
  "receiving",
  "in_transit",
  "3pl_virtual",
  "quarantine",
]);

export class PutawayService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly storage: Pick<IProcurementStorage, "updateReceivingLine">,
    private readonly transferOwner: PutawayTransferOwner,
    private readonly channelSync?: PutawayWakeupChannelSync | null,
    private readonly replenishment?: PutawayWakeupReplenishment | null,
    private readonly picking?: PutawayWakeupPicking | null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listPendingPutawayQueue(warehouseId?: number | null): Promise<PutawayQueueItem[]> {
    const whClause =
      typeof warehouseId === "number" && Number.isInteger(warehouseId) && warehouseId > 0
        ? sql`AND ro.warehouse_id = ${warehouseId}`
        : sql``;

    const rowsResult = await this.db.execute(sql`
      SELECT
        rl.id AS "receivingLineId",
        rl.receiving_order_id AS "receivingOrderId",
        ro.receipt_number AS "receiptNumber",
        ro.po_number AS "poNumber",
        ro.warehouse_id AS "warehouseId",
        ro.closed_date AS "closedDate",
        COALESCE(rl.product_id, pv.product_id) AS "productId",
        rl.product_variant_id AS "productVariantId",
        COALESCE(rl.sku, pv.sku) AS "sku",
        COALESCE(rl.barcode, pv.barcode) AS "barcode",
        COALESCE(rl.product_name, pv.name) AS "productName",
        COALESCE(rl.units_per_variant_snapshot, pv.units_per_variant, 1) AS "unitsPerVariant",
        rl.received_qty AS "receivedQty",
        COALESCE(rl.reversed_qty, 0) AS "reversedQty",
        rl.putaway_location_id AS "dockLocationId",
        wl.code AS "dockLocationCode",
        wl.location_type AS "dockLocationType",
        GREATEST(0, COALESCE(il.variant_qty, 0) - COALESCE(il.reserved_qty, 0)) AS "availableOnDockQty",
        COALESCE((
          SELECT SUM(COALESCE((ae.changes->>'movedQty')::int, 0))
          FROM public.audit_events ae
          WHERE ae.action = 'procurement.receiving.putaway_moved'
            AND ae.target = ('receiving-line:' || rl.id::text)
        ), 0) AS "alreadyPutAwayQty"
      FROM procurement.receiving_lines rl
      JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
      JOIN catalog.product_variants pv ON pv.id = rl.product_variant_id
      JOIN warehouse.warehouse_locations wl ON wl.id = rl.putaway_location_id
      LEFT JOIN inventory.inventory_levels il
        ON il.product_variant_id = rl.product_variant_id
       AND il.warehouse_location_id = rl.putaway_location_id
      WHERE ro.status = 'closed'
        AND rl.putaway_complete = 0
        AND rl.product_variant_id IS NOT NULL
        AND rl.putaway_location_id IS NOT NULL
        AND (rl.received_qty - COALESCE(rl.reversed_qty, 0)) > 0
        ${whClause}
      ORDER BY ro.closed_date ASC NULLS LAST, rl.id ASC
      LIMIT 500
    `);

    const items: PutawayQueueItem[] = [];
    for (const raw of rowsResult.rows ?? []) {
      const netReceivedQty = Math.max(0, Number(raw.receivedQty || 0) - Number(raw.reversedQty || 0));
      const alreadyPutAwayQty = Math.max(0, Number(raw.alreadyPutAwayQty || 0));
      const remainingQty = Math.max(0, netReceivedQty - alreadyPutAwayQty);
      if (remainingQty <= 0) continue;

      const itemWhId = Number(raw.warehouseId);
      const variantId = Number(raw.productVariantId);
      const productId = raw.productId == null ? null : Number(raw.productId);
      const unitsPerVariant = Math.max(1, Number(raw.unitsPerVariant || 1));

      const suggestion = await this.suggestDestination({
        warehouseId: itemWhId,
        productId,
        productVariantId: variantId,
        unitsPerVariant,
        putawayQty: remainingQty,
        excludeLocationId: Number(raw.dockLocationId),
      });

      items.push({
        receivingLineId: Number(raw.receivingLineId),
        receivingOrderId: Number(raw.receivingOrderId),
        receiptNumber: String(raw.receiptNumber || `#${raw.receivingOrderId}`),
        poNumber: raw.poNumber ? String(raw.poNumber) : null,
        warehouseId: itemWhId,
        productId,
        productVariantId: variantId,
        sku: raw.sku ? String(raw.sku) : null,
        barcode: raw.barcode ? String(raw.barcode) : null,
        productName: raw.productName ? String(raw.productName) : null,
        unitsPerVariant,
        netReceivedQty,
        alreadyPutAwayQty,
        remainingQty,
        availableOnDockQty: Math.max(0, Number(raw.availableOnDockQty || 0)),
        dockLocationId: Number(raw.dockLocationId),
        dockLocationCode: String(raw.dockLocationCode || `LOC-${raw.dockLocationId}`),
        dockLocationType: raw.dockLocationType ? String(raw.dockLocationType) : null,
        suggestedLocationId: suggestion.locationId,
        suggestedLocationCode: suggestion.locationCode,
        suggestedLocationType: suggestion.locationType,
        suggestionReason: suggestion.reason,
        closedDate: raw.closedDate ?? null,
      });
    }

    return items;
  }

  async suggestDestination(input: {
    warehouseId: number;
    productId: number | null;
    productVariantId: number;
    unitsPerVariant: number;
    putawayQty: number;
    excludeLocationId: number;
  }): Promise<{
    locationId: number | null;
    locationCode: string | null;
    locationType: string | null;
    reason: PutawaySuggestionReason;
  }> {
    if (!Number.isInteger(input.warehouseId) || input.warehouseId <= 0) {
      return { locationId: null, locationCode: null, locationType: null, reason: "manual_required" };
    }

    // 1. Primary Pick Bin for this exact UOM variant (hungry or fits within max)
    const primaryRows = await this.db.execute(sql`
      SELECT
        wl.id,
        wl.code,
        wl.location_type AS "locationType",
        wl.zone,
        COALESCE(il.variant_qty, 0) AS "currentQty",
        rr.trigger_value AS "minTrigger",
        rr.max_qty AS "maxQty"
      FROM warehouse.product_locations pl
      JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
      LEFT JOIN inventory.inventory_levels il
        ON il.warehouse_location_id = wl.id
       AND il.product_variant_id = ${input.productVariantId}
      LEFT JOIN inventory.replen_rules rr
        ON rr.pick_variant_id = ${input.productVariantId}
       AND rr.is_active = 1
      WHERE pl.product_variant_id = ${input.productVariantId}
        AND pl.is_primary = 1
        AND pl.status = 'active'
        AND wl.warehouse_id = ${input.warehouseId}
        AND wl.is_active = 1
        AND wl.is_pickable = 1
        AND wl.cycle_count_freeze_id IS NULL
        AND wl.id <> ${input.excludeLocationId}
      ORDER BY wl.id ASC
      LIMIT 1
    `);
    const primary = primaryRows.rows?.[0] as
      | {
          id: number;
          code: string;
          locationType: string | null;
          zone: string | null;
          currentQty: number;
          minTrigger: number | null;
          maxQty: number | null;
        }
      | undefined;

    if (primary) {
      const currentQty = Number(primary.currentQty || 0);
      const minTrigger = primary.minTrigger == null ? null : Number(primary.minTrigger);
      const maxQty = primary.maxQty == null ? null : Number(primary.maxQty);
      const isHungry = currentQty <= 0 || (minTrigger !== null && currentQty <= minTrigger);
      const fitsMax = maxQty === null || maxQty <= 0 || currentQty + input.putawayQty <= maxQty;
      if (isHungry && fitsMax) {
        return {
          locationId: Number(primary.id),
          locationCode: String(primary.code),
          locationType: primary.locationType ? String(primary.locationType) : "pick",
          reason: "primary_pick_hungry",
        };
      }
      if (input.unitsPerVariant === 1 && fitsMax) {
        return {
          locationId: Number(primary.id),
          locationCode: String(primary.code),
          locationType: primary.locationType ? String(primary.locationType) : "pick",
          reason: "primary_pick_slot",
        };
      }
    }

    // 2. Consolidate into an active Reserve bin already holding this variant (or product)
    const consolidateRows = await this.db.execute(sql`
      SELECT
        wl.id,
        wl.code,
        wl.location_type AS "locationType"
      FROM inventory.inventory_levels il
      JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
      JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
      WHERE wl.warehouse_id = ${input.warehouseId}
        AND wl.is_active = 1
        AND wl.location_type = 'reserve'
        AND wl.cycle_count_freeze_id IS NULL
        AND wl.id <> ${input.excludeLocationId}
        AND il.variant_qty > 0
        AND (
          il.product_variant_id = ${input.productVariantId}
          ${input.productId ? sql`OR pv.product_id = ${input.productId}` : sql``}
        )
      ORDER BY
        CASE WHEN il.product_variant_id = ${input.productVariantId} THEN 0 ELSE 1 END,
        wl.zone ASC NULLS LAST,
        wl.aisle ASC NULLS LAST,
        wl.bay ASC NULLS LAST,
        wl.level ASC NULLS LAST,
        wl.bin ASC NULLS LAST,
        wl.code ASC
      LIMIT 1
    `);
    const consolidate = consolidateRows.rows?.[0] as
      | { id: number; code: string; locationType: string | null }
      | undefined;
    if (consolidate) {
      return {
        locationId: Number(consolidate.id),
        locationCode: String(consolidate.code),
        locationType: consolidate.locationType ? String(consolidate.locationType) : "reserve",
        reason: "consolidate_reserve",
      };
    }

    // 3. Empty active Reserve bin in the same warehouse (walk-path sorted)
    const emptyReserveRows = await this.db.execute(sql`
      SELECT
        wl.id,
        wl.code,
        wl.location_type AS "locationType"
      FROM warehouse.warehouse_locations wl
      WHERE wl.warehouse_id = ${input.warehouseId}
        AND wl.is_active = 1
        AND wl.location_type = 'reserve'
        AND wl.cycle_count_freeze_id IS NULL
        AND wl.id <> ${input.excludeLocationId}
        AND NOT EXISTS (
          SELECT 1
          FROM inventory.inventory_levels il
          WHERE il.warehouse_location_id = wl.id
            AND il.variant_qty > 0
        )
      ORDER BY
        wl.zone ASC NULLS LAST,
        wl.aisle ASC NULLS LAST,
        wl.bay ASC NULLS LAST,
        wl.level ASC NULLS LAST,
        wl.bin ASC NULLS LAST,
        wl.code ASC
      LIMIT 1
    `);
    const emptyReserve = emptyReserveRows.rows?.[0] as
      | { id: number; code: string; locationType: string | null }
      | undefined;
    if (emptyReserve) {
      return {
        locationId: Number(emptyReserve.id),
        locationCode: String(emptyReserve.code),
        locationType: emptyReserve.locationType ? String(emptyReserve.locationType) : "reserve",
        reason: "empty_reserve",
      };
    }

    // 4. Fallback to Primary Pick Bin even if over max, else manual
    if (primary) {
      return {
        locationId: Number(primary.id),
        locationCode: String(primary.code),
        locationType: primary.locationType ? String(primary.locationType) : "pick",
        reason: "primary_pick_slot",
      };
    }

    return { locationId: null, locationCode: null, locationType: null, reason: "manual_required" };
  }

  async executeLinePutaway(input: ExecuteLinePutawayInput) {
    const receivingLineId = Number(input.receivingLineId);
    const toLocationId = Number(input.toLocationId);
    if (!Number.isInteger(receivingLineId) || receivingLineId <= 0) {
      throw new PutawayError("Valid receivingLineId is required", 400);
    }
    if (!Number.isInteger(toLocationId) || toLocationId <= 0) {
      throw new PutawayError("Select a destination bin before completing putaway", 400);
    }
    const actor = input.userId?.trim() || "system:putaway";

    // Pre-read snapshot & validate destination
    const snapshotRows = await this.db.execute(sql`
      SELECT
        rl.id,
        rl.receiving_order_id AS "receivingOrderId",
        rl.product_id AS "productId",
        rl.product_variant_id AS "productVariantId",
        rl.received_qty AS "receivedQty",
        COALESCE(rl.reversed_qty, 0) AS "reversedQty",
        rl.putaway_location_id AS "fromLocationId",
        rl.putaway_complete AS "putawayComplete",
        ro.status AS "orderStatus",
        ro.receipt_number AS "receiptNumber",
        ro.warehouse_id AS "warehouseId",
        pv.product_id AS "variantProductId",
        GREATEST(0, COALESCE(il.variant_qty, 0) - COALESCE(il.reserved_qty, 0)) AS "availableOnDockQty",
        COALESCE((
          SELECT SUM(COALESCE((ae.changes->>'movedQty')::int, 0))
          FROM public.audit_events ae
          WHERE ae.action = 'procurement.receiving.putaway_moved'
            AND ae.target = ('receiving-line:' || rl.id::text)
        ), 0) AS "alreadyPutAwayQty",
        EXISTS (
          SELECT 1
          FROM procurement.receiving_quarantine_acceptances qa
          WHERE qa.receiving_line_id = rl.id
        ) AS "isQuarantineAcceptance"
      FROM procurement.receiving_lines rl
      JOIN procurement.receiving_orders ro ON ro.id = rl.receiving_order_id
      LEFT JOIN catalog.product_variants pv ON pv.id = rl.product_variant_id
      LEFT JOIN inventory.inventory_levels il
        ON il.product_variant_id = rl.product_variant_id
       AND il.warehouse_location_id = rl.putaway_location_id
      WHERE rl.id = ${receivingLineId}
      LIMIT 1
    `);
    const snap = snapshotRows.rows?.[0];
    if (!snap) {
      throw new PutawayError("Receiving line not found", 404);
    }
    if (String(snap.orderStatus) !== "closed") {
      throw new PutawayError("Finalize the receipt before executing putaway.", 409, {
        code: "PUTAWAY_RECEIPT_NOT_CLOSED",
      });
    }
    if (Number(snap.putawayComplete) === 1) {
      return {
        alreadyComplete: true,
        receivingLineId,
        putawayComplete: 1,
        movedQty: 0,
        remainingQty: 0,
        toLocationId,
      };
    }
    if (snap.isQuarantineAcceptance === true) {
      throw new PutawayError("Quarantine acceptance lines are posted directly to their reviewed location.", 409, {
        code: "PUTAWAY_QUARANTINE_PROTECTED",
      });
    }

    const fromLocationId = Number(snap.fromLocationId);
    const productVariantId = Number(snap.productVariantId);
    const productId = snap.productId != null ? Number(snap.productId) : (snap.variantProductId != null ? Number(snap.variantProductId) : null);
    if (!Number.isInteger(fromLocationId) || fromLocationId <= 0 || !Number.isInteger(productVariantId) || productVariantId <= 0) {
      throw new PutawayError("Receiving line is missing variant or dock location.", 409);
    }
    if (fromLocationId === toLocationId) {
      throw new PutawayError("Destination bin must be different from the current dock staging bin.", 400, {
        code: "PUTAWAY_SAME_LOCATION",
      });
    }

    const destRows = await this.db.execute(sql`
      SELECT id, code, warehouse_id AS "warehouseId", is_active AS "isActive", location_type AS "locationType", cycle_count_freeze_id AS "freezeId"
      FROM warehouse.warehouse_locations
      WHERE id = ${toLocationId}
      LIMIT 1
    `);
    const dest = destRows.rows?.[0];
    if (!dest || Number(dest.isActive) !== 1) {
      throw new PutawayError("Destination bin is missing or inactive.", 400, {
        code: "PUTAWAY_DESTINATION_INACTIVE",
      });
    }
    if (snap.warehouseId != null && Number(dest.warehouseId) !== Number(snap.warehouseId)) {
      throw new PutawayError("Destination bin belongs to a different warehouse.", 409, {
        code: "PUTAWAY_WAREHOUSE_MISMATCH",
      });
    }
    if (dest.locationType && DISALLOWED_PUTAWAY_DEST_TYPES.has(String(dest.locationType))) {
      throw new PutawayError(
        "Select an active Pick or Reserve bin to complete putaway (receiving docks, transit, and quarantine bins cannot complete putaway).",
        400,
        { code: "PUTAWAY_INVALID_DESTINATION_TYPE", locationType: dest.locationType },
      );
    }
    if (dest.freezeId != null) {
      throw new PutawayError("Destination bin is frozen for an active cycle count.", 409, {
        code: "LOCATION_FROZEN",
      });
    }

    const netReceivedQty = Math.max(0, Number(snap.receivedQty || 0) - Number(snap.reversedQty || 0));
    const alreadyPutAwayQty = Math.max(0, Number(snap.alreadyPutAwayQty || 0));
    const remainingQty = Math.max(0, netReceivedQty - alreadyPutAwayQty);
    if (remainingQty <= 0) {
      await this.db.transaction(async (tx) => {
        await this.storage.updateReceivingLine(
          receivingLineId,
          { putawayComplete: 1, putawayLocationId: toLocationId, updatedAt: this.clock() },
          tx,
        );
      });
      return {
        alreadyComplete: true,
        receivingLineId,
        putawayComplete: 1,
        movedQty: 0,
        remainingQty: 0,
        toLocationId,
      };
    }

    const availableOnDockQty = Math.max(0, Number(snap.availableOnDockQty || 0));
    if (availableOnDockQty === 0 && input.reconcileAlreadyMoved === true) {
      const now = this.clock();
      await this.db.transaction(async (tx) => {
        await this.storage.updateReceivingLine(
          receivingLineId,
          { putawayComplete: 1, putawayLocationId: toLocationId, updatedAt: now },
          tx,
        );
        await insertAuditEventSql(tx, {
          timestamp: now,
          actor,
          action: "procurement.receiving.putaway_moved",
          target: `receiving-line:${receivingLineId}`,
          changesJson: JSON.stringify({
            movedQty: remainingQty,
            fromLocationId,
            toLocationId,
            reconciledAlreadyMoved: true,
          }),
          contextJson: JSON.stringify({
            receivingOrderId: Number(snap.receivingOrderId),
            method: input.method ?? "manual",
          }),
        });
      });
      return {
        alreadyComplete: false,
        receivingLineId,
        putawayComplete: 1,
        movedQty: remainingQty,
        remainingQty: 0,
        toLocationId,
        toLocationCode: String(dest.code),
      };
    }

    const requestedQty = input.qty === undefined ? remainingQty : Number(input.qty);
    if (!Number.isInteger(requestedQty) || requestedQty <= 0) {
      throw new PutawayError("Putaway quantity must be a positive whole number.", 400, {
        code: "INVALID_PUTAWAY_QTY",
      });
    }
    if (requestedQty > remainingQty) {
      throw new PutawayError(
        `Putaway quantity (${requestedQty}) exceeds remaining dock quantity for this receipt line (${remainingQty}).`,
        409,
        { code: "PUTAWAY_QTY_EXCEEDS_REMAINING", remainingQty },
      );
    }
    if (requestedQty > availableOnDockQty) {
      throw new PutawayError(
        `Only ${availableOnDockQty} unreserved unit(s) are currently available on dock bin. Adjust putaway quantity or reconcile if already moved.`,
        409,
        { code: "PUTAWAY_INSUFFICIENT_DOCK_STOCK", availableOnDockQty, remainingQty },
      );
    }

    const effectiveCommandKey =
      input.commandKey?.trim() ||
      `putaway:line:${receivingLineId}:offset:${alreadyPutAwayQty}:qty:${requestedQty}:to:${toLocationId}:${randomUUID()}`;

    const transferResult = await transferStock(this.transferOwner, {
      productVariantId,
      fromLocationId,
      toLocationId,
      qty: requestedQty,
      userId: actor,
      notes: `Directed putaway from receipt ${snap.receiptNumber || `#${snap.receivingOrderId}`} (${input.method ?? "manual"})`,
      commandKey: effectiveCommandKey,
    });

    const newRemaining = Math.max(0, remainingQty - requestedQty);
    const isNowComplete = newRemaining === 0;
    const now = this.clock();

    await this.db.transaction(async (tx) => {
      await insertAuditEventSql(tx, {
        timestamp: now,
        actor,
        action: "procurement.receiving.putaway_moved",
        target: `receiving-line:${receivingLineId}`,
        changesJson: JSON.stringify({
          movedQty: requestedQty,
          fromLocationId,
          toLocationId,
          transferReceiptId: transferResult.transferReceiptId ?? null,
        }),
        contextJson: JSON.stringify({
          receivingOrderId: Number(snap.receivingOrderId),
          method: input.method ?? "manual",
          commandKey: effectiveCommandKey,
        }),
      });

      if (isNowComplete) {
        await this.storage.updateReceivingLine(
          receivingLineId,
          {
            putawayComplete: 1,
            putawayLocationId: toLocationId,
            updatedAt: now,
          },
          tx,
        );
      }
    });

    // Immediate post-putaway ATP sync + Replen unblock + Short-Order wakeup bus
    await this.runPostPutawayWakeups(productVariantId, productId, "putaway");

    return {
      alreadyComplete: false,
      receivingLineId,
      receivingOrderId: Number(snap.receivingOrderId),
      transferReceiptId: transferResult.transferReceiptId ?? null,
      putawayComplete: isNowComplete ? 1 : 0,
      movedQty: requestedQty,
      remainingQty: newRemaining,
      fromLocationId,
      toLocationId,
      toLocationCode: String(dest.code),
      followupPending: false,
    };
  }

  async runPostPutawayWakeups(
    productVariantId: number,
    productId: number | null,
    triggeredBy: string,
  ): Promise<void> {
    if (this.channelSync) {
      await this.channelSync.queueSyncAfterInventoryChange(productVariantId).catch((err) => {
        logger.warn("procurement.putaway_service", {
          message: `[Putaway] Channel ATP sync failed for variant ${productVariantId}`,
          error: err,
        });
      });
    }
    if (this.replenishment && productId != null && productId > 0) {
      await this.replenishment.reevaluateReplenForProduct(productId).catch((err) => {
        logger.warn("procurement.putaway_service", {
          message: `[Putaway] Replen wakeup failed for product ${productId}`,
          error: err,
        });
      });
    }
    if (this.picking) {
      await this.picking.wakeShortedExceptionOrdersForVariant(productVariantId, triggeredBy).catch((err) => {
        logger.warn("procurement.putaway_service", {
          message: `[Putaway] Short-order wakeup failed for variant ${productVariantId}`,
          error: err,
        });
      });
    }
  }
}

export function createPutawayService(
  db: DrizzleDb,
  storage: Pick<IProcurementStorage, "updateReceivingLine">,
  transferOwner: PutawayTransferOwner,
  channelSync?: PutawayWakeupChannelSync | null,
  replenishment?: PutawayWakeupReplenishment | null,
  picking?: PutawayWakeupPicking | null,
  clock?: () => Date,
) {
  return new PutawayService(db, storage, transferOwner, channelSync, replenishment, picking, clock);
}
