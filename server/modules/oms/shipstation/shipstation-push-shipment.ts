import { readIntegerCents } from "@shared/money-read";
import { and, eq, sql } from "drizzle-orm";
import { OrderEditError } from "../../order-edits/oms-coordination.api";
import { verifyRefundedChannelMerchandise } from "../channel-merchandise-dispatch.service";
import { outboundShipmentItems, outboundShipments, wmsOrderItems, wmsOrders } from "@shared/schema";
import { recomputeOrderStatusFromShipments } from "../../orders/shipment-rollup-and-context.api";
import type { EngineShipmentItemAppendResult } from "../../shipping/engine-and-reconcile.api";
import { maybeGetPackInstruction } from "../../cartonization/pack-plan.api";
import {
  clearOutboundShipmentReviewFlagByReasonInWms,
  commitAmendedShipmentItemQuantityInWms,
  markAppendedShipmentItemsAuthoritativeInWms,
  countOpenShipmentsSharingShipStationOrderInWms,
  linkShipStationOrderIdentityOnOutboundShipmentInWms,
  markOutboundShipmentQueuedAfterShipStationPushInWms,
  setOutboundShipmentReviewFlagInWms,
} from "../../wms/outbound-shipment-mutations.api";
import { logger as platformLogger } from "../../../platform/observability/logger";
import {
  adoptProvenShipStationOrder,
  proveShipStationOrderAdoption,
  resolveShipStationHandoffCommands,
} from "../shipstation-order-adoption";
import {
  PUSHABLE_SHIPMENT_STATUSES,
  shipStationOrderKeyForShipment,
  shipStationOrderNumberForWmsOrder,
  SS_PUSH_INVALID_SHIPMENT,
  ShipStationPushError,
  requireShipStationCountryCode,
  resolveShipStationIds,
  validateShipmentForPush,
  type ShipmentPushOmsBlocker,
  type ShipStationCreateOrderResponse,
  type ShipStationRuntimeContext,
  type WmsOrderRow,
  type WmsShipmentItemRow,
  type WmsShipmentRow,
} from "./shipstation-contracts";

/** Review reasons stamped when a push lands on a shipment that stopped mid-flight. */
export const SS_REVIEW_CANCEL_UNVERIFIED = "shipstation_cancel_unverified";
export const SS_REVIEW_PUSH_AFTER_TERMINAL = "shipstation_push_landed_after_terminal";

/** Result shape of orderControls.cancelOrder, injected to avoid a module cycle. */
export type ShipStationCancelOrderFn = (shipstationOrderId: number) => Promise<{
  alreadyInState: boolean;
  state: "cancelled" | "already_cancelled" | "already_shipped" | "not_found";
}>;

export function createShipStationPushHandlers(
  ctx: ShipStationRuntimeContext,
  getOmsFinalOrderBlockerForShipmentPush: (
    omsFulfillmentOrderId: string | null | undefined,
    verifiedRefundMerchandise?: boolean,
  ) => Promise<ShipmentPushOmsBlocker>,
  cancelProviderOrder?: ShipStationCancelOrderFn,
) {
  const { db, dependencies, apiRequest, withShipmentPushLock, getOrderById, getOrderByKey } = ctx;

  /**
   * Append late-authorized WMS lines to an existing ShipStation order without
   * rebuilding provider-managed package fields from the Echelon snapshot.
   */
  async function appendShipmentItems(
    shipmentId: number,
    shipmentItemIds: readonly number[],
  ): Promise<EngineShipmentItemAppendResult> {
    if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
      throw new ShipStationPushError("shipmentId must be a positive integer", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "shipmentId",
        value: shipmentId,
      });
    }

    const normalizedItemIds = Array.from(new Set(shipmentItemIds))
      .map((value) => Number(value))
      .sort((left, right) => left - right);
    if (
      normalizedItemIds.length === 0 ||
      normalizedItemIds.some((value) => !Number.isInteger(value) || value <= 0)
    ) {
      throw new ShipStationPushError(
        "shipmentItemIds must contain positive integers",
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipmentItemIds",
          value: shipmentItemIds,
        },
      );
    }

    // Same per-shipment pinned session lock as pushShipment: the amend reads
    // the live provider order, writes it back, then verifies — an interleaved
    // push or amend on the same shipment would clobber the provider state.
    return withShipmentPushLock<EngineShipmentItemAppendResult>(shipmentId, async () => {
      const shipmentResult: any = await db.execute(sql`
        SELECT
          os.id,
          os.status,
          os.held,
          os.requires_review,
          os.review_reason,
          os.shipstation_order_id,
          wo.order_edit_operation_id
        FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id=os.order_id
        WHERE os.id = ${shipmentId}
        LIMIT 1
      `);
      const shipment = shipmentResult?.rows?.[0];
      if (!shipment) {
        throw new ShipStationPushError("shipment not found", {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment",
          value: null,
        });
      }
      if (shipment.requires_review === true) {
        throw new ShipStationPushError(
          `shipment requires review and cannot be amended (${shipment.review_reason ?? "review_required"})`,
          {
            code: SS_PUSH_INVALID_SHIPMENT,
            shipmentId,
            field: "shipment.requires_review",
            value: shipment.review_reason ?? true,
          },
        );
      }

      const shipstationOrderId = Number(shipment.shipstation_order_id);
      if (!Number.isInteger(shipstationOrderId) || shipstationOrderId <= 0) {
        throw new ShipStationPushError(
          "shipment has no ShipStation order identity for append",
          {
            code: SS_PUSH_INVALID_SHIPMENT,
            shipmentId,
            field: "shipment.shipstation_order_id",
            value: shipment.shipstation_order_id ?? null,
          },
        );
      }

      const itemResult: any = await db.execute(sql`
        SELECT
          osi.id,
          osi.qty,
          oi.sku,
          oi.name,
          COALESCE(oi.paid_price_cents, oi.unit_price_cents, 0)::int AS unit_price_cents
        FROM wms.outbound_shipment_items osi
        JOIN wms.order_items oi ON oi.id = osi.order_item_id
        WHERE osi.shipment_id = ${shipmentId}
          AND osi.id = ANY(ARRAY[${sql.join(normalizedItemIds.map((id) => sql`${id}`), sql`, `)}]::int[])
          AND osi.qty > 0
        ORDER BY osi.id
      `);
      const itemRows = itemResult?.rows ?? [];
      if (itemRows.length !== normalizedItemIds.length) {
        throw new ShipStationPushError(
          "one or more shipment items are missing, foreign, or non-positive",
          {
            code: SS_PUSH_INVALID_SHIPMENT,
            shipmentId,
            field: "shipmentItemIds",
            value: normalizedItemIds,
          },
        );
      }

      // This read is intentionally strict. A network error or unknown provider
      // state must throw and retry; only a positive terminal state can trigger
      // residual-package fallback.
      const liveOrder = await apiRequest<any>("GET", `/orders/${shipstationOrderId}`);
      const providerStatus = String(liveOrder?.orderStatus ?? "unknown").toLowerCase();
      if (shipment.order_edit_operation_id != null && providerStatus !== "on_hold") {
        throw new OrderEditError("ORDER_EDIT_PROVIDER_HOLD_MISSING", "ShipStation must remain held while edited lines synchronize.");
      }
      const liveItems = Array.isArray(liveOrder?.items) ? liveOrder.items : [];
      const existingKeys = new Set(
        liveItems
          .map((item: any) => String(item?.lineItemKey ?? "").trim())
          .filter((value: string) => value.length > 0),
      );
      const targetKeys = normalizedItemIds.map((id) => `wms-item-${id}`);
      const allPresent = targetKeys.every((key) => existingKeys.has(key));

      const editableProviderStatuses = new Set([
        "awaiting_shipment",
        "on_hold",
      ]);
      const lockedProviderStatuses = new Set(["shipped", "cancelled"]);
      if (!allPresent && lockedProviderStatuses.has(providerStatus)) {
        return { state: "not_editable", providerStatus };
      }
      if (!allPresent && !editableProviderStatuses.has(providerStatus)) {
        throw new ShipStationPushError(
          `ShipStation amendment state is not recognized as editable or terminal (${providerStatus})`,
          {
            code: "SS_PUSH_AMENDMENT_STATE_UNKNOWN",
            shipmentId,
            field: "orderStatus",
            value: providerStatus,
          },
        );
      }

      if (!allPresent) {
        const missingItems = itemRows
          .filter((row: any) => !existingKeys.has(`wms-item-${Number(row.id)}`))
          .map((row: any) => ({
            lineItemKey: `wms-item-${Number(row.id)}`,
            sku: String(row.sku ?? ""),
            name: String(row.name ?? ""),
            quantity: Number(row.qty),
            unitPrice: readIntegerCents(row.unit_price_cents, "unit price", true) / 100,
            options: [] as unknown[],
          }));

        await apiRequest("POST", "/orders/createorder", {
          ...liveOrder,
          items: [...liveItems, ...missingItems],
        }, { replaySafe: true });

        const verifiedOrder = await apiRequest<any>("GET", `/orders/${shipstationOrderId}`);
        const verifiedKeys = new Set(
          (Array.isArray(verifiedOrder?.items) ? verifiedOrder.items : [])
            .map((item: any) => String(item?.lineItemKey ?? "").trim())
            .filter((value: string) => value.length > 0),
        );
        const missingAfterWrite = targetKeys.filter((key) => !verifiedKeys.has(key));
        if (missingAfterWrite.length > 0) {
          throw new ShipStationPushError(
            `ShipStation amendment verification failed for ${missingAfterWrite.join(", ")}`,
            {
              code: "SS_PUSH_AMENDMENT_VERIFICATION_FAILED",
              shipmentId,
              field: "shipmentItemIds",
              value: normalizedItemIds,
            },
          );
        }
      }

      await markAppendedShipmentItemsAuthoritativeInWms(db, {
        shipmentId,
        normalizedItemIds,
      });

      return {
        state: allPresent ? "already_applied" : "applied",
        providerStatus,
      };
    });
  }
  /**
   * Raise one existing ShipStation line to the current WMS demand for its
   * order item, after the order was already pushed (a channel edit added
   * units to a line the package already carries).
   *
   * Why: a package holds one row per order item, and appendShipmentItems only
   * adds new lines by key. #65696 (2026-11-16) grew 8 -> 10 units on a queued
   * shipment; the append path tried to insert a second row, hit
   * uq_wms_outbound_shipment_items_shipment_order_item, and ShipStation kept 8.
   *
   * The target is recomputed here from current WMS rows (order item quantity
   * minus coverage on the order's other active packages), so replays and later
   * edits converge. Only increases are applied; reductions have other owners.
   * The local row changes only after ShipStation verifies the new quantity, so
   * it never claims more than the engine holds. Same per-shipment pinned lock as
   * pushShipment/appendShipmentItems.
   */
  async function setShipmentItemQuantity(
    shipmentId: number,
    shipmentItemId: number,
  ): Promise<EngineShipmentItemAppendResult> {
    for (const [field, value] of [["shipmentId", shipmentId], ["shipmentItemId", shipmentItemId]] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new ShipStationPushError(`${field} must be a positive integer`, {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field,
          value,
        });
      }
    }

    return withShipmentPushLock<EngineShipmentItemAppendResult>(shipmentId, async () => {
      const shipmentResult: any = await db.execute(sql`
        SELECT os.id, os.requires_review, os.review_reason, os.shipstation_order_id,
               wo.order_edit_operation_id
        FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id = os.order_id
        WHERE os.id = ${shipmentId}
        LIMIT 1
      `);
      const shipment = shipmentResult?.rows?.[0];
      if (!shipment) {
        throw new ShipStationPushError("shipment not found", {
          code: SS_PUSH_INVALID_SHIPMENT, shipmentId, field: "shipment", value: null,
        });
      }
      if (shipment.requires_review === true) {
        throw new ShipStationPushError(
          `shipment requires review and cannot be amended (${shipment.review_reason ?? "review_required"})`,
          { code: SS_PUSH_INVALID_SHIPMENT, shipmentId, field: "shipment.requires_review", value: shipment.review_reason ?? true },
        );
      }
      const shipstationOrderId = Number(shipment.shipstation_order_id);
      if (!Number.isInteger(shipstationOrderId) || shipstationOrderId <= 0) {
        throw new ShipStationPushError("shipment has no ShipStation order identity for quantity amend", {
          code: SS_PUSH_INVALID_SHIPMENT, shipmentId, field: "shipment.shipstation_order_id", value: shipment.shipstation_order_id ?? null,
        });
      }

      const rowResult: any = await db.execute(sql`
        SELECT
          osi.id,
          osi.qty,
          osi.provider_membership_state,
          osi.order_item_id,
          oi.quantity AS order_item_quantity,
          oi.status AS order_item_status,
          COALESCE((
            SELECT SUM(other.qty)
            FROM wms.outbound_shipment_items other
            JOIN wms.outbound_shipments other_shipment ON other_shipment.id = other.shipment_id
            WHERE other.order_item_id = osi.order_item_id
              AND other.id <> osi.id
              AND other_shipment.status NOT IN ('voided', 'cancelled')
          ), 0)::int AS other_coverage
        FROM wms.outbound_shipment_items osi
        JOIN wms.order_items oi ON oi.id = osi.order_item_id
        WHERE osi.id = ${shipmentItemId}
          AND osi.shipment_id = ${shipmentId}
          AND osi.shipment_item_purpose = 'customer_fulfillment'
        LIMIT 1
      `);
      const row = rowResult?.rows?.[0];
      if (!row) {
        throw new ShipStationPushError("shipment item is missing, foreign, or not a customer line", {
          code: SS_PUSH_INVALID_SHIPMENT, shipmentId, field: "shipmentItemId", value: shipmentItemId,
        });
      }
      const currentQuantity = Number(row.qty);
      const targetQuantity = Number(row.order_item_quantity) - Number(row.other_coverage);
      if (!Number.isSafeInteger(currentQuantity) || !Number.isSafeInteger(targetQuantity)) {
        throw new ShipStationPushError("shipment item quantities are not integers", {
          code: SS_PUSH_INVALID_SHIPMENT, shipmentId, field: "qty", value: { currentQuantity, targetQuantity },
        });
      }
      if (row.order_item_status === "cancelled" || targetQuantity <= currentQuantity) {
        // Nothing to grow: already applied, or demand fell (a reduction owner decides).
        return { state: "already_applied", providerStatus: "not_checked" };
      }

      // Strict read: transport errors and unknown state throw and retry.
      const liveOrder = await apiRequest<any>("GET", `/orders/${shipstationOrderId}`);
      const providerStatus = String(liveOrder?.orderStatus ?? "unknown").toLowerCase();
      if (shipment.order_edit_operation_id != null && providerStatus !== "on_hold") {
        throw new OrderEditError("ORDER_EDIT_PROVIDER_HOLD_MISSING", "ShipStation must remain held while edited lines synchronize.");
      }
      const lineItemKey = `wms-item-${shipmentItemId}`;
      const liveItems: any[] = Array.isArray(liveOrder?.items) ? liveOrder.items : [];
      const liveLine = liveItems.find((item: any) => String(item?.lineItemKey ?? "").trim() === lineItemKey);

      const commitLocalQuantity = async () => {
        const updated: any = await commitAmendedShipmentItemQuantityInWms(db, {
          shipmentItemId,
          targetQuantity,
          currentQuantity,
        });
        if ((updated?.rows?.length ?? 0) !== 1) {
          // Changed underneath us; the retry recomputes from fresh rows.
          throw new ShipStationPushError("shipment item changed during quantity amend", {
            code: "SS_PUSH_QUANTITY_AMEND_CONFLICT", shipmentId, field: "qty", value: currentQuantity,
          });
        }
      };

      if (!liveLine) {
        if (row.provider_membership_state === "pending_append") {
          // Not in ShipStation yet; the pending append (serialized by this
          // lock) will send the row with its new quantity.
          await commitLocalQuantity();
          return { state: "applied", providerStatus };
        }
        throw new ShipStationPushError(
          `ShipStation order ${shipstationOrderId} has no line ${lineItemKey} to amend`,
          { code: "SS_PUSH_QUANTITY_AMEND_LINE_MISSING", shipmentId, field: "lineItemKey", value: lineItemKey },
        );
      }

      if (Number(liveLine.quantity) === targetQuantity) {
        // ShipStation already has it (an earlier attempt wrote it, then failed locally).
        await commitLocalQuantity();
        return { state: "already_applied", providerStatus };
      }
      if (providerStatus === "shipped" || providerStatus === "cancelled") {
        return { state: "not_editable", providerStatus };
      }
      if (providerStatus !== "awaiting_shipment" && providerStatus !== "on_hold") {
        throw new ShipStationPushError(
          `ShipStation amendment state is not recognized as editable or terminal (${providerStatus})`,
          { code: "SS_PUSH_AMENDMENT_STATE_UNKNOWN", shipmentId, field: "orderStatus", value: providerStatus },
        );
      }

      await apiRequest("POST", "/orders/createorder", {
        ...liveOrder,
        items: liveItems.map((item: any) =>
          String(item?.lineItemKey ?? "").trim() === lineItemKey ? { ...item, quantity: targetQuantity } : item),
      }, { replaySafe: true });

      const verifiedOrder = await apiRequest<any>("GET", `/orders/${shipstationOrderId}`);
      const verifiedLine = (Array.isArray(verifiedOrder?.items) ? verifiedOrder.items : [])
        .find((item: any) => String(item?.lineItemKey ?? "").trim() === lineItemKey);
      if (!verifiedLine || Number(verifiedLine.quantity) !== targetQuantity) {
        throw new ShipStationPushError(
          `ShipStation quantity amendment verification failed for ${lineItemKey}`,
          { code: "SS_PUSH_AMENDMENT_VERIFICATION_FAILED", shipmentId, field: "quantity", value: targetQuantity },
        );
      }
      await commitLocalQuantity();
      console.log(JSON.stringify({
        level: "info",
        action: "shipstation_line_quantity_amended",
        outcome: "applied",
        shipment_id: shipmentId,
        shipment_item_id: shipmentItemId,
        engine_ref: shipstationOrderId,
        before: currentQuantity,
        after: targetQuantity,
      }));
      return { state: "applied", providerStatus };
    });
  }
  // -------------------------------------------------------------------------
  // pushShipment — WMS-only reader (Commit 11 — §6 refactor plan).
  // -------------------------------------------------------------------------
  //
  // The replacement for legacy pushOrder(omsOrder). Reads every field it
  // needs from the wms.* namespace — which, post-Commit 7, carries a full
  // financial snapshot (amount_paid_cents, tax_cents, shipping_cents,
  // total_cents, unit_price_cents per line, currency). No OMS reads.
  //
  // Fails loudly via ShipStationPushError on invalid data rather than
  // silently emitting $0 to ShipStation (the bug from audit B1 / #56430).
  //
  // The live push path for WMS-native shipments, replacing the legacy
  // pushOrder flow.

  async function pushShipment(
    shipmentId: number,
    opts: { overrideReview?: boolean } = {},
  ): Promise<{ shipstationOrderId: number; orderKey: string }> {
    if (
      !Number.isInteger(shipmentId) ||
      shipmentId <= 0
    ) {
      throw new ShipStationPushError("shipmentId must be a positive integer", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "shipmentId",
        value: shipmentId,
      });
    }

    // Serialize concurrent pushes for the SAME shipment. Without this, two
    // near-simultaneous pushes (multiple Shopify webhooks, or create+edit,
    // firing within milliseconds) both read shipstation_order_id = null before
    // either writes it back, so both take the CREATE path. ShipStation's
    // orderKey upsert is NOT atomic under that race, so it ends up with TWO
    // orders for the same shipment (see #58408, #62452). The lock makes the
    // second push wait for the first to finish and persist its order id — it
    // then sees the id and UPDATES the existing SS order instead of creating a
    // duplicate. It MUST be a session lock on a pinned connection: issuing
    // pg_advisory_lock through the pooled db handle serialized nothing (see
    // server/infrastructure/session-advisory-lock.ts).
    return withShipmentPushLock(shipmentId, () => pushShipmentLocked(shipmentId, opts));
  }

  /** Body of pushShipment. Only ever invoked under withShipmentPushLock. */
  async function pushShipmentLocked(
    shipmentId: number,
    opts: { overrideReview?: boolean },
  ): Promise<{ shipstationOrderId: number; orderKey: string }> {

    // ─── 1. Load shipment header (WMS only) ─────────────────────────
    const shipmentRows = await db.select({
      id: outboundShipments.id,
      order_id: outboundShipments.orderId,
      channel_id: outboundShipments.channelId,
      status: outboundShipments.status,
      held: outboundShipments.held,
      requires_review: outboundShipments.requiresReview,
      review_reason: outboundShipments.reviewReason,
      shipstation_order_id: outboundShipments.shipstationOrderId,
      shipstation_order_key: outboundShipments.shipstationOrderKey,
      shipment_purpose: outboundShipments.shipmentPurpose,
      replaces_shipment_id: outboundShipments.replacesShipmentId,
      replacement_reason: outboundShipments.replacementReason,
    })
      .from(outboundShipments)
      .where(eq(outboundShipments.id, shipmentId))
      .limit(1);

    const shipmentRow = shipmentRows[0] as WmsShipmentRow | undefined;
    if (!shipmentRow) {
      throw new ShipStationPushError("shipment not found", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "shipment",
        value: null,
      });
    }
    if (!PUSHABLE_SHIPMENT_STATUSES.has(shipmentRow.status)) {
      throw new ShipStationPushError(
        `shipment status '${shipmentRow.status}' is not pushable`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment.status",
          value: shipmentRow.status,
        },
      );
    }

    // Idempotency: if this shipment already has a ShipStation order ID,
    // pass it in the payload so SS updates the existing order instead of
    // creating a duplicate.
    const existingSsOrderId = shipmentRow.shipstation_order_id;
    const isReplacementShipment = shipmentRow.shipment_purpose === "replacement";
    const isUpdate =
      existingSsOrderId != null &&
      Number.isInteger(existingSsOrderId) &&
      existingSsOrderId > 0;
    if (shipmentRow.requires_review === true && !opts.overrideReview) {
      throw new ShipStationPushError(
        `shipment requires review and cannot be pushed to ShipStation (${shipmentRow.review_reason ?? "review_required"})`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment.requires_review",
          value: shipmentRow.review_reason ?? true,
        },
      );
    }
    if (shipmentRow.held === true) {
      // A held shipment (line-item hold — LINE-ITEM-HOLD-DESIGN.md P2) must
      // never reach ShipStation until it is released. Single chokepoint: every
      // push path funnels through pushShipment, so this one guard covers them all.
      throw new ShipStationPushError(
        "shipment is held and cannot be pushed to ShipStation",
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "shipment.held",
          value: true,
        },
      );
    }
    // ─── 2. Load order (WMS only, with financial snapshot) ──────────
    const orderRows = await db.select({
      id: wmsOrders.id,
      order_number: wmsOrders.orderNumber,
      channel_id: wmsOrders.channelId,
      warehouse_id: wmsOrders.warehouseId,
      oms_fulfillment_order_id: wmsOrders.omsFulfillmentOrderId,
      warehouse_status: wmsOrders.warehouseStatus,
      financial_status: wmsOrders.financialStatus,
      cancelled_at: wmsOrders.cancelledAt,
      order_edit_operation_id: wmsOrders.orderEditOperationId,
      on_hold: wmsOrders.onHold,
      sort_rank: wmsOrders.sortRank,
      external_order_id: wmsOrders.externalOrderId,
      customer_name: wmsOrders.customerName,
      customer_email: wmsOrders.customerEmail,
      shipping_name: wmsOrders.shippingName,
      shipping_company: wmsOrders.shippingCompany,
      shipping_address: wmsOrders.shippingAddress,
      shipping_address2: wmsOrders.shippingAddress2,
      shipping_city: wmsOrders.shippingCity,
      shipping_state: wmsOrders.shippingState,
      shipping_postal_code: wmsOrders.shippingPostalCode,
      shipping_country: wmsOrders.shippingCountry,
      amount_paid_cents: wmsOrders.amountPaidCents,
      tax_cents: wmsOrders.taxCents,
      shipping_cents: wmsOrders.shippingCents,
      discount_cents: wmsOrders.discountCents,
      total_cents: wmsOrders.totalCents,
      currency: wmsOrders.currency,
      order_placed_at: wmsOrders.orderPlacedAt,
    })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, shipmentRow.order_id))
      .limit(1);

    const orderRow = orderRows[0] as WmsOrderRow | undefined;
    if (!orderRow) {
      throw new ShipStationPushError("wms order not found for shipment", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "order",
        value: shipmentRow.order_id,
      });
    }
    const finalFinancialStatus = String(orderRow.financial_status ?? "").toLowerCase();
    if (orderRow.order_edit_operation_id != null) {
      throw new OrderEditError("ORDER_EDIT_PROVIDER_HELD", "This order is held for an edit; ordinary shipment pushes cannot resume it.");
    }
    const verifiedRefundMerchandise = finalFinancialStatus === "refunded"
      && orderRow.channel_id !== null
      && orderRow.oms_fulfillment_order_id !== null && /^[1-9]\d*$/.test(orderRow.oms_fulfillment_order_id)
      && await verifyRefundedChannelMerchandise(db, Number(orderRow.oms_fulfillment_order_id), "dispatch",
        { usesChannelMerchandise: dependencies.useChannelMerchandise, readSnapshot: dependencies.readChannelMerchandise });
    if (
      orderRow.warehouse_status === "cancelled" ||
      orderRow.cancelled_at != null ||
      (finalFinancialStatus === "refunded" && !verifiedRefundMerchandise) ||
      finalFinancialStatus === "voided"
    ) {
      throw new ShipStationPushError(
        `WMS order ${orderRow.id} is ${orderRow.warehouse_status}/${orderRow.financial_status} — refusing to push cancelled/refunded order to ShipStation`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "order.warehouse_status",
          value: orderRow.warehouse_status,
        },
      );
    }

    const omsBlocker = await getOmsFinalOrderBlockerForShipmentPush(
      orderRow.oms_fulfillment_order_id,
      verifiedRefundMerchandise,
    );
    if (
      omsBlocker.blocked &&
      !(isReplacementShipment && omsBlocker.reason === "oms_fully_shipped")
    ) {
      throw new ShipStationPushError(
        `OMS order ${orderRow.oms_fulfillment_order_id} is ${omsBlocker.reason} — refusing to push cancelled/refunded order to ShipStation`,
        {
          code: SS_PUSH_INVALID_SHIPMENT,
          shipmentId,
          field: "oms.status",
          value: omsBlocker.reason,
        },
      );
    }

    const nonShippingRows: any = await db.execute(sql`
      SELECT COALESCE(SUM(oi.total_price_cents), 0)::int AS non_shipping_total_cents
      FROM wms.order_items oi
      WHERE oi.order_id = ${orderRow.id}
        AND COALESCE(oi.requires_shipping, 1) = 0
    `);
    orderRow.non_shipping_total_cents = readIntegerCents(nonShippingRows?.rows?.[0]?.non_shipping_total_cents ?? 0, "non shipping total", true);

    const itemRows = await db.select({
      id: outboundShipmentItems.id,
      order_item_id: sql<number>`COALESCE(
        ${outboundShipmentItems.orderItemId},
        ${outboundShipmentItems.replacementForOrderItemId}
      )`,
      sku: wmsOrderItems.sku,
      name: wmsOrderItems.name,
      qty: sql<number>`LEAST(COALESCE(${outboundShipmentItems.commercialRequestedQty}, ${outboundShipmentItems.qty}), ${outboundShipmentItems.qty})`,
      unit_price_cents: wmsOrderItems.paidPriceCents,
    })
      .from(outboundShipmentItems)
      .innerJoin(
        wmsOrderItems,
        sql`${wmsOrderItems.id} = COALESCE(
          ${outboundShipmentItems.orderItemId},
          ${outboundShipmentItems.replacementForOrderItemId}
        )`,
      )
      .where(and(
        eq(outboundShipmentItems.shipmentId, shipmentId),
        sql`COALESCE(${wmsOrderItems.requiresShipping}, 1) = 1`,
        // Source qty stays positive for provider-label lineage. Only currently
        // requested units belong in a new or amended ShipStation order.
        sql`COALESCE(${outboundShipmentItems.commercialRequestedQty}, ${outboundShipmentItems.qty}) > 0`,
      ))
      .orderBy(outboundShipmentItems.id) as WmsShipmentItemRow[];

    if (itemRows.length === 0) {
      throw new ShipStationPushError("shipment has no items", {
        code: SS_PUSH_INVALID_SHIPMENT,
        shipmentId,
        field: "items",
        value: 0,
      });
    }

    // ─── 4. Validate (throws ShipStationPushError on violation) ─────
    const shippableTotalsResult: any = await db.execute(sql`
      SELECT
        COALESCE(SUM(oi.quantity), 0)::int AS order_shippable_qty,
        COALESCE(SUM(LEAST(COALESCE(osi.commercial_requested_qty, osi.qty), osi.qty)), 0)::int AS shipment_shippable_qty
      FROM wms.order_items oi
      LEFT JOIN wms.outbound_shipment_items osi
        ON COALESCE(osi.order_item_id, osi.replacement_for_order_item_id) = oi.id
       AND osi.shipment_id = ${shipmentId}
      WHERE oi.order_id = ${orderRow.id}
        AND COALESCE(oi.requires_shipping, 1) = 1
    `);
    const orderShippableQty = Number(shippableTotalsResult?.rows?.[0]?.order_shippable_qty ?? 0);
    const shipmentShippableQty = Number(shippableTotalsResult?.rows?.[0]?.shipment_shippable_qty ?? 0);
    orderRow.is_partial_shipment = shipmentShippableQty > 0 && shipmentShippableQty < orderShippableQty;

    validateShipmentForPush(shipmentRow, orderRow, itemRows);
    const shippingCountry = requireShipStationCountryCode(orderRow.shipping_country, shipmentId);

    // Validate the local destination before even reading provider state.
    // Never resurrect a cancelled ShipStation order: createorder reactivates a
    // cancelled order to awaiting_shipment (ENGINE-CANCEL-DIVERGENCE-DESIGN.md;
    // markAsShipped already guards this for the ship path). Only relevant on an
    // UPDATE (existing SS order) — a fresh create has nothing to resurrect.
    // An explicit operator override (clear-review-and-push, P2) intentionally
    // resurrects the cancelled SS order, so it skips this guard.
    if (isUpdate && !opts.overrideReview) {
      const liveSsOrder = await getOrderById(existingSsOrderId as number);
      if (liveSsOrder?.orderStatus === "cancelled") {
        throw new ShipStationPushError(
          "ShipStation order is cancelled — refusing to resurrect it via push",
          {
            code: SS_PUSH_INVALID_SHIPMENT,
            shipmentId,
            field: "ss_order.cancelled",
            value: existingSsOrderId,
          },
        );
      }
    }

    // ─── 5. Build SS payload ────────────────────────────────────────
    // `let` because the sibling-dedup guard (step 6) may adopt an existing
    // ShipStation order's key when a duplicate full shipment is detected.
    let orderKey = shipStationOrderKeyForShipment(shipmentId);

    // eBay keeps the "EB-" prefix convention from pushOrder so packer-
    // facing order numbers stay stable across the flag flip.
    const orderNumber = shipStationOrderNumberForWmsOrder(orderRow);

    const orderDateIso = orderRow.order_placed_at
      ? new Date(orderRow.order_placed_at).toISOString()
      : new Date().toISOString();

    // Resolve ShipStation store/warehouse routing (data-driven, falls back to env/hardcoded)
    const routing = await resolveShipStationIds(db, {
      channelId: orderRow.channel_id,
      warehouseId: orderRow.warehouse_id,
    });

    // PACKER INSTRUCTION v1: box choice from the shipping engine's pack plan.
    // Feature-flagged (SHIPPING_PACK_INSTRUCTION_ENABLED), never throws, and
    // all shipping.pack_plans* writes stay inside the shipping-engine module.
    const packInstruction = await maybeGetPackInstruction(orderRow.id, shipmentId);
    const provenanceNote = `Source: wms shipment ${shipmentId} (channel ${orderRow.channel_id ?? "unknown"}) via Echelon WMS`;

    const payload: Record<string, unknown> = {
      orderNumber,
      orderKey,
      orderDate: orderDateIso,
      paymentDate: orderDateIso,
      // Completion releases only the edit hold. A manual warehouse hold still
      // applies to a newly rebuilt provider job on its very first write.
      orderStatus: orderRow.on_hold === 1 ? "on_hold" : "awaiting_shipment",
      customerUsername: orderRow.customer_name || "",
      customerEmail: orderRow.customer_email || `no-email+wms-${orderRow.id}@cardshellz.local`,
      billTo: {
        name: orderRow.customer_name || "",
      },
      shipTo: {
        name: orderRow.shipping_name || orderRow.customer_name || "",
        company: orderRow.shipping_company || "",
        street1: orderRow.shipping_address || "",
        street2: orderRow.shipping_address2 || "",
        city: orderRow.shipping_city || "",
        state: orderRow.shipping_state || "",
        postalCode: orderRow.shipping_postal_code || "",
        country: shippingCountry,
        phone: "",
      },
      items: itemRows.map((item) => ({
        lineItemKey: `wms-item-${item.id}`,
        sku: item.sku || "",
        name: item.name || "",
        quantity: item.qty,
        unitPrice: isReplacementShipment ? 0 : item.unit_price_cents / 100,
        options: [] as unknown[],
      })),
      amountPaid: isReplacementShipment ? 0 : orderRow.amount_paid_cents / 100,
      taxAmount: isReplacementShipment ? 0 : orderRow.tax_cents / 100,
      shippingAmount: isReplacementShipment ? 0 : orderRow.shipping_cents / 100,
      internalNotes: packInstruction ? `${packInstruction} | ${provenanceNote}` : provenanceNote,
      advancedOptions: {
        warehouseId: routing.warehouseId,
        storeId: routing.storeId,
        source: "echelon-wms",
        customField1: orderRow.sort_rank || "",
        customField2: `wms_order_id:${orderRow.id}|shipment_id:${shipmentId}`,
        customField3: `oms_order_id:${orderRow.oms_fulfillment_order_id ?? ""}`,
      },
    };

    // ─── 6. Push to ShipStation ─────────────────────────────────────
    // Idempotency: if this shipment already has a SS order ID (from the
    // initial load or from a concurrent push that landed between our
    // SELECT and now), include it so SS updates instead of creating a
    // duplicate.
    let ssOrderIdForPayload: number | null = isUpdate
      ? (shipmentRow.shipstation_order_id ?? null)
      : null;

    if (!ssOrderIdForPayload) {
      // One query closes BOTH races in a single round-trip:
      //
      //  (a) self    — a concurrent push set THIS shipment's SS order id
      //      after our initial SELECT. Adopt it so we UPDATE (orderId in
      //      payload) rather than create a duplicate ShipStation order.
      //
      //  (b) sibling — a DUPLICATE full shipment for the same WMS order
      //      already has a ShipStation order. ShipStation dedups on
      //      orderKey, and our key is per-shipment (echelon-wms-shp-<id>),
      //      so two shipment rows would otherwise emit two keys and create
      //      TWO ShipStation orders. Adopt the sibling's id + key so one WMS
      //      order maps to exactly one ShipStation order. The advisory lock
      //      + unique index on wms.orders prevent the duplicate WMS order
      //      upstream; this is the last-line backstop at the push layer.
      //      Genuine partial/split shipments are EXEMPT — a real split
      //      legitimately gets its own ShipStation order per box.
      //
      // Self is preferred over siblings (ORDER BY is_self DESC) and is
      // always adopted; a sibling is only adopted for full shipments.
      const dedupCheck: any = await db.execute(sql`
        SELECT id, shipstation_order_id, shipstation_order_key,
               (id = ${shipmentId}) AS is_self
        FROM wms.outbound_shipments
        WHERE order_id = ${shipmentRow.order_id}
          AND shipstation_order_id IS NOT NULL
          AND (id = ${shipmentId} OR status NOT IN ('voided', 'cancelled'))
        ORDER BY (id = ${shipmentId}) DESC, id
        LIMIT 1
      `);
      const hit = dedupCheck?.rows?.[0];
      const hitSsId = Number(hit?.shipstation_order_id ?? 0);
      // pg returns boolean as true / "t" depending on driver/casting.
      const isSelf =
        hit?.is_self === true || hit?.is_self === "t" || Number(hit?.id) === shipmentId;
      if (
        Number.isInteger(hitSsId) &&
        hitSsId > 0 &&
        (isSelf || (!isReplacementShipment && !orderRow.is_partial_shipment))
      ) {
        ssOrderIdForPayload = hitSsId;
        if (!isSelf) {
          // Adopt the sibling's orderKey so the existing ShipStation order
          // keeps its stable identity — don't flip its key to this
          // duplicate shipment's key (SHIP_NOTIFY parses key → shipmentId).
          const siblingKey = hit?.shipstation_order_key as string | undefined;
          if (siblingKey) {
            orderKey = siblingKey;
            payload.orderKey = siblingKey;
          }
          console.warn(
            `[ShipStation] Duplicate full shipment for WMS order ${shipmentRow.order_id}: ` +
              `shipment ${shipmentId} adopting sibling SS order ${hitSsId} ` +
              `instead of creating a second ShipStation order`,
          );
        }
      }
    }

    // If a prior push succeeded remotely but local linkage did not commit, the
    // retry must adopt that exact provider order instead of sending another
    // create/update request. ShipStation V1 ignores orderKey as a query filter,
    // so query by supported orderNumber and filter the exact key locally.
    if (!ssOrderIdForPayload) {
      // Lookup failures are retryable and deliberately do not fall through to
      // CREATE because the previous request may already exist in ShipStation.
      const existingSsOrder = await getOrderByKey(orderKey, orderNumber);
      if (existingSsOrder) {
        const proof = proveShipStationOrderAdoption(
          {
            shipmentId,
            wmsOrderId: orderRow.id,
            orderNumber,
            items: itemRows.map((item) => ({
              lineItemKey: `wms-item-${item.id}`,
              quantity: item.qty,
            })),
          },
          existingSsOrder,
        );
        if (!proof.matched) {
          throw new ShipStationPushError(
            `ShipStation order ${existingSsOrder.orderId ?? "unknown"} cannot be adopted for shipment ${shipmentId}: ${proof.reason}`,
            {
              code: SS_PUSH_INVALID_SHIPMENT,
              shipmentId,
              field: "provider_order_identity",
              value: proof.reason,
            },
          );
        }

        const adoption = await db.transaction((tx: any) =>
          adoptProvenShipStationOrder(tx, {
            shipmentId,
            providerOrderId: proof.providerOrderId,
            orderKey: proof.orderKey,
          }),
        );
        if (adoption.state !== "linked") {
          throw new ShipStationPushError(
            `ShipStation order ${proof.providerOrderId} adoption failed for shipment ${shipmentId}: ${adoption.state}`,
            {
              code: SS_PUSH_INVALID_SHIPMENT,
              shipmentId,
              field: "provider_order_linkage",
              value: adoption,
            },
          );
        }

        await recomputeOrderStatusFromShipments(db, adoption.wmsOrderId);
        console.warn(
          `[ShipStation] pushShipment ${shipmentId}: adopted exact existing SS order ` +
            `${proof.providerOrderId} for key ${proof.orderKey}; no provider write was repeated`,
        );
        return {
          shipstationOrderId: proof.providerOrderId,
          orderKey: proof.orderKey,
        };
      }
    }
    if (ssOrderIdForPayload) {
      payload.orderId = ssOrderIdForPayload;
      console.log(
        `[ShipStation] Updating existing SS order ${ssOrderIdForPayload} for WMS shipment ${shipmentId} (key: ${orderKey})`,
      );
    }

    // A keyed CREATE (no orderId) is never replayed after a 429: the first
    // attempt's outcome is unknown and ShipStation's orderKey upsert does not
    // reliably dedup a replay (#58408, #62452). The transient error re-drives
    // the whole push through the retry ladder, where getOrderByKey adopts
    // whatever landed. An UPDATE (orderId present) is an idempotent upsert
    // addressed by id and may replay.
    const result = await apiRequest<ShipStationCreateOrderResponse>(
      "POST",
      "/orders/createorder",
      payload,
      { replaySafe: Boolean(payload.orderId) },
    );

    // ─── 7. Mark shipment queued + persist engine refs ────────────────
    // Write both the legacy SS columns (back-compat) and the engine-
    // agnostic triple (C9) in a single atomic UPDATE.
    const now = new Date();
    let queued = false;
    // False when step 6 adopted a duplicate sibling's ShipStation order: that
    // order belongs to the sibling, so it must never be linked to or
    // cancelled on behalf of THIS shipment.
    const pushedOwnOrder = orderKey === shipStationOrderKeyForShipment(shipmentId);
    await db.transaction(async (tx: any) => {
      queued = await markOutboundShipmentQueuedAfterShipStationPushInWms(tx, {
        shipmentId,
        shipstationOrderId: result.orderId,
        orderKey,
        now,
      });
      if (!queued && pushedOwnOrder) {
        // The shipment left a pushable state while ShipStation was creating
        // the order (cancel paths do not wait for this lock). The provider
        // order exists regardless: save its id without touching status so it
        // is never orphaned, then stop it below (#65805).
        const link = await linkShipStationOrderIdentityOnOutboundShipmentInWms(tx, {
          shipmentId,
          providerOrderId: result.orderId,
          orderKey,
          now,
        });
        if (!link.linked) {
          throw new ShipStationPushError(
            `shipment ${shipmentId} is linked to ShipStation order ${link.existingProviderOrderId}; push created ${result.orderId}`,
            {
              code: SS_PUSH_INVALID_SHIPMENT,
              shipmentId,
              field: "provider_order_linkage",
              value: { existing: link.existingProviderOrderId, created: result.orderId },
            },
          );
        }
      }

      await resolveShipStationHandoffCommands(
        tx,
        shipmentId,
        "provider handoff persisted",
      );

      if (opts.overrideReview) {
        // The operator explicitly resolved the review by re-pushing; clear the
        // flag so the shipment leaves the SHIPMENT_REQUIRES_REVIEW bucket
        // (ENGINE-CANCEL-DIVERGENCE-DESIGN.md P2). Only when the push actually
        // re-queued the row: a row that stopped mid-flight is handled, and
        // flagged if needed, below.
        if (queued) {
          await clearOutboundShipmentReviewFlagByReasonInWms(tx, {
            shipmentId,
            updatedAt: now,
          });
        }
      }
    });
    if (!queued) {
      await stopProviderOrderForStoppedShipment(
        shipmentId,
        shipmentRow.order_id,
        result.orderId,
        pushedOwnOrder,
      );
      return { shipstationOrderId: result.orderId, orderKey };
    }
    await recomputeOrderStatusFromShipments(db, shipmentRow.order_id);

    console.log(
      `[ShipStation] ${isUpdate ? "Updated" : "Pushed"} WMS shipment ${shipmentId} → SS order ${result.orderId} (key: ${orderKey})`,
    );

    return { shipstationOrderId: result.orderId, orderKey };
  }

  /**
   * A push landed after the shipment stopped being pushable. Runs under the
   * push lock. A cancelled shipment must not stay live in ShipStation, so the
   * provider order is cancelled now. Any outcome that is not a proven stop is
   * flagged for review (never swallowed); the queue sweeper retries the
   * cancel for cancelled shipments, so a transient failure here self-heals.
   */
  async function stopProviderOrderForStoppedShipment(
    shipmentId: number,
    wmsOrderId: number,
    providerOrderId: number,
    pushedOwnOrder: boolean,
  ): Promise<void> {
    const current: any = await db.execute(sql`
      SELECT status FROM wms.outbound_shipments WHERE id = ${shipmentId} LIMIT 1
    `);
    const status = String(current?.rows?.[0]?.status ?? "missing");
    const fields = {
      action: "push_landed_after_shipment_stopped",
      wms_shipment_id: shipmentId,
      wms_order_id: wmsOrderId,
      engine_ref: providerOrderId,
      before: { status },
    };

    if (status !== "cancelled" || !pushedOwnOrder) {
      // Shipped/returned/lost while a push was in flight, or the provider order
      // is a duplicate sibling's: nothing to cancel safely without a human.
      await setOutboundShipmentReviewFlagInWms(db, shipmentId, SS_REVIEW_PUSH_AFTER_TERMINAL);
      platformLogger.error("shipstation.push", { ...fields, outcome: "flagged_for_review",
        error_code: SS_REVIEW_PUSH_AFTER_TERMINAL });
      return;
    }

    const sharing = await countOpenShipmentsSharingShipStationOrderInWms(db, {
      shipmentId,
      providerOrderId,
      orderKey: shipStationOrderKeyForShipment(shipmentId),
    });
    if (sharing > 0) {
      await setOutboundShipmentReviewFlagInWms(db, shipmentId, SS_REVIEW_PUSH_AFTER_TERMINAL);
      platformLogger.error("shipstation.push", { ...fields, outcome: "flagged_for_review",
        error_code: SS_REVIEW_PUSH_AFTER_TERMINAL, shared_with_open_shipments: sharing });
      return;
    }

    if (!cancelProviderOrder) {
      await setOutboundShipmentReviewFlagInWms(db, shipmentId, SS_REVIEW_CANCEL_UNVERIFIED);
      platformLogger.error("shipstation.push", { ...fields, outcome: "cancel_unavailable",
        error_code: SS_REVIEW_CANCEL_UNVERIFIED });
      return;
    }

    try {
      const cancel = await cancelProviderOrder(providerOrderId);
      if (cancel.state === "cancelled" || cancel.state === "already_cancelled") {
        platformLogger.warn("shipstation.push", { ...fields, outcome: "provider_order_cancelled",
          after: { status, provider_state: cancel.state } });
        return;
      }
      // already_shipped, or not_found (getOrderById could not read it): not proven stopped.
      await setOutboundShipmentReviewFlagInWms(db, shipmentId, SS_REVIEW_CANCEL_UNVERIFIED);
      platformLogger.error("shipstation.push", { ...fields, outcome: "flagged_for_review",
        error_code: SS_REVIEW_CANCEL_UNVERIFIED, after: { status, provider_state: cancel.state } });
    } catch (err: any) {
      await setOutboundShipmentReviewFlagInWms(db, shipmentId, SS_REVIEW_CANCEL_UNVERIFIED);
      platformLogger.error("shipstation.push", { ...fields, outcome: "cancel_failed",
        error_code: SS_REVIEW_CANCEL_UNVERIFIED, error: err?.message ?? String(err) });
    }
  }

  return {
    pushShipment,
    appendShipmentItems,
    setShipmentItemQuantity,
  };
}
