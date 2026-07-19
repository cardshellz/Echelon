/**
 * Shopify Bridge — writes Shopify orders into OMS for unified view
 *
 * Bridges durable raw Shopify orders into OMS. It is used by both the
 * LISTEN/NOTIFY path and the scheduled recovery sweep.
 */

import { sql } from "drizzle-orm";
import type { OmsService, OrderData, LineItemData } from "./oms.service";
import { envPositiveInteger } from "../../infrastructure/scheduler-config";
import { buildChannelLineDisplayName } from "./line-display-name";
import { enqueueOmsWmsSyncRetry } from "./webhook-retry.worker";

let notificationBackfillRunning = false;
let lastNotificationBackfillStartedAt = 0;
const DEFAULT_SHOPIFY_CHANNEL_ID = 36;

export interface ShopifyBridgeResult {
  shopifyOrderId: string;
  omsOrderId: number;
  channelId: number;
}

export interface ShopifyBackfillResult {
  attempted: number;
  bridged: number;
  failed: number;
  failures: string[];
}

function normalizedShopDomain(value: unknown): string | null {
  const domain = String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  return domain || null;
}

async function resolveShopifyChannelId(db: any, raw: any): Promise<number> {
  const rawChannelId = Number(raw.channel_id);
  const channelId = Number.isInteger(rawChannelId) && rawChannelId > 0
    ? rawChannelId
    : null;
  const orderDomain = normalizedShopDomain(raw.shop_domain);

  let channelResult;
  if (channelId !== null) {
    channelResult = await db.execute(sql`
      SELECT c.id AS channel_id
      FROM channels.channels c
      JOIN channels.channel_connections cc ON cc.channel_id = c.id
      WHERE c.id = ${channelId}
        AND c.provider = 'shopify'
      LIMIT 1
    `);
  } else if (orderDomain) {
    channelResult = await db.execute(sql`
      SELECT c.id AS channel_id
      FROM channels.channels c
      JOIN channels.channel_connections cc ON cc.channel_id = c.id
      WHERE c.provider = 'shopify'
        AND LOWER(BTRIM(cc.shop_domain)) = ${orderDomain}
      LIMIT 1
    `);
  } else {
    channelResult = await db.execute(sql`
      SELECT c.id AS channel_id
      FROM channels.channels c
      JOIN channels.channel_connections cc ON cc.channel_id = c.id
      WHERE c.id = ${DEFAULT_SHOPIFY_CHANNEL_ID}
        AND c.provider = 'shopify'
      LIMIT 1
    `);
  }

  const resolved = Number(channelResult.rows?.[0]?.channel_id);
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(
      `No Shopify channel route for raw order ${raw.order_number ?? raw.id ?? "unknown"}`,
    );
  }
  return resolved;
}

/**
 * Bridge a Shopify order into the OMS.
 * Call this after the existing order sync creates the WMS order.
 *
 * @param db - Drizzle database instance
 * @param omsService - OMS service for ingestion
 * @param shopifyOrderId - The shopify_orders.id value
 */
export async function bridgeShopifyOrderToOms(
  db: any,
  omsService: OmsService,
  shopifyOrderId: string,
): Promise<ShopifyBridgeResult> {
  try {
    // Fetch shop_domain and full order row from legacy table
    const rawOrderResult = await db.execute(sql`
      SELECT * FROM shopify_orders WHERE id = ${shopifyOrderId}
    `);
    
    if (rawOrderResult.rows.length === 0) {
      throw new Error(`Shopify raw order ${shopifyOrderId} was not found`);
    }
    const raw = rawOrderResult.rows[0];
    const channelId = await resolveShopifyChannelId(db, raw);


    const orderItemsResult = await db.execute(sql`
      SELECT * FROM shopify_order_items WHERE order_id = ${shopifyOrderId}
    `);
    const orderItems = orderItemsResult.rows;

    const discountCodesArray: string[] = raw.discount_codes || [];

    const lineItems: LineItemData[] = orderItems.map((item: any) => {
      let planDiscountCents = 0;
      let couponDiscountCents = 0;
      const discountAllocations = item.discount_allocations || [];
      
      for (const alloc of discountAllocations) {
        const allocAmount = Math.round(parseFloat(alloc.amount || "0") * 100);
        // Detect rewards
        const isRewards = discountCodesArray.some((code: string) => 
          code.toUpperCase().startsWith("SHELLZ-") || code.toUpperCase().includes("REWARDS")
        );
        
        // Deduce app type
        let appType = alloc.application_type;
        if (!appType && alloc.discount_application_index !== undefined) {
           if (discountCodesArray.length === 0) appType = "manual";
        }

        if (appType === "manual" && !isRewards) {
          planDiscountCents += allocAmount;
        } else {
          couponDiscountCents += allocAmount;
        }
      }

      const totalDiscountCents = planDiscountCents + couponDiscountCents;
      
      // Calculate retail price from legacy table's final totals + legacy discounts
      const oldPlan = item.plan_discount_cents || 0;
      const oldCoupon = item.coupon_discount_cents || 0;
      const qty = item.quantity || 1;
      const retailPriceCents = Math.round(((item.total_price_cents || 0) + oldPlan + oldCoupon) / qty);
      
      const paidPriceCents = Math.round(retailPriceCents - (totalDiscountCents / qty));
      const totalCents = (retailPriceCents * qty) - totalDiscountCents;
      const displayName = buildChannelLineDisplayName({
        name: item.name,
        title: item.title,
        variantTitle: item.variant_title,
      });

      return {
        externalLineItemId: item.shopify_line_item_id || String(item.id),
        sku: item.sku,
        title: displayName,
        name: displayName,
        quantity: qty,
        paidPriceCents,
        retailPriceCents,
        totalCents,
        discountCents: totalDiscountCents,
        planDiscountCents,
        couponDiscountCents,
        taxable: item.taxable !== false,
        requiresShipping: item.requires_shipping !== false,
        fulfillableQuantity: item.fulfillable_quantity ?? null,
        fulfillmentService: item.fulfillment_service ?? null,
        properties: item.properties || null,
        taxLines: item.tax_lines || null,
        discountAllocations: item.discount_allocations || null,
      };
    });

    let financialStatus = raw.financial_status || "paid";
    let fulfillmentStatus = raw.fulfillment_status || "unfulfilled";

    let status = "pending";
    if (raw.cancelled_at) {
      status = "cancelled";
    } else if (fulfillmentStatus === "fulfilled") {
      status = "shipped";
    } else if (financialStatus === "paid") {
      status = "confirmed";
    }

    const orderData: OrderData = {
      sourceTopic: "shopify/bridge",
      externalOrderNumber: raw.order_number,
      status,
      financialStatus,
      fulfillmentStatus,
      customerName: raw.customer_name || raw.shipping_name || "",
      customerEmail: raw.customer_email || "",
      shipToName: raw.shipping_name,
      shipToCompany: raw.shipping_company || null,
      shipToAddress1: raw.shipping_address1,
      shipToAddress2: raw.shipping_address2,
      shipToCity: raw.shipping_city,
      shipToState: raw.shipping_state,
      shipToZip: raw.shipping_postal_code,
      shipToCountry: raw.shipping_country,
      subtotalCents: raw.subtotal_price_cents || 0,
      // Pre-discount merchandise subtotal = sum of line gross (retail × qty).
      grossSubtotalCents: lineItems.reduce(
        (s, li) => s + (li.retailPriceCents || 0) * (li.quantity || 0),
        0,
      ),
      shippingCents: raw.total_shipping_cents || 0,
      taxCents: raw.total_tax_cents || 0,
      discountCents: raw.total_discounts_cents || 0,
      totalCents: raw.total_price_cents || 0,
      currency: raw.currency || "USD",
      taxExempt: raw.tax_exempt === true,
      rawPayload: { order: raw, lineItems: orderItems },
      notes: raw.note,
      tags: Array.isArray(raw.tags) ? raw.tags : (typeof raw.tags === 'string' ? raw.tags.split(",").map((t: string) => t.trim()) : []),
      shippingMethod: null,
      shippingMethodCode: null,
      orderedAt: raw.created_at ? new Date(raw.created_at) : new Date(),
      lineItems,
    };

    const omsOrder = await omsService.ingestOrder(channelId, shopifyOrderId, orderData);
    if (!omsOrder?.id) {
      throw new Error(`OMS did not confirm Shopify order ${raw.order_number ?? shopifyOrderId}`);
    }

    // Trigger OMS→WMS sync. The bridge paths (reconciliation poller +
    // LISTEN/NOTIFY) previously ended at ingestOrder and relied on
    // backfillUnsynced to push OMS→WMS — but that safety net was broken
    // (wrong link column), so any order that arrived via the bridge instead
    // of the orders/paid webhook got stuck in OMS with no WMS order and no
    // retry handle. Enqueue a durable retry row (idempotent; deduped by
    // pending scope) so the retry worker performs the sync exactly once.
    //
    // Skip terminal/externally-fulfilled orders: a cancelled order must not be
    // synced, and a shipped/fulfilled order with no WMS row was fulfilled
    // out-of-band — syncing it would push a duplicate to the shipping engine.
    if (
      omsOrder?.id &&
      status !== "cancelled" &&
      status !== "shipped" &&
      fulfillmentStatus !== "fulfilled"
    ) {
      try {
        await enqueueOmsWmsSyncRetry(db, omsOrder.id);
      } catch (syncErr: any) {
        // Non-fatal: the order is safely in OMS. Log loudly so the missed
        // sync is diagnosable; backfillUnsynced is the secondary net.
        console.error(
          `[Shopify Bridge] Failed to enqueue OMS→WMS sync for OMS order ${omsOrder.id} (shopify ${shopifyOrderId}): ${syncErr?.message ?? String(syncErr)}`,
        );
      }
    }
    return {
      shopifyOrderId,
      omsOrderId: Number(omsOrder.id),
      channelId,
    };
  } catch (error: any) {
    console.error(
      `[Shopify Bridge] Failed to bridge ${shopifyOrderId}: ${error?.message ?? String(error)}`,
    );
    throw error;
  }
}

/**
 * Batch-backfill existing Shopify orders into the OMS.
 * Finds orders in shopify_orders that aren't yet in oms_orders and ingests them.
 */
export async function backfillShopifyOrders(
  db: any,
  omsService: OmsService,
  limit: number = 100,
): Promise<ShopifyBackfillResult> {
  try {
    await db.execute(sql`
      INSERT INTO oms.shopify_order_bridge_checkpoints (
        id,
        monitor_started_at,
        last_run_at,
        created_at,
        updated_at
      )
      VALUES (1, TIMESTAMPTZ '2026-07-01 00:00:00+00', NOW(), NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET last_run_at = NOW(), updated_at = NOW()
    `);

  const unsynced = await db.execute(sql`
    SELECT so.id, so.order_number
    FROM shopify_orders so
    CROSS JOIN oms.shopify_order_bridge_checkpoints checkpoint
    WHERE checkpoint.id = 1
      AND so.created_at >= checkpoint.monitor_started_at
      AND NOT EXISTS (
        SELECT 1
        FROM oms.oms_orders oo
        WHERE oo.external_order_id IN (so.id, split_part(so.id, '/', -1))
          AND oo.channel_id IN (
            SELECT id FROM channels.channels WHERE provider = 'shopify'
          )
      )
    ORDER BY so.created_at ASC
    LIMIT ${limit}
  `);

  let bridged = 0;
  const failures: string[] = [];
  for (const row of unsynced.rows as any[]) {
    try {
      await bridgeShopifyOrderToOms(db, omsService, row.id);
      bridged++;
    } catch (error: any) {
      const message = error?.message ?? String(error);
      const identity = row.order_number ?? row.id;
      failures.push(`${identity}: ${message}`);
      console.error(`[Shopify Bridge] Backfill failed for ${identity}: ${message}`);
    }
  }

  const attempted = unsynced.rows.length;
  const failed = failures.length;
  const lastError = failed > 0 ? failures.slice(0, 5).join("; ").slice(0, 2000) : null;

  await db.execute(sql`
    UPDATE oms.shopify_order_bridge_checkpoints
    SET last_success_at = CASE WHEN ${failed} = 0 THEN NOW() ELSE last_success_at END,
        last_error = ${lastError},
        consecutive_failures = CASE
          WHEN ${failed} = 0 THEN 0
          ELSE consecutive_failures + 1
        END,
        last_candidates = ${attempted},
        last_bridged = ${bridged},
        last_failed = ${failed},
        updated_at = NOW()
    WHERE id = 1
  `);

  if (bridged > 0 || failed > 0) {
    console.log(
      `[Shopify Bridge] Backfill attempted=${attempted} bridged=${bridged} failed=${failed}`,
    );
  }

    return { attempted, bridged, failed, failures };
  } catch (error: any) {
    const message = (error?.message ?? String(error)).slice(0, 2000);
    try {
      await db.execute(sql`
        UPDATE oms.shopify_order_bridge_checkpoints
        SET last_error = ${message},
            consecutive_failures = consecutive_failures + 1,
            updated_at = NOW()
        WHERE id = 1
      `);
    } catch (checkpointError: any) {
      console.error(
        `[Shopify Bridge] Could not record sweep failure: ${checkpointError?.message ?? String(checkpointError)}`,
      );
    }
    throw error;
  }
}

/**
 * M18: Continuous Shopify Bridge
 * Subscribes to the postgres NOTIFY channel to instantly ingest new orders
 * without relying solely on interval batches.
 */
export function startShopifyBridgeListener(db: any, omsService: OmsService): void {
  // Access the underlying pg pool client from drizzle
  // The exact method to get a raw client depends on setup, but typically we can use db.$client
  const pool = db.$client; // This assumes drizzle was initialized with a pg pool
  
  if (!pool || typeof pool.connect !== 'function') {
    console.warn("[Shopify Bridge] Cannot hook LISTEN/NOTIFY: db.$client is not a standard pg pool");
    return;
  }

  pool.connect((err: Error | null, client: any, done: () => void) => {
    if (err) {
      console.error("[Shopify Bridge] Error acquiring client for listener:", err.message);
      return;
    }

    client.on('notification', async (msg: any) => {
      if (msg.channel === 'shopify_order_ingested') {
        if (notificationBackfillRunning) {
          return;
        }

        const now = Date.now();
        const minIntervalMs = envPositiveInteger("SHOPIFY_BRIDGE_MIN_BACKFILL_INTERVAL_MS", 10_000);
        if (now - lastNotificationBackfillStartedAt < minIntervalMs) {
          return;
        }

        notificationBackfillRunning = true;
        lastNotificationBackfillStartedAt = now;
        try {
          await backfillShopifyOrders(
            db,
            omsService,
            envPositiveInteger("SHOPIFY_BRIDGE_NOTIFY_BACKFILL_LIMIT", 10),
          );
        } catch (error: any) {
          console.error(`[Shopify Bridge] Error running continuous backfill: ${error.message}`);
        } finally {
          notificationBackfillRunning = false;
        }
      }
    });

    client.query('LISTEN shopify_order_ingested')
      .then(() => console.log("[Shopify Bridge] Real-time continuous order bridge active!"))
      .catch((err: Error) => {
        console.error("[Shopify Bridge] Error listening to bridge channel:", err.message);
        done();
      });
  });
}
