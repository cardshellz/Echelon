/**
 * Vendor eBay Order Polling
 *
 * Scheduled job that polls each active vendor's eBay account for new orders.
 * Runs every 5 minutes.
 *
 * Flow: poll → validate → debit wallet → create OMS+WMS order → reserve inventory
 */

import { pool, db } from "../../db";
import { sql } from "drizzle-orm";
import { getVendorEbayToken } from "./vendor-ebay.routes";
import { walletService } from "./wallet.service";
import https from "https";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POLL_WINDOW_HOURS = 24; // Look back 24 hours

// Tier discount rates for wholesale price calculation
const TIER_DISCOUNTS: Record<string, number> = { standard: 0.15, pro: 0.25, elite: 0.30 };

// Flat shipping rate table (Phase 0)
const SHIPPING_RATES = [
  { maxOz: 4, cents: 450 },
  { maxOz: 8, cents: 525 },
  { maxOz: 16, cents: 650 },
  { maxOz: 32, cents: 800 },    // 2 lbs
  { maxOz: 80, cents: 1200 },   // 5 lbs
];

function getShippingCostCents(weightOz: number): number {
  for (const rate of SHIPPING_RATES) {
    if (weightOz <= rate.maxOz) return rate.cents;
  }
  // > 5 lbs: $15.00 + $1.50/lb over 5
  const overLbs = Math.ceil((weightOz - 80) / 16);
  return 1500 + (overLbs * 150);
}

// ---------------------------------------------------------------------------
// eBay API Helper (uses vendor's token)
// ---------------------------------------------------------------------------

function vendorEbayApiRequest(
  method: string,
  path: string,
  accessToken: string,
): Promise<any> {
  const environment = process.env.EBAY_ENVIRONMENT || "production";
  const hostname = environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 429) {
          reject(new Error("eBay API rate limited (429)"));
          return;
        }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(data); }
          return;
        }
        reject(new Error(`eBay API ${method} ${path} failed (${res.statusCode}): ${data.substring(0, 500)}`));
      });
    });

    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OMS / WMS Service References
// ---------------------------------------------------------------------------

let _omsService: any = null;
let _shipStationService: any = null;
let _wmsServices: any = null;

export function setDropshipOmsService(svc: any) { _omsService = svc; }
export function setDropshipShipStationService(svc: any) { _shipStationService = svc; }
export function setDropshipWmsServices(svc: any) { _wmsServices = svc; }

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let pollInterval: ReturnType<typeof setInterval> | null = null;

export function startVendorOrderPolling(): void {
  if (pollInterval) clearInterval(pollInterval);

  async function poll() {
    try {
      await pollAllVendorOrders();
    } catch (err: any) {
      console.error(`[VendorOrderPoll] Poll error: ${err.message}`);
    }
  }

  // Initial poll after 60 seconds (let server fully start)
  setTimeout(poll, 60_000);

  // Then every 5 minutes
  pollInterval = setInterval(poll, POLL_INTERVAL_MS);
  console.log(`[VendorOrderPoll] Started — every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopVendorOrderPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Poll all active vendors' eBay accounts for new orders.
 */
async function pollAllVendorOrders(): Promise<number> {
  const client = await pool.connect();
  let totalIngested = 0;

  try {
    // Get all active vendors with eBay connected
    const vendorsResult = await client.query(
      `SELECT id, name, tier, ebay_user_id
       FROM dropship_vendors
       WHERE status = 'active' AND ebay_oauth_token IS NOT NULL AND ebay_refresh_token IS NOT NULL`,
    );

    if (vendorsResult.rows.length === 0) return 0;

    for (const vendor of vendorsResult.rows) {
      try {
        const count = await pollVendorOrders(vendor.id, vendor.tier);
        totalIngested += count;
      } catch (err: any) {
        console.error(`[VendorOrderPoll] Failed for vendor ${vendor.id} (${vendor.name}): ${err.message}`);
      }
    }

    if (totalIngested > 0) {
      console.log(`[VendorOrderPoll] Poll complete — ${totalIngested} new order(s) ingested across all vendors`);
    }
  } finally {
    client.release();
  }

  return totalIngested;
}

/**
 * Poll a single vendor's eBay account for new orders.
 */
async function pollVendorOrders(vendorId: number, vendorTier: string): Promise<number> {
  const accessToken = await getVendorEbayToken(vendorId);
  if (!accessToken) {
    console.warn(`[VendorOrderPoll] No valid token for vendor ${vendorId}`);
    return 0;
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - POLL_WINDOW_HOURS * 60 * 60 * 1000);
  const filter = `creationdate:[${startDate.toISOString()}..${endDate.toISOString()}]`;

  let totalIngested = 0;
  let offset = 0;
  const limit = 50;

  while (true) {
    const params = new URLSearchParams({
      filter,
      limit: String(limit),
      offset: String(offset),
    });

    let response: any;
    try {
      response = await vendorEbayApiRequest(
        "GET",
        `/sell/fulfillment/v1/order?${params.toString()}`,
        accessToken,
      );
    } catch (err: any) {
      console.error(`[VendorOrderPoll] eBay API error for vendor ${vendorId}: ${err.message}`);
      break;
    }

    if (!response?.orders || response.orders.length === 0) break;

    for (const ebayOrder of response.orders) {
      try {
        const ingested = await processVendorOrder(vendorId, vendorTier, ebayOrder);
        if (ingested) totalIngested++;
      } catch (err: any) {
        console.error(`[VendorOrderPoll] Order ${ebayOrder.orderId} failed for vendor ${vendorId}: ${err.message}`);
      }
    }

    if (response.orders.length < limit || offset + limit >= (response.total || 0)) break;
    offset += limit;
  }

  return totalIngested;
}

/**
 * Process a single vendor eBay order through validation → debit → create flow.
 */
async function processVendorOrder(
  vendorId: number,
  vendorTier: string,
  ebayOrder: any,
): Promise<boolean> {
  const externalOrderId = ebayOrder.orderId;
  if (!externalOrderId) return false;

  // Skip non-paid / cancelled orders
  if (ebayOrder.orderPaymentStatus !== "PAID" && ebayOrder.orderPaymentStatus !== "FULLY_PAID") {
    return false;
  }
  if (ebayOrder.cancelStatus?.cancelState === "CANCELED") return false;
  // Skip fulfilled orders
  if (ebayOrder.orderFulfillmentStatus === "FULFILLED") return false;

  const client = await pool.connect();
  try {
    // Dedup: check if order already exists
    const existingResult = await client.query(
      `SELECT id FROM oms.oms_orders WHERE external_order_id = $1 AND vendor_id = $2 LIMIT 1`,
      [externalOrderId, vendorId],
    );
    if (existingResult.rows.length > 0) return false;

    // Map line items + compute costs
    const lineItems = ebayOrder.lineItems || [];
    if (lineItems.length === 0) return false;

    const discount = TIER_DISCOUNTS[vendorTier] || 0.15;
    let wholesaleTotalCents = 0;
    let totalWeightOz = 0;
    const mappedItems: Array<{
      sku: string;
      title: string;
      quantity: number;
      retailPriceCents: number;
      wholesalePriceCents: number;
      externalLineItemId: string;
      weightGrams: number;
    }> = [];

    for (const item of lineItems) {
      const sku = item.sku;
      if (!sku) {
        console.warn(`[VendorOrderPoll] Order ${externalOrderId}: line item has no SKU, skipping`);
        continue;
      }

      // Look up product variant
      const varResult = await client.query(
        `SELECT pv.id, pv.price_cents, pv.weight_grams, p.name, p.id as product_id
         FROM catalog.product_variants pv
         JOIN catalog.products p ON p.id = pv.product_id
         WHERE UPPER(pv.sku) = UPPER($1) AND pv.is_active = true
         LIMIT 1`,
        [sku],
      );

      if (varResult.rows.length === 0) {
        console.warn(`[VendorOrderPoll] Order ${externalOrderId}: SKU ${sku} not found in catalog`);
        continue; // We'll check below if we have enough items
      }

      const variant = varResult.rows[0];
      const qty = item.quantity || 1;
      const retailCents = variant.price_cents;
      const wholesaleCents = Math.round(retailCents * (1 - discount));
      const lineWholesale = wholesaleCents * qty;
      const weightGrams = variant.weight_grams || 0;

      wholesaleTotalCents += lineWholesale;
      totalWeightOz += (weightGrams / 28.35) * qty;

      mappedItems.push({
        sku,
        title: item.title || variant.name || sku,
        quantity: qty,
        retailPriceCents: retailCents,
        wholesalePriceCents: wholesaleCents,
        externalLineItemId: item.lineItemId,
        weightGrams,
      });
    }

    if (mappedItems.length === 0) {
      console.warn(`[VendorOrderPoll] Order ${externalOrderId}: no mappable items`);
      return false;
    }

    // Calculate shipping
    const shippingCents = getShippingCostCents(totalWeightOz);
    const totalCostCents = wholesaleTotalCents + shippingCents;

    // Validate & debit wallet in a transaction
    await client.query("BEGIN");

    try {
      // Debit wallet
      const debitResult = await walletService.debitWallet(
        vendorId,
        totalCostCents,
        "oms_order",
        externalOrderId,
        `Dropship order ${externalOrderId}: ${mappedItems.map(i => `${i.sku}x${i.quantity}`).join(", ")}`,
        client,
      );

      if (!debitResult.success) {
        await client.query("ROLLBACK");
        console.warn(`[VendorOrderPoll] Wallet debit failed for vendor ${vendorId}, order ${externalOrderId}: ${(debitResult as any).message}`);
        // TODO: notify vendor of failed order
        return false;
      }

      // Create OMS order
      const shipTo = ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
      const address = shipTo?.contactAddress;
      const pricingSummary = ebayOrder.pricingSummary;

      const omsResult = await client.query(
        `INSERT INTO oms_orders (
           channel_id, external_order_id, vendor_id, order_source, vendor_order_ref,
           status, financial_status, fulfillment_status,
           customer_name, customer_email, customer_phone,
           ship_to_name, ship_to_address1, ship_to_address2,
           ship_to_city, ship_to_state, ship_to_zip, ship_to_country,
           subtotal_cents, shipping_cents, tax_cents, total_cents,
           dropship_cost_cents, currency, raw_payload, ordered_at, created_at, updated_at
         ) VALUES (
           67, $1, $2, 'dropship_ebay', $3,
           'confirmed', 'paid', 'unfulfilled',
           $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12, $13,
           $14, $15, 0, $16,
           $17, 'USD', $18, $19, NOW(), NOW()
         ) RETURNING id`,
        [
          externalOrderId,
          vendorId,
          externalOrderId,
          shipTo?.fullName || ebayOrder.buyer?.username || "Unknown",
          shipTo?.email || null,
          shipTo?.primaryPhone?.phoneNumber || null,
          shipTo?.fullName || null,
          address?.addressLine1 || null,
          address?.addressLine2 || null,
          address?.city || null,
          address?.stateOrProvince || null,
          address?.postalCode || null,
          address?.countryCode || "US",
          wholesaleTotalCents,
          shippingCents,
          totalCostCents,
          totalCostCents,
          JSON.stringify(ebayOrder),
          new Date(ebayOrder.creationDate),
        ],
      );

      const omsOrderId = omsResult.rows[0].id;

      // Create OMS order lines
      for (const item of mappedItems) {
        await client.query(
          `INSERT INTO oms_order_lines (order_id, external_line_item_id, sku, title, quantity, unit_price_cents, total_cents, fulfillment_status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'unfulfilled', NOW())`,
          [omsOrderId, item.externalLineItemId, item.sku, item.title, item.quantity, item.wholesalePriceCents, item.wholesalePriceCents * item.quantity],
        );
      }

      // Record events
      await client.query(
        `INSERT INTO oms_order_events (order_id, event_type, details, created_at)
         VALUES ($1, 'order_received', $2, NOW()),
                ($1, 'wallet_debited', $3, NOW())`,
        [
          omsOrderId,
          JSON.stringify({ source: "dropship_ebay", vendor_id: vendorId }),
          JSON.stringify({ amount_cents: -totalCostCents, vendor_id: vendorId }),
        ],
      );

      await client.query("COMMIT");

      console.log(`[VendorOrderPoll] Created OMS order ${omsOrderId} for vendor ${vendorId}, eBay order ${externalOrderId}, cost $${(totalCostCents / 100).toFixed(2)}`);

      // Post-commit: Create WMS order + reserve + push to ShipStation (non-transactional)
      try {
        await createDropshipWmsOrder(omsOrderId, vendorId, externalOrderId, mappedItems, shipTo, address, totalCostCents);
      } catch (e: any) {
        console.error(`[VendorOrderPoll] WMS order creation failed for OMS ${omsOrderId}: ${e.message}`);
      }

      return true;
    } catch (err: any) {
      try { await client.query("ROLLBACK"); } catch {}
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Create a WMS order for a dropship order + reserve + push to ShipStation.
 */
async function createDropshipWmsOrder(
  omsOrderId: number,
  vendorId: number,
  externalOrderId: string,
  items: Array<{ sku: string; title: string; quantity: number; wholesalePriceCents: number; weightGrams: number }>,
  shipTo: any,
  address: any,
  totalCostCents: number,
): Promise<void> {
  const { ordersStorage } = await import("../orders");
  const { warehouseStorage } = await import("../warehouse");

  const enrichedItems: any[] = [];
  for (const item of items) {
    const binLocation = await warehouseStorage.getBinLocationFromInventoryBySku(item.sku);

    // Look up image
    let imageUrl = binLocation?.imageUrl || null;
    if (!imageUrl) {
      const imageResult = await db.execute(sql`
        SELECT pa.url as image_url
        FROM catalog.product_variants pv
        LEFT JOIN catalog.products p ON pv.product_id = p.id
        LEFT JOIN catalog.product_assets pa ON pa.product_id = p.id AND pa.is_primary = 1
        WHERE UPPER(pv.sku) = ${item.sku.toUpperCase()}
          AND pa.url IS NOT NULL
        LIMIT 1
      `);
      if (imageResult.rows.length > 0) {
        imageUrl = (imageResult.rows[0] as any).image_url;
      }
    }

    enrichedItems.push({
      orderId: 0,
      sourceItemId: null,
      sku: item.sku,
      name: item.title,
      quantity: item.quantity,
      pickedQuantity: 0,
      fulfilledQuantity: 0,
      status: "pending",
      location: binLocation?.location || "UNASSIGNED",
      zone: binLocation?.zone || "U",
      imageUrl,
      barcode: binLocation?.barcode || null,
      requiresShipping: 1,
      priceCents: item.wholesalePriceCents,
      discountCents: 0,
      totalPriceCents: item.wholesalePriceCents * item.quantity,
    });
  }

  const totalUnits = enrichedItems.reduce((sum, i) => sum + i.quantity, 0);
  const orderNumber = `DS-${externalOrderId}`;

  const newOrder = await ordersStorage.createOrderWithItems({
    channelId: 67, // eBay channel
    source: "ebay",
    externalOrderId,
    sourceTableId: String(omsOrderId),
    orderNumber,
    customerName: shipTo?.fullName || orderNumber,
    customerEmail: shipTo?.email || null,
    shippingName: shipTo?.fullName || null,
    shippingAddress: address?.addressLine1 || null,
    shippingCity: address?.city || null,
    shippingState: address?.stateOrProvince || null,
    shippingPostalCode: address?.postalCode || null,
    shippingCountry: address?.countryCode || "US",
    financialStatus: "paid",
    priority: 10, // Dropship orders get high priority (1 business day SLA)
    warehouseStatus: "ready",
    itemCount: enrichedItems.length,
    unitCount: totalUnits,
    orderPlacedAt: new Date(),
  }, enrichedItems);

  // Set vendor_id and order_source on WMS order (columns added by migration but not in Drizzle schema)
  await db.execute(sql`
    UPDATE wms.orders SET vendor_id = ${vendorId}, order_source = 'dropship_ebay'
    WHERE id = ${newOrder.id}
  `);

  console.log(`[VendorOrderPoll] Created WMS order ${newOrder.id} (${orderNumber}) — priority: high`);

  // Route to warehouse + reserve
  if (_wmsServices) {
    try {
      const routingCtx = {
        channelId: 67,
        skus: enrichedItems.map((i: any) => i.sku),
        country: address?.countryCode || "US",
      };
      const routing = await _wmsServices.fulfillmentRouter.routeOrder(routingCtx);
      if (routing) {
        await _wmsServices.fulfillmentRouter.assignWarehouseToOrder(newOrder.id, routing);
        try {
          await _wmsServices.slaMonitor.setSLAForOrder(newOrder.id);
        } catch {}
      }
    } catch (err: any) {
      console.error(`[VendorOrderPoll] Routing failed for ${orderNumber}: ${err.message}`);
    }

    // Reserve inventory
    try {
      const reserveResult = await _wmsServices.reservation.reserveOrder(newOrder.id);
      if (reserveResult.failed.length > 0) {
        console.log(`[VendorOrderPoll] Reservation partial for ${orderNumber}: ${reserveResult.failed.length} items could not be reserved`);
      }
    } catch (err: any) {
      console.error(`[VendorOrderPoll] Reservation failed for ${orderNumber}: ${err.message}`);
    }
  }

  // Push to ShipStation
  if (_shipStationService?.isConfigured() && _omsService) {
    try {
      const fullOrder = await _omsService.getOrderById(omsOrderId);
      if (fullOrder) {
        await _shipStationService.pushOrder(fullOrder);
      }
    } catch (e: any) {
      console.error(`[VendorOrderPoll] ShipStation push failed for DS-${externalOrderId}: ${e.message}`);
    }
  }
}
