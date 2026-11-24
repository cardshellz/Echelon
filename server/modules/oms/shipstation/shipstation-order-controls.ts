import { centsToJsonDollars } from "@shared/money-read";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { OrderEditError } from "../../order-edits/oms-coordination.api";
import {
  appendOrderEditShippingAudit,
  prepareOrderEditHeldPartitions,
  providerCarriesManualHold,
  verifyDeferredHeldPartition,
} from "../application/order-edit-held-partitions";
import { clearOutboundShipmentReviewFlagByReasonInWms } from "../../wms/outbound-shipment-mutations.api";
import {
  ORDER_EDIT_PROVIDER_HOLD_UNTIL,
  requireShipStationCountryCode,
  type ShipStationRuntimeContext,
} from "./shipstation-contracts";

export function createShipStationOrderControls(ctx: ShipStationRuntimeContext) {
  const { db, dependencies, apiRequest, isConfigured, withShipmentPushLock, getOrderById } = ctx;

  // -------------------------------------------------------------------------
  // Hold / Release on ShipStation side
  // -------------------------------------------------------------------------

  /**
   * Put a ShipStation order on hold. ShipStation requires a holdUntilDate,
   * so we use a sentinel far-future date for indefinite holds. Echelon
   * controls when it's released.
   */
  async function putOrderOnHold(shipstationOrderId: number): Promise<void> {
    if (!isConfigured()) return;
    try {
      await apiRequest("POST", "/orders/holduntil", {
        orderId: shipstationOrderId,
        holdUntilDate: "2099-12-31",
      }, { replaySafe: true });
      console.log(`[ShipStation] Order ${shipstationOrderId} placed on hold`);
    } catch (err: any) {
      console.error(`[ShipStation] Failed to hold order ${shipstationOrderId}:`, err.message);
      throw err;
    }
  }

  /**
   * Release a ShipStation order from hold back into Awaiting Shipment.
   */
  async function releaseOrderFromHold(shipstationOrderId: number): Promise<void> {
    if (!isConfigured()) return;
    try {
      await withOrderEditProviderFence(shipstationOrderId, async () => {
        await apiRequest("POST", "/orders/restorefromhold", {
          orderId: shipstationOrderId,
        }, { replaySafe: true });
      });
      console.log(`[ShipStation] Order ${shipstationOrderId} released from hold`);
    } catch (err: any) {
      console.error(`[ShipStation] Failed to release order ${shipstationOrderId} from hold:`, err.message);
      throw err;
    }
  }
  /** A stale manual release or cosmetic upsert cannot lift an edit-owned hold. */
  async function withOrderEditProviderFence<T>(providerOrderId: number, write: () => Promise<T>): Promise<T> {
    return db.transaction(async (tx: any) => {
      const result = await tx.execute(sql`SELECT wo.id,wo.order_edit_operation_id FROM wms.orders wo
        WHERE EXISTS(SELECT 1 FROM wms.outbound_shipments os WHERE os.order_id=wo.id
          AND (os.shipstation_order_id=${providerOrderId} OR (os.shipping_engine='shipstation' AND os.engine_order_ref=${String(providerOrderId)})))
        ORDER BY wo.id FOR UPDATE OF wo`);
      if ((result.rows ?? []).some((row: { order_edit_operation_id?: string | null }) => row.order_edit_operation_id != null)) {
        throw new OrderEditError("ORDER_EDIT_PROVIDER_HELD", "This shipment is held by an order edit.");
      }
      return write();
    });
  }

  /**
   * Order-edit shipping owner. Serializes against ordinary push/amend, persists
   * the original provider hold before mutation, and never creates a new label.
   */
  async function synchronizeOrderEditShipment(input: {
    shipmentId: number; operationId: string; mode: "hold" | "verify" | "synchronize" | "release" | "verify_shipped" | "verify_cancelled" | "verify_retired" | "release_unsubmitted";
  }): Promise<{ retiredShipmentIds: number[] }> {
    z.object({ shipmentId: z.number().int().positive(), operationId: z.string().uuid(),
      mode: z.enum(["hold", "verify", "synchronize", "release", "verify_shipped", "verify_cancelled", "verify_retired", "release_unsubmitted"]) }).strict().parse(input);
    const providerSchema = z.object({ orderId: z.number().int().positive(), orderNumber: z.string().min(1), orderStatus: z.string(),
      items: z.array(z.object({ lineItemKey: z.string(), quantity: z.number().int().nonnegative() }).passthrough()) }).passthrough();
    const itemSchema = z.object({ id: z.number().int().positive(), qty: z.number().int().positive(),
      sku: z.string(), name: z.string(), unit_price_cents: z.coerce.number().int().nonnegative().safe() });
    const retiredShipmentIds: number[] = [];
    const headerSchema = z.object({ id: z.number().int().positive(), order_id: z.number().int().positive(),
      provider_order_id: z.number().int().positive().nullable(), order_edit_operation_id: z.string().uuid().nullable(),
      source: z.string().nullable(), order_number: z.string().min(1),
      status: z.string(), warehouse_status: z.string(), on_hold: z.number().int(), held: z.boolean(), requires_review: z.boolean() });
    async function lock(tx: any) {
      const source = await tx.execute(sql`SELECT oo.id FROM oms.oms_orders oo JOIN oms.order_edit_operations operation
        ON operation.oms_order_id=oo.id WHERE operation.id=${input.operationId}::uuid
        AND operation.status NOT IN ('completed','recovered','expired','failed') FOR UPDATE OF oo`);
      if (source.rows?.length !== 1) throw new OrderEditError("ORDER_EDIT_HOLD_OWNER_INVALID", "The active edit no longer owns this order.");
      if (input.mode === "release_unsubmitted") {
        const unsent =
          await tx.execute(sql`SELECT id FROM oms.order_edit_operations WHERE id=${input.operationId}::uuid
          AND document ?& ARRAY['commitStartedAt','commitKey','refundIntent','refundStartedAt','recoveryStartedAt']
          AND document->>'commitStartedAt' IS NULL AND document->>'commitKey' IS NULL AND document->>'refundIntent' IS NULL
          AND document->>'refundStartedAt' IS NULL AND document->>'recoveryStartedAt' IS NULL
          AND NOT EXISTS (SELECT 1 FROM oms.order_edit_paid_projections WHERE operation_id=${input.operationId}::uuid) FOR UPDATE`);
        if (unsent.rows?.length !== 1)
          throw new OrderEditError(
            "ORDER_EDIT_ALREADY_SUBMITTED",
            "A submitted or uncertain edit cannot release an unsubmitted hold.",
          );
      }
      const order = await tx.execute(sql`SELECT wo.id FROM wms.orders wo
        WHERE wo.id=(SELECT order_id FROM wms.outbound_shipments WHERE id=${input.shipmentId}) FOR UPDATE OF wo`);
      if (order.rows?.length !== 1) throw new OrderEditError("ORDER_EDIT_SHIPMENT_MISSING", "The warehouse shipment is unavailable.");
      const result = await tx.execute(sql`SELECT os.id,os.order_id,os.status,os.held,os.requires_review,os.source,wo.order_number,
        COALESCE(os.shipstation_order_id,CASE WHEN os.shipping_engine='shipstation' AND os.engine_order_ref ~ '^[0-9]+$'
          AND length(os.engine_order_ref)<10 THEN os.engine_order_ref::int END) AS provider_order_id,
        wo.order_edit_operation_id,wo.warehouse_status,wo.on_hold FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id=os.order_id
        WHERE os.id=${input.shipmentId} FOR UPDATE OF os`);
      const row = headerSchema.parse(result.rows?.[0]);
      if (row.order_edit_operation_id !== input.operationId || (input.mode !== "release_unsubmitted" && (row.requires_review ||
        (input.mode === "verify_shipped" ? row.warehouse_status !== "shipped" : input.mode === "verify_cancelled" ? row.warehouse_status !== "cancelled" || !["cancelled", "voided"].includes(row.status) : input.mode === "verify_retired" ? !["cancelled", "voided"].includes(row.status) || !["ready", "cancelled"].includes(row.warehouse_status) : !["planned", "queued", "on_hold"].includes(row.status))))) {
        throw new OrderEditError("ORDER_EDIT_SHIPMENT_CHANGED", "The shipment is no longer held by this editable operation.");
      }
      // A timed-out push may have created a remote order before its identity
      // was persisted. Absence of the local ID is not proof of provider absence.
      if (row.provider_order_id === null && !(row.source === "line_item_hold" && row.held && row.status === "planned"))
        throw new OrderEditError("ORDER_EDIT_PROVIDER_IDENTITY_UNVERIFIED", "We couldn’t verify that this order is ready for changes. Contact us for help.");
      return row;
    }
    async function readScope(orderNumber: string) {
      // Independent provider reads share one bounded phase, rather than serial
      // ten-second order lookups repeated for every confirmation.
      const [orderResult, labelResult] = await Promise.all([
        apiRequest<unknown>("GET", `/orders?orderNumber=${encodeURIComponent(orderNumber)}&page=1&pageSize=100`),
        apiRequest<unknown>("GET", `/shipments?orderNumber=${encodeURIComponent(orderNumber)}&page=1&pageSize=100`),
      ]);
      const related = z.object({ orders: z.array(z.object({ orderId: z.number().int().positive(), orderNumber: z.string(), orderStatus: z.string() }).passthrough()),
        pages: z.number().int().nonnegative() }).passthrough().parse(orderResult);
      const labels = z.object({ shipments: z.array(z.object({ orderId: z.number().int(), orderNumber: z.string(), voided: z.boolean() }).passthrough()),
        pages: z.number().int().nonnegative() }).passthrough().parse(labelResult);
      if (related.pages > 1 || labels.pages > 1)
        throw new OrderEditError("ORDER_EDIT_PROVIDER_SPLIT_UNVERIFIED", "We couldn’t verify every shipment for this order. Your order has not been changed. Contact us for help.");
      return { related, labels };
    }
    async function readProvider(providerOrderId: number, orderNumber: string, terminal?: "shipped" | "cancelled") {
      const fulfilled = terminal === "shipped";
      const { related, labels } = await readScope(orderNumber);
      const observed = related.orders.find(order => order.orderId === providerOrderId && order.orderNumber === orderNumber);
      if (!observed) throw new OrderEditError("ORDER_EDIT_PROVIDER_IDENTITY_UNVERIFIED", "We couldn’t verify that this order is ready for changes. Contact us for help.");
      const live = providerSchema.parse(observed);
      if (terminal ? live.orderStatus !== terminal : !["awaiting_shipment", "on_hold"].includes(live.orderStatus))
        throw new OrderEditError("ORDER_EDIT_PROVIDER_NOT_EDITABLE", "Your order is already being shipped and can no longer be changed online. Contact us if you need help.");
      if (!fulfilled && labels.shipments.some(label => label.orderNumber === live.orderNumber && !label.voided))
        throw new OrderEditError("ORDER_EDIT_PROVIDER_LABEL_EXISTS", "Your order is already being prepared for shipping and can no longer be changed online. Contact us if you need help.");
      if (terminal === "cancelled" && input.mode !== "verify_retired") {
        if (related.pages > 1 || !related.orders.some(order => order.orderId === live.orderId && order.orderNumber === live.orderNumber)
          || related.orders.some(order => order.orderNumber === live.orderNumber && order.orderStatus !== "cancelled"))
          throw new OrderEditError("ORDER_CANCELLATION_PROVIDER_PENDING", "Every related provider shipment must be cancelled before this request can finish.");
        return live;
      }
      if (fulfilled) {
        // A shipped split may no longer be mapped to this old edit. All number-scoped
        // provider work must be terminal; this path never sends a hold/release mutation.
        if (related.pages > 1 || !related.orders.some(order => order.orderId === live.orderId && order.orderNumber === live.orderNumber && order.orderStatus === "shipped") ||
          related.orders.some(order => order.orderNumber === live.orderNumber && !["shipped", "cancelled"].includes(order.orderStatus))) {
          throw new OrderEditError("ORDER_EDIT_PROVIDER_FULFILLMENT_PENDING", "Every related provider shipment must be shipped or cancelled before closing this edit.");
        }
        return live;
      }
      await verifyKnownProviderScope(related.orders.filter(order => order.orderNumber === live.orderNumber));
      return live;
    }
    async function verifyKnownProviderScope(related: readonly {orderId:number;orderStatus:string}[]) {
      const known = await db.execute(sql`SELECT COALESCE(os.shipstation_order_id,
        CASE WHEN os.shipping_engine='shipstation' AND os.engine_order_ref ~ '^[0-9]+$' AND length(os.engine_order_ref)<10 THEN os.engine_order_ref::int END) AS provider_order_id
        FROM wms.outbound_shipments os JOIN wms.orders wo ON wo.id=os.order_id WHERE wo.order_edit_operation_id=${input.operationId}::uuid`);
      const knownIds = new Set((known.rows ?? []).map((row: { provider_order_id: number | null }) => row.provider_order_id));
      if (related.some(order => order.orderStatus !== "cancelled" && !knownIds.has(order.orderId))) {
        throw new OrderEditError("ORDER_EDIT_PROVIDER_SPLIT_UNVERIFIED", "A related ShipStation shipment is not covered by this edit hold.");
      }
    }
    function verifyItems(live: z.infer<typeof providerSchema>, expected: Array<{ lineItemKey: string; quantity: number }>): void {
      const actual = new Map(live.items.map(item => [item.lineItemKey, item.quantity]));
      if (actual.size !== live.items.length || actual.size !== expected.length || expected.some(item => actual.get(item.lineItemKey) !== item.quantity)) {
        throw new OrderEditError("ORDER_EDIT_PROVIDER_QUANTITY_MISMATCH", "ShipStation quantities do not exactly match the edited shipment.");
      }
    }
    await withShipmentPushLock(input.shipmentId, async () => {
      const deferred = await db.transaction(async (tx: any) => {
        const row = await lock(tx);
        if (row.provider_order_id !== null) return false;
        if (!isConfigured()) throw new OrderEditError("ORDER_EDIT_SHIPPING_UNAVAILABLE", "Shipping verification is unavailable.");
        const { related, labels } = await readScope(row.order_number);
        if (labels.shipments.some(label => label.orderNumber === row.order_number && !label.voided))
          throw new OrderEditError("ORDER_EDIT_PROVIDER_LABEL_EXISTS", "Your order is already being prepared for shipping and can no longer be changed online.");
        await verifyKnownProviderScope(related.orders.filter(order => order.orderNumber === row.order_number));
        await verifyDeferredHeldPartition(tx, { orderId: row.order_id, shipmentId: input.shipmentId,
          providerOrders: related.orders.filter(order => order.orderNumber === row.order_number && order.orderStatus !== "cancelled").map(order => providerSchema.extend({ orderKey: z.string().optional() }).parse(order)) });
        return true;
      });
      if (deferred) return;
      // Commit baseline hold ownership BEFORE calling holduntil. A timeout after
      // provider success must not be misclassified as somebody else's hold.
      let acquiredLive: z.infer<typeof providerSchema> | undefined;
      if (input.mode === "hold") await db.transaction(async (tx: any) => {
        const row = await lock(tx);
        if (!isConfigured()) throw new OrderEditError("ORDER_EDIT_SHIPPING_UNAVAILABLE", "ShipStation is unavailable.");
        const live = await readProvider(row.provider_order_id!, row.order_number);
        acquiredLive = live;
        const receipt = await tx.execute(sql`INSERT INTO oms.order_edit_provider_holds(operation_id,shipment_id,provider_order_id,was_held)
          VALUES(${input.operationId}::uuid,${input.shipmentId},${row.provider_order_id},${live.orderStatus === "on_hold"})
          ON CONFLICT(operation_id,shipment_id) DO UPDATE SET provider_order_id=EXCLUDED.provider_order_id,
            was_held=EXCLUDED.was_held,released_at=NULL WHERE oms.order_edit_provider_holds.released_at IS NOT NULL RETURNING shipment_id`);
        if (receipt.rows?.length) await appendOrderEditShippingAudit(tx, { operationId:input.operationId,
          action:"provider_hold_baseline_observed", before:{providerOrderId:row.provider_order_id,status:live.orderStatus,items:live.items},
          after:{shipmentId:input.shipmentId,editHoldRequested:true},now:(dependencies.clock ?? (()=>new Date()))() });
      });
      await db.transaction(async (tx: any) => {
        const row = await lock(tx);
        if (!isConfigured()) throw new OrderEditError("ORDER_EDIT_SHIPPING_UNAVAILABLE", "ShipStation is unavailable.");
        const proof = await tx.execute(sql`SELECT provider_order_id,was_held,released_at FROM oms.order_edit_provider_holds
          WHERE operation_id=${input.operationId}::uuid AND shipment_id=${input.shipmentId} FOR UPDATE`);
        if (input.mode === "verify_cancelled" && proof.rows?.length === 0) {
          // Historical shipments can lack a hold receipt. Verify the exact
          // terminal provider state; never fabricate an earlier hold or send a write.
          await readProvider(row.provider_order_id!, row.order_number, "cancelled");
          return;
        }
        if (proof.rows?.[0]?.released_at != null)
          throw new OrderEditError("ORDER_EDIT_PROVIDER_HOLD_RELEASED", "The saved provider hold was already released and needs review.");
        const baseline = z.object({ provider_order_id: z.coerce.number().int().positive().safe(), was_held: z.boolean() }).parse(proof.rows?.[0]);
        if (baseline.provider_order_id !== row.provider_order_id) throw new OrderEditError("ORDER_EDIT_PROVIDER_IDENTITY_CHANGED", "The provider shipment identity changed.");
        if (input.mode === "release_unsubmitted") {
          // No order write was sent. Undo only our hold; quantities, labels,
          // other splits and fulfillment have no dependency on this draft.
          const live = providerSchema.parse(
            await apiRequest<unknown>(
              "GET",
              `/orders/${row.provider_order_id}`,
            ),
          );
          if (
            live.orderId !== row.provider_order_id ||
            !["awaiting_shipment", "on_hold", "shipped", "cancelled"].includes(
              live.orderStatus,
            )
          )
            throw new OrderEditError(
              "ORDER_EDIT_PROVIDER_NOT_EDITABLE",
              "Provider hold cleanup could not be verified.",
            );
          if (
            baseline.was_held ||
            row.on_hold !== 0 ||
            row.held ||
            row.requires_review ||
            await providerCarriesManualHold(tx, row.order_id, live) ||
            live.orderStatus !== "on_hold"
          )
            return;
          await apiRequest(
            "POST",
            "/orders/restorefromhold",
            { orderId: row.provider_order_id },
            { replaySafe: true },
          );
          const verified = providerSchema.parse(
            await apiRequest<unknown>(
              "GET",
              `/orders/${row.provider_order_id}`,
            ),
          );
          if (
            verified.orderId !== row.provider_order_id ||
            !["awaiting_shipment", "shipped", "cancelled"].includes(
              verified.orderStatus,
            )
          )
            throw new OrderEditError(
              "ORDER_EDIT_PROVIDER_HOLD_NOT_VERIFIED",
              "Provider hold cleanup could not be verified.",
            );
          return;
        }
        if (input.mode === "verify_shipped") {
          await readProvider(row.provider_order_id!, row.order_number, "shipped");
          return;
        }
        if (input.mode === "verify_cancelled") {
          await readProvider(row.provider_order_id!, row.order_number, "cancelled");
          return;
        }
        if (input.mode === "verify_retired") {
          // A retired shipment can belong to a resumed warehouse header. Verify
          // its remote cancellation without reopening it. Active replacements
          // must still belong to this edit; unknown provider splits block.
          await readProvider(row.provider_order_id!, row.order_number, "cancelled");
          return;
        }
        const live = acquiredLive ?? await readProvider(row.provider_order_id!, row.order_number);
        let providerChanged = false;
        if (input.mode === "hold") {
          if (live.orderStatus !== "on_hold") {
            await apiRequest("POST", "/orders/holduntil", { orderId: row.provider_order_id, holdUntilDate: ORDER_EDIT_PROVIDER_HOLD_UNTIL }, { replaySafe: true });
            providerChanged = true;
          }
          const held = await prepareOrderEditHeldPartitions(tx, { operationId: input.operationId,
            orderId: row.order_id, shipmentId: input.shipmentId, live, now: (dependencies.clock ?? (() => new Date()))() });
          retiredShipmentIds.push(...held.retiredShipmentIds);
          if (held.excludedItemKeys.length) {
            const excluded = new Set(held.excludedItemKeys);
            // Preserve the provider job and all unrelated fields; only remove
            // the exact keys assigned to verified held local partitions.
            await apiRequest("POST", "/orders/createorder", { ...live, orderStatus: "on_hold",
              items: live.items.filter(item => !excluded.has(item.lineItemKey)) }, { replaySafe: true });
            providerChanged = true;
            await appendOrderEditShippingAudit(tx, {operationId:input.operationId,action:"held_partition_provider_membership_amended",
              before:{shipmentId:input.shipmentId,items:live.items},after:{excludedItemKeys:held.excludedItemKeys,manualHoldsRetained:true},
              now:(dependencies.clock ?? (()=>new Date()))()});
          }
        } else if (input.mode !== "release" && live.orderStatus !== "on_hold") {
          throw new OrderEditError("ORDER_EDIT_PROVIDER_HOLD_MISSING", "ShipStation no longer confirms the edit hold.");
        }
        let expectedItems: Array<{ lineItemKey: string; quantity: number }> | undefined;
        if (input.mode === "synchronize" || input.mode === "release") {
          const result = await tx.execute(sql`SELECT osi.id,osi.qty,oi.sku,oi.name,
            COALESCE(oi.paid_price_cents,oi.unit_price_cents,0) AS unit_price_cents
            FROM wms.outbound_shipment_items osi JOIN wms.order_items oi ON oi.id=osi.order_item_id
            WHERE osi.shipment_id=${input.shipmentId} AND osi.qty>0 AND oi.status<>'cancelled' ORDER BY osi.id`);
          const rows = z.array(itemSchema).min(1).parse(result.rows);
          expectedItems = rows.map(item => ({ lineItemKey: `wms-item-${item.id}`, quantity: item.qty }));
          if (input.mode === "synchronize") {
            // Currency is persisted in exact cents. Convert only at this legacy
            // provider's decimal-number boundary; never calculate money here.
            await apiRequest("POST", "/orders/createorder", { ...live, orderStatus: "on_hold",
              items: rows.map(item => ({ ...live.items.find(existing => existing.lineItemKey === `wms-item-${item.id}`), lineItemKey: `wms-item-${item.id}`, quantity: item.qty,
                sku: item.sku, name: item.name, unitPrice: centsToJsonDollars(item.unit_price_cents) })) }, { replaySafe: true });
          } else {
            verifyItems(live, expectedItems);
            // Preserve preexisting provider, manual order and shipment holds.
            if (!baseline.was_held && row.on_hold === 0 && !row.held && live.orderStatus === "on_hold") {
              await apiRequest("POST", "/orders/restorefromhold", { orderId: row.provider_order_id }, { replaySafe: true });
            }
          }
        }
        const verified = input.mode === "verify" || (input.mode === "hold" && !providerChanged)
          ? live : await readProvider(row.provider_order_id!, row.order_number);
        const retainedHold = input.mode !== "release" || baseline.was_held || row.on_hold !== 0 || row.held;
        if (verified.orderStatus !== (retainedHold ? "on_hold" : "awaiting_shipment")) throw new OrderEditError("ORDER_EDIT_PROVIDER_HOLD_NOT_VERIFIED", "ShipStation hold state was not verified.");
        if (expectedItems) verifyItems(verified, expectedItems);
      });
    });
    return { retiredShipmentIds };
  }

  /**
   * Mark a ShipStation order as shipped without actually printing a label.
   * Uses POST /orders/createorder (upsert by orderKey) with orderStatus='shipped'
   * — the legacy /orders/markasshipped endpoint returned 404 on our account.
   */
  async function markAsShipped(
    shipstationOrderId: number,
    opts: {
      shipDate?: Date | string;
      trackingNumber?: string | null;
      carrierCode?: string | null;
      notifyCustomer?: boolean;
    } = {},
  ): Promise<{ alreadyInState: boolean }> {
    if (!isConfigured()) return { alreadyInState: false };
    const existing = await getOrderById(shipstationOrderId);
    if (!existing) {
      console.warn(`[ShipStation] markAsShipped skipped — order ${shipstationOrderId} not found`);
      return { alreadyInState: false };
    }

    // Per ShipStation docs: orders in 'shipped' or 'cancelled' state cannot
    // be updated via createorder. If the order is already shipped, treat
    // as success (it's in the correct state) and let caller stamp reconciled_at.
    if (existing.orderStatus === "shipped") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already shipped — no-op`);
      return { alreadyInState: true };
    }
    if (existing.orderStatus === "cancelled") {
      console.log(`[ShipStation] Order ${shipstationOrderId} is cancelled — cannot mark shipped`);
      return { alreadyInState: true };
    }

    try {
      const shipDate =
        opts.shipDate instanceof Date
          ? opts.shipDate.toISOString().split('T')[0]
          : (opts.shipDate || new Date().toISOString()).split('T')[0];

      const payload = {
        orderId: shipstationOrderId,
        carrierCode: opts.carrierCode || existing.carrierCode || "other",
        shipDate,
        trackingNumber: opts.trackingNumber || existing.trackingNumber || "",
        notifyCustomer: opts.notifyCustomer ?? false,
        notifySalesChannel: false
      };

      try {
        // Idempotent by orderId: a replay re-asserts the same shipped state.
        await apiRequest("POST", "/orders/markasshipped", payload, { replaySafe: true });
        console.log(`[ShipStation] Order ${shipstationOrderId} marked shipped via markasshipped endpoint`);
        return { alreadyInState: false };
      } catch (postErr: any) {
        console.error(
          `[ShipStation] markAsShipped payload that failed for order ${shipstationOrderId}:`,
          JSON.stringify(payload).slice(0, 800),
        );
        throw postErr;
      }
    } catch (err: any) {
      console.error(
        `[ShipStation] Failed to mark order ${shipstationOrderId} shipped:`,
        err.message,
      );
      throw err;
    }
  }

  /**
   * Cancel a ShipStation order. Uses POST /orders/createorder (upsert) with
   * orderStatus='cancelled' since ShipStation doesn't expose a direct
   * cancel endpoint on the v1 API. This moves the order out of the
   * Awaiting Shipment queue and into the Cancelled tab.
   */
  async function cancelOrder(
    shipstationOrderId: number,
  ): Promise<{ alreadyInState: boolean; state: "cancelled" | "already_cancelled" | "already_shipped" | "not_found" }> {
    if (!isConfigured()) return { alreadyInState: false, state: "not_found" };
    const existing = await getOrderById(shipstationOrderId);
    if (!existing) {
      console.warn(`[ShipStation] cancelOrder skipped — order ${shipstationOrderId} not found`);
      return { alreadyInState: false, state: "not_found" };
    }

    // Same restriction: cancelled/shipped orders can't be updated.
    // P0.3: these are OPPOSITE outcomes — discriminate them. Recording an
    // already-CANCELLED engine order as shipped resurrects dead orders.
    if (existing.orderStatus === "cancelled") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already cancelled — no-op`);
      return { alreadyInState: true, state: "already_cancelled" };
    }
    if (existing.orderStatus === "shipped") {
      console.log(`[ShipStation] Order ${shipstationOrderId} already shipped — cannot cancel`);
      return { alreadyInState: true, state: "already_shipped" };
    }

    try {
      await apiRequest("POST", "/orders/createorder", {
        ...existing,
        orderStatus: "cancelled",
      }, { replaySafe: true });

      console.log(`[ShipStation] Order ${shipstationOrderId} cancelled via createorder upsert`);
      return { alreadyInState: false, state: "cancelled" };
    } catch (err: any) {
      console.error(
        `[ShipStation] Failed to cancel order ${shipstationOrderId}:`,
        err.message,
      );
      throw err;
    }
  }

  type WmsShipmentShipStationRow = {
    id: number;
    shipstation_order_id: number | null;
  };

  async function getActiveWmsShipmentShipStationRows(
    wmsOrderId: number,
  ): Promise<WmsShipmentShipStationRow[]> {
    const shipmentRows: any = await db.execute(sql`
      SELECT id, shipstation_order_id
      FROM wms.outbound_shipments
      WHERE order_id = ${wmsOrderId}
        AND shipstation_order_id IS NOT NULL
        AND status NOT IN ('cancelled', 'voided', 'shipped', 'returned', 'lost')
      ORDER BY id
    `);

    return (shipmentRows?.rows ?? []).map((row: any) => ({
      id: Number(row.id),
      shipstation_order_id:
        row.shipstation_order_id === null || row.shipstation_order_id === undefined
          ? null
          : Number(row.shipstation_order_id),
    }));
  }

  async function getWmsOrderSortRank(wmsOrderId: number): Promise<string | null> {
    const rankRow: any = await db.execute(sql`
      SELECT sort_rank FROM wms.orders WHERE id = ${wmsOrderId} LIMIT 1
    `);
    return rankRow?.rows?.[0]?.sort_rank || null;
  }

  async function updateShipStationCustomField1(
    shipstationOrderId: number,
    sortRank: string,
  ): Promise<void> {
    const ssOrder = await getOrderById(shipstationOrderId);
    if (!ssOrder) return;
    // A sort-rank refresh is cosmetic; never let it resurrect a cancelled order
    // (createorder reactivates a cancelled SS order — ENGINE-CANCEL-DIVERGENCE-DESIGN.md).
    if (ssOrder.orderStatus === "cancelled") return;

    await withOrderEditProviderFence(shipstationOrderId, () => apiRequest("POST", "/orders/createorder", {
      ...ssOrder,
      customField1: sortRank,
      advancedOptions: {
        ...(ssOrder.advancedOptions || {}),
        customField1: sortRank,
      },
    }, { replaySafe: true }));
  }

  async function updateSortRankForShipmentRows(
    wmsOrderId: number,
    shipmentRows: WmsShipmentShipStationRow[],
  ): Promise<{ touched: number }> {
    const sortRank = await getWmsOrderSortRank(wmsOrderId);
    if (!sortRank) return { touched: 0 };

    let touched = 0;
    for (const row of shipmentRows) {
      const ssOrderId = Number(row.shipstation_order_id);
      if (!Number.isInteger(ssOrderId) || ssOrderId <= 0) continue;
      await updateShipStationCustomField1(ssOrderId, sortRank);
      touched += 1;
    }
    return { touched };
  }

  async function updateSortRankForShipmentRowsBestEffort(
    wmsOrderId: number,
    shipmentRows: WmsShipmentShipStationRow[],
    context: string,
  ): Promise<void> {
    try {
      await updateSortRankForShipmentRows(wmsOrderId, shipmentRows);
    } catch (err: any) {
      console.error(
        `[ShipStation] ${context} sort-rank refresh failed for WMS order ${wmsOrderId}:`,
        err.message,
      );
    }
  }

  /**
   * Update only the sort_rank customField1 of active WMS ShipStation orders.
   * ShipStation pointers live on wms.outbound_shipments; do not read the
   * legacy OMS header-level ShipStation id here.
   */
  async function updateSortRank(wmsOrderId: number): Promise<{ touched: number }> {
    if (!isConfigured()) return { touched: 0 };
    const shipmentRows = await getActiveWmsShipmentShipStationRows(wmsOrderId);
    return updateSortRankForShipmentRows(wmsOrderId, shipmentRows);
  }

  async function syncWmsOrderShipStationHoldState(
    wmsOrderId: number,
    mode: "hold" | "release",
  ): Promise<{ touched: number }> {
    if (!isConfigured()) return { touched: 0 };

    const shipmentRows = await getActiveWmsShipmentShipStationRows(wmsOrderId);
    let touched = 0;

    if (mode === "release") {
      await updateSortRankForShipmentRowsBestEffort(
        wmsOrderId,
        shipmentRows,
        "pre-release",
      );
    }

    for (const row of shipmentRows) {
      const ssOrderId = Number(row.shipstation_order_id);
      if (!Number.isInteger(ssOrderId) || ssOrderId <= 0) continue;

      if (mode === "hold") {
        await putOrderOnHold(ssOrderId);
      } else {
        await releaseOrderFromHold(ssOrderId);
      }
      touched += 1;
    }

    if (mode === "hold") {
      await updateSortRankForShipmentRowsBestEffort(
        wmsOrderId,
        shipmentRows,
        "post-hold",
      );
    }

    return { touched };
  }

  /**
   * Push a WMS-side ship-to address change onto the order's PRE-LABEL
   * ShipStation orders (2026-07 #58725 incident: Address Guard corrected the
   * ship-to 45s after checkout; WMS/OMS updated but the already-queued
   * ShipStation order kept the stale address, the advisory requires_review
   * flag didn't stop labeling, and the package shipped to the old address).
   *
   * Non-clobbering by construction: ShipStation v1 has no address-only
   * endpoint, so instead of rebuilding the payload from WMS (which would wipe
   * operator splits/service/weight edits made in ShipStation), we fetch
   * ShipStation's OWN current copy of the order, replace ONLY shipTo, and
   * upsert it back — the same fetch-modify-writeback pattern updateSortRank
   * uses for customField1.
   *
   * Scope guards:
   *  - only WMS shipments in pre-label statuses (planned/queued/on_hold)
   *  - only SS orders still awaiting_shipment / on_hold (label not created)
   *  - skipped entirely when WMS has no shipping_address (never blank an
   *    address in ShipStation)
   * Labeled/shipped shipments keep today's requires_review flow — a printed
   * label is a human decision. On each successful SS update the shipment's
   * 'address_changed_after_push' review flag is cleared (other review reasons
   * are left untouched).
   */
  async function syncWmsOrderShipStationShipToAddress(
    wmsOrderId: number,
  ): Promise<{ updated: number; skipped: number }> {
    if (!isConfigured()) return { updated: 0, skipped: 0 };

    const orderRows: any = await db.execute(sql`
      SELECT shipping_name, shipping_company, shipping_address, shipping_address2,
             shipping_city, shipping_state, shipping_postal_code, shipping_country,
             customer_name
      FROM wms.orders WHERE id = ${wmsOrderId} LIMIT 1
    `);
    const order = orderRows?.rows?.[0];
    if (!order || !order.shipping_address) return { updated: 0, skipped: 0 };
    const shippingCountry = requireShipStationCountryCode(order.shipping_country);

    const shipmentRows: any = await db.execute(sql`
      SELECT id, status, shipstation_order_id
      FROM wms.outbound_shipments
      WHERE order_id = ${wmsOrderId}
        AND shipstation_order_id IS NOT NULL
        AND status IN ('planned', 'queued', 'on_hold')
      ORDER BY id
    `);

    let updated = 0;
    let skipped = 0;

    for (const row of shipmentRows?.rows ?? []) {
      const ssOrderId = Number(row.shipstation_order_id);
      if (!Number.isInteger(ssOrderId) || ssOrderId <= 0) continue;

      const ssOrder = await getOrderById(ssOrderId);
      if (!ssOrder) {
        skipped += 1;
        continue;
      }
      // Pre-label authority is ShipStation's own status: once a label exists
      // the SS order is shipped and an address swap would be a lie.
      if (ssOrder.orderStatus !== "awaiting_shipment" && ssOrder.orderStatus !== "on_hold") {
        skipped += 1;
        continue;
      }

      await withOrderEditProviderFence(ssOrderId, () => apiRequest("POST", "/orders/createorder", {
        ...ssOrder,
        shipTo: {
          name: order.shipping_name || order.customer_name || "",
          company: order.shipping_company || "",
          street1: order.shipping_address || "",
          street2: order.shipping_address2 || "",
          city: order.shipping_city || "",
          state: order.shipping_state || "",
          postalCode: order.shipping_postal_code || "",
          country: shippingCountry,
          phone: ssOrder.shipTo?.phone || "",
        },
      }, { replaySafe: true }));
      updated += 1;
      console.log(
        `[ShipStation] Ship-to address updated on SS order ${ssOrderId} (WMS order ${wmsOrderId}, shipment ${row.id}) after address change`,
      );

      // The address is now correct in ShipStation — the advisory flag for
      // THIS reason is resolved. Other review reasons must survive.
      await clearOutboundShipmentReviewFlagByReasonInWms(db, {
        shipmentId: Number(row.id),
        expectedReason: "address_changed_after_push",
        updatedAt: new Date(),
      });
    }

    return { updated, skipped };
  }

  return {
    putOrderOnHold,
    releaseOrderFromHold,
    markAsShipped,
    cancelOrder,
    updateSortRank,
    updateShipStationCustomField1,
    syncWmsOrderShipStationHoldState,
    synchronizeOrderEditShipment,
    syncWmsOrderShipStationShipToAddress,
  };
}
