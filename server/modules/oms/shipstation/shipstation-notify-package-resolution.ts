import { sql } from "drizzle-orm";
import { buildTrackingUrl } from "../application/tracking-url.util";
import type { ShipmentEvent } from "../../orders/shipment-rollup-and-context.api";
import { resolveShipStationShipmentTimestamp } from "../domain/shipstation-date.util";
import { partitionCommercialRequestedQuantity } from "../domain/shipstation-commercial-quantity.domain";
import { parseProviderAmountCents } from "../../shipping/engine-and-reconcile.api";
import {
  adoptDriftedShipStationOrderMappingOnOutboundShipmentInWms,
  copyPartialShipmentItemToPhysicalSplitInWms,
  insertLegacySplitChildShipmentItemFromShipStationInWms,
  insertShipStationChildOutboundShipmentInWms,
  moveWholeShipmentItemToPhysicalSplitInWms,
  reduceParentShipmentItemAfterPhysicalSplitInWms,
  repairLegacyTrackingOutboundShipmentRefsInWms,
  syncOriginalShipmentItemFromShipStationInWms,
  updateExistingSplitChildShipmentItemFromShipStationInWms,
} from "../../wms/outbound-shipment-mutations.api";
import {
  recordShipStationUnmappedPhysicalException,
  shipStationShipmentRefFromExternalFulfillmentId,
} from "../application/shipstation-unmapped-physical";
import { isPositivePostgresInteger } from "../../shipping/shipstation-provider-reconciliation.api";
import {
  SHIPSTATION_CARRIER_COST_SOURCE,
  SHIPSTATION_COMBINED_CHILD_SOURCE,
  SHIPSTATION_SPLIT_SOURCE,
  ShipStationUnmappedItemsError,
  hasSameShipmentItemSet,
  parseEchelonOrderKey,
  parsePositiveWmsShipmentItemsFromShipStation,
  shipStationShipmentExternalFulfillmentId,
  type ShipStationRuntimeContext,
  type ShipStationShipment,
  type ShipStationShipmentItemOwnership,
} from "./shipstation-contracts";

export function createShipStationNotifyPackageResolution(ctx: ShipStationRuntimeContext) {
  const { db, withOrderShipmentLock } = ctx;

  // -------------------------------------------------------------------------
  // Process SHIP_NOTIFY webhook
  // -------------------------------------------------------------------------
  //
  // The per-shipment handler dispatches to the shipment-native V2 branch
  // (`processShipNotifyV2`) which:
  //   1. Looks up the WMS shipment by `shipstation_order_id` (primary)
  //      with a fallback to the legacy orderKey path for pre-cutover
  //      orders (pushed via pushOrder / echelon-oms-<id>).
  //   2. Dispatches the SS event (shipped / cancelled / voided) to the
  //      single-purpose `markShipment*` helper in shipment-rollup.ts.
  //   3. Rolls up order-level `warehouse_status` via
  //      `recomputeOrderStatusFromShipments` — fixes the
  //      single-shipment-flips-whole-order bug flagged in C13.
  //   4. Derives the OMS state from the (post-rollup) WMS state and
  //      writes to `oms.oms_orders`.
  //
  // If V2 cannot resolve a WMS shipment (pre-cutover orderKeys), it
  // signals fallback and the legacy C13 path runs instead.

  /**
   * Map a ShipStation shipment payload to a typed ShipmentEvent.
   *
   * Returns `null` for shipments with no actionable content (no
   * tracking, no voidDate). Void detection is checked before ship
   * detection: SS can report `orderStatus='shipped'` on a stale
   * snapshot even after a label void, so voidDate wins.
   */
  function deriveEventFromSSShipment(
    shipment: ShipStationShipment,
    carrier: string,
  ): ShipmentEvent | null {
    if (shipment.voidDate) {
      // Carry the voided label's tracking so the rollup can tell whether this
      // void targets the shipment's CURRENT label of record or a superseded
      // one (old label voided after the shipment already re-shipped on a new
      // label). markShipmentVoided ignores stale voids of superseded labels.
      return {
        kind: "voided",
        reason: "ss_label_void",
        trackingNumber: shipment.trackingNumber ?? null,
      };
    }

    const trackingNumber = shipment.trackingNumber;
    const shipDate = shipment.shipDate
      ? resolveShipStationShipmentTimestamp(shipment.shipDate, new Date())
      : null;

    if (
      typeof trackingNumber === "string" &&
      trackingNumber.length > 0 &&
      shipDate !== null &&
      !Number.isNaN(shipDate.getTime())
    ) {
      const parsedCarrierCostCents = parseProviderAmountCents(shipment.shipmentCost);
      const carrierCostCents = parsedCarrierCostCents !== null && parsedCarrierCostCents > 0
        ? parsedCarrierCostCents
        : undefined;
      if (shipment.shipmentCost != null && parsedCarrierCostCents === null) {
        console.error(JSON.stringify({
          code: "SHIPSTATION_SHIPMENT_COST_INVALID",
          message: "ShipStation shipment cost could not be converted to integer cents.",
          context: {
            shipstationShipmentId: shipment.shipmentId,
            shipmentCost: shipment.shipmentCost,
          },
        }));
      }
      return {
        kind: "shipped",
        trackingNumber,
        carrier,
        shipDate,
        trackingUrl: buildTrackingUrl(carrier, trackingNumber),
        serviceCode: typeof shipment.serviceCode === "string" ? shipment.serviceCode.trim() || null : null,
        carrierCostCents,
        carrierCostSource: carrierCostCents === undefined ? undefined : SHIPSTATION_CARRIER_COST_SOURCE,
      };
    }

    return null;
  }

  /**
   * Resolve a WMS shipment for an incoming SHIP_NOTIFY.
   *
   * Resolution order (most → least specific):
   *   1. external_fulfillment_id — the physical SS shipment already mapped
   *      to a WMS row (historical split rows and prior adoptions)
   *   2. orderKey (echelon-wms-shp-<id>) → resolveShipmentByOrderKey, which
   *      MUST run before the ssOrderId lookup: multi-package splits share the
   *      parent's SS orderId, and resolving by orderId would route the second
   *      package onto the parent and destructively rewrite its quantities.
   *   3. shipstation_order_id column (non-wms orderKeys / legacy mappings)
   */
  async function resolveWmsShipmentForShipNotify(
    shipment: ShipStationShipment,
    expectedPhysicalShipmentId: number | null,
  ): Promise<{
    row: any | null;
    fallback: boolean;
    handled: boolean;
    matchedByPhysicalIdentity: boolean;
    combinedOwnership: ShipStationShipmentItemOwnership | null;
  }> {
    const externalFulfillmentId = shipStationShipmentExternalFulfillmentId(
      shipment.shipmentId,
    );
    if (externalFulfillmentId) {
      const byPhysicalShipment: any = await db.execute(sql`
        SELECT id, order_id, source, status, shipstation_order_id,
               external_fulfillment_id, tracking_number,
               requires_review, review_reason, shipment_purpose,
               replaces_shipment_id, replacement_reason
        FROM wms.outbound_shipments
        WHERE external_fulfillment_id = ${externalFulfillmentId}
          AND (
            ${expectedPhysicalShipmentId}::integer IS NULL OR id = ${expectedPhysicalShipmentId}
          )
        LIMIT 1
      `);
      const existing = byPhysicalShipment?.rows?.[0];
      if (existing) {
        return {
          row: existing,
          fallback: false,
          handled: false,
          matchedByPhysicalIdentity: true,
          combinedOwnership: null,
        };
      }
    }

    if (expectedPhysicalShipmentId !== null) {
      return {
        row: null,
        fallback: false,
        handled: true,
        matchedByPhysicalIdentity: false,
        combinedOwnership: null,
      };
    }

    const parsed = parseEchelonOrderKey(shipment.orderKey);
    if (parsed?.source === "wms-shipment") {
      const resolved = await resolveShipmentByOrderKey(
        parsed.shipmentId,
        shipment,
        externalFulfillmentId,
      );
      return {
        row: resolved.row,
        fallback: false,
        handled: resolved.handled,
        matchedByPhysicalIdentity: false,
        combinedOwnership: resolved.combinedOwnership ?? null,
      };
    }

    const ssOrderId = shipment.orderId;
    if (isPositivePostgresInteger(ssOrderId)) {
      const byOrderId: any = await db.execute(sql`
        SELECT id, order_id, source, status, shipstation_order_id,
               external_fulfillment_id, tracking_number,
               requires_review, review_reason, shipment_purpose,
               replaces_shipment_id, replacement_reason
        FROM wms.outbound_shipments
        WHERE shipstation_order_id = ${ssOrderId}
        LIMIT 1
      `);
      const existing = byOrderId?.rows?.[0];
      if (existing) {
        const resolved = await resolveShipmentByOrderKey(
          Number(existing.id),
          shipment,
          externalFulfillmentId,
        );
        return {
          row: resolved.row,
          fallback: false,
          handled: resolved.handled,
          matchedByPhysicalIdentity: false,
          combinedOwnership: resolved.combinedOwnership ?? null,
        };
      }
    }

    return {
      row: null,
      fallback: true,
      handled: false,
      matchedByPhysicalIdentity: false,
      combinedOwnership: null,
    };
  }

  /**
   * Match an incoming SHIP_NOTIFY to an existing WMS shipment via orderKey.
   *
   * Hardened invariants (P0 / order 59301 class — creation from inbound
   * engine data is forbidden for unknown or terminal parents):
   *   - missing parent      → flag + null (never create)
   *   - cancelled/voided    → active sibling, else review-flag + audit event
   *   - duplicate SS order  → REPAIR the parent's mapping (adopt SS ids +
   *     physical shipment id, review-flag on drift) — never a second row
   *
   * One deliberate creation case remains (merged from main): a genuine
   * PARTIAL package — the physical shipment covers a strict subset of an
   * ACTIVE parent's items — forks a child split row so the unshipped
   * remainder stays tracked (without it, the parent's quantities would be
   * destructively rewritten and the remainder would vanish from
   * fulfillment). The child copies the WMS's OWN parent rows; guarded by
   * the per-order advisory lock + external_fulfillment_id dedup, and
   * unreachable for terminal/unknown parents.
   */
  async function resolveShipmentByOrderKey(
    shipmentId: number,
    shipment: ShipStationShipment,
    externalFulfillmentId: string | null,
  ): Promise<{
    row: any | null;
    handled: boolean;
    combinedOwnership?: ShipStationShipmentItemOwnership;
  }> {
    const parentResult: any = await db.execute(sql`
      SELECT id, order_id, channel_id, status, shipstation_order_id,
             shipstation_order_key, external_fulfillment_id,
             tracking_number, source, requires_review, review_reason,
             shipment_purpose, replaces_shipment_id, replacement_reason
      FROM wms.outbound_shipments
      WHERE id = ${shipmentId}
      LIMIT 1
    `);
    const parent = parentResult?.rows?.[0];
    if (!parent) {
      console.error(
        `[SHIP_NOTIFY resolve] orderKey references missing WMS shipment ${shipmentId} — cannot resolve (SS orderId=${shipment.orderId})`,
      );
      return { row: null, handled: false };
    }

    const parentStatus = String(parent.status ?? "");
    if (parentStatus === "cancelled" || parentStatus === "voided") {
      // Parent is terminal — look for any active sibling shipment on the
      // same WMS order that we can match to. NEVER create a replacement.
      const siblingResult: any = await db.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE order_id = ${parent.order_id}
          AND id <> ${shipmentId}
          AND status NOT IN ('cancelled', 'voided')
        ORDER BY id DESC
        LIMIT 1
      `);
      const sibling = siblingResult?.rows?.[0];
      if (sibling) {
        console.warn(
          `[SHIP_NOTIFY resolve] Parent shipment ${shipmentId} is ${parentStatus}, ` +
            `resolved to active sibling ${sibling.id} for WMS order ${parent.order_id}`,
        );
        return { row: sibling, handled: false };
      }

      console.error(
        `[SHIP_NOTIFY resolve] SHIP_NOTIFY for SS orderId=${shipment.orderId} ` +
          `(orderKey=echelon-wms-shp-${shipmentId}) has no active WMS shipment. ` +
          `Parent ${shipmentId} is '${parentStatus}', no active siblings on order ${parent.order_id}. ` +
          `Requires manual review — WMS will NOT auto-create a shipment from inbound data.`,
      );
      await db.execute(sql`
        INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
        SELECT oo.id, 'ship_notify_unresolved',
               ${JSON.stringify({
                 ssOrderId: shipment.orderId,
                 orderKey: shipment.orderKey,
                 shipmentId,
                 parentStatus,
                 wmsOrderId: parent.order_id,
                 reason: "no_active_wms_shipment",
               })}::jsonb,
               NOW()
        FROM wms.orders wo
        JOIN oms.oms_orders oo ON oo.id::text = wo.oms_fulfillment_order_id
        WHERE wo.id = ${parent.order_id}
        LIMIT 1
      `);
      return { row: null, handled: false };
    }

    // Exact physical-id replays are resolved before this function. Once a WMS
    // shipment is fulfillment-terminal, any other package is a replacement or
    // reship ambiguity and cannot authorize more fulfillment. Older rows that
    // lack a physical id may repair only when tracking is an exact match.
    if (["shipped", "returned", "lost"].includes(parentStatus)) {
      const currentPhysicalShipmentRef =
        shipStationShipmentRefFromExternalFulfillmentId(parent.external_fulfillment_id);
      const incomingPhysicalShipmentRef =
        shipStationShipmentRefFromExternalFulfillmentId(externalFulfillmentId);
      const currentTracking = String(parent.tracking_number ?? "").trim();
      const incomingTracking = String(shipment.trackingNumber ?? "").trim();
      const samePhysicalShipment = currentPhysicalShipmentRef !== null &&
        incomingPhysicalShipmentRef !== null &&
        currentPhysicalShipmentRef === incomingPhysicalShipmentRef;
      const safeLegacyTrackingRepair = currentPhysicalShipmentRef === null &&
        currentTracking.length > 0 &&
        incomingTracking.length > 0 &&
        currentTracking === incomingTracking;

      if (safeLegacyTrackingRepair) {
        const incomingSsOrderId = Number(shipment.orderId);
        const validIncomingSsOrderId =
          Number.isInteger(incomingSsOrderId) && incomingSsOrderId > 0
            ? incomingSsOrderId
            : null;
        await repairLegacyTrackingOutboundShipmentRefsInWms(db, {
          shipmentId: Number(parent.id),
          externalFulfillmentId,
          validIncomingSsOrderId,
        });
        return {
          row: {
            ...parent,
            external_fulfillment_id:
              parent.external_fulfillment_id ?? externalFulfillmentId,
          },
          handled: false,
        };
      }

      if (!samePhysicalShipment) {
        await recordShipStationUnmappedPhysicalException(db, {
          shipment,
          wmsOrderId: Number(parent.order_id),
          wmsShipmentId: Number(parent.id),
          blockedReason: "distinct_physical_shipment_after_terminal_fulfillment",
          currentPhysicalShipmentRef: parent.external_fulfillment_id ?? null,
          currentTrackingNumber: parent.tracking_number ?? null,
        });
        console.warn(
          `[SHIP_NOTIFY resolve] Blocked ShipStation shipment ${shipment.shipmentId} ` +
            `from terminal WMS shipment ${parent.id}; the distinct physical package ` +
            `cannot authorize additional fulfillment.`,
        );
        return { row: null, handled: true };
      }
    }

    // Active parent. Decide repair-vs-split by comparing the physical
    // package's items against the parent's items.
    const parsedShipStationItems = parsePositiveWmsShipmentItemsFromShipStation(shipment);
    let isPartialPackage = false;
    if (parsedShipStationItems) {
      const parentItemsResult: any = await db.execute(sql`
        SELECT id, qty
        FROM wms.outbound_shipment_items
        WHERE shipment_id = ${parent.id}
          AND qty > 0
      `);
      const parentItems: Array<{ id: number; qty: number }> =
        (parentItemsResult?.rows ?? []).map((row: any) => ({
        id: Number(row.id),
        qty: Number(row.qty),
      }));
      isPartialPackage = !hasSameShipmentItemSet(parentItems, parsedShipStationItems);
      const parentItemIds = new Set(parentItems.map((item) => item.id));
      const containsForeignShipmentItem = parsedShipStationItems.some(
        (item) => !parentItemIds.has(item.sourceShipmentItemId),
      );
      if (isPartialPackage && containsForeignShipmentItem) {
        const ownership = await loadShipStationShipmentItemOwnership(shipment);
        if (ownership && ownership.sourceIdsByOrder.size > 1) {
          return {
            row: null,
            handled: false,
            combinedOwnership: ownership,
          };
        }
      }
    }

    if (!isPartialPackage) {
      // Full package (or no parseable items): the notify belongs to the
      // parent itself. Repair/adopt the mapping — heals the duplicate-push
      // gap where a failed write-back left our DB with one SS orderId while
      // SS created a second order under the same key.
      const incomingSsOrderId = Number(shipment.orderId);
      const hasIncoming = Number.isInteger(incomingSsOrderId) && incomingSsOrderId > 0;
      const existingSsOrderId = Number(parent.shipstation_order_id);
      const drifted =
        hasIncoming && existingSsOrderId > 0 && incomingSsOrderId !== existingSsOrderId;
      const adoptedSsOrderId = hasIncoming
        ? incomingSsOrderId
        : existingSsOrderId > 0
          ? existingSsOrderId
          : null;
      const needsMappingUpdate =
        (hasIncoming && incomingSsOrderId !== existingSsOrderId) ||
        (Boolean(externalFulfillmentId) && !parent.external_fulfillment_id);

      if (needsMappingUpdate) {
        if (drifted) {
          console.warn(
            `[SHIP_NOTIFY resolve] Shipment ${shipmentId} SS orderId drifted: ` +
              `DB has ${existingSsOrderId}, SHIP_NOTIFY carries ${incomingSsOrderId}. ` +
              `Adopting incoming mapping and flagging for review (duplicate SS order).`,
          );
        }
        await adoptDriftedShipStationOrderMappingOnOutboundShipmentInWms(db, {
          shipmentId,
          adoptedSsOrderId,
          orderKey: shipment.orderKey ?? null,
          externalFulfillmentId,
          drifted,
        });
      }
      return {
        row: { ...parent, shipstation_order_id: adoptedSsOrderId },
        handled: false,
      };
    }

    // Genuine partial package on an ACTIVE parent: fork the WMS's own child
    // split row so the unshipped remainder stays tracked.
    if (!externalFulfillmentId) {
      console.error(
        `[SHIP_NOTIFY resolve] Partial package for shipment ${shipmentId} has no usable ` +
          `SS shipmentId — cannot dedupe replays, refusing to create a split row`,
      );
      return { row: null, handled: false };
    }

    const orderId = parent.order_id;
    const createSplit = async (tx: any): Promise<{ row: any | null; handled: boolean }> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(918406, ${orderId})`);
      const existingAfterLock: any = await tx.execute(sql`
        SELECT id, order_id, status, shipstation_order_id
        FROM wms.outbound_shipments
        WHERE external_fulfillment_id = ${externalFulfillmentId}
        LIMIT 1
      `);
      if (existingAfterLock?.rows?.[0]) {
        return { row: existingAfterLock.rows[0], handled: false };
      }

      const lockedParentResult: any = await tx.execute(sql`
        SELECT id, status
        FROM wms.outbound_shipments
        WHERE id = ${parent.id}
        FOR UPDATE
      `);
      const lockedParent = lockedParentResult?.rows?.[0];
      if (
        !lockedParent
        || !["planned", "queued", "labeled", "on_hold"].includes(
          String(lockedParent.status),
        )
      ) {
        throw new Error(
          `WMS shipment ${parent.id} changed state while physical split ` +
            `${shipment.shipmentId} was being created`,
        );
      }

      const ssOrderKey = shipment.orderKey || parent.shipstation_order_key;
      const inserted: any = await insertShipStationChildOutboundShipmentInWms(tx, {
        orderId,
        channelId: parent.channel_id,
        externalFulfillmentId,
        source: SHIPSTATION_SPLIT_SOURCE,
        shipstationOrderId: shipment.orderId,
        shipstationOrderKey: ssOrderKey,
      });

      const row = inserted?.rows?.[0];
      if (!row) {
        throw new Error(
          `Failed to create WMS split shipment for ShipStation shipment ${shipment.shipmentId}`,
        );
      }

      for (const item of parsedShipStationItems ?? []) {
        const sourceResult: any = await tx.execute(sql`
          SELECT id, qty, commercial_requested_qty, split_root_shipment_item_id
          FROM wms.outbound_shipment_items
          WHERE id = ${item.sourceShipmentItemId}
            AND shipment_id = ${parent.id}
          FOR UPDATE
        `);
        const source = sourceResult?.rows?.[0];
        if (!source || Number(source.qty) < item.qty) {
          throw new Error(
            `WMS shipment item ${item.sourceShipmentItemId} does not have ` +
              `${item.qty} units available for physical split ${shipment.shipmentId}`,
          );
        }

        const sourceQty = Number(source.qty);
        if (!Number.isInteger(sourceQty) || sourceQty <= 0) {
          throw new Error(
            `WMS shipment item ${item.sourceShipmentItemId} has invalid source ` +
              `quantity ${String(source.qty)}`,
          );
        }
        const commercialPartition = partitionCommercialRequestedQuantity({
          sourceQuantity: sourceQty,
          splitQuantity: item.qty,
          commercialRequestedQuantity: source.commercial_requested_qty == null
            ? null
            : Number(source.commercial_requested_qty),
        });

        if (sourceQty === item.qty) {
          // Preserve the stable wms-item identity when the entire line moves to
          // the physical package. Copying and reducing would leave an illegal
          // zero-quantity placeholder on the parent shipment.
          const moved: any = await moveWholeShipmentItemToPhysicalSplitInWms(tx, {
            sourceShipmentItemId: item.sourceShipmentItemId,
            parentShipmentId: Number(parent.id),
            splitShipmentId: Number(row.id),
            qty: item.qty,
            trackingId: String(shipment.shipmentId),
          });
          if ((moved?.rows ?? []).length !== 1) {
            throw new Error(
              `WMS shipment item ${item.sourceShipmentItemId} could not be moved ` +
                `atomically to physical split ${shipment.shipmentId}`,
            );
          }
          continue;
        }

        const rootSourceShipmentItemId = Number(
          source.split_root_shipment_item_id ?? item.sourceShipmentItemId,
        );
        if (
          !Number.isInteger(rootSourceShipmentItemId)
          || rootSourceShipmentItemId <= 0
        ) {
          throw new Error(
            `WMS shipment item ${item.sourceShipmentItemId} has invalid split lineage`,
          );
        }
        const childCommercialQty = commercialPartition.childQuantity;
        const retainedCommercialQty = commercialPartition.retainedQuantity;

        const insertedItem: any = await copyPartialShipmentItemToPhysicalSplitInWms(tx, {
          sourceShipmentItemId: item.sourceShipmentItemId,
          parentShipmentId: Number(parent.id),
          splitShipmentId: Number(row.id),
          rootSourceShipmentItemId,
          qty: item.qty,
          childCommercialQty,
          trackingId: String(shipment.shipmentId),
        });
        if ((insertedItem?.rows ?? []).length !== 1) {
          throw new Error(
            `WMS shipment item ${item.sourceShipmentItemId} could not be copied ` +
              `atomically to physical split ${shipment.shipmentId}`,
          );
        }

        const reduced: any = await reduceParentShipmentItemAfterPhysicalSplitInWms(tx, {
          sourceShipmentItemId: item.sourceShipmentItemId,
          parentShipmentId: Number(parent.id),
          splitQty: item.qty,
          retainedCommercialQty,
        });
        if ((reduced?.rows ?? []).length !== 1) {
          throw new Error(
            `WMS shipment item ${item.sourceShipmentItemId} could not be reduced ` +
              `after physical split ${shipment.shipmentId} was created`,
          );
        }
      }
      return { row, handled: false };
    };

    return typeof db.transaction === "function"
      ? db.transaction(createSplit)
      : createSplit(db);
  }
  async function syncShipmentItemsWithExecutor(
    executor: any,
    targetShipmentId: number,
    shipment: ShipStationShipment,
    allowedSourceShipmentItemIds?: Set<number>,
  ): Promise<void> {
    let parsedItems = parsePositiveWmsShipmentItemsFromShipStation(shipment);
    if (!parsedItems) {
      throw new ShipStationUnmappedItemsError(
        `shipstation_split_items_unmapped: ShipStation shipment ` +
          `${shipment.shipmentId} lacks exact unique wms-item quantity evidence`,
      );
    }

    const targetItems: any = await executor.execute(sql`
      SELECT osi.id, osi.order_item_id, osi.replacement_for_order_item_id,
             COALESCE(oi.sku, catalog_variant.sku) AS sku,
             osi.qty, osi.commercial_requested_qty,
             target_shipment.shipment_purpose,
             osi.provider_membership_state,
             osi.split_root_shipment_item_id
      FROM wms.outbound_shipment_items osi
      JOIN wms.outbound_shipments target_shipment
        ON target_shipment.id = osi.shipment_id
      LEFT JOIN wms.order_items oi
        ON oi.id = COALESCE(osi.order_item_id, osi.replacement_for_order_item_id)
      LEFT JOIN catalog.product_variants catalog_variant
        ON catalog_variant.id = osi.product_variant_id
      WHERE osi.shipment_id = ${targetShipmentId}
    `);
    if (allowedSourceShipmentItemIds && allowedSourceShipmentItemIds.size > 0) {
      parsedItems = parsedItems.filter((item) =>
        allowedSourceShipmentItemIds.has(item.sourceShipmentItemId),
      );
    }

    if (parsedItems.length === 0) {
      return;
    }

    const targetItemIds = new Set(
      (targetItems?.rows ?? []).map((row: any) => Number(row.id)),
    );
    const targetIsReplacement = (targetItems?.rows ?? []).some(
      (row: any) => String(row.shipment_purpose ?? "") === "replacement",
    );
    const targetIsOriginal = parsedItems.some((item) =>
      targetItemIds.has(item.sourceShipmentItemId),
    );

    const childItemsByOrderItemId = new Map<number, any>();
    if (!targetIsOriginal) {
      for (const row of targetItems?.rows ?? []) {
        const orderItemId = Number(
          targetIsReplacement
            ? row.replacement_for_order_item_id
            : row.order_item_id,
        );
        if (Number.isInteger(orderItemId) && orderItemId > 0) {
          childItemsByOrderItemId.set(orderItemId, row);
        }
      }
    }

    const touchedOriginalIds: number[] = [];
    const touchedChildIds: number[] = [];
    for (const item of parsedItems) {
      const source: any = await executor.execute(sql`
        SELECT
          osi.id,
          osi.order_item_id,
          osi.correction_for_shipment_item_id,
          osi.shipment_item_purpose,
          osi.split_root_shipment_item_id,
          osi.product_variant_id,
          osi.commercial_requested_qty,
          -- Planned shipment items may predate picking, so older rows can
          -- legitimately have no source bin. The pick ledger is the source of
          -- truth once the picker has selected physical stock.
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
          ) AS from_location_id,
          osi.box_id,
          osi.weight_oz
        FROM wms.outbound_shipment_items osi
        WHERE osi.id = ${item.sourceShipmentItemId}
        LIMIT 1
      `);
      const sourceRow = source?.rows?.[0];
      if (!sourceRow) {
        throw new ShipStationUnmappedItemsError(
          `shipstation_split_source_item_missing: ShipStation shipment ` +
            `${shipment.shipmentId} referenced missing WMS shipment item ` +
            `${item.sourceShipmentItemId}`,
        );
      }

      if (targetIsOriginal && targetItemIds.has(item.sourceShipmentItemId)) {
        await syncOriginalShipmentItemFromShipStationInWms(executor, {
          shipmentItemId: item.sourceShipmentItemId,
          qty: item.qty,
          fromLocationId: sourceRow.from_location_id,
          trackingId: String(shipment.shipmentId),
        });
        touchedOriginalIds.push(item.sourceShipmentItemId);
      } else {
        const orderItemId = Number(sourceRow.order_item_id);
        const splitRootShipmentItemId = targetIsReplacement
          ? null
          : Number(
              sourceRow.split_root_shipment_item_id
              ?? item.sourceShipmentItemId,
            );
        if (
          !targetIsReplacement
          && (
            !Number.isInteger(splitRootShipmentItemId)
            || Number(splitRootShipmentItemId) <= 0
          )
        ) {
          throw new ShipStationUnmappedItemsError(
            `shipstation_split_source_lineage_invalid: WMS shipment item ` +
              `${item.sourceShipmentItemId} has no valid split root`,
          );
        }
        const existingChild = Number.isInteger(orderItemId) && orderItemId > 0
          ? childItemsByOrderItemId.get(orderItemId)
          : null;

        if (
          !targetIsReplacement
          && sourceRow.commercial_requested_qty !== null
          && (
            !existingChild
            || existingChild.commercial_requested_qty === null
          )
        ) {
          // The legacy fallback can copy a physical split but cannot prove
          // how a reduced commercial request was divided. New splits carry
          // an explicit partition from createSplitShipment above.
          throw new ShipStationUnmappedItemsError(
            `shipstation_split_commercial_quantity_unmapped: WMS source item ` +
              `${item.sourceShipmentItemId} has reduced commercial demand ` +
              `without an authoritative child partition`,
          );
        }

        if (existingChild) {
          await updateExistingSplitChildShipmentItemFromShipStationInWms(executor, {
            childItemId: Number(existingChild.id),
            productVariantId: sourceRow.product_variant_id,
            qty: item.qty,
            fromLocationId: sourceRow.from_location_id,
            boxId: sourceRow.box_id,
            weightOz: sourceRow.weight_oz,
            trackingId: String(shipment.shipmentId),
            splitRootShipmentItemId,
          });
          touchedChildIds.push(Number(existingChild.id));
        } else {
          // New splits reach this path with the parent quantity already
          // reduced and the physical child row already inserted atomically.
          // The insert below remains only for pre-hardening split rows.
          const inserted: any = await insertLegacySplitChildShipmentItemFromShipStationInWms(executor, {
            targetShipmentId,
            orderItemId: targetIsReplacement ? null : sourceRow.order_item_id,
            replacementForOrderItemId: targetIsReplacement ? sourceRow.order_item_id : null,
            correctionForShipmentItemId: targetIsReplacement ? null : sourceRow.correction_for_shipment_item_id,
            splitRootShipmentItemId,
            shipmentItemPurpose: targetIsReplacement ? "replacement" : sourceRow.shipment_item_purpose,
            productVariantId: sourceRow.product_variant_id,
            qty: item.qty,
            fromLocationId: sourceRow.from_location_id,
            boxId: sourceRow.box_id,
            weightOz: sourceRow.weight_oz,
            trackingId: String(shipment.shipmentId),
          });
          const insertedId = Number(inserted?.rows?.[0]?.id);
          if (Number.isInteger(insertedId) && insertedId > 0) {
            touchedChildIds.push(insertedId);
          }
        }
      }
    }

    if (targetIsOriginal && touchedOriginalIds.length > 0) {
      const touched = new Set(touchedOriginalIds);
      const untouchedIds = (targetItems?.rows ?? [])
        .filter((row: any) =>
          String(row.provider_membership_state ?? "authoritative") !== "pending_append"
        )
        .map((row: any) => Number(row.id))
        .filter((rowId: number) => Number.isInteger(rowId) && rowId > 0 && !touched.has(rowId));
      if (untouchedIds.length > 0) {
        throw new ShipStationUnmappedItemsError(
          `ShipStation shipment ${shipment.shipmentId} omitted ${untouchedIds.length} ` +
            `authoritative item row(s) from WMS shipment ${targetShipmentId}; ` +
            `the remaining demand was preserved for review`,
        );
      }
    }

    if (!targetIsOriginal && touchedChildIds.length > 0) {
      const touched = new Set(touchedChildIds);
      const untouchedIds = (targetItems?.rows ?? [])
        .filter((row: any) =>
          String(row.provider_membership_state ?? "authoritative") !== "pending_append"
        )
        .map((row: any) => Number(row.id))
        .filter((rowId: number) => Number.isInteger(rowId) && rowId > 0 && !touched.has(rowId));
      if (untouchedIds.length > 0) {
        throw new ShipStationUnmappedItemsError(
          `ShipStation shipment ${shipment.shipmentId} omitted ${untouchedIds.length} ` +
            `authoritative child item row(s) from WMS shipment ${targetShipmentId}; ` +
            `the remaining demand was preserved for review`,
        );
      }
    }
  }

  async function syncShipmentItemsFromShipStation(
    targetShipmentId: number,
    shipment: ShipStationShipment,
    allowedSourceShipmentItemIds?: Set<number>,
  ): Promise<void> {
    const syncItems = (executor: any) => syncShipmentItemsWithExecutor(
      executor,
      targetShipmentId,
      shipment,
      allowedSourceShipmentItemIds,
    );

    if (typeof db.transaction === "function") {
      await db.transaction(syncItems);
      return;
    }
    await syncItems(db);
  }

  async function loadShipStationShipmentItemOwnership(
    shipment: ShipStationShipment,
  ): Promise<ShipStationShipmentItemOwnership | null> {
    const parsedItems = parsePositiveWmsShipmentItemsFromShipStation(shipment);
    if (!parsedItems || parsedItems.length === 0) {
      return null;
    }

    const sourceShipmentItemIds = parsedItems.map(
      (item) => item.sourceShipmentItemId,
    );
    const sourceItemList = sql.join(
      sourceShipmentItemIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const sourceRowsResult: any = await db.execute(sql`
      SELECT
        osi.id AS source_shipment_item_id,
        oi.order_id AS wms_order_id
      FROM wms.outbound_shipment_items osi
      JOIN wms.order_items oi ON oi.id = osi.order_item_id
      WHERE osi.id IN (${sourceItemList})
    `);
    const sourceRows: Array<{
      source_shipment_item_id: number;
      wms_order_id: number;
    }> = sourceRowsResult?.rows ?? [];

    const resolvedSourceIds = new Set<number>();
    const sourceIdsByOrder = new Map<number, Set<number>>();
    for (const row of sourceRows) {
      const wmsOrderId = Number(row.wms_order_id);
      const sourceShipmentItemId = Number(row.source_shipment_item_id);
      if (
        !Number.isInteger(wmsOrderId) ||
        wmsOrderId <= 0 ||
        !Number.isInteger(sourceShipmentItemId) ||
        sourceShipmentItemId <= 0
      ) {
        return null;
      }
      resolvedSourceIds.add(sourceShipmentItemId);
      if (!sourceIdsByOrder.has(wmsOrderId)) {
        sourceIdsByOrder.set(wmsOrderId, new Set());
      }
      sourceIdsByOrder.get(wmsOrderId)!.add(sourceShipmentItemId);
    }

    // Provider line ownership is authoritative only when every positive
    // wms-item key resolves. Partial ownership must remain on the existing
    // single-order/quarantine path rather than guessing that a package is
    // combined.
    if (
      resolvedSourceIds.size !== sourceShipmentItemIds.length ||
      sourceShipmentItemIds.some((id) => !resolvedSourceIds.has(id))
    ) {
      return null;
    }

    return { sourceShipmentItemIds, sourceIdsByOrder };
  }

  async function resolveCombinedShipmentGroupsFromShipStationItems(
    resolvedShipmentRow: any,
    shipment: ShipStationShipment,
    ownership?: ShipStationShipmentItemOwnership | null,
  ): Promise<Array<{ row: any; sourceShipmentItemIds: Set<number> }>> {
    const resolvedOwnership =
      ownership ?? await loadShipStationShipmentItemOwnership(shipment);
    if (!resolvedOwnership) {
      return resolvedShipmentRow
        ? [{ row: resolvedShipmentRow, sourceShipmentItemIds: new Set() }]
        : [];
    }

    const { sourceShipmentItemIds, sourceIdsByOrder } = resolvedOwnership;
    // With a resolved anchor shipment and a single owning order this is the
    // ordinary (non-combined) case — keep the already-resolved row. When there
    // is NO anchor (recovery path: the orderKey pointed at a cancelled/voided
    // shipment), fall through to the per-order loop below so we resolve or
    // create a LIVE shipment for the owning order instead of returning null.
    if (resolvedShipmentRow && sourceIdsByOrder.size <= 1) {
      return [{
        row: resolvedShipmentRow,
        sourceShipmentItemIds:
          sourceIdsByOrder.get(Number(resolvedShipmentRow.order_id)) ??
          new Set(sourceShipmentItemIds),
      }];
    }

    const groups: Array<{ row: any; sourceShipmentItemIds: Set<number> }> = [];
    for (const [wmsOrderId, groupSourceIds] of sourceIdsByOrder.entries()) {
      let shipmentRow: any | null = null;

      // Prefer a LIVE shipment for this order. Excluding terminal rows means
      // that when the order's only shipment was cancelled (e.g. ShipStation
      // "Combine Orders" merged it away and our shipment got cancelled), we
      // fall into the create-synthetic-child path below and land the shipped
      // event + tracking + marketplace push on a live row, not a dead one.
      const existing: any = await db.execute(sql`
        SELECT id, order_id, source, status, shipstation_order_id,
               external_fulfillment_id, tracking_number,
               requires_review, review_reason, shipment_purpose,
               replaces_shipment_id, replacement_reason
        FROM wms.outbound_shipments
        WHERE order_id = ${wmsOrderId}
          AND status NOT IN ('cancelled', 'voided')
        ORDER BY
          CASE WHEN id = ${Number(resolvedShipmentRow?.id ?? 0)} THEN 0 ELSE 1 END,
          CASE WHEN source = ${SHIPSTATION_COMBINED_CHILD_SOURCE} THEN 0 ELSE 1 END,
          id ASC
        LIMIT 1
      `);
      shipmentRow = existing?.rows?.[0] ?? null;

      if (!shipmentRow) {
        const wmsOrderResult: any = await db.execute(sql`
          SELECT id, channel_id
          FROM wms.orders
          WHERE id = ${wmsOrderId}
          LIMIT 1
        `);
        const wmsOrder = wmsOrderResult?.rows?.[0];
        if (!wmsOrder) {
          throw new Error(
            `ShipStation combined shipment ${shipment.shipmentId} references WMS order ${wmsOrderId}, but that order was not found`,
          );
        }

        // Serialize the synthetic-child insert per WMS order on a pinned
        // session lock. (The old pooled pg_advisory_lock idiom serialized
        // nothing, and this block also unlocked twice on the already-exists
        // path.) The returned row falls through to the shared groups.push below.
        shipmentRow = await withOrderShipmentLock(wmsOrderId, async () => {
          const externalFulfillmentId =
            `shipstation_combined:${shipment.shipmentId}:order:${wmsOrderId}`;
          const existingSynthetic: any = await db.execute(sql`
            SELECT id, order_id, status, shipstation_order_id
            FROM wms.outbound_shipments
            WHERE external_fulfillment_id = ${externalFulfillmentId}
            LIMIT 1
          `);
          const existingRow = existingSynthetic?.rows?.[0] ?? null;
          if (existingRow) {
            return existingRow;
          }

          const inserted: any = await insertShipStationChildOutboundShipmentInWms(db, {
            orderId: wmsOrderId,
            channelId: wmsOrder.channel_id,
            externalFulfillmentId,
            source: SHIPSTATION_COMBINED_CHILD_SOURCE,
            shipstationOrderId: shipment.orderId,
            shipstationOrderKey: shipment.orderKey,
          });
          return inserted?.rows?.[0] ?? null;
        });
      }

      if (shipmentRow) {
        groups.push({ row: shipmentRow, sourceShipmentItemIds: groupSourceIds });
      }
    }

    if (groups.length > 1) {
      console.warn(
        `[ShipStation Webhook V2] ShipStation shipment ${shipment.shipmentId} spans ${groups.length} WMS order(s); applying shared tracking to each order shipment.`,
      );
    }

    if (groups.length > 0) return groups;
    return resolvedShipmentRow
      ? [{ row: resolvedShipmentRow, sourceShipmentItemIds: new Set(sourceShipmentItemIds) }]
      : [];
  }

  return {
    deriveEventFromSSShipment,
    resolveWmsShipmentForShipNotify,
    resolveShipmentByOrderKey,
    syncShipmentItemsFromShipStation,
    resolveCombinedShipmentGroupsFromShipStationItems,
  };
}

export type ShipStationNotifyPackageResolution = ReturnType<typeof createShipStationNotifyPackageResolution>;
