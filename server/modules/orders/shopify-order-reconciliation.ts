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
 *   2. Check if each exists in WMS `orders` table (by source_table_id)
 *   3. If missing from `shopify_orders`, insert the raw row + items first
 *   4. Then sync to WMS via the existing syncSingleOrder() pipeline
 *   5. Track last check timestamp in echelon_settings
 *
 * This does NOT replace the existing real-time sync. It's additive.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import { channelConnections } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { ServiceRegistry } from "../../services";
import type { OmsService } from "../oms/oms.service";

// Re-export for registration in index.ts
export { startShopifyReconciliation };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShopifyApiOrder {
  id: number;
  order_number: number;
  name: string; // e.g. "#54950"
  email: string | null;
  created_at: string;
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
  details: string[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "shopify_reconciliation_last_check";
const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const SHOPIFY_CHANNEL_ID = 36;
const SHOPIFY_API_VERSION = "2024-10";
const RATE_LIMIT_DELAY_MS = 550; // ~2 calls/sec

let reconciliationInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// Services injected at startup
let omsService: OmsService | null = null;

// ---------------------------------------------------------------------------
// Shopify API helpers (direct fetch, uses channel_connections creds)
// ---------------------------------------------------------------------------

async function getShopifyCredentials(): Promise<{ shopDomain: string; accessToken: string }> {
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
      const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
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
      throw new Error(`Shopify API ${path} failed (${response.status}): ${errorBody.slice(0, 200)}`);
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
  const match = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
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

    // Safety: don't fetch more than 10 pages (2500 orders) in one run
    if (page >= 10) {
      console.warn(`[RECONCILE] Hit page limit (${page} pages, ${allOrders.length} orders)`);
      break;
    }
  } while (pageInfo);

  return allOrders;
}

// ---------------------------------------------------------------------------
// Insert into shopify_orders + shopify_order_items (if missing)
// ---------------------------------------------------------------------------

async function ensureShopifyOrderRow(order: ShopifyApiOrder): Promise<string> {
  const shopifyId = String(order.id);

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
    const discountCents = Math.round(parseFloat(item.total_discount || "0") * 100);
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

  console.log(`[RECONCILE] Created shopify_orders row for ${order.name} (${shopifyId}, source: ${order.source_name})`);
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
    INSERT INTO echelon_settings (key, value, type, category)
    VALUES (${SETTINGS_KEY}, ${isoValue}, 'string', 'sync')
    ON CONFLICT (key) DO UPDATE SET value = ${isoValue}, updated_at = NOW()
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
    details: [],
  };

  if (isRunning) {
    console.log("[RECONCILE] Already running, skipping");
    return result;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    if (!omsService) {
      throw new Error("omsService not initialized — call initReconciliation first");
    }

    const lastCheck = await getLastCheckTime();
    // Overlap by 5 minutes to catch race conditions
    const fetchSince = new Date(lastCheck.getTime() - 5 * 60 * 1000);

    console.log(`[RECONCILE] Fetching Shopify orders since ${fetchSince.toISOString()}`);
    const shopifyOrders = await fetchOrdersFromShopify(fetchSince);
    result.checked = shopifyOrders.length;

    if (shopifyOrders.length === 0) {
      await setLastCheckTime(new Date());
      return result;
    }

    // Batch-check which orders already exist in WMS
    const shopifyIds = shopifyOrders.map((o) => String(o.id));
    const existingWms = await db.execute<{ source_table_id: string }>(sql`
      SELECT source_table_id FROM wms.orders
      WHERE source_table_id = ANY(${sql.raw(`ARRAY[${shopifyIds.map(id => `'${id}'`).join(',')}]`)})
    `);
    const existingSet = new Set(existingWms.rows.map((r) => r.source_table_id));

    // Filter to missing orders
    const missingOrders = shopifyOrders.filter((o) => !existingSet.has(String(o.id)));

    if (missingOrders.length === 0) {
      await setLastCheckTime(new Date());
      return result;
    }

    console.log(`[RECONCILE] Found ${missingOrders.length} missing orders out of ${shopifyOrders.length} checked`);

    for (const order of missingOrders) {
      const orderId = String(order.id);

      // Skip cancelled orders
      if (order.cancelled_at) {
        result.skipped++;
        continue;
      }

      try {
        // Step 1: Ensure shopify_orders + shopify_order_items rows exist
        const shopifyRowId = await ensureShopifyOrderRow(order);

        // Step 2: Bridge to OMS
        if (omsService) {
          try {
            const { bridgeShopifyOrderToOms } = require("../oms/shopify-bridge");
            await bridgeShopifyOrderToOms(db, omsService, shopifyRowId);
            result.reconciled++;
            const source = order.source_name || "unknown";
            result.details.push(`${order.name} (${source})`);
          } catch (err: any) {
            result.failed++;
            console.error(`[RECONCILE] OMS bridge failed for ${order.name}: ${err.message}`);
          }
        } else {
          result.skipped++;
        }
      } catch (err: any) {
        result.failed++;
        console.error(`[RECONCILE] Failed to reconcile ${order.name} (${orderId}): ${err.message}`);
      }

      // Rate limit between order processing
      await delay(100);
    }

    // Update last check time to now
    await setLastCheckTime(new Date());

    const durationMs = Date.now() - startTime;
    if (result.reconciled > 0) {
      console.log(
        `[RECONCILE] Reconciled ${result.reconciled} orders in ${durationMs}ms: ${result.details.join(", ")}`,
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
export function initReconciliation(
  oms?: OmsService,
) {
  omsService = oms || null;
}

/**
 * Start the periodic reconciliation job.
 * Runs first check after 3 minutes (let server settle), then every 15 minutes.
 */
function startShopifyReconciliation() {
  if (reconciliationInterval) {
    clearInterval(reconciliationInterval);
  }

  // First run after 3 minutes
  setTimeout(async () => {
    try {
      await runReconciliation();
    } catch (err: any) {
      console.error(`[RECONCILE] Initial run failed: ${err.message}`);
    }

    // Then every 15 minutes
    reconciliationInterval = setInterval(async () => {
      try {
        await runReconciliation();
      } catch (err: any) {
        console.error(`[RECONCILE] Scheduled run failed: ${err.message}`);
      }
    }, RECONCILIATION_INTERVAL_MS);
  }, 3 * 60 * 1000);

  console.log("[RECONCILE] Shopify order reconciliation scheduled (every 15 min, first run in 3 min)");
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
