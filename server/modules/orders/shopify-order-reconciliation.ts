/**
 * Shopify Order Reconciliation Job
 *
 * Safety net that runs every 15 minutes to catch orders that slip through
 * the webhook → shopify_orders → LISTEN/NOTIFY pipeline. This includes:
 *   - TikTok orders routed through Shopify
 *   - Orders where the webhook delivery failed
 *   - POS orders
 *   - Any other source_name variants
 *
 * Flow:
 *   1. Fetch recent orders from Shopify REST API (since last check)
 *   2. Check whether each canonical Shopify GID has reached OMS
 *   3. If missing from `shopify_orders`, insert the raw row + items first
 *   4. Bridge the raw order to OMS; unified recovery handles WMS
 *   5. Track last check timestamp in echelon_settings
 *
 * This does NOT replace the existing real-time sync. It's additive.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import { channelConnections } from "@shared/schema";
import { eq } from "drizzle-orm";

import type { OmsService } from "../oms/oms.service";
import type { WmsSyncService } from "../oms/wms-sync.service";
import { bridgeShopifyOrderToOms } from "../oms/shopify-bridge";
import { reconcileShopifyLineReadiness } from "../oms/shopify-line-readiness.service";
import { envPositiveInteger } from "../../infrastructure/scheduler-config";
import { normalizeShopifyOrderGid } from "./shopify-order-id";

// Re-export for registration in index.ts
export { startShopifyReconciliation };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShopifyApiOrder {
  id: number | string;
  order_number: number;
  name: string; // e.g. "#54950"
  email: string | null;
  created_at: string;
  updated_at?: string;
  cancelled_at: string | null;
  financial_status: string;
  fulfillment_status: string | null;
  source_name: string; // "web", "pos", "shopify_draft_order", "tiktok", etc.
  currency: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_discounts: string;
  taxes_included: boolean;
  tax_exempt: boolean;
  note: string | null;
  tags: string;
  customer: {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
  } | null;
  shipping_address: {
    name: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    province_code: string | null;
    zip: string | null;
    country: string | null;
    country_code: string | null;
    phone: string | null;
  } | null;
  line_items: Array<{
    id: number;
    sku: string | null;
    name: string;
    title: string;
    variant_title: string | null;
    quantity: number;
    fulfillable_quantity: number;
    fulfillment_status: string | null;
    requires_shipping: boolean;
    price: string;
    total_discount: string;
    image?: { src: string };
  }>;
  shipping_lines: Array<{
    title: string;
    price: string;
    code: string;
  }>;
}

interface ReconciliationResult {
  checked: number;
  reconciled: number;
  skipped: number;
  failed: number;
  readinessChecked: number;
  readinessAdvanced: number;
  wmsSyncRequested: number;
  details: string[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "shopify_reconciliation_last_check";
const READINESS_RECOVERY_CURSOR_KEY = "shopify_reconciliation_readiness_cursor";
const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const SHOPIFY_CHANNEL_ID = 36;
const SHOPIFY_API_VERSION = "2024-10";
const RATE_LIMIT_DELAY_MS = 550; // ~2 calls/sec
const MAX_RECONCILIATION_PAGES = envPositiveInteger(
  "SHOPIFY_RECONCILIATION_MAX_PAGES",
  100,
);
const READINESS_RECOVERY_LIMIT = envPositiveInteger(
  "SHOPIFY_READINESS_RECOVERY_LIMIT",
  25,
);

let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// Services injected at startup
let omsService: OmsService | null = null;
let wmsSyncService: WmsSyncService | null = null;

// ---------------------------------------------------------------------------
// Shopify API helpers (direct fetch, uses channel_connections creds)
// ---------------------------------------------------------------------------

async function getShopifyCredentials(): Promise<{
  shopDomain: string;
  accessToken: string;
}> {
  const [conn] = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, SHOPIFY_CHANNEL_ID))
    .limit(1);

  if (!conn?.shopDomain || !conn?.accessToken) {
    throw new Error(`No Shopify credentials for channel ${SHOPIFY_CHANNEL_ID}`);
  }

  return {
    shopDomain: conn.shopDomain,
    accessToken: conn.accessToken,
  };
}

async function shopifyGet(
  creds: { shopDomain: string; accessToken: string },
  path: string,
): Promise<{ data: any; linkHeader: string | null }> {
  const url = `https://${creds.shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": creds.accessToken,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 429) {
      const retryAfter = parseInt(
        response.headers.get("Retry-After") || "2",
        10,
      );
      console.warn(`[RECONCILE] Rate limited, waiting ${retryAfter}s`);
      await delay(retryAfter * 1000);
      continue;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status >= 500 && attempt < 3) {
        await delay(1000 * attempt);
        continue;
      }
      throw new Error(
        `Shopify API ${path} failed (${response.status}): ${errorBody.slice(0, 200)}`,
      );
    }

    const data = await response.json();
    const linkHeader = response.headers.get("Link");
    return { data, linkHeader };
  }

  throw new Error(`Shopify API ${path} failed after 3 retries`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(
    /<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/,
  );
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Fetch orders from Shopify API
// ---------------------------------------------------------------------------

async function fetchOrdersFromShopify(since: Date): Promise<ShopifyApiOrder[]> {
  const creds = await getShopifyCredentials();
  const allOrders: ShopifyApiOrder[] = [];
  let pageInfo: string | null = null;
  let page = 0;

  do {
    page++;
    const path = pageInfo
      ? `/orders.json?limit=250&page_info=${pageInfo}`
      : `/orders.json?limit=250&status=any&created_at_min=${since.toISOString()}`;

    const { data, linkHeader } = await shopifyGet(creds, path);

    if (!data?.orders?.length) break;

    allOrders.push(...data.orders);
    pageInfo = parseNextPageInfo(linkHeader);

    if (pageInfo) {
      await delay(RATE_LIMIT_DELAY_MS);
    }

    if (pageInfo && page >= MAX_RECONCILIATION_PAGES) {
      throw new Error(
        `Shopify reconciliation exceeded ${MAX_RECONCILIATION_PAGES} pages; checkpoint was not advanced`,
      );
    }
  } while (pageInfo);

  return allOrders;
}

interface DelayedReadinessCandidate {
  omsOrderId: number;
  shopifyOrderId: string;
}

function normalizeShopifyNumericOrderId(value: string | number): string {
  const normalized = String(value).split("/").pop()?.trim() ?? "";
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Invalid Shopify order id for readiness recovery: ${String(value)}`,
    );
  }
  return normalized;
}

async function fetchShopifyOrderById(
  shopifyOrderId: string | number,
): Promise<ShopifyApiOrder> {
  const creds = await getShopifyCredentials();
  const numericOrderId = normalizeShopifyNumericOrderId(shopifyOrderId);
  const { data } = await shopifyGet(creds, `/orders/${numericOrderId}.json`);
  if (!data?.order) {
    throw new Error(
      `Shopify order ${numericOrderId} was not returned by the API`,
    );
  }
  return data.order as ShopifyApiOrder;
}

async function loadDelayedReadinessCandidates(
  afterOmsOrderId: number,
): Promise<DelayedReadinessCandidate[]> {
  const candidates = await db.execute<{
    oms_order_id: number;
    shopify_order_id: string;
  }>(sql`
    SELECT
      oo.id AS oms_order_id,
      split_part(oo.external_order_id, '/', -1) AS shopify_order_id
    FROM oms.oms_orders oo
    JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
    WHERE oo.channel_id = ${SHOPIFY_CHANNEL_ID}
      AND oo.status NOT IN ('cancelled', 'refunded', 'shipped')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(oo.financial_status, '') IN ('paid', 'partially_paid')
      AND ol.requires_shipping IS DISTINCT FROM false
      AND COALESCE(ol.cancelled_quantity, 0) = 0
      AND COALESCE(ol.refunded_quantity, 0) = 0
      AND COALESCE(ol.authorization_status, '') IN ('seen', 'authorized')
      AND (
        COALESCE(ol.paid_quantity, 0) > COALESCE(ol.authority_fulfillable_quantity, 0)
        OR COALESCE(ol.authority_fulfillable_quantity, 0) >
           COALESCE(ol.wms_materialized_quantity, 0)
      )
    GROUP BY oo.id, oo.external_order_id
    ORDER BY
      CASE WHEN oo.id > ${afterOmsOrderId} THEN 0 ELSE 1 END ASC,
      oo.id ASC
    LIMIT ${READINESS_RECOVERY_LIMIT}
  `);

  return candidates.rows.map((row) => ({
    omsOrderId: Number(row.oms_order_id),
    shopifyOrderId: normalizeShopifyNumericOrderId(row.shopify_order_id),
  }));
}

function buildReadinessSourceEventId(order: ShopifyApiOrder): string {
  const orderId = normalizeShopifyNumericOrderId(order.id);
  const providerVersion = order.updated_at || order.created_at;
  return `shopify-reconcile:${orderId}:${providerVersion}`.slice(0, 100);
}

async function reconcileExistingOmsOrderReadiness(
  order: ShopifyApiOrder,
  omsOrderId: number,
): Promise<{
  advancedLines: number;
  advancedQuantity: number;
  wmsSyncRequested: boolean;
}> {
  if (!wmsSyncService) {
    throw new Error(
      "wmsSyncService not initialized - call initReconciliation first",
    );
  }

  const readiness = await reconcileShopifyLineReadiness({
    db,
    omsOrderId,
    financialStatus: order.financial_status,
    sourceEventId: buildReadinessSourceEventId(order),
    lineItems: order.line_items.map((line) => ({
      externalLineItemId: line.id,
      quantity: line.quantity,
      fulfillableQuantity: line.fulfillable_quantity,
    })),
  });

  if (
    readiness.missingLines > 0 ||
    readiness.quantityMismatches > 0 ||
    readiness.protectedLines > 0
  ) {
    console.warn(
      `[RECONCILE] Shopify readiness for ${order.name} was partially skipped ` +
        JSON.stringify({
          missingLines: readiness.missingLines,
          quantityMismatches: readiness.quantityMismatches,
          protectedLines: readiness.protectedLines,
        }),
    );
  }

  if (readiness.wmsSyncRequired) {
    await wmsSyncService.syncOmsOrderToWms(omsOrderId);
  }

  return {
    advancedLines: readiness.advancedLines,
    advancedQuantity: readiness.advancedQuantity,
    wmsSyncRequested: readiness.wmsSyncRequired,
  };
}

// ---------------------------------------------------------------------------
// Insert into shopify_orders + shopify_order_items (if missing)
// ---------------------------------------------------------------------------

async function ensureShopifyOrderRow(order: ShopifyApiOrder): Promise<string> {
  const shopifyId = normalizeShopifyOrderGid(order.id);

  // Check if already exists
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id FROM shopify_orders WHERE id = ${shopifyId} LIMIT 1
  `);

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Build customer name
  const customerName = order.customer
    ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
    : order.shipping_address?.name || null;

  const shipping = order.shipping_address;

  // Insert shopify_orders row
  await db.execute(sql`
    INSERT INTO shopify_orders (
      id, order_number, customer_name, customer_email,
      shipping_name, shipping_address1, shipping_city,
      shipping_state, shipping_postal_code, shipping_country,
      total_price_cents, subtotal_price_cents, total_shipping_cents,
      total_tax_cents, total_discounts_cents,
      currency, order_date, financial_status, fulfillment_status,
      cancelled_at, shop_domain, source_name, tax_exempt
    ) VALUES (
      ${shopifyId},
      ${order.name || `#${order.order_number}`},
      ${customerName},
      ${order.email || order.customer?.email || null},
      ${shipping?.name || null},
      ${shipping?.address1 || null},
      ${shipping?.city || null},
      ${shipping?.province || shipping?.province_code || null},
      ${shipping?.zip || null},
      ${shipping?.country_code || shipping?.country || null},
      ${Math.round(parseFloat(order.total_price || "0") * 100)},
      ${Math.round(parseFloat(order.subtotal_price || "0") * 100)},
      ${Math.round((order.shipping_lines || []).reduce((s, l) => s + parseFloat(l.price || "0"), 0) * 100)},
      ${Math.round(parseFloat(order.total_tax || "0") * 100)},
      ${Math.round(parseFloat(order.total_discounts || "0") * 100)},
      ${order.currency || "USD"},
      ${order.created_at ? new Date(order.created_at) : new Date()},
      ${order.financial_status || "paid"},
      ${order.fulfillment_status || null},
      ${order.cancelled_at ? new Date(order.cancelled_at) : null},
      ${null},
      ${order.source_name || "web"},
      ${order.tax_exempt || false}
    )
    ON CONFLICT (id) DO NOTHING
  `);

  // Insert line items
  for (const item of order.line_items) {
    const lineItemId = String(item.id);
    const priceCents = Math.round(parseFloat(item.price || "0") * 100);
    const discountCents = Math.round(
      parseFloat(item.total_discount || "0") * 100,
    );
    const totalCents = priceCents * item.quantity - discountCents;

    await db.execute(sql`
      INSERT INTO shopify_order_items (
        id, order_id, shopify_line_item_id, sku, name, title,
        quantity, fulfillable_quantity, fulfillment_status,
        requires_shipping, paid_price_cents, total_price_cents,
        total_discount_cents
      ) VALUES (
        ${lineItemId},
        ${shopifyId},
        ${lineItemId},
        ${item.sku ? item.sku.trim().toUpperCase() : null},
        ${item.name || item.title},
        ${item.title},
        ${item.quantity},
        ${item.fulfillable_quantity},
        ${item.fulfillment_status || null},
        ${item.requires_shipping},
        ${priceCents},
        ${totalCents},
        ${discountCents}
      )
      ON CONFLICT (id) DO NOTHING
    `);
  }

  console.log(
    `[RECONCILE] Created shopify_orders row for ${order.name} (${shopifyId}, source: ${order.source_name})`,
  );
  return shopifyId;
}

// ---------------------------------------------------------------------------
// Get/set last check timestamp
// ---------------------------------------------------------------------------

async function getLastCheckTime(): Promise<Date> {
  const result = await db.execute<{ value: string | null }>(sql`
    SELECT value FROM warehouse.echelon_settings WHERE key = ${SETTINGS_KEY} LIMIT 1
  `);

  if (result.rows.length > 0 && result.rows[0].value) {
    return new Date(result.rows[0].value);
  }

  // Default: 2 hours ago on first run
  return new Date(Date.now() - 2 * 60 * 60 * 1000);
}

async function setLastCheckTime(ts: Date): Promise<void> {
  const isoValue = ts.toISOString();
  await db.execute(sql`
    INSERT INTO warehouse.echelon_settings (key, value, type, category)
    VALUES (${SETTINGS_KEY}, ${isoValue}, 'string', 'sync')
    ON CONFLICT (key) DO UPDATE SET value = ${isoValue}, updated_at = NOW()
  `);
}
async function getReadinessRecoveryCursor(): Promise<number> {
  const result = await db.execute<{ value: string | null }>(sql`
    SELECT value
    FROM warehouse.echelon_settings
    WHERE key = ${READINESS_RECOVERY_CURSOR_KEY}
    LIMIT 1
  `);
  const value = Number(result.rows[0]?.value ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function setReadinessRecoveryCursor(omsOrderId: number): Promise<void> {
  const value = String(omsOrderId);
  await db.execute(sql`
    INSERT INTO warehouse.echelon_settings (key, value, type, category)
    VALUES (${READINESS_RECOVERY_CURSOR_KEY}, ${value}, 'string', 'sync')
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
  `);
}

// ---------------------------------------------------------------------------
// Main reconciliation logic
// ---------------------------------------------------------------------------

async function runReconciliation(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    checked: 0,
    reconciled: 0,
    skipped: 0,
    failed: 0,
    readinessChecked: 0,
    readinessAdvanced: 0,
    wmsSyncRequested: 0,
    details: [],
  };

  if (isRunning) {
    console.log("[RECONCILE] Already running, skipping");
    return result;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    if (!omsService || !wmsSyncService) {
      throw new Error(
        "OMS and WMS sync services must be initialized before reconciliation",
      );
    }

    const lastCheck = await getLastCheckTime();
    // Overlap by 5 minutes to catch race conditions.
    const fetchSince = new Date(lastCheck.getTime() - 5 * 60 * 1000);

    console.log(
      `[RECONCILE] Fetching Shopify orders since ${fetchSince.toISOString()}`,
    );
    const shopifyOrders = await fetchOrdersFromShopify(fetchSince);
    result.checked = shopifyOrders.length;
    const recentlyCheckedOmsOrderIds = new Set<number>();

    const reconcileReadiness = async (
      order: ShopifyApiOrder,
      omsOrderId: number,
    ): Promise<void> => {
      result.readinessChecked++;
      const readiness = await reconcileExistingOmsOrderReadiness(
        order,
        omsOrderId,
      );
      result.readinessAdvanced += readiness.advancedQuantity;
      if (readiness.wmsSyncRequested) {
        result.wmsSyncRequested++;
      }
    };

    if (shopifyOrders.length > 0) {
      // WMS keys are internal OMS identifiers and cannot prove whether the
      // Shopify source order reached OMS. Compare canonical source identity.
      const shopifyIds = shopifyOrders.map((order) =>
        normalizeShopifyOrderGid(order.id),
      );
      const existingOms = await db.execute<{
        shopify_order_id: string;
        oms_order_id: number;
      }>(sql`
        SELECT DISTINCT
          so.id AS shopify_order_id,
          oo.id AS oms_order_id
        FROM public.shopify_orders so
        JOIN oms.oms_orders oo
          ON oo.external_order_id IN (so.id, split_part(so.id, '/', -1))
        WHERE so.id = ANY(
          ARRAY[${sql.join(
            shopifyIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[]
        )
          AND oo.channel_id IN (
            SELECT id FROM channels.channels WHERE provider = 'shopify'
          )
      `);
      const existingByShopifyId = new Map(
        existingOms.rows.map((row) => [
          row.shopify_order_id,
          Number(row.oms_order_id),
        ]),
      );

      for (const order of shopifyOrders) {
        const orderId = normalizeShopifyOrderGid(order.id);
        const existingOmsOrderId = existingByShopifyId.get(orderId);

        if (order.cancelled_at) {
          result.skipped++;
          continue;
        }

        try {
          if (existingOmsOrderId) {
            recentlyCheckedOmsOrderIds.add(existingOmsOrderId);
            await reconcileReadiness(order, existingOmsOrderId);
          } else {
            const shopifyRowId = await ensureShopifyOrderRow(order);
            await bridgeShopifyOrderToOms(db, omsService, shopifyRowId);
            result.reconciled++;
            const source = order.source_name || "unknown";
            result.details.push(`${order.name} (${source})`);
          }
        } catch (err: any) {
          result.failed++;
          console.error(
            `[RECONCILE] Failed to reconcile ${order.name} (${orderId}): ${err.message}`,
          );
        }

        await delay(100);
      }
    }

    const readinessCursor = await getReadinessRecoveryCursor();
    const delayedCandidates =
      await loadDelayedReadinessCandidates(readinessCursor);
    for (const candidate of delayedCandidates) {
      if (recentlyCheckedOmsOrderIds.has(candidate.omsOrderId)) {
        continue;
      }

      try {
        const order = await fetchShopifyOrderById(candidate.shopifyOrderId);
        if (order.cancelled_at) {
          result.skipped++;
          continue;
        }
        await reconcileReadiness(order, candidate.omsOrderId);
      } catch (err: any) {
        result.failed++;
        console.error(
          `[RECONCILE] Delayed readiness recovery failed for Shopify order ${candidate.shopifyOrderId}: ${err.message}`,
        );
      }

      await delay(100);
    }

    if (delayedCandidates.length > 0) {
      await setReadinessRecoveryCursor(
        delayedCandidates[delayedCandidates.length - 1].omsOrderId,
      );
    }

    // A failed order stays inside the next overlapping poll window.
    if (result.failed === 0) {
      await setLastCheckTime(new Date());
    } else {
      console.error(
        `[RECONCILE] ${result.failed} order(s) failed; checkpoint was not advanced`,
      );
    }

    const durationMs = Date.now() - startTime;
    if (result.reconciled > 0 || result.readinessAdvanced > 0) {
      console.log(
        `[RECONCILE] Imported ${result.reconciled} order(s), advanced ` +
          `${result.readinessAdvanced} readiness unit(s), requested ` +
          `${result.wmsSyncRequested} WMS sync(s) in ${durationMs}ms`,
      );
    }

    return result;
  } catch (err: any) {
    console.error(`[RECONCILE] Error: ${err.message}`);
    throw err;
  } finally {
    isRunning = false;
  }
}
// ---------------------------------------------------------------------------
// Startup & lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the reconciliation job with references to sync services.
 * Must be called before startShopifyReconciliation().
 */
export function initReconciliation(oms?: OmsService, wmsSync?: WmsSyncService) {
  omsService = oms || null;
  wmsSyncService = wmsSync || null;
}

/**
 * Start the periodic reconciliation job.
 * Runs first check after 3 minutes (let server settle), then every 15 minutes.
 */
async function runCancellationReconciliation(): Promise<void> {
  if (!wmsSyncService) return;
  try {
    const result = await wmsSyncService.reconcileCancellations();
    if (result.cancelled > 0) {
      console.log(
        `[RECONCILE] Cancellation sweep: ${result.cancelled} cancelled, ${result.failed} failed`,
      );
    }
  } catch (err: any) {
    console.error(`[RECONCILE] Cancellation sweep failed: ${err.message}`);
  }
}

function startShopifyReconciliation() {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
  }

  // First run after 3 minutes
  setTimeout(
    async () => {
      try {
        await runReconciliation();
      } catch (err: any) {
        console.error(`[RECONCILE] Initial run failed: ${err.message}`);
      }

      await runCancellationReconciliation();

      // Then every 15 minutes
      reconciliationInterval = setInterval(async () => {
        try {
          await runReconciliation();
        } catch (err: any) {
          console.error(`[RECONCILE] Scheduled run failed: ${err.message}`);
        }

        await runCancellationReconciliation();
      }, RECONCILIATION_INTERVAL_MS);
    },
    3 * 60 * 1000,
  );

  console.log(
    "[RECONCILE] Shopify order reconciliation scheduled (every 15 min, first run in 3 min)",
  );
}

/**
 * Stop the reconciliation job.
 */
export function stopShopifyReconciliation() {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
    reconciliationInterval = null;
  }
}

/**
 * Run reconciliation on demand (e.g., from an API endpoint).
 */
export async function runReconciliationNow(): Promise<ReconciliationResult> {
  return runReconciliation();
}
