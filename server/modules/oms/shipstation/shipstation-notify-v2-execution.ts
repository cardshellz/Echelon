import { sql } from "drizzle-orm";
import { isUnmappedOrderLine } from "@shared/unmapped-order-line";
import { omsOrderEvents } from "@shared/schema";
import { verifyRefundedChannelMerchandise } from "../application/channel-merchandise-dispatch.service";
import {
  dispatchShipmentEvent,
  recomputeOrderStatusFromShipments,
  type ShipmentEvent,
} from "../../orders/shipment-rollup-and-context.api";
import {
  clearOutboundShipmentReviewFlagByReasonInWms,
  setOutboundShipmentReviewFlagInWms,
  updateReplacementShipmentItemLocationInWms,
} from "../../wms/outbound-shipment-mutations.api";
import {
  SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON,
  isExactShipStationPhysicalShipmentReplay,
  recordShipStationUnmappedPhysicalException,
  resolveShipStationUnmappedPhysicalExceptionForExactReplay,
  resolveShipStationUnmappedPhysicalExceptionForVoidedLabel,
  shipStationShipmentRefFromExternalFulfillmentId,
} from "../application/shipstation-unmapped-physical";
import type { ChannelFulfillmentAuthorityService } from "../application/channel-fulfillment-authority.service";
import {
  ReplacementInventoryUnavailableError,
  ShipmentInventoryUnavailableError,
} from "../../inventory/shipment-evidence.api";
import { parseExactPositiveWmsShipmentItems } from "../../shipping/shipstation-provider-reconciliation.api";
import {
  HISTORICAL_CUSTOMER_FULFILLMENT_INVENTORY_RULE,
  HISTORICAL_REPLACEMENT_INVENTORY_RULE,
  SHIPSTATION_SPLIT_SOURCE,
  ShipStationUnmappedItemsError,
  manualAuthorityMatchesPersistedCandidate,
  mapShipStationCarrier,
  shipStationShipmentExternalFulfillmentId,
  type ShipNotifyV2Result,
  type ShipmentAuthorityContext,
  type ShipmentPushOmsBlocker,
  type ShipStationRuntimeContext,
  type ShipStationShipment,
  type ShipStationShipmentItemOwnership,
} from "./shipstation-contracts";
import type { ShipStationNotifyPackageResolution } from "./shipstation-notify-package-resolution";

export function createShipStationNotifyV2Execution(
  ctx: ShipStationRuntimeContext,
  resolution: ShipStationNotifyPackageResolution,
) {
  const { db, inventoryCore, dependencies } = ctx;
  const {
    deriveEventFromSSShipment,
    resolveWmsShipmentForShipNotify,
    syncShipmentItemsFromShipStation,
    resolveCombinedShipmentGroupsFromShipStationItems,
  } = resolution;

  async function processMultiOrderShippedPackageBeforeSingleParentResolution(
    shipment: ShipStationShipment,
    event: Extract<ShipmentEvent, { kind: "shipped" }>,
    authorityContext: ShipmentAuthorityContext,
    ownership: ShipStationShipmentItemOwnership,
  ): Promise<ShipNotifyV2Result> {
    if (ownership.sourceIdsByOrder.size <= 1) {
      throw new Error(
        `ShipStation shipment ${shipment.shipmentId} does not span multiple WMS orders`,
      );
    }

    const shipmentGroups =
      await resolveCombinedShipmentGroupsFromShipStationItems(
        null,
        shipment,
        ownership,
      );
    const resolvedOrderIds = new Set(
      shipmentGroups.map((group) => Number(group.row?.order_id)),
    );
    const everyOwningOrderResolved =
      shipmentGroups.length === ownership.sourceIdsByOrder.size &&
      [...ownership.sourceIdsByOrder.keys()].every((orderId) =>
        resolvedOrderIds.has(orderId)
      );
    if (!everyOwningOrderResolved) {
      throw new ShipStationUnmappedItemsError(
        `ShipStation shipment ${shipment.shipmentId} spans ` +
          `${ownership.sourceIdsByOrder.size} WMS orders, but only ` +
          `${shipmentGroups.length} live shipment groups resolved`,
      );
    }

    const incomingPhysicalShipmentRef =
      shipStationShipmentRefFromExternalFulfillmentId(
        shipStationShipmentExternalFulfillmentId(shipment.shipmentId),
      );
    const incomingTracking = String(shipment.trackingNumber ?? "").trim();
    for (const group of shipmentGroups) {
      const row = group.row;
      const status = String(row.status ?? "");
      if (["returned", "lost"].includes(status)) {
        await recordShipStationUnmappedPhysicalException(db, {
          shipment,
          wmsOrderId: Number(row.order_id),
          wmsShipmentId: Number(row.id),
          blockedReason: "combined_package_resolved_to_terminal_shipment",
          currentPhysicalShipmentRef: row.external_fulfillment_id ?? null,
          currentTrackingNumber: row.tracking_number ?? null,
        });
        return { processed: false, fallback: false, handled: true };
      }
      if (status !== "shipped") {
        continue;
      }

      const currentPhysicalShipmentRef =
        shipStationShipmentRefFromExternalFulfillmentId(
          row.external_fulfillment_id,
        );
      const currentTracking = String(row.tracking_number ?? "").trim();
      const samePhysicalShipment = currentPhysicalShipmentRef !== null &&
        incomingPhysicalShipmentRef !== null &&
        currentPhysicalShipmentRef === incomingPhysicalShipmentRef;
      const safeLegacyTrackingRepair = currentPhysicalShipmentRef === null &&
        currentTracking.length > 0 &&
        incomingTracking.length > 0 &&
        currentTracking === incomingTracking;
      if (!samePhysicalShipment && !safeLegacyTrackingRepair) {
        await recordShipStationUnmappedPhysicalException(db, {
          shipment,
          wmsOrderId: Number(row.order_id),
          wmsShipmentId: Number(row.id),
          blockedReason: "distinct_combined_package_after_terminal_fulfillment",
          currentPhysicalShipmentRef: row.external_fulfillment_id ?? null,
          currentTrackingNumber: row.tracking_number ?? null,
        });
        return { processed: false, fallback: false, handled: true };
      }
    }

    console.warn(
      `[ShipStation Webhook V2] Resolving ShipStation shipment ` +
        `${shipment.shipmentId} as one physical package spanning ` +
        `${shipmentGroups.length} active WMS orders before single-order split resolution.`,
    );
    const groupResults: ShipNotifyV2Result[] = [];
    for (const group of shipmentGroups) {
      groupResults.push(
        await applyShipNotifyV2EventToResolvedShipment(
          group.row,
          shipment,
          event,
          authorityContext,
          group.sourceShipmentItemIds,
        ),
      );
    }
    return finalizeCanonicalShipNotifyPackage(
      shipment,
      event,
      groupResults,
      authorityContext,
    );
  }

  /** A customer line with no catalog identity and no variant: nothing to dispatch. */
  function isUnmappedLineWithoutStock(item: any): boolean {
    return item.shipment_purpose !== "replacement"
      && item.shipment_item_purpose === "customer_fulfillment"
      && item.product_variant_id == null
      // The order line must exist: a missing row reads as all-null, not unmapped.
      && item.order_item_id != null
      && item.order_item_row_id != null
      && isUnmappedOrderLine({
        sku: item.order_item_sku ?? null,
        catalogProductId: item.order_item_catalog_product_id ?? null,
        productId: item.order_item_product_id ?? null,
      });
  }

  async function loadValidatedInventoryShipmentItems(
    shipmentId: number,
  ): Promise<any[]> {
    const itemsResult = await db.execute(sql`
      SELECT
        osi.id,
        osi.order_item_id,
        osi.replacement_for_order_item_id,
        osi.shipment_item_purpose,
        COALESCE(osi.order_item_id, osi.replacement_for_order_item_id) AS inventory_order_item_id,
        osi.product_variant_id,
        osi.qty,
        target_shipment.shipment_purpose,
        target_shipment.source AS shipment_source,
        target_shipment.tracking_number AS shipment_tracking_number,
        target_shipment.external_fulfillment_id,
        EXISTS (
          SELECT 1
          FROM wms.reconciliation_exceptions deferred
          WHERE deferred.idempotency_key =
            ${HISTORICAL_REPLACEMENT_INVENTORY_RULE} || ':shipment-item:' || osi.id::text
            AND deferred.status IN ('open', 'acknowledged')
        ) AS historical_inventory_deferred,
        EXISTS (
          SELECT 1
          FROM wms.reconciliation_exceptions deferred_customer_inventory
          WHERE deferred_customer_inventory.idempotency_key =
            ${HISTORICAL_CUSTOMER_FULFILLMENT_INVENTORY_RULE}
              || ':shipment-item:' || osi.id::text
        ) AS historical_customer_inventory_deferred,
        target_order.warehouse_id,
        line_item.id AS order_item_row_id,
        line_item.sku AS order_item_sku,
        line_item.catalog_product_id AS order_item_catalog_product_id,
        line_item.product_id AS order_item_product_id,
        -- Pick-derived source bin: the shipment item's own bin, or the pick
        -- ledger backstop for legacy planned rows created before source-bin
        -- backfill existed.
        COALESCE(
          osi.from_location_id,
          (
            SELECT it.from_location_id
            FROM inventory.inventory_transactions it
            WHERE it.order_item_id = osi.order_item_id
              AND it.product_variant_id = osi.product_variant_id
              AND it.transaction_type = 'pick'
              AND it.from_location_id IS NOT NULL
            ORDER BY it.created_at DESC
            LIMIT 1
          )
        ) AS pick_location_id,
        -- ─── SHIP-BEFORE-PICK FALLBACK (removable once pick-before-push is
        -- enforced) ───────────────────────────────────────────────────────
        -- An order can reach ShipStation and ship before it is ever picked
        -- (the temporary pre-picking push). With no pick there is no source
        -- bin, so resolve the variant's reserved/assigned bin the SAME way
        -- reserveStock does — assigned primary bin, then any in-stock unfrozen
        -- location — and deduct from there. Mirrors
        -- server/modules/channels/reservation.service.ts (reserveStock).
        COALESCE(
          (
            SELECT pl.warehouse_location_id
            FROM warehouse.product_locations pl
            JOIN warehouse.warehouse_locations wl ON wl.id = pl.warehouse_location_id
            WHERE pl.product_variant_id = osi.product_variant_id
              AND pl.status = 'active'
              AND wl.cycle_count_freeze_id IS NULL
            ORDER BY pl.is_primary DESC
            LIMIT 1
          ),
          (
            SELECT il.warehouse_location_id
            FROM inventory.inventory_levels il
            JOIN warehouse.warehouse_locations wl ON wl.id = il.warehouse_location_id
            WHERE il.product_variant_id = osi.product_variant_id
              AND il.variant_qty > 0
              AND wl.cycle_count_freeze_id IS NULL
            ORDER BY il.variant_qty DESC
            LIMIT 1
          )
        ) AS reserved_location_id
        -- ─── END SHIP-BEFORE-PICK FALLBACK ────────────────────────────────
      FROM wms.outbound_shipment_items osi
      JOIN wms.outbound_shipments target_shipment
        ON target_shipment.id = osi.shipment_id
      JOIN wms.orders target_order
        ON target_order.id = target_shipment.order_id
      LEFT JOIN wms.order_items line_item
        ON line_item.id = osi.order_item_id
      WHERE osi.shipment_id = ${shipmentId}
        AND osi.qty > 0
        -- An omission correction points back to inventory already consumed by
        -- the original customer-fulfillment package. It is physical package
        -- evidence only and must never post a second inventory movement.
        AND osi.shipment_item_purpose <> 'omission_correction'
    `);
    const stockRows: any[] = [];
    for (const item of itemsResult.rows as any[]) {
      if (!isUnmappedLineWithoutStock(item)) {
        stockRows.push(item);
        continue;
      }
      // Since #1657 a line with no catalog identity is confirmed at pick, never
      // claimed or picked from stock, so shipping it moves no stock either. Its
      // variant-less row used to send the whole package to review for good, so
      // a package like #63721's could never post its mapped lines. Judged now,
      // not at pick: a line mapped since then still fails closed below.
      console.log(JSON.stringify({
        level: "info", component: "shipstation", action: "ship_unmapped_line", outcome: "no_stock_movement",
        shipmentId, shipmentItemId: Number(item.id), orderItemId: Number(item.order_item_id),
        sku: item.order_item_sku ?? null, qty: Number(item.qty),
      }));
    }
    const rows = stockRows.map((item) => {
      const pickLoc = item.pick_location_id ?? null;
      const reservedLoc = item.reserved_location_id ?? null;
      const fromLoc = pickLoc ?? reservedLoc;
      return {
        ...item,
        from_location_id: fromLoc,
        // Never picked: the location came from the reserved-bin fallback, not a
        // pick. Drives on-hand-only deduction in recordShipment.
        ship_before_pick:
          item.shipment_purpose !== "replacement" &&
          pickLoc == null &&
          fromLoc != null,
      };
    });
    const invalidItems = rows.filter((item) =>
      !item.product_variant_id ||
      !Number.isInteger(Number(item.qty)) ||
      Number(item.qty) <= 0
    );
    if (invalidItems.length > 0) {
      await setOutboundShipmentReviewFlagInWms(
        db,
        shipmentId,
        "inventory_deduction_missing_item_data",
      );
      const message = `Shipment ${shipmentId} has ${invalidItems.length} inventory source item(s) without a product variant or positive quantity; fulfillment requires review.`;
      console.error(JSON.stringify({
        level: "error", component: "shipstation", code: "SHIPMENT_INVENTORY_SOURCE_INVALID",
        shipmentId, invalidItemCount: invalidItems.length, message,
      }));
      // Missing source identity is not an empty shipment or successful posting.
      // Keep the review flag, and stop before inventory posting and the later
      // physical-package materialization (earlier source synchronization remains).
      throw Object.assign(new Error(message), {
        code: "SHIPMENT_INVENTORY_SOURCE_INVALID",
        classification: "permanent",
        context: Object.freeze({ shipmentId, invalidItemCount: invalidItems.length }),
      });
    }

    // Data is complete. If this shipment was previously flagged for the
    // transient missing-data condition, clear it now — the SHIP_NOTIFY V2
    // repair cascade re-runs this path for already-shipped shipments, so a
    // replay after the catalog/bin data lands self-heals the review flag.
    await clearOutboundShipmentReviewFlagByReasonInWms(db, {
      shipmentId,
      expectedReason: "inventory_deduction_missing_item_data",
    });
    return rows;
  }

  function isHistoricalReplacementAdoption(item: any): boolean {
    return item.shipment_purpose === "replacement"
      && item.shipment_source === "shipstation_reship_adopted";
  }

  function historicalReplacementInventoryKey(shipmentItemId: number): string {
    return `${HISTORICAL_REPLACEMENT_INVENTORY_RULE}:shipment-item:${shipmentItemId}`;
  }

  async function deferHistoricalReplacementInventory(
    shipmentId: number,
    wmsOrderId: number,
    item: any,
    error: ReplacementInventoryUnavailableError,
  ): Promise<void> {
    const idempotencyKey = historicalReplacementInventoryKey(Number(item.id));
    const details = {
      wmsOrderId,
      wmsShipmentId: shipmentId,
      wmsShipmentItemId: Number(item.id),
      productVariantId: Number(item.product_variant_id),
      quantity: Number(item.qty),
      warehouseId: item.warehouse_id == null ? null : Number(item.warehouse_id),
      trackingNumber: item.shipment_tracking_number ?? null,
      externalFulfillmentId: item.external_fulfillment_id ?? null,
      shipmentSource: item.shipment_source,
      errorCode: error.code,
      errorContext: error.context ?? {},
      requiredAction: "Verify the historic inventory movement with a count or ledger reconciliation. Do not replenish or consume another order's picked stock.",
    };
    await db.execute(sql`
      INSERT INTO wms.reconciliation_exceptions (
        source, classification, rule, status, severity,
        wms_order_id, wms_shipment_id,
        external_system, external_shipment_ref,
        idempotency_key, summary, details
      )
      VALUES (
        'shipstation_manual_remediation', 'manual_review',
        ${HISTORICAL_REPLACEMENT_INVENTORY_RULE}, 'open', 'review',
        ${wmsOrderId}, ${shipmentId},
        'shipstation', ${item.external_fulfillment_id ?? null},
        ${idempotencyKey},
        ${`Provider-confirmed replacement package was shipped, but current inventory cannot prove the replacement debit for variant ${item.product_variant_id}.`},
        ${JSON.stringify(details)}::jsonb
      )
      ON CONFLICT (idempotency_key)
        WHERE status IN ('open', 'acknowledged')
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW(),
        occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
        details = wms.reconciliation_exceptions.details || EXCLUDED.details
    `);
    await setOutboundShipmentReviewFlagInWms(
      db,
      shipmentId,
      HISTORICAL_REPLACEMENT_INVENTORY_RULE,
    );
    console.warn(JSON.stringify({
      level: "warn",
      component: "shipstation",
      code: "HISTORICAL_REPLACEMENT_INVENTORY_DEFERRED",
      wmsShipmentId: shipmentId,
      wmsShipmentItemId: Number(item.id),
      wmsOrderId,
      productVariantId: Number(item.product_variant_id),
      quantity: Number(item.qty),
      warehouseId: item.warehouse_id ?? null,
      message: error.message,
    }));
  }

  function historicalCustomerFulfillmentInventoryKey(shipmentItemId: number): string {
    return `${HISTORICAL_CUSTOMER_FULFILLMENT_INVENTORY_RULE}:shipment-item:${shipmentItemId}`;
  }

  function isShipmentInventoryUnavailable(error: unknown): boolean {
    if (error instanceof ShipmentInventoryUnavailableError) return true;
    if (error === null || typeof error !== "object") return false;
    const candidate = error as {
      code?: unknown;
      context?: { reason?: unknown };
    };
    return candidate.code === "DATA_INTEGRITY_VIOLATION"
      && candidate.context?.reason === "shipment_inventory_unavailable";
  }

  function mayDeferHistoricalCustomerFulfillmentInventory(
    item: any,
    inventoryItemCount: number,
    authorityContext: ShipmentAuthorityContext,
    error: unknown,
  ): boolean {
    return inventoryItemCount === 1
      && item.shipment_purpose === "customer_fulfillment"
      && item.shipment_item_purpose === "customer_fulfillment"
      && authorityContext.source === "carrier_tracking_confirmed_dispatch"
      && authorityContext.carrierTrackingEventId !== null
      && authorityContext.carrierDispatchCommandId !== null
      && authorityContext.shippingProviderLabelId !== null
      && authorityContext.providerLabelId !== null
      && authorityContext.dispatchOccurredAt !== null
      && authorityContext.reviewedRepair?.repairCohort ===
        "confirmed_historical_inventory_gap"
      && isShipmentInventoryUnavailable(error);
  }

  async function deferHistoricalCustomerFulfillmentInventory(
    shipmentId: number,
    wmsOrderId: number,
    item: any,
    authorityContext: ShipmentAuthorityContext,
    error: unknown,
  ): Promise<void> {
    const reviewedRepair = authorityContext.reviewedRepair;
    if (!reviewedRepair) {
      throw new Error("Historical customer-fulfillment repair authorization is missing");
    }
    const errorRecord = error && typeof error === "object"
      ? error as { code?: unknown; message?: unknown; context?: unknown }
      : {};
    const errorMessage = error instanceof Error
      ? error.message
      : typeof errorRecord.message === "string"
        ? errorRecord.message
        : String(error);
    const idempotencyKey = historicalCustomerFulfillmentInventoryKey(Number(item.id));
    const details = {
      wmsOrderId,
      wmsShipmentId: shipmentId,
      wmsShipmentItemId: Number(item.id),
      wmsOrderItemId: item.inventory_order_item_id == null
        ? null
        : Number(item.inventory_order_item_id),
      productVariantId: Number(item.product_variant_id),
      quantity: Number(item.qty),
      warehouseId: item.warehouse_id == null ? null : Number(item.warehouse_id),
      warehouseLocationId: item.from_location_id == null
        ? null
        : Number(item.from_location_id),
      trackingNumber: item.shipment_tracking_number ?? null,
      externalFulfillmentId: item.external_fulfillment_id ?? null,
      carrierTrackingEventId: authorityContext.carrierTrackingEventId,
      carrierDispatchCommandId: authorityContext.carrierDispatchCommandId,
      shippingProviderLabelId: authorityContext.shippingProviderLabelId,
      providerLabelId: authorityContext.providerLabelId,
      dispatchOccurredAt: authorityContext.dispatchOccurredAt?.toISOString() ?? null,
      reviewedRepair: {
        requeueId: reviewedRepair.requeueId,
        repairCohort: reviewedRepair.repairCohort,
        operator: reviewedRepair.operator,
        reason: reviewedRepair.reason,
        idempotencyKey: reviewedRepair.idempotencyKey,
        requeuedAt: reviewedRepair.requeuedAt.toISOString(),
      },
      inventoryError: {
        code: typeof errorRecord.code === "string" ? errorRecord.code : null,
        message: errorMessage,
        context: errorRecord.context ?? null,
      },
      requiredAction:
        "Preserve the confirmed historical fulfillment without debiting current inventory. " +
        "Do not invent a negative balance or consume stock received after the shipment.",
    };
    await db.execute(sql`
      INSERT INTO wms.reconciliation_exceptions (
        source, classification, rule, status, severity,
        wms_order_id, wms_shipment_id,
        external_system, external_shipment_ref,
        idempotency_key, summary, details
      )
      VALUES (
        'carrier_tracking_confirmed_dispatch', 'historical_ignore',
        ${HISTORICAL_CUSTOMER_FULFILLMENT_INVENTORY_RULE},
        'acknowledged', 'info',
        ${wmsOrderId}, ${shipmentId},
        'shipstation', ${authorityContext.providerLabelId},
        ${idempotencyKey},
        ${`Reviewed carrier-confirmed historical fulfillment was accepted without a current inventory debit for variant ${item.product_variant_id}.`},
        ${JSON.stringify(details)}::jsonb
      )
      ON CONFLICT (idempotency_key)
        WHERE status IN ('open', 'acknowledged')
      DO UPDATE SET
        last_seen_at = NOW(),
        updated_at = NOW(),
        occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
        details = wms.reconciliation_exceptions.details || EXCLUDED.details
    `);
    console.warn(JSON.stringify({
      level: "warn",
      component: "shipstation",
      code: "HISTORICAL_CUSTOMER_FULFILLMENT_INVENTORY_DEFERRED",
      wmsShipmentId: shipmentId,
      wmsShipmentItemId: Number(item.id),
      wmsOrderId,
      productVariantId: Number(item.product_variant_id),
      quantity: Number(item.qty),
      carrierDispatchCommandId: authorityContext.carrierDispatchCommandId,
      repairRequeueId: reviewedRepair.requeueId,
      message: errorMessage,
    }));
  }

  async function recordInventoryForShipment(
    shipmentId: number,
    wmsOrderId: number,
    items: any[],
    authorityContext: ShipmentAuthorityContext,
  ): Promise<void> {
    if (!inventoryCore || items.length === 0) {
      return;
    }
    try {
      for (const item of items) {
        if (item.shipment_purpose === "replacement") {
          if (
            isHistoricalReplacementAdoption(item)
            && item.historical_inventory_deferred === true
          ) {
            continue;
          }
          try {
            const recorded = await inventoryCore.recordReplacementShipmentFromAvailableInventory({
              productVariantId: item.product_variant_id,
              qty: item.qty,
              warehouseId: item.warehouse_id ?? null,
              orderId: wmsOrderId,
              orderItemId: item.inventory_order_item_id ?? item.order_item_id ?? null,
              shipmentId,
              shipmentItemId: item.id,
              userId: "system:shipstation:v2",
            });
            // Canonical operational receipts own their actual allocated bin.
            // Keep the old source hint immutable; only the legacy owner projects it.
            if (!recorded.preserveSourceLocation) {
              await updateReplacementShipmentItemLocationInWms(db, {
                shipmentItemId: Number(item.id),
                warehouseLocationId: recorded.warehouseLocationId,
              });
            }
            console.log(
              `[ShipStation Webhook V2] Recorded replacement shipment for variant ${item.product_variant_id} ` +
              `qty ${item.qty} from location ${recorded.warehouseLocationId} (wmsOrder ${wmsOrderId})`,
            );
          } catch (error: any) {
            if (
              isHistoricalReplacementAdoption(item)
              && (error instanceof ReplacementInventoryUnavailableError
                || error?.code === "REPLACEMENT_INVENTORY_UNAVAILABLE")
            ) {
              await deferHistoricalReplacementInventory(shipmentId, wmsOrderId, item, error);
              continue;
            }
            throw error;
          }
          continue;
        }
        if (item.historical_customer_inventory_deferred === true) continue;
        try {
          await inventoryCore.recordShipment({
            productVariantId: item.product_variant_id,
            // Legacy hints are not canonical source authority. An absent bin is
            // resolved (or explicitly rejected) by the authority-aware recorder.
            warehouseLocationId: item.from_location_id ?? null,
            qty: item.qty,
            orderId: wmsOrderId,
            orderItemId: item.inventory_order_item_id ?? item.order_item_id,
            shipmentId: String(shipmentId),
            shipmentItemId: item.id,
            userId: "system:shipstation:v2",
            // SHIP-BEFORE-PICK FALLBACK: never-picked items have no picked pool.
            deductFromOnHandOnly: item.ship_before_pick === true,
            releaseReservation: item.shipment_item_purpose !== "concession",
          });
        } catch (error) {
          if (
            mayDeferHistoricalCustomerFulfillmentInventory(
              item,
              items.length,
              authorityContext,
              error,
            )
          ) {
            await deferHistoricalCustomerFulfillmentInventory(
              shipmentId,
              wmsOrderId,
              item,
              authorityContext,
              error,
            );
            continue;
          }
          throw error;
        }
        console.log(`[ShipStation Webhook V2] Recorded shipment for variant ${item.product_variant_id} qty ${item.qty} (wmsOrder ${wmsOrderId})`);
      }
    } catch (invErr: any) {
      console.error(`[ShipStation Webhook V2] Inventory deduction failed for shipment ${shipmentId}: ${invErr.message}`);
      throw invErr;
    }
  }

  async function getOmsFinalOrderBlockerForShipmentPush(
    omsFulfillmentOrderId: string | null | undefined,
    verifiedRefundMerchandise = false,
  ): Promise<ShipmentPushOmsBlocker> {
    if (!omsFulfillmentOrderId || !/^[1-9][0-9]*$/.test(omsFulfillmentOrderId)) {
      return {
        blocked: false,
        reason: null,
        status: null,
        fulfillmentStatus: null,
        financialStatus: null,
      };
    }

    const result: any = await db.execute(sql`
      SELECT status, fulfillment_status, financial_status, channel_id
      FROM oms.oms_orders
      WHERE id = ${Number(omsFulfillmentOrderId)}
      LIMIT 1
    `);
    const row = result?.rows?.[0] ?? {};
    const status = String(row.status ?? "").toLowerCase();
    const fulfillmentStatus = String(row.fulfillment_status ?? "").toLowerCase();
    const financialStatus = String(row.financial_status ?? "").toLowerCase();

    if (status === "cancelled") {
      return {
        blocked: true,
        reason: "oms_cancelled",
        status,
        fulfillmentStatus: fulfillmentStatus || null,
        financialStatus: financialStatus || null,
      };
    }

    if (financialStatus === "refunded" && status !== "refunded" && !verifiedRefundMerchandise)
      verifiedRefundMerchandise = await verifyRefundedChannelMerchandise(db, Number(omsFulfillmentOrderId), "dispatch",
        { usesChannelMerchandise: dependencies.useChannelMerchandise, readSnapshot: dependencies.readChannelMerchandise });
    if (status === "refunded" || (financialStatus === "refunded" && !verifiedRefundMerchandise) || financialStatus === "voided") {
      return {
        blocked: true,
        reason: "oms_refunded",
        status: status || null,
        fulfillmentStatus: fulfillmentStatus || null,
        financialStatus: financialStatus || null,
      };
    }

    if (status === "shipped" && fulfillmentStatus === "fulfilled") {
      return {
        blocked: true,
        reason: "oms_fully_shipped",
        status,
        fulfillmentStatus,
        financialStatus: financialStatus || null,
      };
    }

    return {
      blocked: false,
      reason: null,
      status: status || null,
      fulfillmentStatus: fulfillmentStatus || null,
      financialStatus: financialStatus || null,
    };
  }

  async function getOmsFinalOrderBlockerForShipNotify(
    omsOrderId: number,
  ): Promise<{
    blocked: boolean;
    reason: "shipstation_shipped_after_cancel" | "shipstation_shipped_after_refund" | null;
    status: string | null;
    financialStatus: string | null;
  }> {
    const result: any = await db.execute(sql`
      SELECT status, financial_status, channel_id
      FROM oms.oms_orders
      WHERE id = ${omsOrderId}
      LIMIT 1
    `);
    const row = result?.rows?.[0] ?? {};
    const status = String(row.status ?? "").toLowerCase();
    const financialStatus = String(row.financial_status ?? "").toLowerCase();

    if (status === "cancelled" || status === "refunded") {
      return {
        blocked: true,
        reason: "shipstation_shipped_after_cancel",
        status,
        financialStatus: financialStatus || null,
      };
    }

    const verifiedRefundMerchandise = financialStatus === "refunded"
      && await verifyRefundedChannelMerchandise(db, omsOrderId, "observation",
        { usesChannelMerchandise: dependencies.useChannelMerchandise, readSnapshot: dependencies.readChannelMerchandise });
    if ((financialStatus === "refunded" && !verifiedRefundMerchandise) || financialStatus === "voided") {
      return {
        blocked: true,
        reason: "shipstation_shipped_after_refund",
        status: status || null,
        financialStatus,
      };
    }

    return {
      blocked: false,
      reason: null,
      status: status || null,
      financialStatus: financialStatus || null,
    };
  }

  async function markShipmentShippedAfterFinalOrderReview(
    shipmentId: number,
    omsOrderId: number,
    event: ShipmentEvent & { kind: "shipped" },
    finality: Awaited<ReturnType<typeof getOmsFinalOrderBlockerForShipNotify>>,
  ): Promise<void> {
    const reason = finality.reason ?? "shipstation_shipped_after_cancel";
    await setOutboundShipmentReviewFlagInWms(db, shipmentId, reason);

    await db.insert(omsOrderEvents).values({
      orderId: omsOrderId,
      eventType: "shipstation_shipped_after_final_order",
      details: {
        shipmentId,
        trackingNumber: event.trackingNumber,
        carrier: event.carrier,
        omsStatus: finality.status,
        financialStatus: finality.financialStatus,
        reason,
      },
    });

    console.error(
      `[ShipStation Webhook V2] Shipment ${shipmentId} shipped after OMS order ${omsOrderId} was final (${finality.status}/${finality.financialStatus}); OMS/channel fulfillment update suppressed`,
    );
  }

  async function resolveOmsOrderIdForWmsOrder(
    wmsOrderId: number,
    shipmentId: number,
  ): Promise<number | null> {
    const orderResult: any = await db.execute(sql`
      SELECT oms_fulfillment_order_id
      FROM wms.orders
      WHERE id = ${wmsOrderId}
      LIMIT 1
    `);
    const omsPointer = orderResult?.rows?.[0]?.oms_fulfillment_order_id;
    if (!omsPointer) {
      console.warn(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} has no oms_fulfillment_order_id - canonical fulfillment authority cannot resolve the OMS order (shipment=${shipmentId})`,
      );
      return null;
    }

    const omsOrderId = parseInt(String(omsPointer), 10);
    if (!Number.isInteger(omsOrderId) || omsOrderId <= 0) {
      console.warn(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} has non-numeric oms_fulfillment_order_id=${omsPointer} (shipment=${shipmentId})`,
      );
      return null;
    }
    return omsOrderId;
  }

  function requireFulfillmentAuthority(): ChannelFulfillmentAuthorityService {
    const authority = dependencies.fulfillmentAuthority;
    if (
      !authority
      || typeof authority.recordPhysicalPackage !== "function"
      || typeof authority.ensureLegacyShipment !== "function"
      || typeof authority.projectPhysicalPackage !== "function"
      || typeof authority.runDueBatch !== "function"
    ) {
      throw Object.assign(
        new Error("Canonical channel fulfillment authority is not initialized"),
        { code: "CHANNEL_FULFILLMENT_AUTHORITY_UNAVAILABLE" },
      );
    }
    return authority as ChannelFulfillmentAuthorityService;
  }

  async function finalizeCanonicalShipNotifyPackage(
    shipment: ShipStationShipment,
    event: Extract<ShipmentEvent, { kind: "shipped" }>,
    results: readonly ShipNotifyV2Result[],
    authorityContext: ShipmentAuthorityContext,
  ): Promise<ShipNotifyV2Result> {
    const legacyWmsShipmentIds = [...new Set(
      results.flatMap((result) => result.legacyWmsShipmentIds ?? []),
    )].sort((left, right) => left - right);
    const processed = results.some((result) => result.processed);
    if (legacyWmsShipmentIds.length === 0) {
      return { processed, fallback: false, handled: true };
    }

    const authorityResult = await requireFulfillmentAuthority().recordPhysicalPackage({
      legacyWmsShipmentIds,
      shippingProvider: "shipstation",
      providerPhysicalShipmentId: String(shipment.shipmentId),
      providerOrderId: String(shipment.orderId),
      providerOrderKey: shipment.orderKey?.trim() || null,
      trackingNumber: event.trackingNumber,
      carrier: event.carrier,
      trackingUrl: event.trackingUrl ?? null,
      serviceCode: event.serviceCode ?? null,
      shippedAt: authorityContext.dispatchOccurredAt ?? event.shipDate,
      source: authorityContext.source,
      correlationId: authorityContext.carrierTrackingEventId === null
        ? `shipstation-shipment:${shipment.shipmentId}`
        : `carrier-tracking-event:${authorityContext.carrierTrackingEventId}`,
      causationId: authorityContext.carrierDispatchCommandId === null
        ? `manual:${authorityContext.actor}:${authorityContext.reason}`
        : `carrier-dispatch-command:${authorityContext.carrierDispatchCommandId}`,
      // The V2 path has already resolved exact provider shipment-item keys.
      // Legacy outbound-shipment headers are aggregate projections and can
      // legitimately retain another package's order/tracking identity after
      // a split or combined shipment.
      legacyHeaderPolicy: "aggregate_projection",
    }, { executeImmediately: false });
    console.log(JSON.stringify({
      code: "SHIPSTATION_PHYSICAL_PACKAGE_MATERIALIZED",
      shipstationShipmentId: shipment.shipmentId,
      physicalShipmentId: authorityResult.materialized.physicalShipmentId,
      legacyWmsShipmentIds,
      channelCommandIds: authorityResult.materialized.channelCommands.map((command) => command.id),
      dispatch: authorityResult.dispatch,
      authoritySource: authorityContext.source,
      authorityActor: authorityContext.actor,
      authorityReason: authorityContext.reason,
      carrierTrackingEventId: authorityContext.carrierTrackingEventId,
      carrierDispatchCommandId: authorityContext.carrierDispatchCommandId,
    }));

    return {
      processed,
      fallback: false,
      handled: true,
      legacyWmsShipmentIds: Object.freeze(legacyWmsShipmentIds),
    };
  }

  /**
   * V2 per-shipment handler. `handled=true` distinguishes a matched no-op or
   * a deliberately quarantined event from a genuine no-match.
   *   - `fallback=true` means the shipment was NOT found by
   *     `shipstation_order_id` — the caller should retry via the
   *     legacy orderKey path.
   *   - `processed=true` means at least one cascade step ran.
   *   - `handled=true` means the event was matched, ignored, or quarantined
   *     and must not fall through to generic no-match handling.
   */
  async function processShipNotifyV2(
    shipment: ShipStationShipment,
    authorityContext: ShipmentAuthorityContext,
  ): Promise<ShipNotifyV2Result> {
    const carrier = mapShipStationCarrier(shipment.carrierCode);
    const event = deriveEventFromSSShipment(shipment, carrier);
    if (!event) {
      console.log(
        `[ShipStation Webhook V2] No actionable event for ShipStation shipment ${shipment.shipmentId ?? "unknown"} (SS order ${shipment.orderId ?? "unknown"}) - skipping`,
      );
      return { processed: false, fallback: false, handled: true };
    }

    if (event.kind === "voided") {
      try {
        await resolveShipStationUnmappedPhysicalExceptionForVoidedLabel(db, {
          shipment,
          resolvedBy: "system:shipstation_webhook",
        });
      } catch (exceptionErr: any) {
        console.error(
          `[ShipStation Webhook V2] Could not resolve the prior unmapped-package ` +
          `exception for voided provider shipment ${shipment.shipmentId}: ` +
          `${exceptionErr?.message ?? String(exceptionErr)}`,
        );
      }
    }


    const resolved = await resolveWmsShipmentForShipNotify(
      shipment,
      authorityContext.contentsAuthority?.source === "manual_remediation"
        ? authorityContext.contentsAuthority.candidateShipmentId
        : null,
    );
    if (event.kind === "shipped" && resolved.combinedOwnership) {
      return processMultiOrderShippedPackageBeforeSingleParentResolution(
        shipment,
        event,
        authorityContext,
        resolved.combinedOwnership,
      );
    }
    const wmsShipmentRow: any = resolved.row;
    if (!wmsShipmentRow) {
      // The orderKey resolved to no LIVE shipment (fallback === false means we
      // matched an orderKey but its shipment was cancelled/voided with no
      // active sibling — never a pre-cutover miss). A common cause is
      // ShipStation "Combine Orders": it merges two of our orders into ONE
      // label under the surviving order and destroys the other SS order (its
      // id later 404s), and our shipment for the merged/primary order can end
      // up cancelled. For a *shipped* notify we can still recover by mapping
      // the SHIP_NOTIFY's shipmentItems back to the owning WMS order(s) and
      // shipping each — so combined/merged shipments still flow tracking + the
      // marketplace fulfillment push instead of being dropped as unresolved.
      if (event.kind === "shipped" && !resolved.fallback && !resolved.handled) {
        const recoveredGroups = (
          await resolveCombinedShipmentGroupsFromShipStationItems(null, shipment)
        ).filter((group) => group.row);
        if (recoveredGroups.length > 0) {
          console.warn(
            `[ShipStation Webhook V2] orderKey ${shipment.orderKey} (SS order ${shipment.orderId}) resolved to no live shipment; ` +
              `recovered ${recoveredGroups.length} order shipment(s) from shipment items (combined/merged shipment).`,
          );
          const groupResults: ShipNotifyV2Result[] = [];
          for (const group of recoveredGroups) {
            const result = await applyShipNotifyV2EventToResolvedShipment(
              group.row,
              shipment,
              event,
              authorityContext,
              group.sourceShipmentItemIds,
            );
            groupResults.push(result);
          }
          return finalizeCanonicalShipNotifyPackage(
            shipment,
            event,
            groupResults,
            authorityContext,
          );
        }
      }
      // Pre-cutover order (pushed via pushOrder, no shipstation_order_id on
      // outbound_shipments) or genuinely unknown — fall back to the legacy
      // orderKey path.
      return {
        processed: false,
        fallback: resolved.fallback,
        handled: resolved.handled,
      };
    }

    const currentPhysicalShipmentRef =
      shipStationShipmentRefFromExternalFulfillmentId(
        wmsShipmentRow.external_fulfillment_id,
      );
    const incomingPhysicalShipmentRef =
      shipStationShipmentRefFromExternalFulfillmentId(
        shipStationShipmentExternalFulfillmentId(shipment.shipmentId),
      );
    const currentTracking = String(wmsShipmentRow.tracking_number ?? "").trim();
    const incomingTracking = String(shipment.trackingNumber ?? "").trim();
    const currentWmsShipmentStatus = String(wmsShipmentRow.status ?? "");
    const samePhysicalShipment = currentPhysicalShipmentRef !== null &&
      incomingPhysicalShipmentRef !== null &&
      currentPhysicalShipmentRef === incomingPhysicalShipmentRef;
    const safeLegacyTrackingRepair = currentPhysicalShipmentRef === null &&
      currentTracking.length > 0 &&
      incomingTracking.length > 0 &&
      currentTracking === incomingTracking;
    if (
      event.kind === "shipped" &&
      !resolved.matchedByPhysicalIdentity &&
      ["shipped", "returned", "lost"].includes(currentWmsShipmentStatus) &&
      !samePhysicalShipment &&
      !safeLegacyTrackingRepair
    ) {
      await recordShipStationUnmappedPhysicalException(db, {
        shipment,
        wmsOrderId: Number(wmsShipmentRow.order_id),
        wmsShipmentId: Number(wmsShipmentRow.id),
        blockedReason: "distinct_physical_shipment_resolved_by_order_identity",
        currentPhysicalShipmentRef: wmsShipmentRow.external_fulfillment_id ?? null,
        currentTrackingNumber: wmsShipmentRow.tracking_number ?? null,
      });
      return { processed: false, fallback: false, handled: true };
    }

    if (
      event.kind === "shipped" &&
      ["returned", "lost"].includes(currentWmsShipmentStatus)
    ) {
      console.warn(
        `[ShipStation Webhook V2] Ignored late shipped replay for ` +
          `${currentWmsShipmentStatus} WMS shipment ${wmsShipmentRow.id}.`,
      );
      return { processed: false, fallback: false, handled: true };
    }

    const compatibilityReason = String(wmsShipmentRow.review_reason ?? "");
    const isHistoricalUnmappedCompatibilityRow =
      String(wmsShipmentRow.source ?? "") === SHIPSTATION_SPLIT_SOURCE &&
      compatibilityReason === SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON;
    if (
      event.kind === "shipped" &&
      isHistoricalUnmappedCompatibilityRow
    ) {
      if (compatibilityReason === SHIPSTATION_LEGACY_UNMAPPED_SPLIT_REASON) {
        await recordShipStationUnmappedPhysicalException(db, {
          shipment,
          wmsOrderId: Number(wmsShipmentRow.order_id),
          wmsShipmentId: Number(wmsShipmentRow.id),
          blockedReason: "historical_zero_item_split_replay",
          currentPhysicalShipmentRef: wmsShipmentRow.external_fulfillment_id ?? null,
          currentTrackingNumber: wmsShipmentRow.tracking_number ?? null,
        });
      }
      console.warn(
        `[ShipStation Webhook V2] Ignored fulfillment replay for historical ` +
          `ShipStation compatibility shipment ${wmsShipmentRow.id}.`,
      );
      return { processed: false, fallback: false, handled: true };
    }

    if (event.kind === "shipped") {
      const shipmentGroups =
        await resolveCombinedShipmentGroupsFromShipStationItems(
          wmsShipmentRow,
          shipment,
        );
      if (shipmentGroups.length > 1) {
        const groupResults: ShipNotifyV2Result[] = [];
        for (const group of shipmentGroups) {
          const result = await applyShipNotifyV2EventToResolvedShipment(
            group.row,
            shipment,
            event,
            authorityContext,
            group.sourceShipmentItemIds,
          );
          groupResults.push(result);
        }
        return finalizeCanonicalShipNotifyPackage(
          shipment,
          event,
          groupResults,
          authorityContext,
        );
      }
      const [singleGroup] = shipmentGroups;
      const result = await applyShipNotifyV2EventToResolvedShipment(
        singleGroup?.row ?? wmsShipmentRow,
        shipment,
        event,
        authorityContext,
        singleGroup?.sourceShipmentItemIds,
      );
      return finalizeCanonicalShipNotifyPackage(
        shipment,
        event,
        [result],
        authorityContext,
      );
    }

    return applyShipNotifyV2EventToResolvedShipment(
      wmsShipmentRow,
      shipment,
      event,
      authorityContext,
      undefined,
    );
  }

  function hasAuthoritativeProviderItems(shipment: ShipStationShipment): boolean {
    return parseExactPositiveWmsShipmentItems(shipment.shipmentItems) !== null;
  }

  async function providerItemsExactlyMatchCustomerShipment(
    shipmentId: number,
    shipment: ShipStationShipment,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(shipmentId) || shipmentId <= 0) return false;
    const providerItems = parseExactPositiveWmsShipmentItems(
      shipment.shipmentItems,
    );
    if (!providerItems) return false;
    const result: any = await db.execute(sql`
      SELECT shipment_item.id, shipment_item.qty
      FROM wms.outbound_shipment_items AS shipment_item
      WHERE shipment_item.shipment_id = ${shipmentId}
        AND shipment_item.order_item_id IS NOT NULL
        AND shipment_item.qty > 0
        AND COALESCE(
          shipment_item.shipment_item_purpose,
          'customer_fulfillment'
        ) = 'customer_fulfillment'
      ORDER BY shipment_item.id
    `);
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const wmsItems = parseExactPositiveWmsShipmentItems(
      rows.map((row: any) => ({
        lineItemKey: `wms-item-${String(row.id)}`,
        quantity: row.qty,
      })),
    );
    return wmsItems !== null
      && wmsItems.length === providerItems.length
      && wmsItems.every((item, index) =>
        item.sourceShipmentItemId === providerItems[index]?.sourceShipmentItemId
        && item.quantity === providerItems[index]?.quantity
      );
  }
  async function applyShipNotifyV2EventToResolvedShipment(
    wmsShipmentRow: any,
    shipment: ShipStationShipment,
    event: ShipmentEvent,
    authorityContext: ShipmentAuthorityContext,
    allowedSourceShipmentItemIds?: Set<number>,
  ): Promise<ShipNotifyV2Result> {
    const shipmentPurpose = String(
      wmsShipmentRow.shipment_purpose ?? "customer_fulfillment",
    );
    const isCustomerFulfillmentShipment =
      shipmentPurpose === "customer_fulfillment";
    const isReplacementShipment = shipmentPurpose === "replacement";
    const exactPhysicalIdentityReplay = isCustomerFulfillmentShipment
      && event.kind === "shipped"
      && isExactShipStationPhysicalShipmentReplay({
        shipment,
        currentPhysicalShipmentRef: wmsShipmentRow.external_fulfillment_id,
        currentTrackingNumber: wmsShipmentRow.tracking_number,
      });
    const exactPhysicalShipmentReplay = exactPhysicalIdentityReplay
      && await providerItemsExactlyMatchCustomerShipment(
        Number(wmsShipmentRow.id),
        shipment,
      );

    if (exactPhysicalShipmentReplay) {
      const exceptionResolved =
        await resolveShipStationUnmappedPhysicalExceptionForExactReplay(db, {
          shipment,
          wmsOrderId: Number(wmsShipmentRow.order_id),
          wmsShipmentId: Number(wmsShipmentRow.id),
          currentPhysicalShipmentRef: wmsShipmentRow.external_fulfillment_id,
          currentTrackingNumber: wmsShipmentRow.tracking_number,
          resolvedBy: authorityContext.actor,
        });
      console.log(
        `[ShipStation Webhook V2] Exact physical shipment replay ` +
          `${shipment.shipmentId} matched WMS shipment ${wmsShipmentRow.id}; ` +
          `provider line remapping skipped, exceptionResolved=${exceptionResolved}.`,
      );
    }

    if (
      event.kind === "shipped"
      && !exactPhysicalShipmentReplay
      && !isReplacementShipment
    ) {
      try {
        const isUnmappedProviderFirstShell =
          String(wmsShipmentRow.source ?? "") === SHIPSTATION_SPLIT_SOURCE
          && wmsShipmentRow.requires_review === true;
        if (
          isUnmappedProviderFirstShell
          && !hasAuthoritativeProviderItems(shipment)
        ) {
          throw new ShipStationUnmappedItemsError(
            "shipstation_package_contents_missing: ShipStation shipment "
              + shipment.shipmentId
              + " has no positive package-item evidence",
          );
        }
        await syncShipmentItemsFromShipStation(
          wmsShipmentRow.id,
          shipment,
          allowedSourceShipmentItemIds,
        );
      } catch (error) {
        if (!(error instanceof ShipStationUnmappedItemsError)) throw error;
        await recordShipStationUnmappedPhysicalException(db, {
          shipment,
          wmsOrderId: Number(wmsShipmentRow.order_id),
          wmsShipmentId: Number(wmsShipmentRow.id),
          blockedReason: "shipment_items_missing_authoritative_wms_line_keys",
          currentPhysicalShipmentRef: wmsShipmentRow.external_fulfillment_id ?? null,
          currentTrackingNumber: wmsShipmentRow.tracking_number ?? null,
        });
        console.warn(
          `[ShipStation Webhook V2] Shipment ${shipment.shipmentId} was quarantined ` +
            `because its items could not be mapped authoritatively.`,
        );
        return { processed: false, fallback: false, handled: true };
      }
    }
    if (event.kind === "shipped" && isReplacementShipment) {
      if (authorityContext.contentsAuthority?.source !== "manual_remediation") {
        throw new ShipStationUnmappedItemsError(
          "Replacement fulfillment requires explicit reviewed local package contents",
        );
      }
      const candidateShipmentId = Number(wmsShipmentRow.id);
      if (
        candidateShipmentId !== authorityContext.contentsAuthority.candidateShipmentId
        || !await manualAuthorityMatchesPersistedCandidate(
          db,
          shipment,
          authorityContext.contentsAuthority,
        )
      ) {
        throw new ShipStationUnmappedItemsError(
          "Manual remediation contents no longer match the complete persisted replacement package",
        );
      }
    }

    const inventoryItemsToRecord = event.kind === "shipped" && inventoryCore
      ? await loadValidatedInventoryShipmentItems(wmsShipmentRow.id)
      : [];

    const { wmsOrderId, changed } = await dispatchShipmentEvent(
      db,
      wmsShipmentRow.id,
      event,
    );
    if (!changed && event.kind !== "shipped") {
      console.log(
        `[ShipStation Webhook V2] Shipment ${wmsShipmentRow.id} already in target state - no-op`,
      );
      return { processed: false, fallback: false, handled: true };
    }
    if (!changed) {
      console.log(
        `[ShipStation Webhook V2] Shipment ${wmsShipmentRow.id} already shipped - running repair cascade`,
      );
    }

    // Roll up order-level warehouse_status from ALL shipments. This is
    // the fix for the single-shipment-flips-whole-order bug: the order
    // status is now derived from the full shipment set. Shipped replays
    // also run this cascade because the original attempt may have died
    // after WMS shipment state changed but before OMS/Shopify were updated.
    // Cancellation and void remain operational WMS facts. Shipped quantities
    // are projected later from the immutable physical package; invoking the
    // legacy broad rollup here would create a second fulfillment writer.
    if (event.kind !== "shipped" && changed) {
      const rollup = await recomputeOrderStatusFromShipments(db, wmsOrderId);
      console.log(
        `[ShipStation Webhook V2] WMS order ${wmsOrderId} warehouse_status=${rollup.warehouseStatus} (changed=${rollup.changed})`,
      );
    }


    if (isReplacementShipment) {
      if (event.kind === "shipped" && inventoryCore) {
        await recordInventoryForShipment(
          wmsShipmentRow.id,
          wmsOrderId,
          inventoryItemsToRecord,
          authorityContext,
        );
      }
      console.log(
        `[ShipStation Webhook V2] Processed replacement shipment ${wmsShipmentRow.id} ` +
          `without changing customer fulfillment or channel state`,
      );
      return {
        processed: true,
        fallback: false,
        handled: true,
        legacyWmsShipmentIds: event.kind === "shipped"
          ? Object.freeze([Number(wmsShipmentRow.id)])
          : undefined,
      };
    }

    // Resolve the OMS pointer for final-order quarantine and audit only. The
    // canonical physical-package projector owns all OMS fulfillment fields.
    const omsOrderId = await resolveOmsOrderIdForWmsOrder(
      wmsOrderId,
      wmsShipmentRow.id,
    );
    if (omsOrderId === null) {
      // Missing OMS projection linkage is not evidence that WMS inventory was
      // posted. Exact WMS source identity is sufficient for the inventory owner
      // to authorize or reject this command; do not silently skip it here.
      if (event.kind === "shipped" && inventoryCore) {
        await recordInventoryForShipment(
          wmsShipmentRow.id,
          wmsOrderId,
          inventoryItemsToRecord,
          authorityContext,
        );
      }
      return {
        processed: true,
        fallback: false,
        handled: true,
        legacyWmsShipmentIds: event.kind === "shipped"
          ? Object.freeze([Number(wmsShipmentRow.id)])
          : undefined,
      };
    }

    if (event.kind === "shipped") {
      const finality = await getOmsFinalOrderBlockerForShipNotify(omsOrderId);
      if (finality.blocked) {
        await markShipmentShippedAfterFinalOrderReview(
          wmsShipmentRow.id,
          omsOrderId,
          event,
          finality,
        );
      }
    }

    if (changed || event.kind === "shipped") {
      await recordShipmentEventV2(omsOrderId, event, shipment, {
        wmsFirst: true,
        wmsShipmentId: wmsShipmentRow.id,
        authorityContext,
      });
    }

    if (event.kind === "shipped" && inventoryCore) {
      await recordInventoryForShipment(
        wmsShipmentRow.id,
        wmsOrderId,
        inventoryItemsToRecord,
        authorityContext,
      );
    }

    console.log(
      `[ShipStation Webhook V2] Processed shipment ${wmsShipmentRow.id} (event=${event.kind}) → OMS ${omsOrderId}`,
    );
    return {
      processed: true,
      fallback: false,
      handled: true,
      legacyWmsShipmentIds: event.kind === "shipped"
        ? Object.freeze([Number(wmsShipmentRow.id)])
        : undefined,
    };
  }

  /**
   * V2 audit event writer. Event type encodes the event kind so
   * dashboards can filter ship vs. cancel vs. void.
   */
  async function recordShipmentEventV2(
    omsOrderId: number,
    event: ShipmentEvent,
    shipment: ShipStationShipment,
    meta: {
      wmsFirst: boolean;
      wmsShipmentId: number;
      authorityContext: ShipmentAuthorityContext;
    },
  ): Promise<void> {
    const eventType =
      event.kind === "shipped"
        ? "shipped_via_shipstation"
        : event.kind === "cancelled"
          ? "cancelled_via_shipstation"
          : "voided_via_shipstation";

    const details: Record<string, unknown> = {
      shipmentId: shipment.shipmentId,
      wmsShipmentId: meta.wmsShipmentId,
      carrierCode: shipment.carrierCode,
      serviceCode: shipment.serviceCode,
      shipDate: shipment.shipDate,
      wmsFirst: meta.wmsFirst,
      authoritySource: meta.authorityContext.source,
      authorityActor: meta.authorityContext.actor,
      authorityReason: meta.authorityContext.reason,
      carrierTrackingEventId: meta.authorityContext.carrierTrackingEventId,
      carrierDispatchCommandId: meta.authorityContext.carrierDispatchCommandId,
    };
    if (event.kind === "shipped") {
      details.trackingNumber = event.trackingNumber;
      details.carrier = event.carrier;
    } else if (event.kind === "cancelled" || event.kind === "voided") {
      details.reason = event.reason ?? null;
    }

    try {
      await db.insert(omsOrderEvents).values({
        orderId: omsOrderId,
        eventType,
        details,
      });
    } catch (err: any) {
      if (err?.code === "23505" && String(err?.constraint ?? "").includes("shipment_dedup")) {
        console.log(
          `[ShipStation Webhook V2] Dedup: event ${eventType} for OMS order ${omsOrderId} shipment ${meta.wmsShipmentId} already recorded`,
        );
        return;
      }
      throw err;
    }
  }

  return {
    getOmsFinalOrderBlockerForShipmentPush,
    finalizeCanonicalShipNotifyPackage,
    processShipNotifyV2,
    applyShipNotifyV2EventToResolvedShipment,
  };
}

export type ShipStationNotifyV2Execution = ReturnType<typeof createShipStationNotifyV2Execution>;
